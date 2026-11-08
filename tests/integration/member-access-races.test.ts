import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { io, type Socket } from "socket.io-client";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertAdministratorWillRemain } from "../../apps/server/src/members/members.service.js";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const commandTimeoutMs = 180_000;
const inContainer = process.env.MEMBER_ACCESS_TEST_IN_CONTAINER === "true";

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

if (!inContainer) {
  describe("member access integration", () => {
    let fixtureDirectory = "";
    let projectName = "";
    let envFile = "";
    let overrideFile = "";
    let adminLogin = "";
    let adminPassword = "";

    function run(args: string[], timeout = commandTimeoutMs) {
      return compose(projectName, envFile, overrideFile, args, timeout);
    }

    function runRunner(stage: "reset" | "disable"): void {
      const args = ["run", "--rm", "--no-deps", "-T", "-e", "MEMBER_ACCESS_TEST_IN_CONTAINER=true", "-e", `MEMBER_ACCESS_TEST_STAGE=${stage}`, "test-runner"];
      const result = run(args, 480_000);
      if (result.status !== 0) {
        const logs = run(["logs", "--no-color", "app"], 30_000);
        process.stderr.write(`App logs after member-access failure:\n${logs.stdout ?? ""}${logs.stderr ?? ""}\n`);
      }
      assertComposeSucceeded(result, args);
    }

    beforeAll(() => {
      fixtureDirectory = mkdtempSync(join(tmpdir(), "decentracord-member-access-"));
      const suffix = randomBytes(6).toString("hex");
      projectName = `decentracord-member-access-${suffix}`;
      const databaseName = `decentracord_test_${suffix}`;
      const databaseUser = `member_access_${suffix.slice(0, 10)}`;
      const databasePassword = randomBytes(24).toString("base64url");
      adminLogin = `member_admin_${suffix.slice(0, 10)}`;
      adminPassword = `Member-admin-${randomBytes(18).toString("base64url")}`;
      const secretFile = join(fixtureDirectory, "db_password");
      envFile = join(fixtureDirectory, "compose.env");
      overrideFile = join(fixtureDirectory, "compose.member-access.yaml");
      const buildxConfig = join(fixtureDirectory, "buildx");
      mkdirSync(buildxConfig, { mode: 0o700 });
      writeFileSync(secretFile, databasePassword, { mode: 0o600 });
      chmodSync(secretFile, 0o600);
      writeFileSync(envFile, [
        `DB_PASSWORD_SECRET_FILE=${secretFile}`,
        `DB_PASSWORD=${databasePassword}`,
        `DB_NAME=${databaseName}`,
        `DB_USER=${databaseUser}`,
        `MEMBER_ACCESS_ADMIN_LOGIN=${adminLogin}`,
        `MEMBER_ACCESS_ADMIN_PASSWORD=${adminPassword}`,
        "DB_CONNECT_TIMEOUT_MS=2500",
        ""
      ].join("\n"), { mode: 0o600 });
      chmodSync(envFile, 0o600);
      writeFileSync(overrideFile, [
        "services:",
        "  app:",
        "    environment:",
        "      APP_HOST: 0.0.0.0",
        "      APP_PORT: 3000",
        "      NODE_ENV: test",
        "    healthcheck:",
        "      test: [\"CMD\", \"node\", \"-e\", \"fetch('http://127.0.0.1:3000/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))\"]",
        "    networks:",
        "      - backend",
        "  test-runner:",
        "    build:",
        `      context: ${JSON.stringify(projectRoot)}`,
        "      dockerfile: Dockerfile",
        "      target: test-runner",
        `    image: ${JSON.stringify(`decentracord-member-access-runner:${suffix}`)}`,
        '    entrypoint: ["npm", "run", "test:integration", "--", "tests/integration/member-access-races.test.ts"]',
        "    environment:",
        "      NODE_ENV: test",
        "      MEMBER_ACCESS_TEST_BASE_URL: http://app:3000",
        "      MEMBER_ACCESS_ADMIN_LOGIN: ${MEMBER_ACCESS_ADMIN_LOGIN}",
        "      MEMBER_ACCESS_ADMIN_PASSWORD: ${MEMBER_ACCESS_ADMIN_PASSWORD}",
        `      TEST_DATABASE_URL: postgresql://${databaseUser}:${databasePassword}@db:5432/${databaseName}`,
        "    networks:",
        "      - backend",
        "    depends_on:",
        "      app:",
        "        condition: service_healthy",
        "",
      ].join("\n"), { mode: 0o600 });
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
      const bootstrapArgs = ["run", "--rm", "--no-deps", "-T", "-i", "-e", `DB_NAME=${databaseName}`, "app", "bootstrap-admin", "--login", adminLogin];
      const bootstrap = spawnSync("docker", ["compose", "--project-name", projectName, "--env-file", envFile, "--file", join(projectRoot, "compose.yaml"), "--file", overrideFile, ...bootstrapArgs], {
        cwd: projectRoot,
        encoding: "utf8",
        env: process.env,
        input: `${adminPassword}\n`,
        maxBuffer: 2 * 1024 * 1024,
        timeout: commandTimeoutMs
      });
      assert.equal(bootstrap.status, 0, `Administrator bootstrap failed: ${bootstrap.error?.message ?? ""}\n${bootstrap.stdout ?? ""}\n${bootstrap.stderr ?? ""}`);
      assert.ok(!`${bootstrap.stdout}\n${bootstrap.stderr}`.includes(adminPassword), "bootstrap output leaked the administrator password");
      const appArgs = ["up", "--detach", "--wait", "--wait-timeout", "90", "app"];
      assertComposeSucceeded(run(appArgs, 180_000), appArgs);
    }, 660_000);

    afterAll(() => {
      if (!fixtureDirectory) return;
      const downArgs = ["down", "--volumes", "--remove-orphans", "--rmi", "local"];
      const result = run(downArgs, 120_000);
      rmSync(fixtureDirectory, { recursive: true, force: true });
      assertComposeSucceeded(result, downArgs);
    });

    it("runs reset, login-race, and self-password checks against PostgreSQL", () => {
      runRunner("reset");
    }, 600_000);

    it("runs disable, last-admin, and concurrent mutation checks against PostgreSQL", () => {
      runRunner("disable");
    }, 600_000);
  }, 1_500_000);
} else {
  interface HttpSession {
    cookie?: string;
    csrfToken?: string;
  }

  interface LoginResponse {
    response: Response;
    session: HttpSession;
  }

  interface MemberIdentity {
    id: string;
    login: string;
    password: string;
  }

  const baseUrl = process.env.MEMBER_ACCESS_TEST_BASE_URL ?? "http://app:3000";
  const appOrigin = new URL(baseUrl).origin;
  const stage = process.env.MEMBER_ACCESS_TEST_STAGE ?? "reset";
  const adminCredentials = {
    login: process.env.MEMBER_ACCESS_ADMIN_LOGIN ?? "",
    password: process.env.MEMBER_ACCESS_ADMIN_PASSWORD ?? ""
  };
  let pool: Pool;
  let adminSession: HttpSession;
  let adminId = "";
  const liveSockets = new Set<Socket>();

  async function request(
    session: HttpSession,
    path: string,
    method = "GET",
    body?: unknown
  ): Promise<Response> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (session.cookie) headers.cookie = session.cookie;
    if (method !== "GET") {
      headers.origin = appOrigin;
      if (session.csrfToken) headers["x-csrf-token"] = session.csrfToken;
    }
    if (body !== undefined) headers["content-type"] = "application/json";
    const options: RequestInit = { method, headers, signal: AbortSignal.timeout(45_000) };
    if (body !== undefined) options.body = JSON.stringify(body);
    const response = await fetch(new URL(path, baseUrl), options);
    const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
    if (cookie) session.cookie = cookie;
    return response;
  }

  async function csrf(session: HttpSession): Promise<string> {
    const response = await request(session, "/api/auth/csrf");
    expect(response.status).toBe(200);
    const body = await response.json() as { csrfToken?: unknown };
    expect(typeof body.csrfToken).toBe("string");
    session.csrfToken = body.csrfToken as string;
    return session.csrfToken;
  }

  async function loginResponse(credentials: { login: string; password: string }): Promise<LoginResponse> {
    const session: HttpSession = {};
    await csrf(session);
    const response = await request(session, "/api/auth/login", "POST", {
      login: credentials.login,
      password: credentials.password
    });
    return { response, session };
  }

  async function login(credentials: { login: string; password: string }): Promise<HttpSession> {
    const result = await loginResponse(credentials);
    expect(result.response.status).toBe(200);
    const body = await result.response.json() as { csrfToken?: unknown };
    expect(typeof body.csrfToken).toBe("string");
    result.session.csrfToken = body.csrfToken as string;
    return result.session;
  }

  async function currentUser(session: HttpSession): Promise<{ id: string; login: string }> {
    const response = await request(session, "/api/auth/me");
    expect(response.status).toBe(200);
    return response.json() as Promise<{ id: string; login: string }>;
  }

  async function createMember(loginValue = `access_${randomBytes(5).toString("hex")}`): Promise<MemberIdentity> {
    const password = `Issued-access-${randomBytes(16).toString("base64url")}`;
    const response = await request(adminSession, "/api/members", "POST", { login: loginValue, password });
    expect(response.status).toBe(201);
    const member = await response.json() as { id: string; login: string };
    return { id: member.id, login: member.login, password };
  }

  async function makeAdministrator(member: MemberIdentity): Promise<void> {
    const result = await pool.query<{ id: string }>("SELECT id FROM roles WHERE system_key = 'administrator'");
    const roleId = result.rows[0]?.id;
    expect(roleId).toBeTruthy();
    await pool.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)", [member.id, roleId]);
  }

  async function resetMember(session: HttpSession, memberId: string, newPassword: string): Promise<Response> {
    return request(session, `/api/members/${memberId}/reset-password`, "POST", { newPassword });
  }

  async function disableMember(session: HttpSession, memberId: string): Promise<Response> {
    return request(session, `/api/members/${memberId}/disable`, "POST");
  }

  function assertConnected(cookie: string, transport: "polling" | "websocket"): Promise<Socket> {
    const socket = io(`${baseUrl}/realtime`, {
      autoConnect: false,
      forceNew: true,
      reconnection: false,
      timeout: 5_000,
      transports: [transport],
      extraHeaders: { cookie, origin: appOrigin }
    });
    liveSockets.add(socket);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.disconnect();
        reject(new Error(`${transport} session readiness timed out`));
      }, 8_000);
      let connected = false;
      let ready = false;
      const finish = () => {
        if (!connected || !ready) return;
        clearTimeout(timer);
        resolve(socket);
      };
      socket.once("connect", () => { connected = true; finish(); });
      socket.once("session:ready", (value: unknown) => {
        if (JSON.stringify(value) !== JSON.stringify({ connected: true })) {
          clearTimeout(timer);
          socket.disconnect();
          reject(new Error("Socket readiness included unexpected data"));
          return;
        }
        ready = true;
        finish();
      });
      socket.once("connect_error", (error) => {
        clearTimeout(timer);
        socket.disconnect();
        reject(error);
      });
      socket.connect();
    });
  }

  function waitForRevocation(socket: Socket): { revoked: Promise<unknown>; disconnected: Promise<string> } {
    const revoked = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("socket did not receive revocation")), 8_000);
      socket.once("session:revoked", (value) => { clearTimeout(timer); resolve(value); });
    });
    const disconnected = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("socket did not disconnect")), 8_000);
      socket.once("disconnect", (reason) => { clearTimeout(timer); resolve(reason); });
    });
    void revoked.catch(() => undefined);
    void disconnected.catch(() => undefined);
    return { revoked, disconnected };
  }

  async function assertRejected(cookie: string, transport: "polling" | "websocket"): Promise<void> {
    const socket = io(`${baseUrl}/realtime`, {
      autoConnect: false,
      forceNew: true,
      reconnection: false,
      timeout: 5_000,
      transports: [transport],
      extraHeaders: { cookie, origin: appOrigin }
    });
    liveSockets.add(socket);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.disconnect();
        reject(new Error(`${transport} unexpectedly reconnected`));
      }, 8_000);
      socket.once("connect_error", () => { clearTimeout(timer); socket.disconnect(); resolve(); });
      socket.once("connect", () => { clearTimeout(timer); socket.disconnect(); reject(new Error(`${transport} unexpectedly connected`)); });
      socket.connect();
    });
    liveSockets.delete(socket);
  }

  async function waitForBlockedLocks(forUpdate: number, forShare = 0): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const result = await pool.query<{ query: string }>(
        `SELECT query
         FROM pg_stat_activity
         WHERE datname = current_database()
           AND usename = current_user
           AND pid <> pg_backend_pid()
           AND wait_event_type = 'Lock'`
      );
      const userRowLocks = result.rows.filter((row) => /\bFROM\s+users\b[\s\S]*\bFOR\s+(?:UPDATE|SHARE)\b/iu.test(row.query));
      const updateCount = userRowLocks.filter((row) => row.query.toUpperCase().includes("FOR UPDATE")).length;
      const shareCount = userRowLocks.filter((row) => row.query.toUpperCase().includes("FOR SHARE")).length;
      if (updateCount >= forUpdate && shareCount >= forShare) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const activity = await pool.query<{
      query: string;
      state: string | null;
      wait_event_type: string | null;
      wait_event: string | null;
    }>(
      `SELECT query, state, wait_event_type, wait_event FROM pg_stat_activity
       WHERE datname = current_database() AND usename = current_user
         AND pid <> pg_backend_pid() AND (state = 'active' OR state = 'idle in transaction')`
    );
    throw new Error(
      `Timed out waiting for blocked database operations: FOR UPDATE >= ${forUpdate}, FOR SHARE >= ${forShare}; ` +
      `observed=${JSON.stringify(activity.rows)}`
    );
  }

  async function lockUser(client: PoolClient, userId: string): Promise<void> {
    await client.query("BEGIN");
    await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);
  }

  async function withHeldUserLock<T>(userId: string, begin: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await lockUser(client, userId);
      return await begin(client);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  }

  async function waitForAppHealth(): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        const health = await fetch(new URL("/healthz", baseUrl), { signal: AbortSignal.timeout(1_000) });
        if (health.ok) return;
      } catch { /* Wait for the isolated app to become healthy. */ }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("isolated app did not become healthy");
  }

  async function expectRequestPending<T>(requestPromise: Promise<T>): Promise<void> {
    const completed = await Promise.race([
      requestPromise.then(() => true, () => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 200))
    ]);
    expect(completed).toBe(false);
  }

  async function expectHttpRequestPending(requestPromise: Promise<Response>, label: string): Promise<void> {
    const completed = await Promise.race([
      requestPromise.then(
        async (response) => ({ status: response.status, body: await response.clone().text() }),
        (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) })
      ),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 200))
    ]);
    if (completed) throw new Error(`${label} completed before the lock barrier: ${JSON.stringify(completed)}`);
  }

  beforeAll(async () => {
    const database = new URL(process.env.TEST_DATABASE_URL ?? "");
    expect(database.hostname).toBe("db");
    expect(database.pathname).toMatch(/^\/decentracord_test/u);
    expect(new URL(baseUrl).hostname).toBe("app");
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 10, connectionTimeoutMillis: 3_000 });
    await waitForAppHealth();
    adminSession = await login(adminCredentials);
    const identity = await currentUser(adminSession);
    adminId = identity.id;
  }, 30_000);

  afterAll(async () => {
    for (const socket of liveSockets) socket.disconnect();
    await pool?.end();
  });

  describe("real account session revocation and row-lock races", () => {
    if (stage === "reset") {
      it("resets a password, disconnects all sockets, rejects old cookies and enforces endpoint authorization", async () => {
        const target = await createMember();
        const targetSessionA = await login(target);
        const targetSessionB = await login(target);
        const oldCookieA = targetSessionA.cookie!;
        const oldCookieB = targetSessionB.cookie!;
        const socketA = await assertConnected(targetSessionA.cookie!, "polling");
        const socketA2 = await assertConnected(targetSessionA.cookie!, "websocket");
        const socketB = await assertConnected(targetSessionB.cookie!, "websocket");
        const revokeA = waitForRevocation(socketA);
        const revokeA2 = waitForRevocation(socketA2);
        const revokeB = waitForRevocation(socketB);
        const replacementPassword = `Reset-winner-${randomBytes(12).toString("base64url")}`;

        const response = await resetMember(adminSession, target.id, replacementPassword);
        expect(response.status).toBe(204);
        await expect(revokeA.revoked).resolves.toEqual({ code: "SESSION_REVOKED" });
        await expect(revokeA2.revoked).resolves.toEqual({ code: "SESSION_REVOKED" });
        await expect(revokeB.revoked).resolves.toEqual({ code: "SESSION_REVOKED" });
        await Promise.all([revokeA.disconnected, revokeA2.disconnected, revokeB.disconnected]);
        expect((await request(targetSessionA, "/api/auth/me")).status).toBe(401);
        expect((await request(targetSessionB, "/api/auth/me")).status).toBe(401);
        await expect(assertRejected(oldCookieA, "polling")).resolves.toBeUndefined();
        await expect(assertRejected(oldCookieB, "websocket")).resolves.toBeUndefined();
        expect((await loginResponse(target)).response.status).toBe(401);
        const fresh = await login({ login: target.login, password: replacementPassword });
        expect((await request(fresh, "/api/auth/me")).status).toBe(200);

        const selfReset = await resetMember(adminSession, adminId, replacementPassword);
        expect(selfReset.status).toBe(409);
        const invalidId = await resetMember(adminSession, "not-a-uuid", replacementPassword);
        expect(invalidId.status).toBe(400);
        const missingId = await resetMember(adminSession, "00000000-0000-4000-8000-000000000000", replacementPassword);
        expect(missingId.status).toBe(404);

        const ordinary = await createMember();
        const ordinarySession = await login(ordinary);
        expect((await resetMember(ordinarySession, target.id, replacementPassword)).status).toBe(403);

        const secondAdministrator = await createMember();
        await makeAdministrator(secondAdministrator);
        expect((await resetMember(adminSession, secondAdministrator.id, replacementPassword)).status).toBe(403);
        socketA.disconnect();
        socketA2.disconnect();
        socketB.disconnect();
      }, 90_000);

      it("makes reset win over an in-flight old-password login session establishment", async () => {
        const target = await createMember();
        const replacementPassword = `Reset-race-${randomBytes(12).toString("base64url")}`;
        const loginSession: HttpSession = {};
        await csrf(loginSession);
        const locker = await pool.connect();
        let resetResponse: Response;
        let loginResult: Response;
        try {
          await lockUser(locker, target.id);
          const loginPromise = request(loginSession, "/api/auth/login", "POST", {
            login: target.login,
            password: target.password
          });
          await expectHttpRequestPending(loginPromise, "Login session establishment");
          await waitForBlockedLocks(0, 1);
          const resetPromise = resetMember(adminSession, target.id, replacementPassword);
          await expectHttpRequestPending(resetPromise, "Administrator password reset");
          await locker.query("COMMIT");
          [resetResponse, loginResult] = await Promise.all([resetPromise, loginPromise]);
        } finally {
          await locker.query("ROLLBACK").catch(() => undefined);
          locker.release();
        }
        expect(resetResponse.status).toBe(204);
        expect(loginResult.status).toBe(200);
        expect((await request(loginSession, "/api/auth/me")).status).toBe(401);
        expect((await loginResponse(target)).response.status).toBe(401);
        const fresh = await login({ login: target.login, password: replacementPassword });
        expect((await request(fresh, "/api/auth/me")).status).toBe(200);
      }, 60_000);

      it("serializes reset with voluntary password changes in both lock orders", async () => {
        const resetFirst = await createMember();
        const resetFirstSession = await login(resetFirst);
        const resetFirstNewPassword = `Reset-first-${randomBytes(12).toString("base64url")}`;
        const changeFirstNewPassword = `Change-first-${randomBytes(12).toString("base64url")}`;
        await withHeldUserLock(resetFirst.id, async (locker) => {
          const resetPromise = resetMember(adminSession, resetFirst.id, resetFirstNewPassword);
          await waitForBlockedLocks(1);
          const changePromise = request(resetFirstSession, "/api/auth/password", "POST", {
            currentPassword: resetFirst.password,
            newPassword: changeFirstNewPassword
          });
          await expectRequestPending(changePromise);
          await waitForBlockedLocks(1);
          await locker.query("COMMIT");
          const [resetResponse, changeResponse] = await Promise.all([resetPromise, changePromise]);
          expect(resetResponse.status).toBe(204);
          expect([401, 403]).toContain(changeResponse.status);
        });
        expect((await request(resetFirstSession, "/api/auth/me")).status).toBe(401);
        expect((await loginResponse(resetFirst)).response.status).toBe(401);
        expect((await loginResponse({ login: resetFirst.login, password: changeFirstNewPassword })).response.status).toBe(401);
        const resetFirstWinner = await login({ login: resetFirst.login, password: resetFirstNewPassword });
        expect((await request(resetFirstWinner, "/api/auth/me")).status).toBe(200);

        const changeFirst = await createMember();
        const changeFirstSession = await login(changeFirst);
        const adminResetPassword = `Reset-last-${randomBytes(12).toString("base64url")}`;
        const personalPassword = `Change-first-${randomBytes(12).toString("base64url")}`;
        await withHeldUserLock(changeFirst.id, async (locker) => {
          const changePromise = request(changeFirstSession, "/api/auth/password", "POST", {
            currentPassword: changeFirst.password,
            newPassword: personalPassword
          });
          await waitForBlockedLocks(1);
          const resetPromise = resetMember(adminSession, changeFirst.id, adminResetPassword);
          await expectRequestPending(resetPromise);
          await waitForBlockedLocks(1);
          await locker.query("COMMIT");
          const [changeResponse, resetResponse] = await Promise.all([changePromise, resetPromise]);
          expect(changeResponse.status).toBe(204);
          expect(resetResponse.status).toBe(204);
        });
        expect((await loginResponse({ login: changeFirst.login, password: changeFirst.password })).response.status).toBe(401);
        expect((await loginResponse({ login: changeFirst.login, password: personalPassword })).response.status).toBe(401);
        const resetWinner = await login({ login: changeFirst.login, password: adminResetPassword });
        expect((await request(resetWinner, "/api/auth/me")).status).toBe(200);
      }, 90_000);
    }

    if (stage === "disable") {
      it("disables a member idempotently, blocks login/reconnect, and keeps identity and assignments", async () => {
        const target = await createMember();
        const targetSessionA = await login(target);
        const targetSessionB = await login(target);
        const oldCookieA = targetSessionA.cookie!;
        const oldCookieB = targetSessionB.cookie!;
        const socketA = await assertConnected(targetSessionA.cookie!, "polling");
        const socketB = await assertConnected(targetSessionB.cookie!, "websocket");
        const revokeA = waitForRevocation(socketA);
        const revokeB = waitForRevocation(socketB);

        expect((await disableMember(adminSession, target.id)).status).toBe(204);
        await expect(revokeA.revoked).resolves.toEqual({ code: "SESSION_REVOKED" });
        await expect(revokeB.revoked).resolves.toEqual({ code: "SESSION_REVOKED" });
        await Promise.all([revokeA.disconnected, revokeB.disconnected]);
        expect((await disableMember(adminSession, target.id)).status).toBe(204);
        expect((await request(targetSessionA, "/api/auth/me")).status).toBe(401);
        expect((await request(targetSessionB, "/api/auth/me")).status).toBe(401);
        await expect(assertRejected(oldCookieA, "polling")).resolves.toBeUndefined();
        await expect(assertRejected(oldCookieB, "websocket")).resolves.toBeUndefined();
        const rejectedLogin = await loginResponse(target);
        expect(rejectedLogin.response.status).toBe(401);
        const rejectedText = await rejectedLogin.response.text();
        expect(rejectedText).not.toMatch(new RegExp(target.login, "iu"));

        const saved = await pool.query<{ id: string; login: string; active: boolean; assignments: number }>(
          `SELECT u.id, u.login, u.active, count(ur.role_id)::int AS assignments
           FROM users AS u LEFT JOIN user_roles AS ur ON ur.user_id = u.id
           WHERE u.id = $1 GROUP BY u.id`,
          [target.id]
        );
        expect(saved.rows[0]).toEqual({ id: target.id, login: target.login, active: false, assignments: 1 });
        const members = await request(adminSession, "/api/members");
        const memberList = await members.json() as { members: Array<{ id: string; login: string; active: boolean }> };
        expect(memberList.members.find((item) => item.id === target.id)).toEqual({ id: target.id, login: target.login, active: false });

        expect((await resetMember(adminSession, target.id, `New-after-disable-${randomBytes(12).toString("base64url")}`)).status).toBe(409);
        expect((await disableMember(adminSession, adminId)).status).toBe(409);
        const invalidId = await disableMember(adminSession, "not-a-uuid");
        expect(invalidId.status).toBe(400);

        const ordinary = await createMember();
        const ordinarySession = await login(ordinary);
        expect((await disableMember(ordinarySession, target.id)).status).toBe(403);

        const secondAdministrator = await createMember();
        await makeAdministrator(secondAdministrator);
        expect((await disableMember(adminSession, secondAdministrator.id)).status).toBe(403);
        socketA.disconnect();
        socketB.disconnect();
      }, 90_000);

      it("enforces the last-administrator invariant as a service guard without a production bypass", async () => {
        const client = await pool.connect();
        try {
          const administratorRole = await client.query<{ id: string }>(
            "SELECT id FROM roles WHERE system_key = 'administrator'"
          );
          const administratorRoleId = administratorRole.rows[0]?.id;
          expect(administratorRoleId).toBeTruthy();
          await client.query("BEGIN");
          await client.query(
            "DELETE FROM user_roles WHERE role_id = $1 AND user_id <> $2",
            [administratorRoleId, adminId]
          );
          await expect(assertAdministratorWillRemain(client, adminId)).rejects.toMatchObject({ status: 409 });
          await client.query("ROLLBACK");

          const secondAdministrator = await createMember();
          await makeAdministrator(secondAdministrator);
          await client.query("BEGIN");
          await client.query(
            "DELETE FROM user_roles WHERE role_id = $1 AND user_id NOT IN ($2, $3)",
            [administratorRoleId, adminId, secondAdministrator.id]
          );
          await expect(assertAdministratorWillRemain(client, adminId)).resolves.toBeUndefined();
          await client.query("ROLLBACK");
        } finally {
          await client.query("ROLLBACK").catch(() => undefined);
          client.release();
        }
      }, 30_000);

      it("does not let disable or reset restore access across password and login races", async () => {
        const target = await createMember();
        const targetSession = await login(target);
        const newPassword = `Password-before-disable-${randomBytes(12).toString("base64url")}`;
        await withHeldUserLock(target.id, async (locker) => {
          const changePromise = request(targetSession, "/api/auth/password", "POST", {
            currentPassword: target.password,
            newPassword
          });
          await waitForBlockedLocks(1);
          const disablePromise = disableMember(adminSession, target.id);
          await expectRequestPending(disablePromise);
          await waitForBlockedLocks(1);
          await locker.query("COMMIT");
          const [changeResponse, disableResponse] = await Promise.all([changePromise, disablePromise]);
          expect(changeResponse.status).toBe(204);
          expect(disableResponse.status).toBe(204);
        });
        expect((await loginResponse({ login: target.login, password: newPassword })).response.status).toBe(401);
        const row = await pool.query<{ active: boolean }>("SELECT active FROM users WHERE id = $1", [target.id]);
        expect(row.rows[0]?.active).toBe(false);

        const loginRaceTarget = await createMember();
        const loginSession: HttpSession = {};
        await csrf(loginSession);
        const locker = await pool.connect();
        let disableResponse: Response;
        let loginResponseResult: Response;
        try {
          await lockUser(locker, loginRaceTarget.id);
          const loginPromise = request(loginSession, "/api/auth/login", "POST", {
            login: loginRaceTarget.login,
            password: loginRaceTarget.password
          });
          await expectHttpRequestPending(loginPromise, "Login session establishment before disable");
          await waitForBlockedLocks(0, 1);
          const disablePromise = disableMember(adminSession, loginRaceTarget.id);
          await expectHttpRequestPending(disablePromise, "Account disable after login session write");
          await locker.query("COMMIT");
          [disableResponse, loginResponseResult] = await Promise.all([disablePromise, loginPromise]);
        } finally {
          await locker.query("ROLLBACK").catch(() => undefined);
          locker.release();
        }
        expect(disableResponse.status).toBe(204);
        expect(loginResponseResult.status).toBe(200);
        expect((await request(loginSession, "/api/auth/me")).status).toBe(401);
        expect((await loginResponse(loginRaceTarget)).response.status).toBe(401);

        const parallel = await createMember();
        const [disableA, disableB] = await Promise.all([
          disableMember(adminSession, parallel.id),
          disableMember(adminSession, parallel.id)
        ]);
        expect([disableA.status, disableB.status]).toEqual([204, 204]);
        const state = await pool.query<{ active: boolean }>("SELECT active FROM users WHERE id = $1", [parallel.id]);
        expect(state.rows[0]?.active).toBe(false);
      }, 120_000);
    }
  });
}
