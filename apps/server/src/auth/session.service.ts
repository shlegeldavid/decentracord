import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { Request, RequestHandler, Response } from "express";
import session from "express-session";
import { HttpException } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { parsePasswordChange } from "./contracts.js";
import { PasswordService } from "./password.service.js";
import { ABSOLUTE_SESSION_TTL_MS, GuardedSessionStore, IDLE_SESSION_TTL_MS } from "./session-store.js";

const dummyPasswordHash =
  "$argon2id$v=19$m=19456,t=2,p=1$z8NCZlPnjMLoA5DdU1LrQA$jGKRQdVQyL4UHyBWV3jfQgcm1kQuQe0Fvx90uUxbQJA";
const loginAttemptLimit = 10;
const loginSourceAttemptLimit = 30;
const maxConcurrentPasswordVerifications = 8;
const loginWindowMs = 15 * 60 * 1_000;
const maxRateKeys = 4_096;
const passwordChangeAttemptLimit = 5;
export const DATABASE_POOL = Symbol("decentracord.database-pool");

export interface AuthPrincipal {
  userId: string;
  sessionId: string;
  authVersion: number;
}

export interface AuthenticatedRequest extends Request {
  authPrincipal?: AuthPrincipal;
}

interface LoginUserRow {
  id: string;
  login: string;
  password_hash: string;
  active: boolean;
  auth_version: number;
}

interface CurrentUserRow {
  id: string;
  login: string;
}

function apiError(status: number, code: string, message: string): HttpException {
  return new HttpException({ code, message }, status);
}

function sessionSecret(): string {
  const secretFile = process.env.SESSION_SECRET_FILE ?? process.env.DB_PASSWORD_FILE ?? "/run/secrets/db_password";
  if (secretFile.length > 4_096) throw new Error("Invalid session configuration");

  const stats = statSync(secretFile);
  if (!stats.isFile() || stats.size === 0 || stats.size > 4_096) {
    throw new Error("Invalid session configuration");
  }

  const sourceSecret = readFileSync(secretFile);
  if (sourceSecret.length === 0 || sourceSecret.length > 4_096) {
    throw new Error("Invalid session configuration");
  }

  return createHmac("sha256", sourceSecret)
    .update("decentracord:express-session-cookie:v1")
    .digest("base64url");
}

function callbackResult(run: (callback: (error?: Error | null) => void) => unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    run((error) => (error ? reject(error) : resolve()));
  });
}

function equalTokens(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  if (leftBytes.length !== rightBytes.length) return false;
  return timingSafeEqual(leftBytes, rightBytes);
}

function validPasswordLength(password: string): boolean {
  const length = Array.from(password).length;
  return length >= 12 && length <= 128;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cookieName(): string {
  return process.env.NODE_ENV === "production" ? "__Host-decentracord.sid" : "decentracord.sid";
}

function auditPasswordChange(userId: string, outcome: string): void {
  try {
    process.stdout.write(`${JSON.stringify({
      event: "auth.password.change",
      actorId: userId,
      targetUserId: userId,
      outcome
    })}\n`);
  } catch {
    // Audit output must not change the authorization or password result.
  }
}

export class SessionService {
  private readonly failedBySource = new Map<string, number[]>();
  private readonly failedByLogin = new Map<string, number[]>();
  private readonly failedPasswordChanges = new Map<string, number[]>();
  private readonly inFlightBySource = new Map<string, number>();
  private readonly inFlightByLogin = new Map<string, number>();
  private activePasswordVerifications = 0;
  private guardedStore: GuardedSessionStore | undefined;

  constructor(
    private readonly pool: Pool,
    private readonly passwordService: PasswordService,
    private readonly now: () => number = Date.now
  ) {}

  createMiddleware(): RequestHandler {
    const store = this.store();

    return session({
      name: cookieName(),
      proxy: true,
      resave: false,
      saveUninitialized: false,
      secret: sessionSecret(),
      store,
      unset: "destroy",
      cookie: {
        httpOnly: true,
        maxAge: IDLE_SESSION_TTL_MS,
        path: "/",
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production"
      }
    });
  }

  async destroySession(request: Request): Promise<void> {
    await callbackResult((callback) => request.session.destroy(callback));
  }

  clearSessionCookie(response: Pick<Response, "setHeader">): void {
    const attributes = [
      `${cookieName()}=`,
      "Path=/",
      "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
      "HttpOnly",
      "SameSite=Lax"
    ];
    if (process.env.NODE_ENV === "production") attributes.push("Secure");
    response.setHeader("Set-Cookie", attributes.join("; "));
  }

  async prepare(): Promise<void> {
    await this.passwordService.verify("Decentracord-Dummy-Password-123456", dummyPasswordHash);
  }

  async issueCsrfToken(request: Request): Promise<{ csrfToken: string }> {
    if (await this.store().isRevoked(request.sessionID)) {
      await callbackResult((callback) => request.session.regenerate(callback));
    }
    if (!request.session.csrfToken) {
      request.session.csrfToken = randomBytes(32).toString("base64url");
      await callbackResult((callback) => request.session.save(callback));
    }

    return { csrfToken: request.session.csrfToken };
  }

  async login(request: Request, input: unknown): Promise<{ user: { id: string; login: string }; csrfToken: string }> {
    this.assertCsrf(request);
    if (!isRecord(input) || Object.keys(input).some((key) => key !== "login" && key !== "password")) {
      throw apiError(400, "INVALID_REQUEST", "Некорректный запрос");
    }

    const loginInput = input.login;
    const password = input.password;
    if (typeof loginInput !== "string" || typeof password !== "string") {
      throw apiError(400, "INVALID_REQUEST", "Некорректный запрос");
    }

    const normalizedLogin = loginInput.trim().toLowerCase();
    const validLogin = /^[a-z0-9_.-]{3,64}$/u.test(normalizedLogin);
    const validPassword = validPasswordLength(password);
    const source = this.requestSource(request);
    const loginKey = /^[a-z0-9_.-]{1,64}$/u.test(normalizedLogin) ? normalizedLogin : "invalid-login";
    this.assertLoginAllowed(source, loginKey);
    if (this.activePasswordVerifications >= maxConcurrentPasswordVerifications) {
      throw apiError(429, "TOO_MANY_REQUESTS", "Слишком много попыток входа");
    }
    this.activePasswordVerifications += 1;
    this.reserve(this.inFlightBySource, source);
    this.reserve(this.inFlightByLogin, loginKey);

    try {
      let user: LoginUserRow | undefined;
      if (validLogin) {
        const result = await this.pool.query<LoginUserRow>(
          "SELECT id, login, password_hash, active, auth_version FROM users WHERE login_normalized = $1",
          [normalizedLogin]
        );
        user = result.rows[0];
      }

      const verificationPassword = validPassword ? password : "Decentracord-Invalid-Password-123";
      const verified = await this.passwordService.verify(verificationPassword, user?.password_hash ?? dummyPasswordHash);
      if (!validLogin || !validPassword || !user?.active || !verified) {
        this.recordFailedAttempt(source, loginKey);
        throw apiError(401, "UNAUTHORIZED", "Неверный логин или пароль");
      }

      this.failedBySource.delete(source);
      this.failedByLogin.delete(loginKey);
      await callbackResult((callback) => request.session.regenerate(callback));
      const authenticatedAt = this.now();
      const csrfToken = randomBytes(32).toString("base64url");
      request.session.auth = {
        absoluteExpiresAt: authenticatedAt + ABSOLUTE_SESSION_TTL_MS,
        authenticatedAt,
        authVersion: user.auth_version,
        userId: user.id
      };
      request.session.csrfToken = csrfToken;
      this.store().allowNewAuthenticatedSession(request.sessionID);
      await callbackResult((callback) => request.session.save(callback));

      return { user: { id: user.id, login: user.login }, csrfToken };
    } finally {
      this.activePasswordVerifications -= 1;
      this.release(this.inFlightBySource, source);
      this.release(this.inFlightByLogin, loginKey);
    }
  }

  async requireActiveSession(request: Request): Promise<AuthPrincipal> {
    const auth = request.session?.auth;
    if (
      !auth ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(auth.userId) ||
      !Number.isInteger(auth.authVersion) ||
      auth.authVersion < 0 ||
      !Number.isSafeInteger(auth.authenticatedAt) ||
      !Number.isSafeInteger(auth.absoluteExpiresAt) ||
      auth.absoluteExpiresAt <= this.now()
    ) {
      throw apiError(401, "UNAUTHORIZED", "Требуется вход");
    }

    if (!(await this.store().isUsable(request.sessionID, auth))) {
      await callbackResult((callback) => request.session.destroy(callback)).catch(() => undefined);
      throw apiError(401, "UNAUTHORIZED", "Требуется вход");
    }

    return { authVersion: auth.authVersion, sessionId: request.sessionID, userId: auth.userId };
  }

  async currentUser(principal: AuthPrincipal): Promise<{ id: string; login: string }> {
    const result = await this.pool.query<CurrentUserRow>(
      "SELECT id, login FROM users WHERE id = $1 AND active = true AND auth_version = $2",
      [principal.userId, principal.authVersion]
    );
    const user = result.rows[0];
    if (!user) throw apiError(401, "UNAUTHORIZED", "Требуется вход");
    return { id: user.id, login: user.login };
  }

  async changePassword(principal: AuthPrincipal, request: Request, value: unknown): Promise<void> {
    this.assertCsrf(request);
    const input = parsePasswordChange(value);
    if (!input) {
      auditPasswordChange(principal.userId, "invalid_request");
      throw apiError(400, "INVALID_REQUEST", "Проверьте текущий и новый пароль");
    }
    try {
      this.assertPasswordChangeAllowed(principal.userId);
    } catch (error) {
      auditPasswordChange(principal.userId, "rate_limited");
      throw error;
    }

    const passwordHash = await this.passwordService.hash(input.newPassword);
    const client = await this.pool.connect();
    let transactionOpen = false;
    let auditOutcome = "failed";
    try {
      await client.query("BEGIN");
      transactionOpen = true;
      const locked = await client.query<LoginUserRow>(
        "SELECT id, login, password_hash, active, auth_version FROM users WHERE id = $1 FOR UPDATE",
        [principal.userId]
      );
      const currentUser = locked.rows[0];
      if (!currentUser?.active || currentUser.auth_version !== principal.authVersion) {
        auditOutcome = "stale_session";
        throw apiError(401, "UNAUTHORIZED", "Требуется вход");
      }

      if (!(await this.passwordService.verify(input.currentPassword, currentUser.password_hash))) {
        this.recordPasswordChangeFailure(principal.userId);
        auditOutcome = "invalid_current_password";
        throw apiError(400, "CURRENT_PASSWORD_INVALID", "Текущий пароль неверен");
      }

      const updated = await client.query<{ id: string }>(
        `UPDATE users
         SET password_hash = $1, auth_version = auth_version + 1
         WHERE id = $2 AND active = true AND auth_version = $3
         RETURNING id`,
        [passwordHash, principal.userId, principal.authVersion]
      );
      if (updated.rowCount !== 1) {
        auditOutcome = "stale_session";
        throw apiError(401, "UNAUTHORIZED", "Требуется вход");
      }

      await this.store().bulkRevoke(client as PoolClient, principal.userId);
      await client.query("COMMIT");
      transactionOpen = false;
      this.failedPasswordChanges.delete(principal.userId);
      auditOutcome = "changed";
    } catch (error) {
      if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
      auditPasswordChange(principal.userId, auditOutcome);
      throw error;
    } finally {
      client.release();
    }
    auditPasswordChange(principal.userId, auditOutcome);
  }

  /** Adds durable revocation tombstones within the caller's already-open user transaction. */
  async revokeAllSessionsInTransaction(client: PoolClient, userId: string): Promise<void> {
    await this.store().bulkRevoke(client, userId);
  }

  assertCsrf(request: Request): void {
    const origin = request.get("origin");
    const host = request.get("host");
    const requestOrigin = host && !host.includes(",") ? `${request.protocol}://${host}` : "";
    const expectedOrigin = process.env.NODE_ENV === "production" ? process.env.APP_ORIGIN : requestOrigin;
    const fetchSite = request.get("sec-fetch-site");
    if (
      !expectedOrigin ||
      requestOrigin !== expectedOrigin ||
      origin !== expectedOrigin ||
      (fetchSite !== undefined && fetchSite !== "same-origin" && fetchSite !== "none") ||
      !equalTokens(request.get("x-csrf-token"), request.session?.csrfToken)
    ) {
      throw apiError(403, "CSRF_FAILED", "Запрос не прошёл проверку безопасности");
    }
  }

  private requestSource(request: Request): string {
    const source = request.ip ?? request.socket.remoteAddress ?? "unknown";
    return source.slice(0, 128) || "unknown";
  }

  private assertPasswordChangeAllowed(userId: string): void {
    const attempts = this.recentFailures(this.failedPasswordChanges, userId, this.now());
    if (attempts.length >= passwordChangeAttemptLimit) {
      throw apiError(429, "TOO_MANY_REQUESTS", "Слишком много попыток смены пароля");
    }
  }

  private recordPasswordChangeFailure(userId: string): void {
    const now = this.now();
    const attempts = this.recentFailures(this.failedPasswordChanges, userId, now);
    attempts.push(now);
    if (!this.failedPasswordChanges.has(userId) && this.failedPasswordChanges.size >= maxRateKeys) {
      const oldestUserId = this.failedPasswordChanges.keys().next().value as string | undefined;
      if (oldestUserId) this.failedPasswordChanges.delete(oldestUserId);
    }
    this.failedPasswordChanges.set(userId, attempts);
  }

  private assertLoginAllowed(source: string, login: string): void {
    const now = this.now();
    const sourceAttempts = this.recentFailures(this.failedBySource, source, now);
    const loginAttempts = this.recentFailures(this.failedByLogin, login, now);
    if (
      sourceAttempts.length + (this.inFlightBySource.get(source) ?? 0) >= loginSourceAttemptLimit ||
      loginAttempts.length + (this.inFlightByLogin.get(login) ?? 0) >= loginAttemptLimit
    ) {
      throw apiError(429, "TOO_MANY_REQUESTS", "Слишком много попыток входа");
    }
  }

  private recordFailedAttempt(source: string, login: string): void {
    const now = this.now();
    this.recordFailure(this.failedBySource, source, now);
    this.recordFailure(this.failedByLogin, login, now);
  }

  private recentFailures(map: Map<string, number[]>, key: string, now: number): number[] {
    const recent = map.get(key)?.filter((timestamp) => now - timestamp < loginWindowMs) ?? [];
    if (recent.length === 0) map.delete(key);
    else map.set(key, recent);
    return recent;
  }

  private recordFailure(map: Map<string, number[]>, key: string, now: number): void {
    const attempts = this.recentFailures(map, key, now);
    attempts.push(now);
    if (!map.has(key) && map.size >= maxRateKeys) {
      const oldestKey = map.keys().next().value as string | undefined;
      if (oldestKey) map.delete(oldestKey);
    }
    map.set(key, attempts);
  }

  private reserve(map: Map<string, number>, key: string): void {
    map.set(key, (map.get(key) ?? 0) + 1);
  }

  private release(map: Map<string, number>, key: string): void {
    const count = map.get(key) ?? 0;
    if (count <= 1) map.delete(key);
    else map.set(key, count - 1);
  }

  private store(): GuardedSessionStore {
    this.guardedStore ??= new GuardedSessionStore(this.pool, this.now);
    return this.guardedStore;
  }
}
