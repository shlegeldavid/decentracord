import { HttpException } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import type { ChannelOrderGroup } from "./channels.dto.js";

export interface ChannelCategorySummary {
  id: string;
  name: string;
  position: number;
}

function apiError(status: number, code: string, message: string): HttpException {
  return new HttpException({ code, message }, status);
}

function matchesIds<T>(actual: ReadonlySet<T>, expected: ReadonlySet<T>): boolean {
  return actual.size === expected.size && [...actual].every((id) => expected.has(id));
}

export async function withChannelOrderLock<T>(pool: Pool, write: (client: PoolClient) => Promise<T>): Promise<T> {
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(21471, 901)");
    const result = await write(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client?.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client?.release();
  }
}

async function lockedCategoryIds(client: PoolClient): Promise<Set<string>> {
  const { rows } = await client.query<{ id: string }>(
    "SELECT id::text AS id FROM channel_categories ORDER BY position ASC, id ASC FOR UPDATE"
  );
  return new Set(rows.map((row) => row.id));
}

export async function writeCategoryOrder(client: PoolClient, categoryIds: string[]): Promise<void> {
  const existingIds = await lockedCategoryIds(client);
  const submittedIds = new Set(categoryIds);
  if (submittedIds.size === 0 || submittedIds.size !== categoryIds.length || !matchesIds(submittedIds, existingIds)) {
    throw apiError(400, "INVALID_REQUEST", "Некорректный порядок категорий");
  }

  for (const [index, categoryId] of categoryIds.entries()) {
    await client.query(
      "UPDATE channel_categories SET position = $1, updated_at = now() WHERE id = $2",
      [index + 1, categoryId]
    );
  }
}

export async function writeChannelOrder(
  client: PoolClient,
  groups: ChannelOrderGroup[],
  findVisibleIds: () => Promise<string[]>
): Promise<void> {
  const existingCategoryIds = await lockedCategoryIds(client);
  const currentChannels = await client.query<{
    id: string;
    category_id: string | null;
    position: number;
  }>(
    `SELECT id::text AS id, category_id::text AS category_id, position
     FROM channels
     ORDER BY category_id NULLS FIRST, position ASC, lower(name) ASC, id ASC
     FOR UPDATE`
  );
  const visibleIds = new Set(await findVisibleIds());
  const submittedIds = new Set(groups.flatMap((group) => group.channelIds));
  const submittedCategoryIds = new Set(groups.map((group) => group.categoryId));
  const expectedCategoryIds = new Set([null, ...existingCategoryIds]);
  if (submittedCategoryIds.size !== groups.length ||
    !matchesIds(submittedCategoryIds, expectedCategoryIds) ||
    !matchesIds(submittedIds, visibleIds)) {
    throw apiError(400, "INVALID_REQUEST", "Некорректный порядок каналов");
  }

  const hiddenByCategory = new Map<string | null, string[]>();
  for (const channel of currentChannels.rows) {
    if (visibleIds.has(channel.id)) continue;
    const hidden = hiddenByCategory.get(channel.category_id) ?? [];
    hidden.push(channel.id);
    hiddenByCategory.set(channel.category_id, hidden);
  }

  // Keep hidden channels out of the client contract; retain their category and relative order server-side.
  const completeGroups = groups.map((group) => ({
    categoryId: group.categoryId,
    channelIds: [...group.channelIds, ...(hiddenByCategory.get(group.categoryId) ?? [])]
  }));

  for (const group of completeGroups) {
    for (const [index, channelId] of group.channelIds.entries()) {
      await client.query(
        "UPDATE channels SET category_id = $3, position = $1, updated_at = now() WHERE id = $2",
        [index + 1, channelId, group.categoryId]
      );
    }
  }

  for (const { categoryId } of completeGroups) await normalizeChannelPositions(client, categoryId);
}

async function normalizeChannelPositions(client: PoolClient, categoryId: string | null): Promise<void> {
  await client.query(
    `WITH ordered AS (
      SELECT id, row_number() OVER (ORDER BY position ASC, lower(name) ASC, id ASC)::integer AS new_position
      FROM channels
      WHERE category_id IS NOT DISTINCT FROM $1
    )
    UPDATE channels AS channel
    SET position = ordered.new_position, updated_at = now()
    FROM ordered
    WHERE ordered.id = channel.id`,
    [categoryId]
  );
}

export async function nextChannelPosition(client: PoolClient, categoryId: string | null): Promise<number> {
  if (categoryId !== null) {
    const category = await client.query<{ id: string }>(
      "SELECT id::text AS id FROM channel_categories WHERE id = $1",
      [categoryId]
    );
    if (!category.rows[0]) throw apiError(404, "CATEGORY_NOT_FOUND", "Категория не найдена");
  }
  const { rows } = await client.query<{ max_position: number }>(
    "SELECT COALESCE(MAX(position), 0)::integer AS max_position FROM channels WHERE category_id IS NOT DISTINCT FROM $1",
    [categoryId]
  );
  return (rows[0]?.max_position ?? 0) + 1;
}

export async function moveChannelToCategory(
  client: PoolClient,
  channelId: string,
  categoryId: string | null,
  previousCategoryId: string | null
): Promise<void> {
  const position = await nextChannelPosition(client, categoryId);
  const moved = await client.query<{ id: string }>(
    "UPDATE channels SET category_id = $2, position = $3, updated_at = now() WHERE id = $1 RETURNING id::text AS id",
    [channelId, categoryId, position]
  );
  if (!moved.rows[0]) throw apiError(404, "CHANNEL_NOT_FOUND", "Канал не найден");

  const affectedCategories = new Set([previousCategoryId, categoryId]);
  for (const id of affectedCategories) await normalizeChannelPositions(client, id);
}

export async function insertCategory(client: PoolClient, name: string): Promise<ChannelCategorySummary> {
  const { rows: positions } = await client.query<{ max_position: number }>(
    "SELECT COALESCE(MAX(position), 0)::integer AS max_position FROM channel_categories"
  );
  const position = (positions[0]?.max_position ?? 0) + 1;
  const { rows: [created] } = await client.query<ChannelCategorySummary>(
    "INSERT INTO channel_categories (name, position) VALUES ($1, $2) RETURNING id::text AS id, name, position",
    [name, position]
  );
  if (!created) throw new Error("Category was not created");
  return created;
}

export async function updateCategoryName(client: PoolClient, categoryId: string, name: string): Promise<ChannelCategorySummary> {
  const { rows: [updated] } = await client.query<ChannelCategorySummary>(
    "UPDATE channel_categories SET name = $1, updated_at = now() WHERE id = $2 RETURNING id::text AS id, name, position",
    [name, categoryId]
  );
  if (!updated) throw apiError(404, "CATEGORY_NOT_FOUND", "Категория не найдена");
  return updated;
}

export async function removeCategory(client: PoolClient, categoryId: string): Promise<{ id: string }> {
  const { rows: [deleted] } = await client.query<{ id: string }>(
    "DELETE FROM channel_categories WHERE id = $1 RETURNING id::text AS id",
    [categoryId]
  );
  if (!deleted) throw apiError(404, "CATEGORY_NOT_FOUND", "Категория не найдена");
  await normalizeChannelPositions(client, null);
  return deleted;
}
