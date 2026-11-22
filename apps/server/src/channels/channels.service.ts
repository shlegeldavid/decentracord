import { HttpException } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { AccessService } from "../access/access.service.js";
import { evaluateChannelAccess, isPermission, type AccessFacts, type OverrideFact, type Permission, PERMISSIONS } from "../access/permissions.js";
import type { AuthPrincipal } from "../auth/session.service.js";
import { RealtimeGateway } from "../realtime/realtime.gateway.js";
import {
  isUuid,
  parseCategoryNameBody,
  parseChannelOverridesBody,
  parseCreateChannelBody,
  parseReorderCategoriesBody,
  parseReorderChannelsBody,
  parseUpdateChannelBody,
  type ChannelOrderGroup,
  type ChannelSubject,
  type OverrideEffect,
  type OverrideInput
} from "./channels.dto.js";

interface ChannelRow {
  id: string;
  name: string;
  description?: string | null;
  visibility?: "hidden" | "known";
}

interface ChannelOverrideRow {
  subject: ChannelSubject;
  subject_id: string | null;
  permission: Permission;
  effect: OverrideEffect;
}

interface ChannelAccessRow {
  is_owner: boolean;
  has_administrator: boolean;
  base_permissions: unknown;
  member_role_ids: unknown;
  overrides: unknown;
}

interface ChannelSummary {
  id: string;
  name: string;
  categoryId: string | null;
  description: string | null;
  visibility: "hidden" | "known";
  canView: boolean;
  canSend: boolean;
  canManageMessages: boolean;
  ownerEditable: boolean;
  unreadCount: number;
  lastReadSeq: number;
}

interface ChannelCategorySummary {
  id: string;
  name: string;
  position: number;
}

interface ChannelOverride {
  subject: ChannelSubject;
  subjectId: string | null;
  permission: Permission;
  effect: OverrideEffect;
}

function apiError(status: number, code: string, message: string): HttpException {
  return new HttpException({ code, message }, status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function matchesIds<T>(actual: ReadonlySet<T>, expected: ReadonlySet<T>): boolean {
  return actual.size === expected.size && [...actual].every((id) => expected.has(id));
}

function jsonArray(value: unknown): unknown[] {
  let entries = value;
  if (typeof entries === "string") {
    try {
      entries = JSON.parse(entries) as unknown;
    } catch {
      return [];
    }
  }
  return Array.isArray(entries) ? entries : [];
}

function permissionArray(value: unknown): Permission[] {
  const permissions = new Set(jsonArray(value).filter(isPermission));
  return PERMISSIONS.filter((permission) => permissions.has(permission));
}

function stringArray(value: unknown): string[] {
  return jsonArray(value).filter((entry): entry is string => typeof entry === "string");
}

function overrideArray(value: unknown): OverrideFact[] {
  const overrides: OverrideFact[] = [];
  for (const entry of jsonArray(value)) {
    if (!isRecord(entry) || !isPermission(entry.permission) || (entry.effect !== "allow" && entry.effect !== "deny")) continue;
    if (entry.subject === "everyone" && entry.subjectId === null) {
      overrides.push({ subject: "everyone", subjectId: null, permission: entry.permission, effect: entry.effect });
    } else if (entry.subject === "role" && typeof entry.subjectId === "string") {
      overrides.push({ subject: "role", subjectId: entry.subjectId, permission: entry.permission, effect: entry.effect });
    } else if (entry.subject === "member" && typeof entry.subjectId === "string") {
      overrides.push({ subject: "member", subjectId: entry.subjectId, permission: entry.permission, effect: entry.effect });
    }
  }
  return overrides;
}

function auditChannel(event: string, actorUserId: string, channelId: string | null, outcome: string): void {
  try {
    process.stdout.write(`${JSON.stringify({
      event,
      actorUserId,
      target: { type: "channel", id: channelId },
      outcome
    })}\n`);
  } catch {
    // Audit output must not change the channel-management result.
  }
}

function auditCategory(event: string, actorUserId: string, categoryId: string | null, outcome: string): void {
  try {
    process.stdout.write(`${JSON.stringify({
      event,
      actorUserId,
      target: { type: "category", id: categoryId },
      outcome
    })}\n`);
  } catch {
    // Audit output must not change the category-management result.
  }
}

export class ChannelsService {
  constructor(
    private readonly pool: Pool,
    private readonly access: AccessService,
    private readonly realtime: RealtimeGateway
  ) {}

  async list(principal: AuthPrincipal): Promise<{ channels: ChannelSummary[]; categories: ChannelCategorySummary[] }> {
    const [channels, unreadCounts, categories] = await Promise.all([
      this.access.listVisibleChannels(principal),
      this.access.unreadCountsByChannel(principal),
      this.access.listVisibleCategories(principal)
    ]);
    return {
      channels: channels.map((channel) => {
        const counts = unreadCounts.get(channel.id);
        return {
          ...channel,
          unreadCount: counts?.unreadCount ?? 0,
          lastReadSeq: counts?.lastReadSeq ?? 0
        };
      }),
      categories
    };
  }

  async listCategories(principal: AuthPrincipal): Promise<ChannelCategorySummary[]> {
    return this.access.listVisibleCategories(principal);
  }

  async createCategory(principal: AuthPrincipal, body: unknown): Promise<ChannelCategorySummary> {
    const input = parseCategoryNameBody(body);
    if (!input) throw apiError(400, "INVALID_REQUEST", "Проверьте название категории");
    await this.requireChannelManager(principal);

    let client: PoolClient | undefined;
    let created: ChannelCategorySummary | undefined;
    try {
      client = await this.pool.connect();
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(21471, 901)");
      const positionResult = await client.query<{ max_position: number }>(
        "SELECT COALESCE(MAX(position), 0)::integer AS max_position FROM channel_categories"
      );
      const position = (positionResult.rows[0]?.max_position ?? 0) + 1;
      const inserted = await client.query<ChannelCategorySummary>(
        "INSERT INTO channel_categories (name, position) VALUES ($1, $2) RETURNING id::text AS id, name, position",
        [input.name, position]
      );
      created = inserted.rows[0];
      if (!created) throw new Error("Category was not created");
      await client.query("COMMIT");
      auditCategory("audit.category.create", principal.userId, created.id, "created");
    } catch (error) {
      await client?.query("ROLLBACK").catch(() => undefined);
      auditCategory("audit.category.create", principal.userId, created?.id ?? null, hasErrorCode(error, "23505") ? "conflict" : "failed");
      if (hasErrorCode(error, "23505")) {
        throw apiError(409, "CATEGORY_ALREADY_EXISTS", "Категория с таким названием уже существует");
      }
      throw error;
    } finally {
      client?.release();
    }
    await this.notifyAllUsersChannelsChanged(principal.userId, created!.id);
    return created!;
  }

  async renameCategory(principal: AuthPrincipal, categoryId: string, body: unknown): Promise<ChannelCategorySummary> {
    this.assertCategoryId(categoryId);
    const input = parseCategoryNameBody(body);
    if (!input) throw apiError(400, "INVALID_REQUEST", "Проверьте название категории");
    await this.requireChannelManager(principal);

    let client: PoolClient | undefined;
    let updated: ChannelCategorySummary | undefined;
    try {
      client = await this.pool.connect();
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(21471, 901)");
      const result = await client.query<ChannelCategorySummary>(
        "UPDATE channel_categories SET name = $1, updated_at = now() WHERE id = $2 RETURNING id::text AS id, name, position",
        [input.name, categoryId]
      );
      updated = result.rows[0];
      if (!updated) throw apiError(404, "CATEGORY_NOT_FOUND", "Категория не найдена");
      await client.query("COMMIT");
    } catch (error) {
      await client?.query("ROLLBACK").catch(() => undefined);
      auditCategory("audit.category.update", principal.userId, categoryId, hasErrorCode(error, "23505") ? "conflict" : "failed");
      if (hasErrorCode(error, "23505")) {
        throw apiError(409, "CATEGORY_ALREADY_EXISTS", "Категория с таким названием уже существует");
      }
      throw error;
    } finally {
      client?.release();
    }
    auditCategory("audit.category.update", principal.userId, categoryId, "updated");
    await this.notifyAllUsersChannelsChanged(principal.userId, categoryId);
    return updated!;
  }

  async deleteCategory(principal: AuthPrincipal, categoryId: string): Promise<void> {
    this.assertCategoryId(categoryId);
    await this.requireChannelManager(principal);

    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(21471, 901)");
      const deleted = await client.query<{ id: string }>(
        "DELETE FROM channel_categories WHERE id = $1 RETURNING id::text AS id",
        [categoryId]
      );
      if (!deleted.rows[0]) throw apiError(404, "CATEGORY_NOT_FOUND", "Категория не найдена");
      await client.query(
        `WITH ordered AS (
          SELECT id, row_number() OVER (ORDER BY position ASC, lower(name) ASC, id ASC)::integer AS new_position
          FROM channels
          WHERE category_id IS NULL
        )
        UPDATE channels AS channel
        SET position = ordered.new_position, updated_at = now()
        FROM ordered
        WHERE ordered.id = channel.id`
      );
      await client.query("COMMIT");
    } catch (error) {
      await client?.query("ROLLBACK").catch(() => undefined);
      auditCategory("audit.category.delete", principal.userId, categoryId, "failed");
      throw error;
    } finally {
      client?.release();
    }
    auditCategory("audit.category.delete", principal.userId, categoryId, "deleted");
    await this.notifyAllUsersChannelsChanged(principal.userId, categoryId);
  }

  async reorderCategories(principal: AuthPrincipal, body: unknown): Promise<void> {
    const input = parseReorderCategoriesBody(body);
    if (!input) throw apiError(400, "INVALID_REQUEST", "Некорректный порядок категорий");
    await this.requireChannelManager(principal);
    await this.reorderWithLock(principal, "category", (client) => this.writeCategoryOrder(client, input.categoryIds));
  }

  async reorderChannels(principal: AuthPrincipal, body: unknown): Promise<void> {
    const input = parseReorderChannelsBody(body);
    if (!input) throw apiError(400, "INVALID_REQUEST", "Некорректный порядок каналов");
    await this.requireChannelManager(principal);
    await this.reorderWithLock(principal, "channel", (client) => this.writeChannelOrder(client, principal, input.groups));
  }

  private async reorderWithLock(
    principal: AuthPrincipal,
    target: "category" | "channel",
    writeOrder: (client: PoolClient) => Promise<void>
  ): Promise<void> {
    const event = `audit.${target}.reorder`;
    const audit = target === "category" ? auditCategory : auditChannel;
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(21471, 901)");
      await writeOrder(client);
      await client.query("COMMIT");
    } catch (error) {
      await client?.query("ROLLBACK").catch(() => undefined);
      audit(event, principal.userId, null, "failed");
      throw error;
    } finally {
      client?.release();
    }
    audit(event, principal.userId, null, "reordered");
    await this.notifyAllUsersChannelsChanged(principal.userId, null);
  }

  private async lockedCategoryIds(client: PoolClient): Promise<Set<string>> {
    const { rows } = await client.query<{ id: string }>(
      "SELECT id::text AS id FROM channel_categories ORDER BY position ASC, id ASC FOR UPDATE"
    );
    return new Set(rows.map((row) => row.id));
  }

  private async writeCategoryOrder(client: PoolClient, categoryIds: string[]): Promise<void> {
    const existingIds = await this.lockedCategoryIds(client);
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

  private async writeChannelOrder(client: PoolClient, principal: AuthPrincipal, groups: ChannelOrderGroup[]): Promise<void> {
    const existingCategoryIds = await this.lockedCategoryIds(client);
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
    const visibleChannels = await this.access.listVisibleChannels(principal, client);
    const visibleIds = new Set(visibleChannels.map((channel) => channel.id));
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

    for (const { categoryId } of completeGroups) {
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
  }

  async listSubjects(principal: AuthPrincipal): Promise<{
    roles: Array<{ id: string; name: string }>;
    members: Array<{ id: string; login: string }>;
  }> {
    await this.requireChannelManager(principal);
    const [roles, members] = await Promise.all([
      this.pool.query<{ id: string; name: string }>(
        "SELECT id::text AS id, name FROM roles WHERE system_key IS NULL ORDER BY position DESC, name ASC, id ASC"
      ),
      this.pool.query<{ id: string; login: string }>(
        "SELECT id::text AS id, login FROM users WHERE active = true ORDER BY login_normalized ASC, id ASC"
      )
    ]);
    return {
      roles: roles.rows.map(({ id, name }) => ({ id, name })),
      members: members.rows.map(({ id, login }) => ({ id, login }))
    };
  }

  async get(principal: AuthPrincipal, channelId: string): Promise<{ channel: ChannelSummary; overrides: ChannelOverride[] }> {
    this.assertChannelId(channelId);
    await this.access.requireChannelPermission(principal, channelId, "VIEW_CHANNEL");
    const channel = (await this.access.listVisibleChannels(principal)).find((entry) => entry.id === channelId);
    if (!channel) throw apiError(404, "CHANNEL_NOT_FOUND", "Канал не найден");

    const unreadCounts = await this.access.unreadCountsByChannel(principal);

    const overrides = channel.ownerEditable ? await this.readOverrides(channelId) : [];
    const counts = unreadCounts.get(channel.id);
    return {
      channel: {
        ...channel,
        unreadCount: counts?.unreadCount ?? 0,
        lastReadSeq: counts?.lastReadSeq ?? 0
      },
      overrides
    };
  }

  async create(principal: AuthPrincipal, body: unknown): Promise<ChannelSummary> {
    const input = parseCreateChannelBody(body);
    if (!input) throw apiError(400, "INVALID_REQUEST", "Проверьте название канала");
    await this.requireChannelManager(principal);

    let client: PoolClient | undefined;
    let created: ChannelRow | undefined;
    try {
      client = await this.pool.connect();
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(21471, 901)");
      if (input.categoryId !== null) {
        const category = await client.query<{ id: string }>(
          "SELECT id::text AS id FROM channel_categories WHERE id = $1",
          [input.categoryId]
        );
        if (!category.rows[0]) throw apiError(404, "CATEGORY_NOT_FOUND", "Категория не найдена");
      }
      const positionResult = await client.query<{ max_position: number }>(
        "SELECT COALESCE(MAX(position), 0)::integer AS max_position FROM channels WHERE category_id IS NOT DISTINCT FROM $1",
        [input.categoryId]
      );
      const position = (positionResult.rows[0]?.max_position ?? 0) + 1;
      const inserted = await client.query<ChannelRow>(
        "INSERT INTO channels (name, position, description, visibility, category_id) VALUES ($1, $2, $3, 'hidden', $4) RETURNING id::text AS id, name, description, visibility",
        [input.name, position, input.description, input.categoryId]
      );
      created = inserted.rows[0];
      if (!created) throw new Error("Channel was not created");
      if (input.overrides.length > 0) {
        await this.findAffectedUsers(client, input.overrides);
        await this.writeOverrides(client, created.id, input.overrides);
      }
      await client.query("COMMIT");
      auditChannel("audit.channel.create", principal.userId, created.id, "created");
    } catch (error) {
      await client?.query("ROLLBACK").catch(() => undefined);
      auditChannel("audit.channel.create", principal.userId, null, hasErrorCode(error, "23505") ? "conflict" : "failed");
      if (hasErrorCode(error, "23505")) {
        throw apiError(409, "CHANNEL_ALREADY_EXISTS", "Канал с таким названием уже существует");
      }
      throw error;
    } finally {
      client?.release();
    }
    try {
      const users = await this.pool.query<{ id: string }>("SELECT id::text AS id FROM users WHERE active = true");
      await this.notifyChannelAccess(users.rows.map((row) => row.id), created!.id, false, principal.userId);
    } catch {
      auditChannel("audit.channel.realtime", principal.userId, created!.id, "notification_failed");
    }
    await this.notifyAllUsersChannelsChanged(principal.userId, input.categoryId);
    return this.summaryFor(principal, created!);
  }

  async update(principal: AuthPrincipal, channelId: string, body: unknown): Promise<ChannelSummary> {
    this.assertChannelId(channelId);
    const input = parseUpdateChannelBody(body);
    if (!input) throw apiError(400, "INVALID_REQUEST", "Проверьте данные канала");
    const changesProperties = Object.hasOwn(input, "description") || Object.hasOwn(input, "visibility");
    if (input.name !== undefined || changesProperties) {
      await this.access.requireChannelPermission(principal, channelId, "VIEW_CHANNEL");
    }
    await this.requireChannelManager(principal);

    let client: PoolClient | undefined;
    let updated: (ChannelRow & { description: string | null; visibility: "hidden" | "known"; category_id: string | null }) | undefined;
    try {
      client = await this.pool.connect();
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(21471, 901)");
      const currentResult = await client.query<ChannelRow & { category_id: string | null }>(
        "SELECT id::text AS id, name, category_id::text AS category_id FROM channels WHERE id = $1 FOR UPDATE",
        [channelId]
      );
      const current = currentResult.rows[0];
      if (!current) throw apiError(404, "CHANNEL_NOT_FOUND", "Канал не найден");

      const result = await client.query<ChannelRow & {
        description: string | null;
        visibility: "hidden" | "known";
        category_id: string | null;
      }>(
        `UPDATE channels
         SET name = CASE WHEN $1::boolean THEN $2::text ELSE name END,
             description = CASE WHEN $3::boolean THEN $4::text ELSE description END,
             visibility = CASE WHEN $5::boolean THEN $6::text ELSE visibility END,
             updated_at = now()
         WHERE id = $7
         RETURNING id::text AS id, name, description, visibility, category_id::text AS category_id`,
        [
          input.name !== undefined,
          input.name ?? null,
          Object.hasOwn(input, "description"),
          input.description ?? null,
          Object.hasOwn(input, "visibility"),
          input.visibility ?? null,
          channelId
        ]
      );
      updated = result.rows[0];
      if (!updated) throw apiError(404, "CHANNEL_NOT_FOUND", "Канал не найден");

      if (Object.hasOwn(input, "categoryId")) {
        await this.moveChannelToCategory(client, channelId, input.categoryId ?? null, current.category_id);
      }
      await client.query("COMMIT");
      if (input.name !== undefined || changesProperties) auditChannel("audit.channel.update", principal.userId, channelId, "updated");
      if (Object.hasOwn(input, "categoryId")) auditChannel("audit.channel.move", principal.userId, channelId, "updated");
    } catch (error) {
      await client?.query("ROLLBACK").catch(() => undefined);
      if (input.name !== undefined || changesProperties) {
        auditChannel("audit.channel.update", principal.userId, channelId, hasErrorCode(error, "23505") ? "conflict" : "failed");
      }
      if (Object.hasOwn(input, "categoryId")) auditChannel("audit.channel.move", principal.userId, channelId, "failed");
      if (input.name !== undefined && hasErrorCode(error, "23505")) {
        throw apiError(409, "CHANNEL_ALREADY_EXISTS", "Канал с таким названием уже существует");
      }
      throw error;
    } finally {
      client?.release();
    }
    if (input.name !== undefined) {
      await this.notifyChannelUpdate(channelId, { channelId, name: updated!.name }, principal.userId);
    }
    if (Object.hasOwn(input, "categoryId") || changesProperties) {
      await this.notifyAllUsersChannelsChanged(principal.userId, channelId);
    }
    const summary = await this.summaryFor(principal, updated!);
    return Object.hasOwn(input, "categoryId")
      ? { ...summary, categoryId: input.categoryId ?? null }
      : summary;
  }

  private async moveChannelToCategory(
    client: PoolClient,
    channelId: string,
    categoryId: string | null,
    previousCategoryId: string | null
  ): Promise<void> {
    if (categoryId !== null) {
      const category = await client.query<{ id: string }>(
        "SELECT id::text AS id FROM channel_categories WHERE id = $1",
        [categoryId]
      );
      if (!category.rows[0]) throw apiError(404, "CATEGORY_NOT_FOUND", "Категория не найдена");
    }

    const positionResult = await client.query<{ max_position: number }>(
      "SELECT COALESCE(MAX(position), 0)::integer AS max_position FROM channels WHERE category_id IS NOT DISTINCT FROM $1",
      [categoryId]
    );
    const position = (positionResult.rows[0]?.max_position ?? 0) + 1;
    const moved = await client.query<{ id: string }>(
      "UPDATE channels SET category_id = $2, position = $3, updated_at = now() WHERE id = $1 RETURNING id::text AS id",
      [channelId, categoryId, position]
    );
    if (!moved.rows[0]) throw apiError(404, "CHANNEL_NOT_FOUND", "Канал не найден");

    const affectedCategories = new Set([previousCategoryId, categoryId]);
    for (const affectedCategoryId of affectedCategories) {
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
        [affectedCategoryId]
      );
    }
  }

  async setOverrides(principal: AuthPrincipal, channelId: string, body: unknown): Promise<void> {
    this.assertChannelId(channelId);
    const overrides = parseChannelOverridesBody(body);
    if (!overrides) throw apiError(400, "INVALID_REQUEST", "Проверьте переопределения канала");
    if (overrides.some((override) => override.permission === "ADMINISTRATOR")) {
      throw apiError(403, "FORBIDDEN", "ADMINISTRATOR нельзя задавать для канала");
    }
    await this.access.requireChannelPermission(principal, channelId, "VIEW_CHANNEL");
    await this.requireChannelManager(principal);

    let client: PoolClient | undefined;
    let affectedUserIds: string[] = [];
    let previousView = new Map<string, boolean>();
    try {
      client = await this.pool.connect();
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(21471, 901)");
      const channel = await client.query("SELECT id FROM channels WHERE id = $1 FOR UPDATE", [channelId]);
      if (channel.rows.length === 0) throw apiError(404, "CHANNEL_NOT_FOUND", "Канал не найден");

      affectedUserIds = await this.findAffectedUsers(client, overrides);
      if (overrides.some((override) => override.permission === "VIEW_CHANNEL")) {
        previousView = new Map();
        for (const userId of affectedUserIds) {
          previousView.set(userId, await this.canViewChannel(client, userId, channelId));
        }
      }
      await this.writeOverrides(client, channelId, overrides);
      await client.query("COMMIT");
      auditChannel("audit.channel.override.update", principal.userId, channelId, "updated");
    } catch (error) {
      await client?.query("ROLLBACK").catch(() => undefined);
      auditChannel("audit.channel.override.update", principal.userId, channelId, "failed");
      throw error;
    } finally {
      client?.release();
    }
    await this.notifyAccessChanges(affectedUserIds, channelId, previousView, principal.userId);
  }

  private async writeOverrides(client: PoolClient, channelId: string, overrides: OverrideInput[]): Promise<void> {
    let everyoneRoleId: string | undefined;
    for (const override of overrides) {
      let roleId: string | null = null;
      if (override.subject === "everyone") {
        if (!everyoneRoleId) {
          const everyone = await client.query<{ id: string }>("SELECT id::text AS id FROM roles WHERE system_key = 'everyone'");
          everyoneRoleId = everyone.rows[0]?.id;
          if (!everyoneRoleId) throw new Error("Required @everyone role is missing");
        }
        roleId = everyoneRoleId;
      } else if (override.subject === "role") {
        const targetRole = await client.query<{ id: string }>("SELECT id FROM roles WHERE id = $1", [override.subjectId]);
        if (targetRole.rows.length === 0) throw apiError(404, "ROLE_NOT_FOUND", "Роль не найдена");
        roleId = override.subjectId;
      } else {
        const targetMember = await client.query<{ id: string }>("SELECT id FROM users WHERE id = $1", [override.subjectId]);
        if (targetMember.rows.length === 0) throw apiError(404, "MEMBER_NOT_FOUND", "Участник не найден");
      }

      if (override.effect === "unset") {
        if (override.subject === "member") {
          await client.query(
            "DELETE FROM channel_member_overrides WHERE channel_id = $1 AND user_id = $2 AND permission = $3",
            [channelId, override.subjectId, override.permission]
          );
        } else {
          await client.query(
            "DELETE FROM channel_role_overrides WHERE channel_id = $1 AND role_id = $2 AND permission = $3",
            [channelId, roleId, override.permission]
          );
        }
      } else if (override.subject === "member") {
        await client.query(
          `INSERT INTO channel_member_overrides (channel_id, user_id, permission, effect)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (channel_id, user_id, permission)
           DO UPDATE SET effect = EXCLUDED.effect, updated_at = now()`,
          [channelId, override.subjectId, override.permission, override.effect]
        );
      } else {
        await client.query(
          `INSERT INTO channel_role_overrides (channel_id, role_id, permission, effect)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (channel_id, role_id, permission)
           DO UPDATE SET effect = EXCLUDED.effect, updated_at = now()`,
          [channelId, roleId, override.permission, override.effect]
        );
      }
    }
  }

  private async findAffectedUsers(client: PoolClient, overrides: OverrideInput[]): Promise<string[]> {
    const affected = new Set<string>();
    for (const override of overrides) {
      if (override.subject === "everyone") {
        const users = await client.query<{ id: string }>("SELECT id::text AS id FROM users WHERE active = true");
        for (const user of users.rows) affected.add(user.id);
      } else if (override.subject === "member") {
        const user = await client.query<{ id: string }>("SELECT id::text AS id FROM users WHERE id = $1", [override.subjectId]);
        if (!user.rows[0]) throw apiError(404, "MEMBER_NOT_FOUND", "Участник не найден");
        affected.add(user.rows[0].id);
      } else {
        const role = await client.query<{ id: string }>("SELECT id::text AS id FROM roles WHERE id = $1", [override.subjectId]);
        if (!role.rows[0]) throw apiError(404, "ROLE_NOT_FOUND", "Роль не найдена");
        const users = await client.query<{ id: string }>(
          "SELECT user_id::text AS id FROM user_roles WHERE role_id = $1",
          [override.subjectId]
        );
        for (const user of users.rows) affected.add(user.id);
      }
    }
    return [...affected];
  }

  private async canViewChannel(client: PoolClient, userId: string, channelId: string): Promise<boolean> {
    const result = await client.query<ChannelAccessRow>(
      `SELECT
         user_account.is_owner,
         EXISTS (
           SELECT 1
           FROM roles AS role
           CROSS JOIN LATERAL jsonb_array_elements_text(role.permissions) AS permission(permission)
           WHERE permission.permission = 'ADMINISTRATOR'
             AND (role.system_key = 'everyone' OR role.id IN (
               SELECT assignment.role_id FROM user_roles AS assignment WHERE assignment.user_id = user_account.id
             ))
         ) AS has_administrator,
         COALESCE((
           SELECT jsonb_agg(DISTINCT permission.permission)
           FROM roles AS role
           CROSS JOIN LATERAL jsonb_array_elements_text(role.permissions) AS permission(permission)
           WHERE role.system_key = 'everyone' OR role.id IN (
             SELECT assignment.role_id FROM user_roles AS assignment WHERE assignment.user_id = user_account.id
           )
         ), '[]'::jsonb) AS base_permissions,
         COALESCE((
           SELECT jsonb_agg(DISTINCT role.id::text)
           FROM user_roles AS assignment
           JOIN roles AS role ON role.id = assignment.role_id
           WHERE assignment.user_id = user_account.id
             AND role.system_key IS DISTINCT FROM 'everyone'
         ), '[]'::jsonb) AS member_role_ids,
         COALESCE((
           SELECT jsonb_agg(fact)
           FROM (
             SELECT jsonb_build_object(
               'subject', CASE WHEN role.system_key = 'everyone' THEN 'everyone' ELSE 'role' END,
               'subjectId', CASE WHEN role.system_key = 'everyone' THEN NULL ELSE override.role_id::text END,
               'permission', override.permission,
               'effect', override.effect
             ) AS fact
             FROM channel_role_overrides AS override
             JOIN roles AS role ON role.id = override.role_id
             WHERE override.channel_id = channel.id
               AND (role.system_key = 'everyone' OR role.id IN (
                 SELECT assignment.role_id FROM user_roles AS assignment WHERE assignment.user_id = user_account.id
               ))
             UNION ALL
             SELECT jsonb_build_object(
               'subject', 'member',
               'subjectId', override.user_id::text,
               'permission', override.permission,
               'effect', override.effect
             ) AS fact
             FROM channel_member_overrides AS override
             WHERE override.channel_id = channel.id AND override.user_id = user_account.id
           ) AS overrides
         ), '[]'::jsonb) AS overrides
       FROM users AS user_account
       JOIN channels AS channel ON channel.id = $2
       WHERE user_account.id = $1`,
      [userId, channelId]
    );
    const row = result.rows[0];
    if (!row) return false;
    if (row.is_owner || row.has_administrator) return true;
    const facts: AccessFacts = {
      memberId: userId,
      basePermissions: permissionArray(row.base_permissions),
      hasAdministrator: false,
      memberRoleIds: stringArray(row.member_role_ids),
      overrides: overrideArray(row.overrides)
    };
    return evaluateChannelAccess(facts).has("VIEW_CHANNEL");
  }

  private async notifyAccessChanges(
    userIds: string[],
    channelId: string,
    previousView: Map<string, boolean>,
    actorUserId: string
  ): Promise<void> {
    const revoked: string[] = [];
    const changed: string[] = [];
    try {
      for (const userId of userIds) {
        const canView = await this.access.canReceiveChannelEvent(userId, channelId, "channel:updated");
        if (previousView.get(userId) === true && !canView) revoked.push(userId);
        else changed.push(userId);
      }
    } catch {
      auditChannel("audit.channel.realtime", actorUserId, channelId, "notification_failed");
      return;
    }

    await this.notifyChannelAccess(revoked, channelId, true, actorUserId);
    await this.notifyChannelAccess(changed, channelId, false, actorUserId);
    await this.notifyChannelUpdate(channelId, { channelId }, actorUserId);
  }

  private async notifyChannelAccess(
    userIds: string[],
    channelId: string,
    revoked: boolean,
    actorUserId: string
  ): Promise<void> {
    if (userIds.length === 0) return;
    try {
      await this.realtime.notifyChannelAccessChanged(userIds, channelId, revoked);
    } catch {
      auditChannel("audit.channel.realtime", actorUserId, channelId, "notification_failed");
    }
  }

  private async notifyAllUsersChannelsChanged(actorUserId: string, categoryId: string | null): Promise<void> {
    try {
      const users = await this.pool.query<{ id: string }>("SELECT id::text AS id FROM users WHERE active = true");
      await this.realtime.notifyUsersChannelsChanged(users.rows.map((row) => ({
        userId: row.id,
        revokedChannelIds: []
      })));
    } catch {
      auditCategory("audit.channel.realtime", actorUserId, categoryId, "notification_failed");
    }
  }

  private async notifyChannelUpdate(channelId: string, payload: unknown, actorUserId: string): Promise<void> {
    try {
      await this.realtime.emitChannelEvent(channelId, "channel:updated", payload);
    } catch {
      auditChannel("audit.channel.realtime", actorUserId, channelId, "notification_failed");
    }
  }

  private async readOverrides(channelId: string): Promise<ChannelOverride[]> {
    const result = await this.pool.query<ChannelOverrideRow>(
      `SELECT subject, subject_id, permission, effect
       FROM (
         SELECT
           CASE WHEN role.system_key = 'everyone' THEN 'everyone' ELSE 'role' END AS subject,
           CASE WHEN role.system_key = 'everyone' THEN NULL ELSE override.role_id::text END AS subject_id,
           override.permission,
           override.effect
         FROM channel_role_overrides AS override
         JOIN roles AS role ON role.id = override.role_id
         WHERE override.channel_id = $1
         UNION ALL
         SELECT 'member', override.user_id::text, override.permission, override.effect
         FROM channel_member_overrides AS override
         WHERE override.channel_id = $1
       ) AS channel_overrides
       ORDER BY subject ASC, subject_id ASC NULLS FIRST, permission ASC`,
      [channelId]
    );
    return result.rows.map((row) => ({
      subject: row.subject,
      subjectId: row.subject_id,
      permission: row.permission,
      effect: row.effect
    }));
  }

  private async summaryFor(principal: AuthPrincipal, channel: ChannelRow): Promise<ChannelSummary> {
    const visible = (await this.access.listVisibleChannels(principal)).find((entry) => entry.id === channel.id);
    const unreadCounts = await this.access.unreadCountsByChannel(principal);
    const counts = unreadCounts.get(channel.id);
    return visible
      ? {
          ...visible,
          unreadCount: counts?.unreadCount ?? 0,
          lastReadSeq: counts?.lastReadSeq ?? 0
        }
      : {
          id: channel.id,
          name: channel.name,
          categoryId: null,
          description: null,
          visibility: channel.visibility ?? "hidden",
          canView: false,
          canSend: false,
          canManageMessages: false,
          ownerEditable: false,
          unreadCount: 0,
          lastReadSeq: 0
        };
  }

  private async requireChannelManager(principal: AuthPrincipal): Promise<void> {
    const permissions = await this.access.effectivePermissions(principal.userId);
    if (!permissions.has("MANAGE_CHANNELS") && !permissions.has("ADMINISTRATOR")) {
      throw apiError(403, "FORBIDDEN", "Недостаточно прав");
    }
  }

  private assertChannelId(channelId: string): void {
    if (!isUuid(channelId)) throw apiError(400, "INVALID_REQUEST", "Некорректный идентификатор канала");
  }

  private assertCategoryId(categoryId: string): void {
    if (!isUuid(categoryId)) throw apiError(400, "INVALID_REQUEST", "Некорректный идентификатор категории");
  }
}
