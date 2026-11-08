import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GuardedSessionStore, type SessionAuth } from "../../apps/server/src/auth/session-store.js";
import type { SessionData } from "express-session";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const commandTimeoutMs = 180_000;
const inContainer = process.env.SESSION_RACE_TEST_IN_CONTAINER === "true";
const afterRestart = process.env.SESSION_RACE_TEST_STAGE === "after-restart";
const idleTtlMs = 8 * 60 * 60 * 1_000;
const absoluteTtlMs = 7 * 24 * 60 * 60 * 1_000;

function runCompose(projectName: string, envFile: string, overrideFile: string, args: string[], timeout = commandTimeoutMs) {
  return spawnSync(
    "docker",
    ["compose", "--project-name", projectName, "--env-file", envFile, "--file", join(projectRoot, "compose.yaml"), "--file", overrideFile, ...args],
    { cwd: projectRoot, encoding: "utf8", timeout, env: process.env, maxBuffer: 4 * 1024 * 1024 }
  );
}

function assertComposeSucceeded(result: ReturnType<typeof runCompose>, args: string[]): void {
  assert.equal(
    result.status,
    0,
    `docker compose ${args.join(" ")} failed: ${result.error?.message ?? ""}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`
  );
}

function runComposeWithInput(
  projectName: string,
  envFile: string,
  overrideFile: string,
  args: string[],
  input: string
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "docker",
      ["compose", "--project-name", projectName, "--env-file", envFile, "--file", join(projectRoot, "compose.yaml"), "--file", overrideFile, ...args],
      { cwd: projectRoot, env: process.env, stdio: ["pipe", "pipe", "pipe"] }
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), commandTimeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    child.stdin.end(input);
  });
}

function withCallback(run: (callback: (error?: Error | null) => void) => void): Promise<void> {
  return new Promise((resolve, reject) => run((error) => error ? reject(error) : resolve()));
}

function storeGet(store: GuardedSessionStore, sid: string): Promise<SessionData | null> {
  return new Promise((resolve, reject) => {
    store.get(sid, (error, value) => error ? reject(error) : resolve(value ?? null));
  });
}

function storeSet(store: GuardedSessionStore, sid: string, value: SessionData): Promise<void> {
  return withCallback((callback) => store.set(sid, value, callback));
}

function storeSetNew(store: GuardedSessionStore, sid: string, value: SessionData): Promise<void> {
  if (value.auth) store.allowNewAuthenticatedSession(sid);
  return storeSet(store, sid, value);
}

function storeTouch(store: GuardedSessionStore, sid: string, value: SessionData): Promise<void> {
  return withCallback((callback) => store.touch(sid, value, callback));
}

function storeDestroy(store: GuardedSessionStore, sid: string): Promise<void> {
  return withCallback((callback) => store.destroy(sid, callback));
}

function sessionFor(userId: string, authVersion: number, now: number): SessionData {
  const auth: SessionAuth = {
    absoluteExpiresAt: now + absoluteTtlMs,
    authenticatedAt: now,
    authVersion,
    userId
  };
  return {
    auth,
    cookie: { originalMaxAge: idleTtlMs, maxAge: idleTtlMs, expires: new Date(now + idleTtlMs) } as SessionData["cookie"]
  };
}

if (!inContainer) {
  describe("PostgreSQL guarded session store races", () => {
    let fixtureDirectory = "";
    let projectName = "";
    let envFile = "";
    let overrideFile = "";
    let stateDirectory = "";

    function compose(args: string[], timeout = commandTimeoutMs) {
      return runCompose(projectName, envFile, overrideFile, args, timeout);
    }

    function runRunner(stage: "race" | "after-restart"): void {
      const args = ["run", "--rm", "--no-deps", "-T", "-e", "SESSION_RACE_TEST_IN_CONTAINER=true", "-e", `SESSION_RACE_TEST_STAGE=${stage}`, "test-runner"];
      assertComposeSucceeded(compose(args, 300_000), args);
    }

    beforeAll(async () => {
      fixtureDirectory = mkdtempSync(join(tmpdir(), "decentracord-session-races-"));
      const suffix = randomBytes(6).toString("hex");
      projectName = `decentracord-session-races-${suffix}`;
      const databaseName = `decentracord_test_${suffix}`;
      const databaseUser = `session_race_${suffix.slice(0, 10)}`;
      const databasePassword = randomBytes(24).toString("base64url");
      const secretFile = join(fixtureDirectory, "db_password");
      envFile = join(fixtureDirectory, "compose.env");
      overrideFile = join(fixtureDirectory, "compose.races.yaml");
      const buildxConfig = join(fixtureDirectory, "buildx");
      stateDirectory = join(fixtureDirectory, "state");
      mkdirSync(buildxConfig, { mode: 0o700 });
      mkdirSync(stateDirectory, { mode: 0o700 });
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
          "  app:",
          '    entrypoint: ["node", "apps/server/dist/main.js"]',
          "    command: []",
          "    environment:",
          "      APP_HOST: 0.0.0.0",
          "      APP_PORT: 3000",
          "      NODE_ENV: test",
          "    healthcheck:",
          '      test: ["CMD", "node", "-e", "fetch(\'http://127.0.0.1:3000/healthz\').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]',
          "      interval: 2s",
          "      timeout: 2s",
          "      retries: 30",
          "      start_period: 3s",
          "  test-runner:",
          "    build:",
          `      context: ${JSON.stringify(projectRoot)}`,
          "      dockerfile: Dockerfile",
          "      target: test-runner",
          `    image: ${JSON.stringify(`decentracord-session-races-runner:${suffix}`)}`,
          '    entrypoint: ["npm", "run", "test:integration", "--", "tests/integration/session-store-races.test.ts"]',
          "    environment:",
          "      SESSION_RACE_BASE_URL: http://app:3000",
          "      SESSION_RACE_STATE_PATH: /race-state/session-cookie.json",
          "      SESSION_RACE_ADMIN_LOGIN: ${SESSION_RACE_ADMIN_LOGIN}",
          "      SESSION_RACE_ADMIN_PASSWORD: ${SESSION_RACE_ADMIN_PASSWORD}",
          `      TEST_DATABASE_URL: postgresql://${databaseUser}:${databasePassword}@db:5432/${databaseName}`,
          "    volumes:",
          "      - type: bind",
          `        source: ${JSON.stringify(stateDirectory)}`,
          "        target: /race-state",
          "    networks:",
          "      - backend",
          "    depends_on:",
          "      app:",
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
      assertComposeSucceeded(compose(buildArgs, 600_000), buildArgs);
      const startDatabaseArgs = ["up", "--detach", "--wait", "--wait-timeout", "90", "db"];
      assertComposeSucceeded(compose(startDatabaseArgs, 180_000), startDatabaseArgs);
      const migrateArgs = ["run", "--rm", "--no-deps", "-T", "--entrypoint", "node", "app", "apps/server/dist/cli.js", "migrate"];
      assertComposeSucceeded(compose(migrateArgs, 180_000), migrateArgs);

      const bootstrapPassword = `Race-test-${randomBytes(18).toString("base64url")}`;
      const bootstrapLogin = `race_admin_${suffix.slice(0, 10)}`;
      writeFileSync(
        join(fixtureDirectory, "credentials.json"),
        JSON.stringify({ login: bootstrapLogin, password: bootstrapPassword }),
        { mode: 0o600 }
      );
      const bootstrapArgs = ["run", "--rm", "--no-deps", "-T", "-i", "-e", `DB_NAME=${databaseName}`, "app", "bootstrap-admin", "--login", bootstrapLogin];
      const bootstrap = await runComposeWithInput(projectName, envFile, overrideFile, bootstrapArgs, `${bootstrapPassword}\n`);
      assert.equal(bootstrap.status, 0, `${bootstrap.stdout}\n${bootstrap.stderr}`);
    }, 660_000);

    it("runs the PostgreSQL barriers, revokes a live cookie, then rejects it after restart", () => {
      const credentials = JSON.parse(readFileSync(join(fixtureDirectory, "credentials.json"), "utf8")) as { login: string; password: string };
      const startAppArgs = ["up", "--detach", "--wait", "--wait-timeout", "90", "app"];
      assertComposeSucceeded(compose(startAppArgs, 180_000), startAppArgs);
      process.env.SESSION_RACE_ADMIN_LOGIN = credentials.login;
      process.env.SESSION_RACE_ADMIN_PASSWORD = credentials.password;
      runRunner("race");

      const restartArgs = ["restart", "app"];
      assertComposeSucceeded(compose(restartArgs, 120_000), restartArgs);
      assertComposeSucceeded(compose(startAppArgs, 180_000), startAppArgs);
      runRunner("after-restart");
    }, 600_000);

    afterAll(() => {
      if (!fixtureDirectory) return;
      const downArgs = ["down", "--volumes", "--remove-orphans", "--rmi", "local"];
      const result = compose(downArgs, 120_000);
      rmSync(fixtureDirectory, { recursive: true, force: true });
      assertComposeSucceeded(result, downArgs);
    });
  });
} else {
  let pool: Pool;
  let store: GuardedSessionStore;
  let targetUserId: string;
  let otherUserId: string;
  let targetAuthVersion = 0;
  const now = Date.now();

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 12 });
    store = new GuardedSessionStore(pool, () => now);
    if (afterRestart) return;
    const target = await pool.query<{ id: string }>(
      "INSERT INTO users (login, login_normalized, password_hash) VALUES ('race.target', 'race.target', 'not-used') RETURNING id"
    );
    const other = await pool.query<{ id: string }>(
      "INSERT INTO users (login, login_normalized, password_hash) VALUES ('race.other', 'race.other', 'not-used') RETURNING id"
    );
    targetUserId = target.rows[0]!.id;
    otherUserId = other.rows[0]!.id;
  });

  afterAll(async () => {
    await store?.close();
    await pool?.end();
  });

  describe("durable SID tombstones and user-bound store locks", () => {
    if (!afterRestart) {
      it("tombstones late set and touch after destroy and preserves the refusal after restart", async () => {
      const sid = `race-late-${randomBytes(12).toString("hex")}`;
      const initial = sessionFor(targetUserId, targetAuthVersion, now);
      await storeSetNew(store, sid, initial);
      const loaded = await storeGet(store, sid);
      assert.ok(loaded);

      await storeDestroy(store, sid);
      await expect(storeSet(store, sid, loaded)).rejects.toThrow();
      await expect(storeTouch(store, sid, loaded)).rejects.toThrow();
      await expect(storeGet(store, sid)).resolves.toBeNull();
      await expect(store.isRevoked(sid)).resolves.toBe(true);

      const sessionRow = await pool.query("SELECT sid FROM \"session\" WHERE sid = $1", [sid]);
      expect(sessionRow.rowCount).toBe(0);
      });

      it("serializes set-before-destroy and touch-before-destroy without leaving a live SID", async () => {
      const setSid = `race-set-first-${randomBytes(12).toString("hex")}`;
      const touchSid = `race-touch-first-${randomBytes(12).toString("hex")}`;
      const value = sessionFor(targetUserId, targetAuthVersion, now);

      await storeSetNew(store, setSid, value);
      await storeSetNew(store, touchSid, value);
      await storeSet(store, setSid, { ...value, marker: "final-save" } as SessionData);
      await storeTouch(store, touchSid, value);
      await storeDestroy(store, setSid);
      await storeDestroy(store, touchSid);

      const result = await pool.query("SELECT COUNT(*)::int AS count FROM \"session\" WHERE sid = ANY($1::varchar[])", [[setSid, touchSid]]);
      expect(result.rows[0]?.count).toBe(0);
      await expect(store.isRevoked(setSid)).resolves.toBe(true);
      await expect(store.isRevoked(touchSid)).resolves.toBe(true);
      });

      it("bulk-revokes every target SID and leaves other users untouched", async () => {
      const targetSids = [`bulk-target-a-${randomBytes(8).toString("hex")}`, `bulk-target-b-${randomBytes(8).toString("hex")}`];
      const otherSid = `bulk-other-${randomBytes(8).toString("hex")}`;
      await Promise.all([
        ...targetSids.map((sid) => storeSetNew(store, sid, sessionFor(targetUserId, targetAuthVersion, now))),
        storeSetNew(store, otherSid, sessionFor(otherUserId, 0, now))
      ]);

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [targetUserId]);
        await store.bulkRevoke(client, targetUserId);
        await client.query("COMMIT");
      } finally {
        client.release();
      }

      const rows = await pool.query("SELECT sid FROM \"session\" WHERE sid = ANY($1::varchar[])", [[...targetSids, otherSid]]);
      expect(rows.rows.map((row) => row.sid)).toEqual([otherSid]);
      for (const sid of targetSids) await expect(store.isRevoked(sid)).resolves.toBe(true);
      await expect(store.isRevoked(otherSid)).resolves.toBe(false);
      });

      it("keeps user mutation and bulk revocation atomic on rollback", async () => {
      const sid = `bulk-rollback-${randomBytes(12).toString("hex")}`;
      await storeSetNew(store, sid, sessionFor(targetUserId, targetAuthVersion, now));

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [targetUserId]);
        await client.query("UPDATE users SET auth_version = auth_version + 1 WHERE id = $1", [targetUserId]);
        await store.bulkRevoke(client, targetUserId);
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }

      expect((await pool.query("SELECT sid FROM \"session\" WHERE sid = $1", [sid])).rowCount).toBe(1);
      await expect(store.isRevoked(sid)).resolves.toBe(false);
      expect((await pool.query("SELECT auth_version FROM users WHERE id = $1", [targetUserId])).rows[0]?.auth_version).toBe(targetAuthVersion);
      });

      it("makes set and touch lose to an atomic user-version update and bulk revoke", async () => {
      const setSid = `bulk-set-loses-${randomBytes(12).toString("hex")}`;
      const touchSid = `bulk-touch-loses-${randomBytes(12).toString("hex")}`;
      const stale = sessionFor(targetUserId, targetAuthVersion, now);
      await storeSetNew(store, setSid, stale);
      await storeSetNew(store, touchSid, stale);

      const loadedSet = await storeGet(store, setSid);
      const loadedTouch = await storeGet(store, touchSid);
      assert.ok(loadedSet && loadedTouch);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [targetUserId]);
        await client.query("UPDATE users SET auth_version = auth_version + 1 WHERE id = $1", [targetUserId]);
        await store.bulkRevoke(client, targetUserId);
        await client.query("COMMIT");
      } finally {
        client.release();
      }

      await expect(storeSet(store, setSid, loadedSet)).rejects.toThrow();
      await expect(storeTouch(store, touchSid, loadedTouch)).rejects.toThrow();
      expect((await pool.query("SELECT sid FROM \"session\" WHERE sid = ANY($1::varchar[])", [[setSid, touchSid]])).rowCount).toBe(0);
      expect((await pool.query("SELECT auth_version FROM users WHERE id = $1", [targetUserId])).rows[0]?.auth_version).toBe(targetAuthVersion + 1);
      targetAuthVersion += 1;
      });

      it("completes concurrent per-session and bulk locks within a bounded interval", async () => {
      const sids = Array.from({ length: 12 }, (_, index) => `lock-order-${index}-${randomBytes(6).toString("hex")}`);
      await Promise.all(sids.map((sid) => storeSetNew(store, sid, sessionFor(targetUserId, targetAuthVersion, now))));

      const operations = sids.map(async (sid, index) => {
        const loaded = await storeGet(store, sid);
        if (!loaded) return;
        try {
          if (index % 3 === 0) await storeDestroy(store, sid);
          else if (index % 3 === 1) await storeTouch(store, sid, loaded);
          else await storeSet(store, sid, loaded);
        } catch (error) {
          if (!(error instanceof Error) || !/revoked|expired|superseded|inactive/iu.test(error.message)) throw error;
        }
      });
      const bulk = (async () => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [targetUserId]);
          await client.query("UPDATE users SET auth_version = auth_version + 1 WHERE id = $1", [targetUserId]);
          await store.bulkRevoke(client, targetUserId);
          await client.query("COMMIT");
        } finally {
          client.release();
        }
      })();
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("store lock-order test timed out")), 8_000); });
      try {
        await Promise.race([Promise.all([...operations, bulk]), timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      expect((await pool.query("SELECT sid FROM \"session\" WHERE sess->'auth'->>'userId' = $1", [targetUserId])).rowCount).toBe(0);
      });
    }

    it("logs in over HTTP, tombstones the SID, and verifies 401 after app restart", async () => {
      const origin = process.env.SESSION_RACE_BASE_URL ?? "http://app:3000";
      if (afterRestart) {
        const saved = JSON.parse(readFileSync(process.env.SESSION_RACE_STATE_PATH!, "utf8")) as { cookie: string; sid: string };
        const response = await fetch(new URL("/api/auth/me", origin), { headers: { cookie: saved.cookie } });
        expect(response.status).toBe(401);
        expect((await pool.query("SELECT sid FROM \"session\" WHERE sid = $1", [saved.sid])).rowCount).toBe(0);
        await expect(store.isRevoked(saved.sid)).resolves.toBe(true);
        return;
      }

      const csrfResponse = await fetch(new URL("/api/auth/csrf", origin));
      expect(csrfResponse.status).toBe(200);
      const csrfCookie = csrfResponse.headers.get("set-cookie")?.split(";", 1)[0];
      assert.ok(csrfCookie);
      const csrf = await csrfResponse.json() as { csrfToken: string };
      const loginResponse = await fetch(new URL("/api/auth/login", origin), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: csrfCookie,
          origin,
          "x-csrf-token": csrf.csrfToken
        },
        body: JSON.stringify({ login: process.env.SESSION_RACE_ADMIN_LOGIN, password: process.env.SESSION_RACE_ADMIN_PASSWORD })
      });
      expect(loginResponse.status).toBe(200);
      const cookie = loginResponse.headers.get("set-cookie")?.split(";", 1)[0];
      assert.ok(cookie);
      const login = await loginResponse.json() as { user: { id: string }; csrfToken: string };
      const user = login.user;
      const row = await pool.query<{ sid: string }>("SELECT sid FROM \"session\" WHERE sess->'auth'->>'userId' = $1", [user.id]);
      expect(row.rowCount).toBe(1);
      const sid = row.rows[0]!.sid;
      const savedSession = await storeGet(store, sid);
      assert.ok(savedSession);

      const logoutResponse = await fetch(new URL("/api/auth/logout", origin), {
        method: "POST",
        headers: { cookie, origin, "x-csrf-token": login.csrfToken }
      });
      expect(logoutResponse.status).toBe(204);
      expect(logoutResponse.headers.get("set-cookie")).toContain("Expires=");

      // Model store callbacks that resume after a concurrent HTTP logout committed its tombstone.
      await expect(storeSet(store, sid, savedSession)).rejects.toThrow();
      await expect(storeTouch(store, sid, savedSession)).rejects.toThrow();

      const response = await fetch(new URL("/api/auth/me", origin), { headers: { cookie } });
      expect(response.status).toBe(401);
      expect((await pool.query("SELECT sid FROM \"session\" WHERE sid = $1", [sid])).rowCount).toBe(0);
      await expect(store.isRevoked(sid)).resolves.toBe(true);
      writeFileSync(process.env.SESSION_RACE_STATE_PATH!, JSON.stringify({ cookie, sid }), { mode: 0o600 });
    });
  });
}
