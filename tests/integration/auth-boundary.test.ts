import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HttpException } from "@nestjs/common";
import type { Request } from "express";
import type { SessionData } from "express-session";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PasswordService } from "../../apps/server/src/auth/password.service.js";
import { ABSOLUTE_SESSION_TTL_MS, GuardedSessionStore, IDLE_SESSION_TTL_MS, type SessionAuth } from "../../apps/server/src/auth/session-store.js";
import { SessionService } from "../../apps/server/src/auth/session.service.js";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const commandTimeoutMs = 180_000;
const inContainer = process.env.AUTH_BOUNDARY_TEST_IN_CONTAINER === "true";
const loginWindowMs = 15 * 60 * 1_000;

function compose(projectName: string, envFile: string, overrideFile: string, args: string[], timeout = commandTimeoutMs) {
  return spawnSync(
    "docker",
    ["compose", "--project-name", projectName, "--env-file", envFile, "--file", join(projectRoot, "compose.yaml"), "--file", overrideFile, ...args],
    { cwd: projectRoot, encoding: "utf8", timeout, env: process.env, maxBuffer: 4 * 1024 * 1024 }
  );
}

function assertComposeSucceeded(result: ReturnType<typeof compose>, args: string[]): void {
  assert.equal(
    result.status,
    0,
    `docker compose ${args.join(" ")} failed: ${result.error?.message ?? ""}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`
  );
}

function requestFor(source: string): Request {
  const headers: Record<string, string> = {
    host: "app.test:3000",
    origin: "http://app.test:3000",
    "sec-fetch-site": "same-origin",
    "x-csrf-token": "csrf-test-token"
  };
  return {
    get: (name: string) => headers[name.toLowerCase()],
    ip: source,
    protocol: "http",
    session: { csrfToken: "csrf-test-token" } as Request["session"],
    socket: { remoteAddress: source }
  } as unknown as Request;
}

async function loginStatus(service: SessionService, login: string, source: string): Promise<number> {
  try {
    await service.login(requestFor(source), { login, password: "Wrong-password-123" });
    return 200;
  } catch (error) {
    if (error instanceof HttpException) return error.getStatus();
    throw error;
  }
}

function withCallback(run: (callback: (error?: Error | null) => void) => void): Promise<void> {
  return new Promise((resolve, reject) => run((error) => error ? reject(error) : resolve()));
}

function getSession(store: GuardedSessionStore, sid: string): Promise<SessionData | null> {
  return new Promise((resolve, reject) => store.get(sid, (error, value) => error ? reject(error) : resolve(value ?? null)));
}

function setSession(store: GuardedSessionStore, sid: string, value: SessionData): Promise<void> {
  return withCallback((callback) => store.set(sid, value, callback));
}

function touchSession(store: GuardedSessionStore, sid: string, value: SessionData): Promise<void> {
  return withCallback((callback) => store.touch(sid, value, callback));
}

function destroySession(store: GuardedSessionStore, sid: string): Promise<void> {
  return withCallback((callback) => store.destroy(sid, callback));
}

function sessionFor(userId: string, authVersion: number, now: number): SessionData {
  const auth: SessionAuth = {
    absoluteExpiresAt: now + ABSOLUTE_SESSION_TTL_MS,
    authenticatedAt: now,
    authVersion,
    userId
  };
  return {
    auth,
    cookie: { originalMaxAge: IDLE_SESSION_TTL_MS, maxAge: IDLE_SESSION_TTL_MS, expires: new Date(now + IDLE_SESSION_TTL_MS) } as SessionData["cookie"]
  };
}

if (!inContainer) {
  describe("login throttling and session lifetime integration", () => {
    let fixtureDirectory = "";
    let projectName = "";
    let envFile = "";
    let overrideFile = "";

    function run(args: string[], timeout = commandTimeoutMs) {
      return compose(projectName, envFile, overrideFile, args, timeout);
    }

    beforeAll(() => {
      fixtureDirectory = mkdtempSync(join(tmpdir(), "decentracord-auth-boundary-"));
      const suffix = randomBytes(6).toString("hex");
      projectName = `decentracord-auth-boundary-${suffix}`;
      const databaseName = `decentracord_test_${suffix}`;
      const databaseUser = `auth_boundary_${suffix.slice(0, 10)}`;
      const databasePassword = randomBytes(24).toString("base64url");
      const secretFile = join(fixtureDirectory, "db_password");
      envFile = join(fixtureDirectory, "compose.env");
      overrideFile = join(fixtureDirectory, "compose.auth-boundary.yaml");
      const buildxConfig = join(fixtureDirectory, "buildx");
      mkdirSync(buildxConfig, { mode: 0o700 });
      writeFileSync(secretFile, databasePassword, { mode: 0o600 });
      chmodSync(secretFile, 0o600);
      writeFileSync(
        envFile,
        [`DB_PASSWORD_SECRET_FILE=${secretFile}`, `DB_NAME=${databaseName}`, `DB_USER=${databaseUser}`, "DB_CONNECT_TIMEOUT_MS=2500", ""].join("\n"),
        { mode: 0o600 }
      );
      chmodSync(envFile, 0o600);
      writeFileSync(
        overrideFile,
        [
          "services:",
          "  test-runner:",
          "    build:",
          `      context: ${JSON.stringify(projectRoot)}`,
          "      dockerfile: Dockerfile",
          "      target: test-runner",
          `    image: ${JSON.stringify(`decentracord-auth-boundary-runner:${suffix}`)}`,
          '    entrypoint: ["npm", "run", "test:integration", "--", "tests/integration/auth-boundary.test.ts"]',
          "    environment:",
          `      TEST_DATABASE_URL: postgresql://${databaseUser}:${databasePassword}@db:5432/${databaseName}`,
          "      AUTH_BOUNDARY_TEST_SECRET: /tmp/decentracord-session-secret",
          "    networks:",
          "      - backend",
          "    depends_on:",
          "      db:",
          "        condition: service_healthy",
          "",
        ].join("\n"),
        { mode: 0o600 }
      );
      chmodSync(overrideFile, 0o600);
      process.env.BUILDX_CONFIG = buildxConfig;
      process.env.npm_config_cache = "/tmp/decentracord-npm-cache";
      process.env.DOCKER_CLI_HINTS = "false";

      const buildArgs = ["build", "app", "test-runner"];
      assertComposeSucceeded(run(buildArgs, 600_000), buildArgs);
      const databaseArgs = ["up", "--detach", "--wait", "--wait-timeout", "90", "db"];
      assertComposeSucceeded(run(databaseArgs, 180_000), databaseArgs);
      const migrateArgs = ["run", "--rm", "--no-deps", "-T", "--entrypoint", "node", "app", "apps/server/dist/cli.js", "migrate"];
      assertComposeSucceeded(run(migrateArgs, 180_000), migrateArgs);
      const runnerArgs = ["run", "--rm", "--no-deps", "-T", "-e", "AUTH_BOUNDARY_TEST_IN_CONTAINER=true", "test-runner"];
      assertComposeSucceeded(run(runnerArgs, 360_000), runnerArgs);
    }, 660_000);

    afterAll(() => {
      if (!fixtureDirectory) return;
      const downArgs = ["down", "--volumes", "--remove-orphans", "--rmi", "local"];
      const result = run(downArgs, 120_000);
      rmSync(fixtureDirectory, { recursive: true, force: true });
      assertComposeSucceeded(result, downArgs);
    });

    it("runs the isolated Postgres authentication boundary suite", () => {
      expect(projectName).toContain("decentracord-auth-boundary-");
    });
  });
} else {
  let pool: Pool;
  let store: GuardedSessionStore;
  let userId = "";
  let now = Date.now();
  let secretFile = "";

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 12 });
    secretFile = process.env.AUTH_BOUNDARY_TEST_SECRET ?? join(tmpdir(), `decentracord-session-secret-${randomBytes(8).toString("hex")}`);
    writeFileSync(secretFile, randomBytes(32), { mode: 0o600 });
    chmodSync(secretFile, 0o600);
    process.env.SESSION_SECRET_FILE = secretFile;
    const user = await pool.query<{ id: string }>(
      "INSERT INTO users (login, login_normalized, password_hash) VALUES ('boundary.user', 'boundary.user', 'not-used') RETURNING id"
    );
    userId = user.rows[0]!.id;
    store = new GuardedSessionStore(pool, () => now);
  });

  afterAll(async () => {
    await store?.close();
    await pool?.end();
    if (secretFile) rmSync(secretFile, { force: true });
  });

  describe("login and session boundary checks", () => {
    it("limits failed attempts per normalized login and per IP for fifteen minutes", async () => {
      const failVerifier = { verify: async () => false } as unknown as PasswordService;
      const service = new SessionService(pool, failVerifier, () => now);
      for (let index = 0; index < 10; index += 1) {
        expect(await loginStatus(service, " Victim.User ", `198.51.100.${index + 1}`)).toBe(401);
      }
      expect(await loginStatus(service, "victim.user", "198.51.100.80")).toBe(429);

      now += loginWindowMs + 1;
      expect(await loginStatus(service, "VICTIM.USER", "198.51.100.81")).toBe(401);

      const ipService = new SessionService(pool, failVerifier, () => now);
      for (let index = 0; index < 30; index += 1) {
        expect(await loginStatus(ipService, `account.${index}.user`, "203.0.113.45")).toBe(401);
      }
      expect(await loginStatus(ipService, "account.extra.user", "203.0.113.45")).toBe(429);
    });

    it("bounds concurrent password verification work", async () => {
      let calls = 0;
      let unblock: (() => void) | undefined;
      let entered: (() => void) | undefined;
      const allEntered = new Promise<void>((resolve) => { entered = resolve; });
      const waitForRelease = new Promise<void>((resolve) => { unblock = resolve; });
      const slowVerifier = {
        verify: async () => {
          calls += 1;
          if (calls === 8) entered?.();
          await waitForRelease;
          return false;
        }
      } as unknown as PasswordService;
      const service = new SessionService(pool, slowVerifier, () => now);
      const attempts = Array.from({ length: 8 }, (_, index) => loginStatus(service, `parallel.${index}.user`, `192.0.2.${index + 1}`));
      await Promise.race([
        allEntered,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("password verification did not reach its bound")), 5_000))
      ]);
      expect(calls).toBe(8);
      expect(await loginStatus(service, "parallel.extra.user", "192.0.2.80")).toBe(429);
      expect(calls).toBe(8);
      unblock?.();
      expect(await Promise.all(attempts)).toEqual(Array(8).fill(401));
    });

    it("enforces an eight-hour idle TTL and seven-day absolute TTL without extending either by stale touch/save", async () => {
      const baseTime = now;
      const idleSid = `boundary-idle-${randomBytes(12).toString("hex")}`;
      const idleValue = sessionFor(userId, 0, baseTime);
      store.allowNewAuthenticatedSession(idleSid);
      await setSession(store, idleSid, idleValue);
      expect(await getSession(store, idleSid)).not.toBeNull();

      now = baseTime + IDLE_SESSION_TTL_MS + 1;
      await expect(getSession(store, idleSid)).resolves.toBeNull();
      await expect(touchSession(store, idleSid, idleValue)).rejects.toThrow();
      await expect(setSession(store, idleSid, idleValue)).rejects.toThrow();

      now = baseTime + 2 * IDLE_SESSION_TTL_MS;
      const absoluteSid = `boundary-absolute-${randomBytes(12).toString("hex")}`;
      const absoluteValue = sessionFor(userId, 0, now);
      store.allowNewAuthenticatedSession(absoluteSid);
      await setSession(store, absoluteSid, absoluteValue);

      let renewedCookie = absoluteValue;
      for (let hour = 0; hour < 24 * 7 - 6; hour += 6) {
        now += 6 * 60 * 60 * 1_000;
        renewedCookie = {
          ...absoluteValue,
          cookie: { ...absoluteValue.cookie, expires: new Date(now + IDLE_SESSION_TTL_MS) }
        } as SessionData;
        await touchSession(store, absoluteSid, renewedCookie);
      }
      const persisted = await pool.query<{ expire: Date }>("SELECT expire FROM \"session\" WHERE sid = $1", [absoluteSid]);
      expect(persisted.rows[0]!.expire.getTime()).toBe(absoluteValue.auth!.absoluteExpiresAt);

      now = absoluteValue.auth!.absoluteExpiresAt + 1;
      await expect(getSession(store, absoluteSid)).resolves.toBeNull();
      await expect(touchSession(store, absoluteSid, renewedCookie)).rejects.toThrow();
      await expect(setSession(store, absoluteSid, renewedCookie)).rejects.toThrow();
    });

    it("rejects a tombstoned, expired, inactive, or version-stale principal", async () => {
      const service = new SessionService(pool, { verify: async () => false } as unknown as PasswordService, () => now);
      service.createMiddleware();

      const activeSid = `boundary-active-${randomBytes(12).toString("hex")}`;
      const activeValue = sessionFor(userId, 0, now);
      store.allowNewAuthenticatedSession(activeSid);
      await setSession(store, activeSid, activeValue);
      const activeRequest = {
        session: { ...activeValue, destroy: (callback: (error?: Error | null) => void) => store.destroy(activeSid, callback) },
        sessionID: activeSid
      } as unknown as Request;
      expect(await service.requireActiveSession(activeRequest)).toMatchObject({ authVersion: 0, userId });

      await destroySession(store, activeSid);
      await expect(service.requireActiveSession(activeRequest)).rejects.toMatchObject({ status: 401 });

      const staleSid = `boundary-version-${randomBytes(12).toString("hex")}`;
      const staleValue = sessionFor(userId, 0, now);
      store.allowNewAuthenticatedSession(staleSid);
      await setSession(store, staleSid, staleValue);
      await pool.query("UPDATE users SET auth_version = auth_version + 1 WHERE id = $1", [userId]);
      const staleRequest = {
        session: { ...staleValue, destroy: (callback: (error?: Error | null) => void) => store.destroy(staleSid, callback) },
        sessionID: staleSid
      } as unknown as Request;
      await expect(service.requireActiveSession(staleRequest)).rejects.toMatchObject({ status: 401 });
      await expect(store.isRevoked(staleSid)).resolves.toBe(true);

      await pool.query("UPDATE users SET active = false WHERE id = $1", [userId]);
      const disabledSid = `boundary-disabled-${randomBytes(12).toString("hex")}`;
      const disabledValue = sessionFor(userId, 1, now);
      store.allowNewAuthenticatedSession(disabledSid);
      await expect(setSession(store, disabledSid, disabledValue)).rejects.toThrow();
      await expect(getSession(store, disabledSid)).resolves.toBeNull();
    });
  });
}
