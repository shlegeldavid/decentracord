import { HttpException } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { AccessService, findUserChannelAccessChanges, type UserChannelAccessChange } from "../access/access.service.js";
import { assertCanEditRolePermissions, canManageRole } from "../access/hierarchy.service.js";
import { isPermission, PERMISSIONS, type Permission } from "../access/permissions.js";
import { parseCreateRole, parseReorderRoles, parseUpdateRole, type RoleSummary } from "../auth/contracts.js";
import type { AuthPrincipal } from "../auth/session.service.js";
import { RealtimeGateway } from "../realtime/realtime.gateway.js";

interface RoleRow {
  id: string;
  name: string;
  position: number;
  permissions: unknown;
  system_key: string | null;
  color: string | null;
}

interface RoleListRow extends RoleRow {
  actor_highest: number;
}

interface ActorAccess {
  permissions: Set<Permission>;
  isOwner: boolean;
  highestRole: number;
}

interface UserAccessRow {
  is_owner: boolean;
  has_administrator: boolean;
  base_permissions: unknown;
}

function apiError(status: number, code: string, message: string): HttpException {
  return new HttpException({ code, message }, status);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function rolePermissions(value: unknown): Permission[] {
  let entries: unknown = value;
  if (typeof entries === "string") {
    try {
      entries = JSON.parse(entries) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(entries)) return [];
  const allowed = new Set(entries.filter(isPermission));
  return PERMISSIONS.filter((permission) => allowed.has(permission));
}

function roleSummary(row: RoleRow, canEdit: boolean): RoleSummary {
  return {
    id: row.id,
    name: row.name,
    position: row.position,
    permissions: rolePermissions(row.permissions),
    systemKey: row.system_key,
    ownerEditable: row.system_key !== null,
    color: row.color,
    editable: row.system_key === null && canEdit
  };
}

function auditRole(event: "create" | "update", actorUserId: string, roleId: string | null, outcome: string): void {
  try {
    process.stdout.write(`${JSON.stringify({
      event: `audit.role.${event}`,
      actorUserId,
      target: { type: "role", id: roleId },
      outcome
    })}\n`);
  } catch {
    // Audit output must not change the role management result.
  }
}

function auditRoleOrder(actorUserId: string, roleIds: string[], outcome: string): void {
  try {
    process.stdout.write(`${JSON.stringify({
      event: "audit.role.order",
      actorUserId,
      roleIds,
      outcome
    })}\n`);
  } catch {
    // Audit output must not change the role order result.
  }
}

function assertPermissionSubset(actor: ActorAccess, requested: Permission[]): void {
  if (actor.permissions.has("ADMINISTRATOR")) return;
  for (const permission of requested) {
    if (!actor.permissions.has(permission)) {
      throw apiError(403, "MISSING_PERMISSION", "Недостаточно прав");
    }
  }
}

export class RolesService {
  constructor(
    private readonly pool: Pool,
    private readonly access: AccessService,
    private readonly realtime: RealtimeGateway
  ) {}

  async list(principal: AuthPrincipal): Promise<RoleSummary[]> {
    await this.access.requirePermission(principal, "MANAGE_ROLES");
    const result = await this.pool.query<RoleListRow>(
      "WITH actor AS (" +
        "SELECT COALESCE(MAX(actor_role.position), 0)::integer AS highest_position " +
        "FROM user_roles AS assignment " +
        "JOIN roles AS actor_role ON actor_role.id = assignment.role_id " +
        "WHERE assignment.user_id = $1 AND actor_role.system_key IS DISTINCT FROM 'everyone'" +
      ") " +
      "SELECT role.id, role.name, role.position, role.permissions, role.system_key, role.color, " +
        "actor.highest_position AS actor_highest " +
      "FROM roles AS role CROSS JOIN actor " +
      "ORDER BY role.position DESC, role.name ASC, role.id ASC",
      [principal.userId]
    );
    return result.rows.map((row) => roleSummary(row, canManageRole(row.actor_highest, row.position)));
  }

  async create(principal: AuthPrincipal, body: unknown): Promise<RoleSummary> {
    const input = parseCreateRole(body);
    if (!input) throw apiError(400, "INVALID_REQUEST", "Проверьте название роли и разрешения");
    await this.access.requirePermission(principal, "MANAGE_ROLES");

    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(21471, 901)");
      const actor = await this.readActorAccess(client, principal);
      if (input.permissions.includes("ADMINISTRATOR") && !actor.isOwner) {
        throw apiError(403, "FORBIDDEN", "Недостаточно прав");
      }
      // Check the delegation boundary before hierarchy so unsupported grants are reported consistently.
      assertPermissionSubset(actor, input.permissions);

      const positionResult = await client.query<{ max_position: number }>(
        "SELECT COALESCE(MAX(position), 0)::integer AS max_position FROM roles WHERE system_key IS NULL"
      );
      const position = (positionResult.rows[0]?.max_position ?? 0) + 1;
      if (position >= 1_000_000) throw apiError(409, "ROLE_POSITION_LIMIT", "Не осталось места для новой роли");
      assertCanEditRolePermissions({
        actorPermissions: actor.permissions,
        actorHighest: actor.highestRole,
        targetPosition: position,
        requested: input.permissions
      });

      const inserted = await client.query<RoleRow>(
        "INSERT INTO roles (system_key, name, position, permissions, color) VALUES (NULL, $1, $2, $3::jsonb, $4) RETURNING id, name, position, permissions, system_key, color",
        [input.name, position, JSON.stringify(input.permissions), input.color]
      );
      const role = inserted.rows[0];
      if (!role) throw new Error("Role was not created");
      await client.query("COMMIT");
      auditRole("create", principal.userId, role.id, "created");
      return roleSummary(role, canManageRole(actor.highestRole, role.position));
    } catch (error) {
      await client?.query("ROLLBACK").catch(() => undefined);
      if (hasErrorCode(error, "23505")) {
        auditRole("create", principal.userId, null, "conflict");
        throw apiError(409, "ROLE_ALREADY_EXISTS", "Роль с таким названием уже существует");
      }
      auditRole("create", principal.userId, null, "failed");
      throw error;
    } finally {
      client?.release();
    }
  }

  async update(principal: AuthPrincipal, roleId: string, body: unknown): Promise<RoleSummary> {
    if (!isUuid(roleId)) throw apiError(400, "INVALID_REQUEST", "Некорректный идентификатор роли");
    const input = parseUpdateRole(body);
    if (!input) throw apiError(400, "INVALID_REQUEST", "Проверьте название роли и разрешения");
    await this.access.requirePermission(principal, "MANAGE_ROLES");
    const currentRole = await this.pool.query<{ system_key: string | null }>(
      "SELECT system_key FROM roles WHERE id = $1",
      [roleId]
    );
    if (!currentRole.rows[0]) throw apiError(404, "ROLE_NOT_FOUND", "Роль не найдена");
    if (currentRole.rows[0].system_key !== null) await this.access.requireOwner(principal);

    let client: PoolClient | undefined;
    let result: RoleSummary | undefined;
    let accessChanges: UserChannelAccessChange[] = [];
    try {
      client = await this.pool.connect();
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(21471, 901)");
      const actor = await this.readActorAccess(client, principal);
      const locked = await client.query<RoleRow>(
        "SELECT id, name, position, permissions, system_key, color FROM roles WHERE id = $1 FOR UPDATE",
        [roleId]
      );
      const role = locked.rows[0];
      if (!role) throw apiError(404, "ROLE_NOT_FOUND", "Роль не найдена");

      if (role.system_key !== null && !actor.isOwner) throw apiError(403, "FORBIDDEN", "Недостаточно прав");
      if (input.permissions?.includes("ADMINISTRATOR") && !actor.isOwner) {
        throw apiError(403, "FORBIDDEN", "Недостаточно прав");
      }

      const requested = input.permissions ?? [];
      const hierarchyHighest = actor.isOwner && role.system_key === "administrator"
        ? Math.max(actor.highestRole, role.position + 1)
        : actor.highestRole;
      assertCanEditRolePermissions({
        actorPermissions: actor.permissions,
        actorHighest: hierarchyHighest,
        targetPosition: role.position,
        requested
      });

      const affectedUserIds = input.permissions ? await this.activeUsersForRole(client, role) : [];
      const previousChannels = input.permissions
        ? await this.access.listVisibleChannelsForUsers(affectedUserIds, client)
        : new Map();

      if (
        input.permissions &&
        rolePermissions(role.permissions).includes("ADMINISTRATOR") &&
        !input.permissions.includes("ADMINISTRATOR")
      ) {
        await this.assertAdministratorWillRemain(client, role.id);
      }

      const values: Array<string | null> = [];
      const fields: string[] = [];
      if (input.name !== undefined) {
        values.push(input.name);
        fields.push(`name = $${values.length}`);
      }
      if (input.permissions !== undefined) {
        values.push(JSON.stringify(input.permissions));
        fields.push(`permissions = $${values.length}::jsonb`);
      }
      if (input.color !== undefined) {
        values.push(input.color);
        fields.push(`color = $${values.length}`);
      }
      values.push(role.id);
      const updated = await client.query<RoleRow>(
        "UPDATE roles SET " + fields.join(", ") + ", updated_at = now() WHERE id = $" + values.length +
          " RETURNING id, name, position, permissions, system_key, color",
        values
      );
      const updatedRole = updated.rows[0];
      if (!updatedRole) throw apiError(409, "ROLE_CHANGED", "Роль изменилась, повторите запрос");
      if (input.permissions) {
        const currentChannels = await this.access.listVisibleChannelsForUsers(affectedUserIds, client);
        accessChanges = findUserChannelAccessChanges(previousChannels, currentChannels);
      }
      await client.query("COMMIT");
      auditRole("update", principal.userId, role.id, "updated");
      result = roleSummary(updatedRole, canManageRole(hierarchyHighest, role.position));
    } catch (error) {
      await client?.query("ROLLBACK").catch(() => undefined);
      if (hasErrorCode(error, "23505")) {
        auditRole("update", principal.userId, roleId, "conflict");
        throw apiError(409, "ROLE_ALREADY_EXISTS", "Роль с таким названием уже существует");
      }
      auditRole("update", principal.userId, roleId, "failed");
      throw error;
    } finally {
      client?.release();
    }

    if (accessChanges.length > 0) {
      try {
        await this.realtime.notifyUsersChannelsChanged(accessChanges);
      } catch {
        auditRole("update", principal.userId, roleId, "realtime_notification_failed");
      }
    }
    if (!result) throw new Error("Role update returned no result");
    return result;
  }

  private async activeUsersForRole(client: PoolClient, role: RoleRow): Promise<string[]> {
    const users = role.system_key === "everyone"
      ? await client.query<{ id: string }>("SELECT id::text AS id FROM users WHERE active = true ORDER BY id")
      : await client.query<{ id: string }>(
          `SELECT user_account.id::text AS id
           FROM users AS user_account
           JOIN user_roles AS assignment ON assignment.user_id = user_account.id
           WHERE user_account.active = true AND assignment.role_id = $1
           ORDER BY user_account.id`,
          [role.id]
        );
    return users.rows.map((row) => row.id);
  }

  async reorder(principal: AuthPrincipal, body: unknown): Promise<void> {
    const input = parseReorderRoles(body);
    if (!input) throw apiError(400, "INVALID_REQUEST", "Некорректный порядок ролей");
    await this.access.requirePermission(principal, "MANAGE_ROLES");

    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(21471, 901)");
      const actor = await this.readActorAccess(client, principal);
      const result = await client.query<RoleRow>(
        "SELECT id, name, position, permissions, system_key, color FROM roles WHERE system_key IS NULL ORDER BY position ASC, id ASC FOR UPDATE"
      );
      const roles = result.rows;
      const roleById = new Map(roles.map((role) => [role.id, role]));
      const requested = input.roleIds;
      if (
        new Set(requested).size !== requested.length ||
        requested.some((id) => !isUuid(id) || !roleById.has(id))
      ) {
        throw apiError(400, "INVALID_REQUEST", "Порядок может содержать только уникальные пользовательские роли");
      }

      const requestedSet = new Set(requested);
      const orderedIds = [...requested, ...roles.filter((role) => !requestedSet.has(role.id)).map((role) => role.id)];
      if (orderedIds.length >= 1_000_000) throw apiError(409, "ROLE_POSITION_LIMIT", "Слишком много ролей для перестановки");

      for (const [index, id] of orderedIds.entries()) {
        const role = roleById.get(id);
        if (!role) continue;
        const nextPosition = index + 1;
        if (
          !actor.isOwner &&
          role.position !== nextPosition &&
          (!canManageRole(actor.highestRole, role.position) || !canManageRole(actor.highestRole, nextPosition))
        ) {
          throw apiError(403, "HIERARCHY", "Недостаточно прав");
        }
      }

      for (const [index, id] of orderedIds.entries()) {
        const position = index + 1;
        const role = roleById.get(id);
        if (!role || role.position === position) continue;
        await client.query("UPDATE roles SET position = $1, updated_at = now() WHERE id = $2", [position, id]);
      }
      await client.query("COMMIT");
      auditRoleOrder(principal.userId, requested, "updated");
    } catch (error) {
      await client?.query("ROLLBACK").catch(() => undefined);
      auditRoleOrder(principal.userId, [], "failed");
      throw error;
    } finally {
      client?.release();
    }
  }

  private async readActorAccess(client: PoolClient, principal: AuthPrincipal): Promise<ActorAccess> {
    const result = await client.query<UserAccessRow>(
      `SELECT
         user_account.is_owner,
         COALESCE(bool_or(permission.permission = 'ADMINISTRATOR'), false) AS has_administrator,
         COALESCE(
           jsonb_agg(DISTINCT permission.permission) FILTER (WHERE permission.permission IS NOT NULL),
           '[]'::jsonb
         ) AS base_permissions
       FROM users AS user_account
       LEFT JOIN user_roles AS assignment ON assignment.user_id = user_account.id
       LEFT JOIN roles AS base_role
         ON base_role.system_key = 'everyone' OR base_role.id = assignment.role_id
       LEFT JOIN LATERAL jsonb_array_elements_text(base_role.permissions) AS permission(permission) ON true
       WHERE user_account.id = $1
       GROUP BY user_account.id, user_account.is_owner`,
      [principal.userId]
    );
    const row = result.rows[0];
    if (!row) throw apiError(403, "FORBIDDEN", "Недостаточно прав");
    const permissions = row.is_owner || row.has_administrator ? [...PERMISSIONS] : rolePermissions(row.base_permissions);
    if (!permissions.includes("MANAGE_ROLES")) {
      throw apiError(403, "FORBIDDEN", "Недостаточно прав");
    }
    const highestRole = await client.query<{ highest_position: number }>(
      `SELECT COALESCE(MAX(role.position), 0)::integer AS highest_position
       FROM user_roles AS assignment
       JOIN roles AS role ON role.id = assignment.role_id
       WHERE assignment.user_id = $1
         AND role.system_key IS DISTINCT FROM 'everyone'`,
      [principal.userId]
    );
    return {
      permissions: new Set(permissions),
      isOwner: row.is_owner,
      highestRole: highestRole.rows[0]?.highest_position ?? 0
    };
  }

  private async assertAdministratorWillRemain(client: PoolClient, roleId: string): Promise<void> {
    const result = await client.query<{ has_members: boolean; has_remaining_admin: boolean }>(
      `SELECT
         EXISTS (SELECT 1 FROM user_roles WHERE role_id = $1) AS has_members,
         EXISTS (
           SELECT 1
           FROM users AS user_account
           WHERE user_account.active = true
             AND (
               user_account.is_owner = true
               OR EXISTS (
                 SELECT 1
                 FROM user_roles AS assignment
                 JOIN roles AS other_role ON other_role.id = assignment.role_id
                 WHERE assignment.user_id = user_account.id
                   AND other_role.id <> $1
                   AND other_role.permissions @> '["ADMINISTRATOR"]'::jsonb
               )
             )
         ) AS has_remaining_admin`,
      [roleId]
    );
    const state = result.rows[0];
    if (state?.has_members && !state.has_remaining_admin) {
      throw apiError(409, "LAST_ADMINISTRATOR", "Нельзя оставить установку без администратора");
    }
  }
}
