import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { io, type Socket } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const commandTimeoutMs = 180_000;
const inContainer = process.env.SESSION_REVOCATION_TEST_IN_CONTAINER === "true";

function compose(projectName: string, envFile: string, overrideFile: string, args: string[], timeout = commandTimeoutMs) {
  return spawnSync(
    "docker",
    ["compose", "--project-name", projectName, "--env-file", envFile, "--file", join(projectRoot, "compose.yaml"), "--file", overrideFile, ...args],
    { cwd: projectRoot, encoding: "utf8", timeout, env: process.env, maxBuffer: 4 * 1024 * 1024 }
  );
}

function assertComposeSucceeded(result: ReturnType<typeof compose>, args: string[]): void {
  assert.equal(result.status, 0, `docker compose ${args.join(" ")} failed: ${result.error?.message ?? ""}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
}

function runComposeWithInput(projectName: string, envFile: string, overrideFile: string, args: string[], input: string) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn("docker", ["compose", "--project-name", projectName, "--env-file", envFile, "--file", join(projectRoot, "compose.yaml"), "--file", overrideFile, ...args], {
      cwd: projectRoot,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
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

function assertConnected(origin: string, cookie: string | undefined, transport: "polling" | "websocket", requestedOrigin = origin): Promise<Socket> {
  const socket = io(`${origin}/realtime`, {
    autoConnect: false,
    forceNew: true,
    reconnection: false,
    timeout: 5_000,
    transports: [transport],
    extraHeaders: {
      ...(cookie ? { cookie } : {}),
      origin: requestedOrigin
    }
  });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.disconnect();
      reject(new Error(`${transport} connection or readiness timed out`));
    }, 7_000);
    let isConnected = false;
    let isReady = false;
    const finishWhenReady = () => {
      if (!isConnected || !isReady) return;
      clearTimeout(timer);
      resolve(socket);
    };
    socket.once("connect", () => { isConnected = true; finishWhenReady(); });
    socket.once("session:ready", (value: unknown) => {
      if (JSON.stringify(value) !== JSON.stringify({ connected: true })) {
        clearTimeout(timer);
        socket.disconnect();
        reject(new Error("readiness payload contained unexpected data"));
        return;
      }
      isReady = true;
      finishWhenReady();
    });
    socket.once("connect_error", (error) => {
      clearTimeout(timer);
      socket.disconnect();
      const diagnostic = error as Error & { description?: unknown; data?: unknown; context?: unknown };
      const detail = JSON.stringify({ message: error.message, description: diagnostic.description, data: diagnostic.data, context: diagnostic.context });
      reject(new Error(detail));
    });
    socket.connect();
  });
}

function assertRejected(origin: string, cookie: string | undefined, transport: "polling" | "websocket", requestedOrigin = origin): Promise<void> {
  const socket = io(`${origin}/realtime`, {
    autoConnect: false,
    forceNew: true,
    reconnection: false,
    timeout: 5_000,
    transports: [transport],
    extraHeaders: {
      ...(cookie ? { cookie } : {}),
      origin: requestedOrigin
    }
  });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.disconnect();
      reject(new Error(`${transport} unexpectedly connected`));
    }, 7_000);
    socket.once("connect_error", () => { clearTimeout(timer); socket.disconnect(); resolve(); });
    socket.once("connect", () => { clearTimeout(timer); socket.disconnect(); reject(new Error(`${transport} unexpectedly connected`)); });
    socket.connect();
  });
}

if (!inContainer) {
  describe("HTTP and Socket.IO session revocation in private Compose", () => {
    let fixtureDirectory = "";
    let projectName = "";
    let envFile = "";
    let overrideFile = "";
    let stateDirectory = "";

    function runRunner(stage: "race" | "after-restart"): void {
      const args = ["run", "--rm", "--no-deps", "-T", "-e", "SESSION_REVOCATION_TEST_IN_CONTAINER=true", "-e", `SESSION_REVOCATION_TEST_STAGE=${stage}`, "test-runner"];
      const result = compose(projectName, envFile, overrideFile, args, 360_000);
      if (result.status !== 0) {
        const logs = compose(projectName, envFile, overrideFile, ["logs", "--no-color", "app"], 30_000);
        process.stderr.write(`App logs after integration failure:\n${logs.stdout ?? ""}${logs.stderr ?? ""}\n`);
      }
      assertComposeSucceeded(result, args);
    }

    beforeAll(async () => {
      fixtureDirectory = mkdtempSync(join(tmpdir(), "decentracord-session-revocation-"));
      const suffix = randomBytes(6).toString("hex");
      projectName = `decentracord-session-revocation-${suffix}`;
      const databaseName = `decentracord_test_${suffix}`;
      const databaseUser = `session_revocation_${suffix.slice(0, 10)}`;
      const databasePassword = randomBytes(24).toString("base64url");
      const secretFile = join(fixtureDirectory, "db_password");
      envFile = join(fixtureDirectory, "compose.env");
      overrideFile = join(fixtureDirectory, "compose.revocation.yaml");
      const buildxConfig = join(fixtureDirectory, "buildx");
      stateDirectory = join(fixtureDirectory, "state");
      mkdirSync(buildxConfig, { mode: 0o700 });
      mkdirSync(stateDirectory, { mode: 0o700 });
      writeFileSync(secretFile, databasePassword, { mode: 0o600 });
      chmodSync(secretFile, 0o600);
      writeFileSync(envFile, [
        `DB_PASSWORD_SECRET_FILE=${secretFile}`,
        `DB_PASSWORD=${databasePassword}`,
        `DB_NAME=${databaseName}`,
        `DB_USER=${databaseUser}`,
        `SESSION_REVOCATION_STATE_DIRECTORY=${stateDirectory}`,
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
        `    image: ${JSON.stringify(`decentracord-session-revocation-runner:${suffix}`)}`,
        '    entrypoint: ["npm", "run", "test:integration", "--", "tests/integration/session-revocation.test.ts"]',
        "    environment:",
        "      NODE_ENV: test",
        "      APP_HOST: 127.0.0.1",
        "      DB_HOST: db",
        "      DB_PORT: \"5432\"",
        `      DB_NAME: ${databaseName}`,
        `      DB_USER: ${databaseUser}`,
        "      DB_PASSWORD_FILE: /run/secrets/db_password",
        "      SESSION_SECRET_FILE: /run/secrets/db_password",
        `      TEST_DATABASE_URL: postgresql://${databaseUser}:${databasePassword}@db:5432/${databaseName}`,
        "      SESSION_REVOCATION_BASE_URL: http://app:3000",
        "      SESSION_REVOCATION_STATE_PATH: /revocation-state/stale-session.json",
        "      SESSION_REVOCATION_ADMIN_LOGIN: ${SESSION_REVOCATION_ADMIN_LOGIN}",
        "      SESSION_REVOCATION_ADMIN_PASSWORD: ${SESSION_REVOCATION_ADMIN_PASSWORD}",
        "    secrets:",
        "      - db_password",
        "    volumes:",
        "      - type: bind",
        `        source: ${JSON.stringify(stateDirectory)}`,
        "        target: /revocation-state",
        "    networks:",
        "      - backend",
        "    depends_on:",
        "      db:",
        "        condition: service_healthy",
        "",
      ].join("\n"), { mode: 0o600 });
      chmodSync(overrideFile, 0o600);
      process.env.BUILDX_CONFIG = buildxConfig;
      process.env.npm_config_cache = "/tmp/decentracord-npm-cache";
      process.env.DOCKER_CLI_HINTS = "false";

      const buildArgs = ["build", "app", "test-runner"];
      assertComposeSucceeded(compose(projectName, envFile, overrideFile, buildArgs, 600_000), buildArgs);
      const databaseArgs = ["up", "--detach", "--wait", "--wait-timeout", "90", "db"];
      assertComposeSucceeded(compose(projectName, envFile, overrideFile, databaseArgs, 180_000), databaseArgs);
      const migrateArgs = ["run", "--rm", "--no-deps", "-T", "--entrypoint", "node", "app", "apps/server/dist/cli.js", "migrate"];
      assertComposeSucceeded(compose(projectName, envFile, overrideFile, migrateArgs, 180_000), migrateArgs);

      const adminLogin = `revoke_admin_${suffix.slice(0, 10)}`;
      const adminPassword = `Revoke-test-${randomBytes(18).toString("base64url")}`;
      writeFileSync(join(fixtureDirectory, "credentials.json"), JSON.stringify({ login: adminLogin, password: adminPassword }), { mode: 0o600 });
      const bootstrapArgs = ["run", "--rm", "--no-deps", "-T", "-i", "-e", `DB_NAME=${databaseName}`, "app", "bootstrap-admin", "--login", adminLogin];
      const bootstrap = await runComposeWithInput(projectName, envFile, overrideFile, bootstrapArgs, `${adminPassword}\n`);
      assert.equal(bootstrap.status, 0, `${bootstrap.stdout}\n${bootstrap.stderr}`);
      const environmentFile = join(fixtureDirectory, "compose.env");
      writeFileSync(environmentFile, [
        ...readFileSync(environmentFile, "utf8").trimEnd().split("\n"),
        `SESSION_REVOCATION_ADMIN_LOGIN=${adminLogin}`,
        `SESSION_REVOCATION_ADMIN_PASSWORD=${adminPassword}`,
        ""
      ].join("\n"), { mode: 0o600 });
      chmodSync(environmentFile, 0o600);
    }, 660_000);

    it("runs logout barriers, two transports, and post-restart refusal", () => {
      const upArgs = ["up", "--detach", "--wait", "--wait-timeout", "90", "app"];
      assertComposeSucceeded(compose(projectName, envFile, overrideFile, upArgs, 180_000), upArgs);
      runRunner("race");
      assertComposeSucceeded(compose(projectName, envFile, overrideFile, ["restart", "app"], 120_000), ["restart", "app"]);
      assertComposeSucceeded(compose(projectName, envFile, overrideFile, upArgs, 180_000), upArgs);
      runRunner("after-restart");
    }, 600_000);

    afterAll(() => {
      if (!fixtureDirectory) return;
      const args = ["down", "--volumes", "--remove-orphans", "--rmi", "local"];
      const result = compose(projectName, envFile, overrideFile, args, 120_000);
      rmSync(fixtureDirectory, { recursive: true, force: true });
      assertComposeSucceeded(result, args);
    });
  });
} else {
  const origin = process.env.SESSION_REVOCATION_BASE_URL ?? "http://app:3000";
  const statePath = process.env.SESSION_REVOCATION_STATE_PATH ?? "/revocation-state/stale-session.json";
  const stage = process.env.SESSION_REVOCATION_TEST_STAGE ?? "race";
  const adminLogin = process.env.SESSION_REVOCATION_ADMIN_LOGIN ?? "";
  const adminPassword = process.env.SESSION_REVOCATION_ADMIN_PASSWORD ?? "";
  let staleCookie = "";

  async function loginResponse(password: string): Promise<Response> {
    const csrfResponse = await fetch(new URL("/api/auth/csrf", origin));
    assert.equal(csrfResponse.status, 200);
    const csrfCookie = csrfResponse.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(csrfCookie);
    const csrf = await csrfResponse.json() as { csrfToken: string };
    return fetch(new URL("/api/auth/login", origin), {
      method: "POST",
      headers: { "content-type": "application/json", cookie: csrfCookie, origin, "x-csrf-token": csrf.csrfToken },
      body: JSON.stringify({ login: adminLogin, password })
    });
  }

  async function login(password = adminPassword): Promise<{ cookie: string; csrfToken: string }> {
    const response = await loginResponse(password);
    assert.equal(response.status, 200);
    const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(cookie);
    const result = await response.json() as { csrfToken: string };
    return { cookie, csrfToken: result.csrfToken };
  }

  async function changePassword(
    session: { cookie: string; csrfToken: string },
    currentPassword: string,
    newPassword: string
  ): Promise<Response> {
    return fetch(new URL("/api/auth/password", origin), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: session.cookie,
        origin,
        "x-csrf-token": session.csrfToken
      },
      body: JSON.stringify({ currentPassword, newPassword })
    });
  }

  async function logout(session: { cookie: string; csrfToken: string }): Promise<Response> {
    return fetch(new URL("/api/auth/logout", origin), {
      method: "POST",
      headers: { cookie: session.cookie, origin, "x-csrf-token": session.csrfToken }
    });
  }

  describe("persistent HTTP and Socket.IO session revocation", () => {
    beforeAll(async () => {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        try {
          const health = await fetch(new URL("/healthz", origin), { signal: AbortSignal.timeout(1_000) });
          if (health.ok) return;
        } catch { /* Wait for the isolated app to become healthy. */ }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error("isolated app did not become healthy");
    });

    if (stage === "after-restart") {
      it("rejects the saved cookie over HTTP and both Socket.IO transports after restart", async () => {
        const saved = JSON.parse(readFileSync(statePath, "utf8")) as { cookie: string };
        const response = await fetch(new URL("/api/auth/me", origin), { headers: { cookie: saved.cookie } });
        expect(response.status).toBe(401);
        expect(await response.text()).not.toMatch(/Организация|password_hash/iu);
        for (const transport of ["polling", "websocket"] as const) {
          await expect(assertRejected(origin, saved.cookie, transport)).resolves.toBeUndefined();
        }
      });
    } else {
      it("rejects missing-cookie and cross-origin handshakes for polling and websocket", async () => {
        const guest = await fetch(new URL("/api/organization", origin));
        expect(guest.status).toBe(401);
        expect(await guest.text()).not.toContain("Организация");
        for (const transport of ["polling", "websocket"] as const) {
          await expect(assertRejected(origin, undefined, transport)).resolves.toBeUndefined();
          const active = await login();
          await expect(assertRejected(origin, active.cookie, transport, "http://attacker.invalid")).resolves.toBeUndefined();
        }
      });

      it("disconnects every socket for one session while preserving the user's other session", async () => {
        const sessionA = await login();
        const sessionB = await login();
        const socketA = await assertConnected(origin, sessionA.cookie, "polling");
        const socketAWebSocket = await assertConnected(origin, sessionA.cookie, "websocket");
        const socketB = await assertConnected(origin, sessionB.cookie, "polling");

        const revokedA = new Promise<unknown>((resolve) => socketA.once("session:revoked", resolve));
        const disconnectedA = new Promise<string>((resolve) => socketA.once("disconnect", resolve));
        const disconnectedAWebSocket = new Promise<string>((resolve) => socketAWebSocket.once("disconnect", resolve));
        const logoutResponse = await logout(sessionA);
        expect(logoutResponse.status).toBe(204);
        expect(logoutResponse.headers.get("set-cookie")).toContain("Expires=");
        expect(await revokedA).toEqual({ code: "SESSION_REVOKED" });
        await disconnectedA;
        await disconnectedAWebSocket;

        const staleHttp = await fetch(new URL("/api/auth/me", origin), { headers: { cookie: sessionA.cookie } });
        expect(staleHttp.status).toBe(401);
        expect(await staleHttp.text()).not.toContain("Организация");
        for (const transport of ["polling", "websocket"] as const) {
          await expect(assertRejected(origin, sessionA.cookie, transport)).resolves.toBeUndefined();
        }
        const sessionBResponse = await fetch(new URL("/api/auth/me", origin), { headers: { cookie: sessionB.cookie } });
        expect(sessionBResponse.status).toBe(200);
        expect(await sessionBResponse.json()).toHaveProperty("login", adminLogin);
        expect(socketB.connected).toBe(true);
        socketA.disconnect();
        socketAWebSocket.disconnect();
        socketB.disconnect();
        staleCookie = sessionA.cookie;
      });

      it("disconnects an open socket when its server-side session expires", async () => {
        const active = await login();
        const socket = await assertConnected(origin, active.cookie, "websocket");
        const databaseUrl = process.env.TEST_DATABASE_URL;
        assert.ok(databaseUrl);
        const pool = new Pool({ connectionString: databaseUrl });
        const revoked = new Promise<unknown>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("expired socket was not revoked")), 7_000);
          socket.once("session:revoked", (value) => { clearTimeout(timer); resolve(value); });
        });
        const disconnected = new Promise<string>((resolve) => socket.once("disconnect", resolve));
        try {
          const user = await pool.query<{ id: string }>(
            "SELECT id FROM users WHERE login_normalized = $1",
            [adminLogin]
          );
          assert.ok(user.rows[0]?.id);
          const expired = await pool.query(
            `UPDATE "session" SET expire = now() - interval '1 second'
             WHERE sess->'auth'->>'userId' = $1`,
            [user.rows[0].id]
          );
          expect(expired.rowCount).toBeGreaterThan(0);

          socket.emit("expiry:probe", { kind: "command" });
          await expect(revoked).resolves.toEqual({ code: "SESSION_REVOKED" });
          await disconnected;
          expect(socket.connected).toBe(false);

          const staleHttp = await fetch(new URL("/api/auth/me", origin), { headers: { cookie: active.cookie } });
          expect(staleHttp.status).toBe(401);
        } finally {
          socket.disconnect();
          await pool.end();
        }
      }, 20_000);

      it("changes password atomically, revokes all sessions, rejects stale races, and limits retries", async () => {
        const sessionA = await login();
        const sessionB = await login();
        const invalid = await changePassword(sessionA, "Wrong-current-password-123", "Changed-password-123456");
        expect(invalid.status).toBe(400);
        expect((await invalid.json() as { error: { code: string } }).error.code).toBe("CURRENT_PASSWORD_INVALID");
        expect((await fetch(new URL("/api/auth/me", origin), { headers: { cookie: sessionA.cookie } })).status).toBe(200);
        expect((await loginResponse(adminPassword)).status).toBe(200);

        const socketA = await assertConnected(origin, sessionA.cookie, "polling");
        const socketB = await assertConnected(origin, sessionB.cookie, "websocket");
        const revokedA = new Promise<unknown>((resolve) => socketA.once("session:revoked", resolve));
        const revokedB = new Promise<unknown>((resolve) => socketB.once("session:revoked", resolve));
        const disconnectedA = new Promise<string>((resolve) => socketA.once("disconnect", resolve));
        const disconnectedB = new Promise<string>((resolve) => socketB.once("disconnect", resolve));
        const passwordA = `Changed-password-${randomBytes(12).toString("base64url")}`;
        const passwordB = `Changed-password-${randomBytes(12).toString("base64url")}`;
        const [responseA, responseB] = await Promise.all([
          changePassword(sessionA, adminPassword, passwordA),
          changePassword(sessionB, adminPassword, passwordB)
        ]);
        expect([responseA.status, responseB.status].sort((a, b) => a - b)).toEqual([204, 401]);
        const winnerPassword = responseA.status === 204 ? passwordA : passwordB;
        await expect(revokedA).resolves.toEqual({ code: "SESSION_REVOKED" });
        await expect(revokedB).resolves.toEqual({ code: "SESSION_REVOKED" });
        await disconnectedA;
        await disconnectedB;
        expect((await fetch(new URL("/api/auth/me", origin), { headers: { cookie: sessionA.cookie } })).status).toBe(401);
        expect((await fetch(new URL("/api/auth/me", origin), { headers: { cookie: sessionB.cookie } })).status).toBe(401);
        expect((await loginResponse(adminPassword)).status).toBe(401);

        const fresh = await login(winnerPassword);
        expect((await fetch(new URL("/api/auth/me", origin), { headers: { cookie: fresh.cookie } })).status).toBe(200);
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const rejected = await changePassword(fresh, "Wrong-current-password-123", "Another-new-password-123");
          expect(rejected.status).toBe(400);
          expect((await rejected.json() as { error: { code: string } }).error.code).toBe("CURRENT_PASSWORD_INVALID");
        }
        const limited = await changePassword(fresh, "Wrong-current-password-123", "Another-new-password-123");
        expect(limited.status).toBe(429);
        expect((await limited.json() as { error: { code: string } }).error.code).toBe("TOO_MANY_REQUESTS");
        socketA.disconnect();
        socketB.disconnect();
      }, 60_000);

      afterAll(() => {
        if (!staleCookie) return;
        writeFileSync(statePath, JSON.stringify({ cookie: staleCookie }), { mode: 0o600 });
        chmodSync(statePath, 0o600);
      });
    }
  });
}
