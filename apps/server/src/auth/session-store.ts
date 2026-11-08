import connectPgSimple from "connect-pg-simple";
import session from "express-session";
import type { Pool, PoolClient } from "pg";

export const IDLE_SESSION_TTL_MS = 8 * 60 * 60 * 1_000;
export const ABSOLUTE_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export interface SessionAuth {
  userId: string;
  authVersion: number;
  authenticatedAt: number;
  absoluteExpiresAt: number;
}

declare module "express-session" {
  interface SessionData {
    auth?: SessionAuth;
    csrfToken?: string;
  }
}

interface SessionRow {
  sess: unknown;
  expire: Date | string;
}

interface UserAuthRow {
  active: boolean;
  auth_version: number;
}

type StoreErrorCallback = (error?: Error | null) => void;
type StoreGetCallback = (error: Error | null, value?: session.SessionData | null) => void;
type SessionStoreOptions = ConstructorParameters<ReturnType<typeof connectPgSimple>>[0];

const PgStore = connectPgSimple(session);
const userIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSession(value: unknown): session.SessionData | undefined {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      return undefined;
    }
  }
  return isRecord(parsed) ? parsed as unknown as session.SessionData : undefined;
}

function sessionAuth(value: unknown): SessionAuth | undefined {
  if (!isRecord(value) || !isRecord(value.auth)) return undefined;
  const auth = value.auth;
  if (
    typeof auth.userId !== "string" ||
    !userIdPattern.test(auth.userId) ||
    !Number.isInteger(auth.authVersion) ||
    Number(auth.authVersion) < 0 ||
    !Number.isSafeInteger(auth.authenticatedAt) ||
    !Number.isSafeInteger(auth.absoluteExpiresAt) ||
    Number(auth.absoluteExpiresAt) <= Number(auth.authenticatedAt) ||
    Number(auth.absoluteExpiresAt) - Number(auth.authenticatedAt) > ABSOLUTE_SESSION_TTL_MS
  ) {
    return undefined;
  }
  return auth as unknown as SessionAuth;
}

function hasAuthProperty(value: unknown): boolean {
  return isRecord(value) && Object.hasOwn(value, "auth");
}

function storeError(): Error {
  return new Error("Session is expired, revoked, or superseded");
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Session store operation failed");
}

function expiryMillis(value: SessionRow["expire"]): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

/** PostgreSQL session adapter that serializes every mutation with durable SID tombstones. */
export class GuardedSessionStore extends PgStore {
  private readonly newlyAuthenticatedSids = new Set<string>();

  constructor(
    private readonly pool: Pool,
    private readonly now: () => number = Date.now,
    options: SessionStoreOptions = {}
  ) {
    super({
      ...options,
      createTableIfMissing: false,
      errorLog: () => undefined,
      pool,
      pruneSessionInterval: false,
      tableName: "session",
      ttl: IDLE_SESSION_TTL_MS / 1_000
    });
  }

  /** Marks the post-regeneration SID from a successful login as eligible for its first insert. */
  allowNewAuthenticatedSession(sid: string): void {
    this.newlyAuthenticatedSids.add(sid);
  }

  isRevoked(sid: string): Promise<boolean> {
    return this.pool
      .query<{ revoked: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM session_revocations WHERE sid = $1) AS revoked",
        [sid]
      )
      .then((result) => result.rows[0]?.revoked ?? false);
  }

  async isUsable(sid: string, auth: SessionAuth): Promise<boolean> {
    const now = this.now();
    const result = await this.pool.query<{ usable: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM "session" AS s
         JOIN users AS u ON u.id = $2::uuid
         WHERE s.sid = $1
           AND s.expire > to_timestamp($4::double precision / 1000)
           AND NOT EXISTS (SELECT 1 FROM session_revocations AS r WHERE r.sid = s.sid)
           AND u.active = true
           AND u.auth_version = $3
           AND s.sess->'auth'->>'userId' = $2::text
           AND s.sess->'auth'->>'authVersion' = $3::text
           AND CASE
             WHEN s.sess->'auth'->>'absoluteExpiresAt' ~ '^[0-9]{1,16}$'
               THEN (s.sess->'auth'->>'absoluteExpiresAt')::bigint > $4
             ELSE false
           END
       ) AS usable`,
      [sid, auth.userId, auth.authVersion, now]
    );
    return result.rows[0]?.usable ?? false;
  }

  get(sid: string, callback: StoreGetCallback): void {
    void this.read(sid).then(
      (value) => callback(null, value),
      (error: unknown) => callback(asError(error))
    );
  }

  set(sid: string, value: session.SessionData, callback?: StoreErrorCallback): void {
    void this.write(sid, value).then(
      () => callback?.(null),
      (error: unknown) => callback?.(asError(error))
    );
  }

  touch(sid: string, value: session.SessionData, callback?: StoreErrorCallback): void {
    void this.refresh(sid, value).then(
      () => callback?.(null),
      (error: unknown) => callback?.(asError(error))
    );
  }

  destroy(sid: string, callback?: StoreErrorCallback): void {
    void this.revoke(sid).then(
      () => callback?.(null),
      (error: unknown) => callback?.(asError(error))
    );
  }

  /** Caller owns the transaction and must hold the user's row lock before invoking this method. */
  async bulkRevoke(transaction: PoolClient, userId: string): Promise<void> {
    if (!userIdPattern.test(userId)) throw new Error("Invalid session owner");

    const initial = await transaction.query<{ sid: string }>(
      `SELECT sid FROM "session"
       WHERE sess->'auth'->>'userId' = $1
       ORDER BY sid COLLATE "C"`,
      [userId]
    );
    const sids = initial.rows.map((row) => row.sid).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    for (const sid of sids) await this.lockSid(transaction, sid);

    const current = await transaction.query<{ sid: string }>(
      `SELECT sid FROM "session"
       WHERE sess->'auth'->>'userId' = $1
       ORDER BY sid COLLATE "C"`,
      [userId]
    );
    const currentSids = current.rows.map((row) => row.sid).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    if (currentSids.some((sid, index) => sid !== sids[index]) || currentSids.length !== sids.length) {
      throw new Error("Session set changed while acquiring revocation locks");
    }

    if (sids.length === 0) return;
    await transaction.query(
      `INSERT INTO session_revocations (sid, revoked_at)
       SELECT sid, now() FROM "session" WHERE sid = ANY($1::varchar[])
       ON CONFLICT (sid) DO NOTHING`,
      [sids]
    );
    await transaction.query('DELETE FROM "session" WHERE sid = ANY($1::varchar[])', [sids]);
  }

  private async read(sid: string): Promise<session.SessionData | null> {
    const now = this.now();
    const result = await this.pool.query<SessionRow>(
      `SELECT s.sess, s.expire
       FROM "session" AS s
       WHERE s.sid = $1
         AND s.expire > to_timestamp($2::double precision / 1000)
         AND NOT EXISTS (SELECT 1 FROM session_revocations AS r WHERE r.sid = s.sid)`,
      [sid, now]
    );
    const row = result.rows[0];
    if (!row) return null;

    const parsed = parseSession(row.sess);
    if (!parsed || hasAuthProperty(parsed) && !sessionAuth(parsed)) {
      await this.revoke(sid);
      return null;
    }

    const auth = sessionAuth(parsed);
    if (auth && (auth.absoluteExpiresAt <= now || !(await this.isUsable(sid, auth)))) {
      await this.revoke(sid);
      return null;
    }
    return parsed;
  }

  private async write(sid: string, value: session.SessionData): Promise<void> {
    const auth = sessionAuth(value);
    if (hasAuthProperty(value) && !auth) throw storeError();
    const now = this.now();
    if (auth && auth.absoluteExpiresAt <= now) throw storeError();

    await this.withTransaction(async (client) => {
      if (auth) await this.lockAndValidateUser(client, auth);
      await this.lockSid(client, sid);
      await this.assertNotRevoked(client, sid);
      const current = await this.sessionRow(client, sid, true);

      if (current) {
        if (expiryMillis(current.expire) <= now) throw storeError();
        const stored = parseSession(current.sess);
        if (!stored || hasAuthProperty(stored) && !sessionAuth(stored)) throw storeError();
        this.assertSameOwner(sessionAuth(stored), auth);
      } else if (auth && !this.newlyAuthenticatedSids.has(sid)) {
        throw storeError();
      }

      const expiresAt = this.expiration(value, now, auth);
      if (expiresAt <= now) throw storeError();
      await client.query(
        `INSERT INTO "session" (sid, sess, expire)
         VALUES ($1, $2::json, to_timestamp($3::double precision / 1000))
         ON CONFLICT (sid) DO UPDATE SET sess = EXCLUDED.sess, expire = EXCLUDED.expire`,
        [sid, JSON.stringify(value), expiresAt]
      );
    });

    if (auth) this.newlyAuthenticatedSids.delete(sid);
  }

  private async refresh(sid: string, value: session.SessionData): Promise<void> {
    const auth = sessionAuth(value);
    if (hasAuthProperty(value) && !auth) throw storeError();
    const now = this.now();
    if (auth && auth.absoluteExpiresAt <= now) throw storeError();

    await this.withTransaction(async (client) => {
      if (auth) await this.lockAndValidateUser(client, auth);
      await this.lockSid(client, sid);
      await this.assertNotRevoked(client, sid);
      const current = await this.sessionRow(client, sid, true);
      if (!current || expiryMillis(current.expire) <= now) throw storeError();
      const stored = parseSession(current.sess);
      if (!stored || hasAuthProperty(stored) && !sessionAuth(stored)) throw storeError();
      this.assertSameOwner(sessionAuth(stored), auth);

      const expiresAt = this.expiration(value, now, auth);
      if (expiresAt <= now) throw storeError();
      await client.query(
        'UPDATE "session" SET expire = to_timestamp($1::double precision / 1000) WHERE sid = $2',
        [expiresAt, sid]
      );
    });
  }

  private async revoke(sid: string): Promise<void> {
    const owner = await this.pool.query<{ user_id: string | null }>(
      `SELECT sess->'auth'->>'userId' AS user_id FROM "session" WHERE sid = $1`,
      [sid]
    );
    const candidateUserId = owner.rows[0]?.user_id;
    const userId = typeof candidateUserId === "string" && userIdPattern.test(candidateUserId) ? candidateUserId : undefined;

    await this.withTransaction(async (client) => {
      if (userId) {
        await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);
      }
      await this.lockSid(client, sid);
      await client.query(
        "INSERT INTO session_revocations (sid, revoked_at) VALUES ($1, now()) ON CONFLICT (sid) DO NOTHING",
        [sid]
      );
      await client.query('DELETE FROM "session" WHERE sid = $1', [sid]);
    });
    this.newlyAuthenticatedSids.delete(sid);
  }

  private expiration(value: session.SessionData, now: number, auth: SessionAuth | undefined): number {
    const cookieExpiry = value.cookie?.expires ? new Date(value.cookie.expires).getTime() : Number.POSITIVE_INFINITY;
    return Math.min(now + IDLE_SESSION_TTL_MS, cookieExpiry, auth?.absoluteExpiresAt ?? Number.POSITIVE_INFINITY);
  }

  private assertSameOwner(existing: SessionAuth | undefined, incoming: SessionAuth | undefined): void {
    if (!existing && !incoming) return;
    if (
      !existing ||
      !incoming ||
      existing.userId !== incoming.userId ||
      existing.authVersion !== incoming.authVersion ||
      existing.authenticatedAt !== incoming.authenticatedAt ||
      existing.absoluteExpiresAt !== incoming.absoluteExpiresAt
    ) {
      throw storeError();
    }
  }

  private async lockAndValidateUser(client: PoolClient, auth: SessionAuth): Promise<void> {
    const result = await client.query<UserAuthRow>(
      "SELECT active, auth_version FROM users WHERE id = $1 FOR SHARE",
      [auth.userId]
    );
    const row = result.rows[0];
    if (!row?.active || row.auth_version !== auth.authVersion) throw storeError();
  }

  private async lockSid(client: PoolClient, sid: string): Promise<void> {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [sid]);
  }

  private async assertNotRevoked(client: PoolClient, sid: string): Promise<void> {
    const result = await client.query<{ revoked: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM session_revocations WHERE sid = $1) AS revoked",
      [sid]
    );
    if (result.rows[0]?.revoked) throw storeError();
  }

  private async sessionRow(client: PoolClient, sid: string, forUpdate: boolean): Promise<SessionRow | undefined> {
    const result = await client.query<SessionRow>(
      `SELECT sess, expire FROM "session" WHERE sid = $1${forUpdate ? " FOR UPDATE" : ""}`,
      [sid]
    );
    return result.rows[0];
  }

  private async withTransaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await run(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
