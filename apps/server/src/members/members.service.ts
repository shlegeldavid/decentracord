import { HttpException } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { AccessService, findUserChannelAccessChanges, type UserChannelAccessChange } from "../access/access.service.js";
import { assertCanGrantRoles, canActOnMember } from "../access/hierarchy.service.js";
import { isPermission, PERMISSIONS, type Permission } from "../access/permissions.js";
import { AuthorizationService } from "../auth/authorization.service.js";
import { parseCreateMember, parseMemberRoleIds, parseResetMemberPassword, type MemberSummary, type MemberWithRoles } from "../auth/contracts.js";
import { PasswordService } from "../auth/password.service.js";
import { SessionRevocationService } from "../auth/session-revocation.service.js";
import type { AuthPrincipal, SessionService } from "../auth/session.service.js";
import { RealtimeGateway } from "../realtime/realtime.gateway.js";

interface MemberRow {
  id: string;
  login: string;
  active: boolean;
}

interface MemberListRow extends MemberRow {
  role_ids: unknown;
  role_names: unknown;
}

interface LockedMemberRow extends MemberRow {
  auth_version: number;
  is_owner: boolean;
}

interface RoleRow {
  id: string;
  name: string;
  position: number;
  permissions: unknown;
  system_key: string | null;
}

interface ActorAccess {
  permissions: Set<Permission>;
  isOwner: boolean;
  highestRole: number;
}

export interface PersonSearchRole {
  id: string;
  name: string;
  color: string | null;
}

export interface PersonSearchChannel {
  id: string;
  name: string;
}

export interface PersonSearchResult {
  id: string;
  login: string;
  roles: PersonSearchRole[];
  commonChannels: PersonSearchChannel[];
  presence: "online" | "offline";
}

export interface PersonSearchResponse {
  results: PersonSearchResult[];
  truncated: boolean;
}

interface UserAccessRow {
  is_owner: boolean;
  has_administrator: boolean;
  base_permissions: unknown;
}

function apiError(status: number, code: string, message: string): HttpException {
  return new HttpException({ code, message }, status);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function rolePermissions(value: unknown): Permission[] {
  let entries = value;
  if (typeof entries === "string") {
    try {
      entries = JSON.parse(entries) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(entries)) return [];
  const permissions = new Set(entries.filter(isPermission));
  return PERMISSIONS.filter((permission) => permissions.has(permission));
}

function stringArray(value: unknown): string[] {
  let entries = value;
  if (typeof entries === "string") {
    try {
      entries = JSON.parse(entries) as unknown;
    } catch {
      return [];
    }
  }
  return Array.isArray(entries) ? entries.filter((entry): entry is string => typeof entry === "string") : [];
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Roles of a searched participant: every assigned role except the `@everyone` system role. */
function personSearchRoles(value: unknown): PersonSearchRole[] {
  const roles: PersonSearchRole[] = [];
  for (const entry of jsonArray(value)) {
    if (!isRecord(entry)) continue;
    if (typeof entry.id !== "string" || typeof entry.name !== "string") continue;
    roles.push({
      id: entry.id,
      name: entry.name,
      color: typeof entry.color === "string" ? entry.color : null
    });
  }
  return roles;
}

function auditMemberCreation(
  actorUserId: string,
  targetUserId: string | null,
  targetLogin: string | null,
  outcome: string
): void {
  try {
    process.stdout.write(`${JSON.stringify({
      event: "audit.member.create",
      actorUserId,
      target: { type: "user", id: targetUserId, login: targetLogin },
      outcome
    })}\n`);
  } catch {
    // An audit output failure must not change the authorization or write result.
  }
}

function auditMemberAccess(actorUserId: string, targetUserId: string, action: "reset-password" | "disable", outcome: string): void {
  try {
    process.stdout.write(`${JSON.stringify({
      event: `audit.member.${action}`,
      actorUserId,
      targetUserId,
      outcome
    })}\n`);
  } catch {
    // Audit output must not change the authorization or access-management result.
  }
}

function auditRoleAssignment(actorUserId: string, targetUserId: string | null, roleIds: string[], outcome: string): void {
  try {
    process.stdout.write(`${JSON.stringify({
      event: "audit.role.assign",
      actorUserId,
      targetUserId,
      roleIds,
      outcome
    })}\n`);
  } catch {
    // Audit output must not change the role assignment result.
  }
}

async function isAdministrator(client: Pick<PoolClient, "query">, userId: string): Promise<boolean> {
  const result = await client.query<{ allowed: boolean }>(
    `SELECT user_account.is_owner OR EXISTS (
       SELECT 1
       FROM user_roles AS user_role
       JOIN roles AS role ON role.id = user_role.role_id
       WHERE user_role.user_id = $1
         AND role.permissions @> '["ADMINISTRATOR"]'::jsonb
     ) AS allowed
     FROM users AS user_account
     WHERE user_account.id = $1`,
    [userId]
  );
  return result.rows[0]?.allowed === true;
}

/** Serializes administrator disable decisions and prevents removing the final active administrator. */
export async function assertAdministratorWillRemain(
  client: Pick<PoolClient, "query">,
  targetUserId: string
): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(21471, 901)");
  const result = await client.query<{ id: string }>(
    `SELECT target.id
     FROM users AS target
     WHERE target.id <> $1
       AND target.active = true
       AND (
         target.is_owner = true
         OR EXISTS (
           SELECT 1
           FROM user_roles AS user_role
           JOIN roles AS role ON role.id = user_role.role_id
           WHERE user_role.user_id = target.id
             AND role.permissions @> '["ADMINISTRATOR"]'::jsonb
         )
       )
     ORDER BY target.id
     FOR UPDATE OF target`,
    [targetUserId]
  );
  if (result.rows.length < 1) {
    throw apiError(409, "LAST_ADMINISTRATOR", "Нельзя оставить установку без администратора");
  }
}

export class MembersService {
  constructor(
    private readonly pool: Pool,
    private readonly authorization: AuthorizationService,
    private readonly passwords: PasswordService,
    private readonly revocations: SessionRevocationService,
    private readonly sessions: SessionService,
    private readonly access: AccessService,
    private readonly realtime: RealtimeGateway
  ) {}

  async list(principal: AuthPrincipal): Promise<MemberWithRoles[]> {
    await this.access.requirePermission(principal, "MANAGE_ROLES");
    const result = await this.pool.query<MemberListRow>(
      `SELECT user_account.id, user_account.login, user_account.active,
         COALESCE(
           jsonb_agg(role.id::text ORDER BY role.position, role.id) FILTER (WHERE role.id IS NOT NULL),
           '[]'::jsonb
         ) AS role_ids,
         COALESCE(
           jsonb_agg(role.name ORDER BY role.position, role.id) FILTER (WHERE role.id IS NOT NULL),
           '[]'::jsonb
         ) AS role_names
       FROM users AS user_account
       LEFT JOIN user_roles AS assignment ON assignment.user_id = user_account.id
       LEFT JOIN roles AS role
         ON role.id = assignment.role_id
        AND role.system_key IS DISTINCT FROM 'everyone'
       GROUP BY user_account.id
       ORDER BY user_account.login_normalized, user_account.id`
    );
    return result.rows.map(({ id, login, active, role_ids, role_names }) => ({
      id,
      login,
      active,
      roleIds: stringArray(role_ids),
      roleNames: stringArray(role_names)
    }));
  }

  /**
   * Prefix search over member logins.
   *
   * The search is open to every signed-in member, so it requires no
   * management permission. Matching uses `starts_with` on `login_normalized`:
   * `LIKE` would treat `_` as a single-character wildcard, so `a_b` would
   * wrongly match `axb`.
   */
  async searchPeople(principal: AuthPrincipal, rawQuery: unknown): Promise<PersonSearchResponse> {
    if (typeof rawQuery !== "string") {
      throw apiError(400, "INVALID_REQUEST", "Некорректный поисковый запрос");
    }
    const query = rawQuery.trim();
    if (query.length === 0) {
      return { results: [], truncated: false };
    }
    if (query.length > 64) {
      throw apiError(400, "INVALID_REQUEST", "Некорректный поисковый запрос");
    }

    // `login_normalized` is always lower case, so the prefix is lower cased as well.
    const prefix = query.toLowerCase();
    // Запрашивается на строку больше, чем отдаётся: так «список обрезан»
    // отличается от «совпало ровно столько-то людей».
    const peopleLimit = 25;
    const found = await this.pool.query<{ id: string; login: string; roles: unknown }>(
      `SELECT u.id::text AS id,
         u.login,
         COALESCE(
           (
             SELECT jsonb_agg(
               jsonb_build_object(
                 'id', member_role.id::text,
                 'name', member_role.name,
                 'color', member_role.color
               )
               ORDER BY member_role.position DESC, member_role.id ASC
             )
             FROM user_roles AS role_assignment
             JOIN roles AS member_role
               ON member_role.id = role_assignment.role_id
              AND member_role.system_key IS DISTINCT FROM 'everyone'
             WHERE role_assignment.user_id = u.id
           ),
           '[]'::jsonb
         ) AS roles
       FROM users AS u
       WHERE u.active = true
         AND u.id <> $2
         AND starts_with(u.login_normalized, $1)
       ORDER BY (u.login_normalized = $3) DESC, u.login_normalized ASC
       LIMIT ${peopleLimit + 1}`,
      [prefix, principal.userId, prefix]
    );

    const truncated = found.rows.length > peopleLimit;
    const foundRows = truncated ? found.rows.slice(0, peopleLimit) : found.rows;
    const foundUserIds = foundRows.map((row) => row.id);
    // Common channels come from the shared access engine, never from a second
    // copy of the permission rules.
    const visibleByUser = await this.access.listVisibleChannelsForUsers([principal.userId, ...foundUserIds]);
    const searcherChannelIds = new Set(
      (visibleByUser.get(principal.userId) ?? [])
        .filter((channel) => channel.canView)
        .map((channel) => channel.id)
    );
    const onlineUserIds = this.realtime.onlineUserIds();

    const results: PersonSearchResult[] = foundRows.map((row) => ({
      id: row.id,
      login: row.login,
      roles: personSearchRoles(row.roles),
      commonChannels: (visibleByUser.get(row.id) ?? [])
        .filter((channel) => channel.canView && searcherChannelIds.has(channel.id))
        .map((channel) => ({ id: channel.id, name: channel.name })),
      presence: onlineUserIds.has(row.id) ? "online" : "offline"
    }));
    return { results, truncated };
  }

  async create(principal: AuthPrincipal, body: unknown): Promise<MemberSummary> {
    try {
      await this.access.requirePermission(principal, "MANAGE_ROLES");
    } catch (error) {
      auditMemberCreation(principal.userId, null, null, "forbidden");
      throw error;
    }
    const input = parseCreateMember(body);
    if (!input) {
      auditMemberCreation(principal.userId, null, null, "invalid_request");
      throw apiError(400, "INVALID_REQUEST", "Проверьте логин и пароль");
    }

    let passwordHash: string;
    try {
      passwordHash = await this.passwords.hash(input.password);
    } catch (error) {
      auditMemberCreation(principal.userId, null, input.login, "failed");
      throw error;
    }

    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(21471, 901)");
      const everyoneRole = await client.query<{ id: string }>(
        "SELECT id FROM roles WHERE system_key = 'everyone' FOR SHARE"
      );
      const everyoneRoleId = everyoneRole.rows[0]?.id;
      if (!everyoneRoleId) throw new Error("Required system role is missing");

      const requestedIds = input.roleIds;
      const rolesResult = await client.query<RoleRow>(
        "SELECT id, name, position, permissions, system_key FROM roles WHERE id = ANY($1::uuid[]) ORDER BY position, id FOR SHARE",
        [requestedIds]
      );
      const roleById = new Map(rolesResult.rows.map((role) => [role.id, role]));
      if (requestedIds.some((roleId) => !roleById.has(roleId))) {
        throw apiError(404, "ROLE_NOT_FOUND", "Роль не найдена");
      }
      const assignedRoleIds = requestedIds.filter((roleId) => roleId !== everyoneRoleId);
      const actor = await this.readActorAccess(client, principal);

      const created = await client.query<MemberRow>(
        "INSERT INTO users (login, login_normalized, password_hash) VALUES ($1, $1, $2) RETURNING id, login, active",
        [input.login, passwordHash]
      );
      const member = created.rows[0];
      if (!member) throw new Error("Member was not created");
      const requestedRoles = rolesResult.rows.map((role) => ({
        id: role.id,
        position: role.position,
        permissions: rolePermissions(role.permissions)
      }));
      if (!actor.isOwner && requestedRoles.some((role) => role.permissions.includes("ADMINISTRATOR"))) {
        throw apiError(403, "FORBIDDEN", "Недостаточно прав");
      }
      assertCanGrantRoles({
        actorPermissions: actor.permissions,
        actorHighest: actor.isOwner ? Number.MAX_SAFE_INTEGER : actor.highestRole,
        actorIsOwner: actor.isOwner,
        requestedRoleIds: assignedRoleIds,
        actorUserId: principal.userId,
        targetUserId: member.id,
        roles: requestedRoles
      });
      for (const roleId of [everyoneRoleId, ...assignedRoleIds]) {
        await client.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)", [member.id, roleId]);
      }
      await client.query("COMMIT");
      auditMemberCreation(principal.userId, member.id, member.login, "created");
      return { id: member.id, login: member.login, active: member.active };
    } catch (error) {
      await client?.query("ROLLBACK").catch(() => undefined);
      if (hasErrorCode(error, "23505")) {
        auditMemberCreation(principal.userId, null, input.login, "conflict");
        throw apiError(409, "LOGIN_ALREADY_EXISTS", "Участник с таким логином уже существует");
      }
      auditMemberCreation(principal.userId, null, input.login, "failed");
      throw error;
    } finally {
      client?.release();
    }
  }

  async setRoles(principal: AuthPrincipal, targetUserId: string, body: unknown): Promise<void> {
    await this.access.requirePermission(principal, "MANAGE_ROLES");
    if (!isUuid(targetUserId)) {
      auditRoleAssignment(principal.userId, null, [], "invalid_request");
      throw apiError(400, "INVALID_REQUEST", "Некорректный идентификатор участника");
    }
    const requested = parseMemberRoleIds(body);
    if (!requested) {
      auditRoleAssignment(principal.userId, targetUserId, [], "invalid_request");
      throw apiError(400, "INVALID_REQUEST", "Некорректный набор ролей");
    }

    let client: PoolClient | undefined;
    let accessChanges: UserChannelAccessChange[] = [];
    try {
      client = await this.pool.connect();
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(21471, 901)");
      const locked = await client.query<LockedMemberRow>(
        "SELECT id, login, active, 0 AS auth_version, is_owner FROM users WHERE id = $1 FOR UPDATE",
        [targetUserId]
      );
      const target = locked.rows[0];
      if (!target) throw apiError(404, "MEMBER_NOT_FOUND", "Участник не найден");
      if (target.is_owner) throw apiError(403, "FORBIDDEN", "Владельца установки нельзя лишить ролей");

      const everyoneResult = await client.query<{ id: string }>(
        "SELECT id FROM roles WHERE system_key = 'everyone' FOR SHARE"
      );
      const everyoneRoleId = everyoneResult.rows[0]?.id;
      if (!everyoneRoleId) throw new Error("Required system role is missing");

      const currentRolesResult = await client.query<RoleRow>(
        `SELECT role.id, role.name, role.position, role.permissions, role.system_key
         FROM user_roles AS assignment
         JOIN roles AS role ON role.id = assignment.role_id
         WHERE assignment.user_id = $1
         ORDER BY role.position, role.id
         FOR SHARE OF role`,
        [targetUserId]
      );
      const currentRoles = currentRolesResult.rows.filter((role) => role.system_key !== "everyone");
      const targetHighest = currentRoles.reduce((highest, role) => Math.max(highest, role.position), 0);
      const actor = await this.readActorAccess(client, principal);
      if (!actor.isOwner && !canActOnMember(actor.highestRole, targetHighest)) {
        throw apiError(403, "HIERARCHY", "Недостаточно прав");
      }

      const rolesResult = await client.query<RoleRow>(
        "SELECT id, name, position, permissions, system_key FROM roles WHERE id = ANY($1::uuid[]) ORDER BY position, id FOR SHARE",
        [requested]
      );
      const roleById = new Map(rolesResult.rows.map((role) => [role.id, role]));
      if (requested.some((roleId) => !roleById.has(roleId))) {
        throw apiError(404, "ROLE_NOT_FOUND", "Роль не найдена");
      }
      const assignedRoleIds = requested.filter((roleId) => roleId !== everyoneRoleId);
      const requestedRoles = rolesResult.rows.map((role) => ({
        id: role.id,
        position: role.position,
        permissions: rolePermissions(role.permissions)
      }));
      if (!actor.isOwner && requestedRoles.some((role) => role.permissions.includes("ADMINISTRATOR"))) {
        throw apiError(403, "FORBIDDEN", "Недостаточно прав");
      }
      assertCanGrantRoles({
        actorPermissions: actor.permissions,
        actorHighest: actor.isOwner ? Number.MAX_SAFE_INTEGER : actor.highestRole,
        actorIsOwner: actor.isOwner,
        requestedRoleIds: assignedRoleIds,
        actorUserId: principal.userId,
        targetUserId,
        roles: requestedRoles
      });

      const targetCurrentlyAdministrator = currentRoles.some((role) => rolePermissions(role.permissions).includes("ADMINISTRATOR"));
      const targetWillRemainAdministrator = assignedRoleIds.some((roleId) => {
        const role = roleById.get(roleId);
        return role ? rolePermissions(role.permissions).includes("ADMINISTRATOR") : false;
      });
      if (targetCurrentlyAdministrator && !targetWillRemainAdministrator) {
        await assertAdministratorWillRemain(client, targetUserId);
      }

      const previousChannels = target.active
        ? await this.access.listVisibleChannelsForUsers([targetUserId], client)
        : new Map();

      await client.query(
        "DELETE FROM user_roles WHERE user_id = $1 AND role_id <> $2",
        [targetUserId, everyoneRoleId]
      );
      await client.query(
        "INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT (user_id, role_id) DO NOTHING",
        [targetUserId, everyoneRoleId]
      );
      for (const roleId of assignedRoleIds) {
        await client.query(
          "INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)",
          [targetUserId, roleId]
        );
      }
      if (target.active) {
        const currentChannels = await this.access.listVisibleChannelsForUsers([targetUserId], client);
        accessChanges = findUserChannelAccessChanges(previousChannels, currentChannels);
      }
      await client.query("COMMIT");
      auditRoleAssignment(principal.userId, targetUserId, assignedRoleIds, "assigned");
    } catch (error) {
      await client?.query("ROLLBACK").catch(() => undefined);
      auditRoleAssignment(principal.userId, targetUserId, requested, "failed");
      throw error;
    } finally {
      client?.release();
    }

    if (accessChanges.length > 0) {
      try {
        await this.realtime.notifyUsersChannelsChanged(accessChanges);
      } catch {
        auditRoleAssignment(principal.userId, targetUserId, requested, "realtime_notification_failed");
      }
    }
  }

  async resetPassword(principal: AuthPrincipal, targetUserId: string, body: unknown): Promise<void> {
    try {
      await this.authorization.requireAdministrator(principal);
    } catch (error) {
      auditMemberAccess(principal.userId, isUuid(targetUserId) ? targetUserId : "invalid-target", "reset-password", "forbidden");
      throw error;
    }
    if (!isUuid(targetUserId)) {
      auditMemberAccess(principal.userId, "invalid-target", "reset-password", "invalid_request");
      throw apiError(400, "INVALID_REQUEST", "Некорректный идентификатор участника");
    }
    if (targetUserId === principal.userId) {
      auditMemberAccess(principal.userId, targetUserId, "reset-password", "self_conflict");
      throw apiError(409, "SELF_PASSWORD_RESET", "Нельзя сбросить собственный пароль здесь");
    }
    const input = parseResetMemberPassword(body);
    if (!input) {
      auditMemberAccess(principal.userId, targetUserId, "reset-password", "invalid_request");
      throw apiError(400, "INVALID_REQUEST", "Проверьте новый пароль");
    }

    try {
      await this.revocations.revokeAllSessionsForUser(targetUserId, async () => {
        const client = await this.pool.connect();
        try {
          await client.query("BEGIN");
          const locked = await client.query<LockedMemberRow>(
            "SELECT id, login, active, auth_version FROM users WHERE id = $1 FOR UPDATE",
            [targetUserId]
          );
          const member = locked.rows[0];
          if (!member) throw apiError(404, "MEMBER_NOT_FOUND", "Участник не найден");
          if (!member.active) throw apiError(409, "MEMBER_DISABLED", "Нельзя сбросить пароль отключённого участника");
          if (await isAdministrator(client, targetUserId)) {
            throw apiError(403, "FORBIDDEN", "Нельзя сбросить пароль администратора");
          }

          const passwordHash = await this.passwords.hash(input.newPassword);
          const updated = await client.query<{ id: string }>(
            `UPDATE users
             SET password_hash = $1, auth_version = auth_version + 1, updated_at = now()
             WHERE id = $2 AND active = true AND auth_version = $3
             RETURNING id`,
            [passwordHash, targetUserId, member.auth_version]
          );
          if (updated.rowCount !== 1) throw apiError(409, "MEMBER_CHANGED", "Учётная запись изменилась, повторите запрос");
          await this.sessions.revokeAllSessionsInTransaction(client, targetUserId);
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      });
      auditMemberAccess(principal.userId, targetUserId, "reset-password", "completed");
    } catch (error) {
      auditMemberAccess(principal.userId, targetUserId, "reset-password", "failed");
      throw error;
    }
  }

  async disable(principal: AuthPrincipal, targetUserId: string): Promise<void> {
    try {
      await this.authorization.requireAdministrator(principal);
    } catch (error) {
      auditMemberAccess(principal.userId, isUuid(targetUserId) ? targetUserId : "invalid-target", "disable", "forbidden");
      throw error;
    }
    if (!isUuid(targetUserId)) {
      auditMemberAccess(principal.userId, "invalid-target", "disable", "invalid_request");
      throw apiError(400, "INVALID_REQUEST", "Некорректный идентификатор участника");
    }
    if (targetUserId === principal.userId) {
      auditMemberAccess(principal.userId, targetUserId, "disable", "self_conflict");
      throw apiError(409, "SELF_DISABLE", "Нельзя отключить собственную учётную запись");
    }

    try {
      // Соучастники отключённого собираются внутри транзакции отключения: при
      // пуле max: 1 отдельный запрос до COMMIT заблокировал бы сам себя.
      const peerIds: string[] = [];
      await this.revocations.revokeAllSessionsForUser(targetUserId, async () => {
        const client = await this.pool.connect();
        try {
          await client.query("BEGIN");
          await client.query("SELECT pg_advisory_xact_lock(21471, 901)");
          const locked = await client.query<LockedMemberRow>(
            "SELECT id, login, active, auth_version, is_owner FROM users WHERE id = $1 FOR UPDATE",
            [targetUserId]
          );
          const member = locked.rows[0];
          if (!member) throw apiError(404, "MEMBER_NOT_FOUND", "Участник не найден");
          if (member.is_owner) throw apiError(403, "FORBIDDEN", "Владельца установки нельзя отключить");
          if (!member.active) {
            await client.query("COMMIT");
            return;
          }
          if (await isAdministrator(client, targetUserId)) {
            await assertAdministratorWillRemain(client, targetUserId);
            throw apiError(403, "FORBIDDEN", "Нельзя отключить другую учётную запись администратора");
          }

          const updated = await client.query<{ id: string }>(
            `UPDATE users
             SET active = false, auth_version = auth_version + 1, updated_at = now()
             WHERE id = $1 AND active = true AND auth_version = $2
             RETURNING id`,
            [targetUserId, member.auth_version]
          );
          if (updated.rowCount !== 1) throw apiError(409, "MEMBER_CHANGED", "Учётная запись изменилась, повторите запрос");
          await this.sessions.revokeAllSessionsInTransaction(client, targetUserId);
          // Переписки, в которых состоит отключённый: их участники должны увидеть
          // новый состав и скрытие переписки на двоих без перезагрузки.
          const peers = await client.query<{ user_id: string }>(
            `SELECT DISTINCT peer.user_id::text AS user_id
             FROM conversation_participants AS mine
             JOIN conversation_participants AS peer ON peer.conversation_id = mine.conversation_id
             WHERE mine.user_id = $1`,
            [targetUserId]
          );
          for (const row of peers.rows) peerIds.push(row.user_id);
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      });
      // Ранний выход «уже отключён» оставляет список пустым: уведомления нет.
      if (peerIds.length > 0) {
        try {
          this.realtime.notifyUsersConversationsChanged([targetUserId, ...peerIds]);
        } catch {
          // Ошибка рассылки не ломает отключение: список перечитается сам.
        }
      }
      auditMemberAccess(principal.userId, targetUserId, "disable", "completed");
    } catch (error) {
      auditMemberAccess(principal.userId, targetUserId, "disable", "failed");
      throw error;
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

    const permissions = row.is_owner || row.has_administrator
      ? [...PERMISSIONS]
      : rolePermissions(row.base_permissions);
    if (!permissions.includes("MANAGE_ROLES")) {
      throw apiError(403, "FORBIDDEN", "Недостаточно прав");
    }
    const highestResult = await client.query<{ highest_position: number }>(
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
      highestRole: highestResult.rows[0]?.highest_position ?? 0
    };
  }
}
