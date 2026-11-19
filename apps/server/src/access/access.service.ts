import { HttpException } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { evaluateChannelAccess, isPermission, PERMISSIONS, type AccessFacts, type OverrideFact, type Permission } from "./permissions.js";

export interface AccessPrincipal {
  userId: string;
}

export interface CurrentUserAccess {
  permissions: Permission[];
  isOwner: boolean;
  roleIds: string[];
  roleNames: string[];
  roles: Array<{ id: string; name: string; color: string | null; position: number }>;
}

interface UserAccessRow {
  is_owner: boolean;
  has_administrator: boolean;
  base_permissions: unknown;
  role_ids: unknown;
  role_names: unknown;
  roles: unknown;
}

interface ChannelAccessRow {
  is_owner: boolean;
  has_administrator: boolean;
  base_permissions: unknown;
  member_role_ids: unknown;
  overrides: unknown;
}

interface ChannelMemberFactsRow {
  is_owner: boolean;
  has_administrator: boolean;
  base_permissions: unknown;
  member_roles: unknown;
  overrides: unknown;
  user_id: string;
  login: string;
}

interface VisibleChannelFactsRow extends ChannelAccessRow {
  user_id: string;
  channel_id: string;
}

export interface VisibleChannelRow {
  id: string;
  name: string;
  categoryId: string | null;
  description: string | null;
  visibility: "hidden" | "known";
  canView: boolean;
  canSend: boolean;
  canManageMessages: boolean;
  ownerEditable: boolean;
}

export interface VisibleCategoryRow {
  id: string;
  name: string;
  position: number;
}

export interface UserChannelAccessChange {
  userId: string;
  revokedChannelIds: string[];
  reason?: string;
}

type QueryExecutor = Pick<PoolClient, "query">;

export function findUserChannelAccessChanges(
  before: Map<string, VisibleChannelRow[]>,
  after: Map<string, VisibleChannelRow[]>
): UserChannelAccessChange[] {
  const changes: UserChannelAccessChange[] = [];
  for (const [userId, previousChannels] of before) {
    const currentChannels = after.get(userId) ?? [];
    const currentById = new Map(currentChannels.map((channel) => [channel.id, channel]));
    const revokedChannelIds = previousChannels
      .filter((channel) => !currentById.has(channel.id))
      .map((channel) => channel.id);
    const changed = revokedChannelIds.length > 0 || currentChannels.length !== previousChannels.length ||
      previousChannels.some((channel) => {
        const current = currentById.get(channel.id);
        return current !== undefined && (
          current.name !== channel.name ||
          current.canView !== channel.canView ||
          current.canSend !== channel.canSend ||
          current.canManageMessages !== channel.canManageMessages ||
          current.ownerEditable !== channel.ownerEditable
        );
      });
    if (changed) changes.push({ userId, revokedChannelIds });
  }
  return changes;
}

function apiError(status: number, code: string, message: string): HttpException {
  return new HttpException({ code, message }, status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function userRoleArray(value: unknown): CurrentUserAccess["roles"] {
  if (!Array.isArray(value)) return [];
  const roles: CurrentUserAccess["roles"] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      typeof entry.name !== "string" ||
      (entry.color !== null && typeof entry.color !== "string") ||
      typeof entry.position !== "number" ||
      !Number.isSafeInteger(entry.position)
    ) {
      continue;
    }
    roles.push({
      id: entry.id,
      name: entry.name,
      color: entry.color,
      position: entry.position
    });
  }
  return roles;
}

function permissionArray(value: unknown): Permission[] {
  if (!Array.isArray(value)) return [];
  const values = new Set(value.filter(isPermission));
  return PERMISSIONS.filter((permission) => values.has(permission));
}

function overrideArray(value: unknown): OverrideFact[] {
  if (!Array.isArray(value)) return [];
  const overrides: OverrideFact[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || !isPermission(entry.permission) || (entry.effect !== "allow" && entry.effect !== "deny")) {
      continue;
    }
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

export class AccessService {
  constructor(private readonly pool: Pool) {}

  async currentUserAccess(userId: string): Promise<CurrentUserAccess | null> {
    const result = await this.pool.query<UserAccessRow>(
      `SELECT
         user_account.is_owner,
         COALESCE(bool_or(permission.permission = 'ADMINISTRATOR'), false) AS has_administrator,
         COALESCE(
           jsonb_agg(DISTINCT permission.permission) FILTER (WHERE permission.permission IS NOT NULL),
           '[]'::jsonb
         ) AS base_permissions,
         COALESCE(
           jsonb_agg(DISTINCT assigned_role.id::text) FILTER (WHERE assigned_role.id IS NOT NULL),
           '[]'::jsonb
         ) AS role_ids,
         COALESCE(
           jsonb_agg(DISTINCT assigned_role.name) FILTER (WHERE assigned_role.name IS NOT NULL),
           '[]'::jsonb
         ) AS role_names,
         COALESCE(
           (
             SELECT jsonb_agg(
               jsonb_build_object(
                 'id', member_role.id::text,
                 'name', member_role.name,
                 'color', member_role.color,
                 'position', member_role.position
               )
               ORDER BY member_role.position DESC
             )
             FROM user_roles AS role_assignment
             JOIN roles AS member_role
               ON member_role.id = role_assignment.role_id
              AND member_role.system_key IS DISTINCT FROM 'everyone'
             WHERE role_assignment.user_id = user_account.id
           ),
           '[]'::jsonb
         ) AS roles
       FROM users AS user_account
       LEFT JOIN user_roles AS assignment ON assignment.user_id = user_account.id
       LEFT JOIN roles AS base_role
         ON base_role.system_key = 'everyone' OR base_role.id = assignment.role_id
       LEFT JOIN roles AS assigned_role
         ON assigned_role.id = assignment.role_id
        AND assigned_role.system_key IS DISTINCT FROM 'everyone'
       LEFT JOIN LATERAL jsonb_array_elements_text(base_role.permissions) AS permission(permission) ON true
       WHERE user_account.id = $1
       GROUP BY user_account.id, user_account.is_owner`,
      [userId]
    );

    const row = result.rows[0];
    if (!row) return null;
    const basePermissions = permissionArray(row.base_permissions);
    return {
      permissions: row.is_owner || row.has_administrator ? [...PERMISSIONS] : basePermissions,
      isOwner: row.is_owner,
      roleIds: stringArray(row.role_ids),
      roleNames: stringArray(row.role_names),
      roles: userRoleArray(row.roles)
    };
  }

  async effectivePermissions(userId: string): Promise<Set<Permission>> {
    const profile = await this.currentUserAccess(userId);
    return new Set(profile?.permissions ?? []);
  }

  async requirePermission(principal: AccessPrincipal, permission: Permission): Promise<void> {
    if (!(await this.effectivePermissions(principal.userId)).has(permission)) {
      throw apiError(403, "FORBIDDEN", "Недостаточно прав");
    }
  }

  async requireOwner(principal: AccessPrincipal): Promise<void> {
    const profile = await this.currentUserAccess(principal.userId);
    if (!profile?.isOwner) throw apiError(403, "FORBIDDEN", "Недостаточно прав");
  }

  async requireChannelPermission(
    principal: AccessPrincipal,
    channelId: string,
    permission: Permission
  ): Promise<void> {
    const permissions = await this.channelPermissions(principal.userId, channelId);
    if (!permissions?.has("VIEW_CHANNEL")) {
      throw apiError(404, "CHANNEL_NOT_FOUND", "Канал не найден");
    }
    if (!permissions.has(permission)) throw apiError(403, "FORBIDDEN", "Недостаточно прав");
  }

  async hasChannelPermission(
    principal: AccessPrincipal,
    channelId: string,
    permission: Permission
  ): Promise<boolean> {
    const permissions = await this.channelPermissions(principal.userId, channelId);
    return permissions !== null && permissions.has("VIEW_CHANNEL") && permissions.has(permission);
  }

  async listChannelMembers(channelId: string): Promise<Array<{
    id: string;
    login: string;
    roles: Array<{ id: string; name: string; color: string | null; position: number }>;
  }>> {
    const result = await this.pool.query<ChannelMemberFactsRow>(
      `SELECT
         user_account.id::text AS user_id,
         user_account.login,
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
           SELECT jsonb_agg(
             jsonb_build_object(
               'id', role.id::text,
               'name', role.name,
               'color', role.color,
               'position', role.position
             ) ORDER BY role.position DESC, role.id ASC
           )
           FROM user_roles AS assignment
           JOIN roles AS role ON role.id = assignment.role_id
           WHERE assignment.user_id = user_account.id
             AND role.system_key IS DISTINCT FROM 'everyone'
         ), '[]'::jsonb) AS member_roles,
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
           ) AS channel_overrides
         ), '[]'::jsonb) AS overrides
       FROM users AS user_account
       JOIN channels AS channel ON channel.id = $1
       WHERE user_account.active = true
       ORDER BY lower(user_account.login) ASC, user_account.id ASC`,
      [channelId]
    );

    const members: Array<{
      id: string;
      login: string;
      roles: Array<{ id: string; name: string; color: string | null; position: number }>;
    }> = [];
    for (const row of result.rows) {
      const roles = userRoleArray(row.member_roles);
      const permissions = row.is_owner || row.has_administrator
        ? new Set<Permission>(PERMISSIONS)
        : evaluateChannelAccess({
            memberId: row.user_id,
            basePermissions: permissionArray(row.base_permissions),
            hasAdministrator: false,
            memberRoleIds: roles.map((role) => role.id),
            overrides: overrideArray(row.overrides)
          });
      if (!permissions.has("VIEW_CHANNEL")) continue;
      members.push({ id: row.user_id, login: row.login, roles });
    }
    return members;
  }

  async listVisibleChannels(principal: AccessPrincipal, executor: QueryExecutor = this.pool): Promise<VisibleChannelRow[]> {
    const channels = await this.listVisibleChannelsForUsers([principal.userId], executor);
    return channels.get(principal.userId) ?? [];
  }

  async listVisibleCategories(principal: AccessPrincipal, executor: QueryExecutor = this.pool): Promise<VisibleCategoryRow[]> {
    const categories = await this.listVisibleCategoriesForUsers([principal.userId], executor);
    return categories.get(principal.userId) ?? [];
  }

  async listVisibleCategoriesForUsers(
    userIds: string[],
    executor: QueryExecutor = this.pool
  ): Promise<Map<string, VisibleCategoryRow[]>> {
    const uniqueUserIds = [...new Set(userIds)];
    const categoriesByUser = new Map(uniqueUserIds.map((userId) => [userId, [] as VisibleCategoryRow[]]));
    if (uniqueUserIds.length === 0) return categoriesByUser;

    const [categories, visibleChannels, managers] = await Promise.all([
      executor.query<VisibleCategoryRow>(
        "SELECT id::text AS id, name, position FROM channel_categories ORDER BY position ASC, lower(name) ASC, id ASC"
      ),
      this.listVisibleChannelsForUsers(uniqueUserIds, executor),
      executor.query<{ id: string }>(
        `SELECT DISTINCT user_account.id::text AS id
         FROM users AS user_account
         LEFT JOIN user_roles AS assignment ON assignment.user_id = user_account.id
         LEFT JOIN roles AS role ON role.id = assignment.role_id
         WHERE user_account.id = ANY($1::uuid[])
           AND user_account.active = true
           AND (user_account.is_owner = true OR role.permissions ? 'MANAGE_CHANNELS' OR role.permissions ? 'ADMINISTRATOR')`,
        [uniqueUserIds]
      )
    ]);

    const managerIds = new Set(managers.rows.map((row) => row.id));
    for (const userId of uniqueUserIds) {
      const visibleCategoryIds = new Set(
        (visibleChannels.get(userId) ?? [])
          .map((channel) => channel.categoryId)
          .filter((categoryId): categoryId is string => categoryId !== null)
      );
      categoriesByUser.set(
        userId,
        categories.rows.filter((category) => managerIds.has(userId) || visibleCategoryIds.has(category.id))
      );
    }
    return categoriesByUser;
  }

  async unreadCountsByChannel(
    principal: AccessPrincipal
  ): Promise<Map<string, { unreadCount: number; lastReadSeq: number }>> {
    const visibleChannels = await this.listVisibleChannels(principal);
    const channelIds = visibleChannels.filter((channel) => channel.canView).map((channel) => channel.id);
    if (channelIds.length === 0) return new Map();

    const result = await this.pool.query<{ id: string; unread_count: number; last_read_seq: number }>(
      `SELECT c.id::text AS id,
              COALESCE(r.last_read_seq, 0)::int AS last_read_seq,
              (SELECT count(*)::int
               FROM messages AS m
               WHERE m.channel_id = c.id
                 AND m.seq > COALESCE(r.last_read_seq, 0)
                 AND m.deleted_at IS NULL
                 AND m.author_id <> $1) AS unread_count
       FROM channels AS c
       LEFT JOIN channel_reads AS r ON r.channel_id = c.id AND r.user_id = $1
       WHERE c.id = ANY($2::uuid[])`,
      [principal.userId, channelIds]
    );
    return new Map(result.rows.map((row) => [row.id, {
      unreadCount: row.unread_count,
      lastReadSeq: row.last_read_seq
    }]));
  }

  async listVisibleChannelsForUsers(
    userIds: string[],
    executor: QueryExecutor = this.pool
  ): Promise<Map<string, VisibleChannelRow[]>> {
    const uniqueUserIds = [...new Set(userIds)];
    const visibleByUser = new Map(uniqueUserIds.map((userId) => [userId, [] as VisibleChannelRow[]]));
    if (uniqueUserIds.length === 0) return visibleByUser;

    const channels = await executor.query<{
      id: string;
      name: string;
      category_id: string | null;
      description: string | null;
      visibility: "hidden" | "known";
    }>(
      "SELECT id::text AS id, name, category_id::text AS category_id, description, visibility FROM channels ORDER BY category_id NULLS FIRST, position ASC, lower(name) ASC, id ASC"
    );
    if (channels.rows.length === 0) return visibleByUser;

    const facts = await executor.query<VisibleChannelFactsRow>(
      `SELECT
         user_account.id::text AS user_id,
         channel.id::text AS channel_id,
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
           ) AS channel_overrides
         ), '[]'::jsonb) AS overrides
       FROM channels AS channel
       JOIN users AS user_account ON true
       WHERE user_account.id = ANY($1::uuid[])
         AND channel.id = ANY($2::uuid[])
       ORDER BY user_account.id, channel.category_id NULLS FIRST, channel.position ASC, lower(channel.name) ASC, channel.id ASC`,
      [uniqueUserIds, channels.rows.map((channel) => channel.id)]
    );

    const factsByUser = new Map<string, Map<string, VisibleChannelFactsRow>>();
    for (const row of facts.rows) {
      const byChannel = factsByUser.get(row.user_id) ?? new Map<string, VisibleChannelFactsRow>();
      byChannel.set(row.channel_id, row);
      factsByUser.set(row.user_id, byChannel);
    }

    for (const userId of uniqueUserIds) {
      const factsByChannel = factsByUser.get(userId);
      const visible: VisibleChannelRow[] = [];
      for (const channel of channels.rows) {
        const row = factsByChannel?.get(channel.id);
        if (!row) continue;
        const permissions = row.is_owner || row.has_administrator
          ? new Set<Permission>(PERMISSIONS)
          : evaluateChannelAccess({
              memberId: userId,
              basePermissions: permissionArray(row.base_permissions),
              hasAdministrator: false,
              memberRoleIds: stringArray(row.member_role_ids),
              overrides: overrideArray(row.overrides)
            });
        const readable = permissions.has("VIEW_CHANNEL");
        const known = !readable && channel.visibility === "known";
        if (!readable && !known) continue;
        visible.push({
          id: channel.id,
          name: channel.name,
          categoryId: channel.category_id,
          description: readable ? channel.description : null,
          visibility: channel.visibility,
          canView: readable,
          canSend: readable && permissions.has("SEND_MESSAGES"),
          canManageMessages: readable && permissions.has("MANAGE_MESSAGES"),
          ownerEditable: readable && (permissions.has("MANAGE_CHANNELS") || permissions.has("ADMINISTRATOR"))
        });
      }
      visibleByUser.set(userId, visible);
    }
    return visibleByUser;
  }

  async canReceiveChannelEvent(userId: string, channelId: string, event: string): Promise<boolean> {
    void event;
    const permissions = await this.channelPermissions(userId, channelId);
    return permissions?.has("VIEW_CHANNEL") === true;
  }

  async highestRoleOf(userId: string): Promise<number> {
    const result = await this.pool.query<{ highest_position: number }>(
      `SELECT COALESCE(MAX(role.position), 0)::integer AS highest_position
       FROM user_roles AS assignment
       JOIN roles AS role ON role.id = assignment.role_id
       WHERE assignment.user_id = $1
         AND role.system_key IS DISTINCT FROM 'everyone'`,
      [userId]
    );
    return result.rows[0]?.highest_position ?? 0;
  }

  private async channelPermissions(userId: string, channelId: string): Promise<Set<Permission> | null> {
    const result = await this.pool.query<ChannelAccessRow>(
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
    if (!row) return null;
    if (row.is_owner || row.has_administrator) return new Set(PERMISSIONS);

    const facts: AccessFacts = {
      memberId: userId,
      basePermissions: permissionArray(row.base_permissions),
      hasAdministrator: false,
      memberRoleIds: stringArray(row.member_role_ids),
      overrides: overrideArray(row.overrides)
    };
    return evaluateChannelAccess(facts);
  }
}
