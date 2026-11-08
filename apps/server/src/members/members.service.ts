import { HttpException } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { AuthorizationService } from "../auth/authorization.service.js";
import { parseCreateMember, parseResetMemberPassword, type MemberSummary } from "../auth/contracts.js";
import { PasswordService } from "../auth/password.service.js";
import { SessionRevocationService } from "../auth/session-revocation.service.js";
import type { AuthPrincipal, SessionService } from "../auth/session.service.js";

interface MemberRow {
  id: string;
  login: string;
  active: boolean;
}

interface LockedMemberRow extends MemberRow {
  auth_version: number;
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

async function isAdministrator(client: Pick<PoolClient, "query">, userId: string): Promise<boolean> {
  const result = await client.query<{ allowed: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM user_roles AS user_role
       JOIN roles AS role ON role.id = user_role.role_id
       WHERE user_role.user_id = $1
         AND role.system_key = 'administrator'
         AND role.permissions @> '["ADMINISTRATOR"]'::jsonb
     ) AS allowed`,
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
       AND EXISTS (
         SELECT 1
         FROM user_roles AS user_role
         JOIN roles AS role ON role.id = user_role.role_id
         WHERE user_role.user_id = target.id
           AND role.system_key = 'administrator'
           AND role.permissions @> '["ADMINISTRATOR"]'::jsonb
       )
     ORDER BY target.id
     FOR UPDATE OF target`,
    [targetUserId]
  );
  if (result.rows.length < 1) {
    throw apiError(409, "LAST_ADMINISTRATOR", "Нельзя отключить последнего активного администратора");
  }
}

export class MembersService {
  constructor(
    private readonly pool: Pool,
    private readonly authorization: AuthorizationService,
    private readonly passwords: PasswordService,
    private readonly revocations: SessionRevocationService,
    private readonly sessions: SessionService
  ) {}

  async list(principal: AuthPrincipal): Promise<MemberSummary[]> {
    await this.authorization.requireAdministrator(principal);
    const result = await this.pool.query<MemberRow>(
      "SELECT id, login, active FROM users ORDER BY login_normalized, id"
    );
    return result.rows.map(({ id, login, active }) => ({ id, login, active }));
  }

  async create(principal: AuthPrincipal, body: unknown): Promise<MemberSummary> {
    try {
      await this.authorization.requireAdministrator(principal);
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
      const everyoneRole = await client.query<{ id: string }>(
        "SELECT id FROM roles WHERE system_key = 'everyone' FOR SHARE"
      );
      const everyoneRoleId = everyoneRole.rows[0]?.id;
      if (!everyoneRoleId) throw new Error("Required system role is missing");

      const created = await client.query<MemberRow>(
        "INSERT INTO users (login, login_normalized, password_hash) VALUES ($1, $1, $2) RETURNING id, login, active",
        [input.login, passwordHash]
      );
      const member = created.rows[0];
      if (!member) throw new Error("Member was not created");
      await client.query(
        "INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)",
        [member.id, everyoneRoleId]
      );
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
      await this.revocations.revokeAllSessionsForUser(targetUserId, async () => {
        const client = await this.pool.connect();
        try {
          await client.query("BEGIN");
          await client.query("SELECT pg_advisory_xact_lock(21471, 901)");
          const locked = await client.query<LockedMemberRow>(
            "SELECT id, login, active, auth_version FROM users WHERE id = $1 FOR UPDATE",
            [targetUserId]
          );
          const member = locked.rows[0];
          if (!member) throw apiError(404, "MEMBER_NOT_FOUND", "Участник не найден");
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
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      });
      auditMemberAccess(principal.userId, targetUserId, "disable", "completed");
    } catch (error) {
      auditMemberAccess(principal.userId, targetUserId, "disable", "failed");
      throw error;
    }
  }
}
