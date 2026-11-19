import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { io, type Socket } from "socket.io-client";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const commandTimeoutMs = 180_000;
const inContainer = process.env.REALTIME_CHANNEL_ACCESS_TEST_IN_CONTAINER === "true";

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
  describe("realtime channel access integration", () => {
    let fixtureDirectory = "";
    let projectName = "";
    let envFile = "";
    let overrideFile = "";

    function run(args: string[], timeout = commandTimeoutMs) {
      return compose(projectName, envFile, overrideFile, args, timeout);
    }

    beforeAll(() => {
      fixtureDirectory = mkdtempSync(join(tmpdir(), "decentracord-realtime-channel-access-"));
      const suffix = randomBytes(6).toString("hex");
      projectName = `decentracord-realtime-channel-access-${suffix}`;
      const databaseName = `decentracord_test_${suffix}`;
      const databaseUser = `realtime_channel_${suffix.slice(0, 10)}`;
      const databasePassword = randomBytes(24).toString("base64url");
      const adminLogin = `realtime_admin_${suffix.slice(0, 10)}`;
      const adminPassword = `Realtime-admin-${randomBytes(18).toString("base64url")}`;
      const secretFile = join(fixtureDirectory, "db_password");
      envFile = join(fixtureDirectory, "compose.env");
      overrideFile = join(fixtureDirectory, "compose.realtime-channel-access.yaml");
      const buildxConfig = join(fixtureDirectory, "buildx");
      mkdirSync(buildxConfig, { mode: 0o700 });
      writeFileSync(secretFile, databasePassword, { mode: 0o600 });
      chmodSync(secretFile, 0o600);
      writeFileSync(envFile, [
        `DB_PASSWORD_SECRET_FILE=${secretFile}`,
        `DB_PASSWORD=${databasePassword}`,
        `DB_NAME=${databaseName}`,
        `DB_USER=${databaseUser}`,
        `REALTIME_CHANNEL_ACCESS_ADMIN_LOGIN=${adminLogin}`,
        `REALTIME_CHANNEL_ACCESS_ADMIN_PASSWORD=${adminPassword}`,
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
        '      test: ["CMD", "node", "-e", "fetch(\'http://127.0.0.1:3000/healthz\').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]',
        "    networks:",
        "      - backend",
        "  test-runner:",
        "    build:",
        `      context: ${JSON.stringify(projectRoot)}`,
        "      dockerfile: Dockerfile",
        "      target: test-runner",
        `    image: ${JSON.stringify(`decentracord-realtime-channel-access-runner:${suffix}`)}`,
        '    entrypoint: ["npm", "run", "test:integration", "--", "tests/integration/realtime-channel-access.test.ts"]',
        "    environment:",
        "      NODE_ENV: test",
        "      REALTIME_CHANNEL_ACCESS_TEST_IN_CONTAINER: \"true\"",
        "      REALTIME_CHANNEL_ACCESS_TEST_BASE_URL: http://app:3000",
        "      REALTIME_CHANNEL_ACCESS_ADMIN_LOGIN: ${REALTIME_CHANNEL_ACCESS_ADMIN_LOGIN}",
        "      REALTIME_CHANNEL_ACCESS_ADMIN_PASSWORD: ${REALTIME_CHANNEL_ACCESS_ADMIN_PASSWORD}",
        `      TEST_DATABASE_URL: postgresql://${databaseUser}:${databasePassword}@db:5432/${databaseName}`,
        "    networks:",
        "      - backend",
        "    depends_on:",
        "      app:",
        "        condition: service_healthy",
        ""
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
      assertComposeSucceeded(bootstrap, bootstrapArgs);
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

    it("revokes channel events without disconnecting the authorized session", () => {
      const args = ["run", "--rm", "--no-deps", "-T", "-e", "REALTIME_CHANNEL_ACCESS_TEST_IN_CONTAINER=true", "test-runner"];
      const result = run(args, 600_000);
      if (result.status !== 0) {
        const logs = run(["logs", "--no-color", "app"], 30_000);
        process.stderr.write(`App logs after realtime-channel-access failure:\n${logs.stdout ?? ""}${logs.stderr ?? ""}\n`);
      }
      assertComposeSucceeded(result, args);
    }, 660_000);
  }, 660_000);
} else {
  interface HttpSession {
    cookie?: string;
    csrfToken?: string;
  }

  interface MemberIdentity {
    id: string;
    login: string;
    password: string;
  }

  interface ChannelIdentity {
    id: string;
    name: string;
  }

  const baseUrl = process.env.REALTIME_CHANNEL_ACCESS_TEST_BASE_URL ?? "http://app:3000";
  const appOrigin = new URL(baseUrl).origin;
  const adminCredentials = {
    login: process.env.REALTIME_CHANNEL_ACCESS_ADMIN_LOGIN ?? "",
    password: process.env.REALTIME_CHANNEL_ACCESS_ADMIN_PASSWORD ?? ""
  };
  let pool: Pool;
  let adminSession: HttpSession;
  const liveSockets = new Set<Socket>();

  async function request(session: HttpSession, path: string, method = "GET", body?: unknown): Promise<Response> {
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

  async function login(credentials: { login: string; password: string }): Promise<HttpSession> {
    const session: HttpSession = {};
    const csrfResponse = await request(session, "/api/auth/csrf");
    expect(csrfResponse.status).toBe(200);
    const csrfBody = await csrfResponse.json() as { csrfToken?: unknown };
    expect(typeof csrfBody.csrfToken).toBe("string");
    session.csrfToken = csrfBody.csrfToken as string;
    const loginResponse = await request(session, "/api/auth/login", "POST", credentials);
    expect(loginResponse.status).toBe(200);
    const loginBody = await loginResponse.json() as { csrfToken?: unknown };
    expect(typeof loginBody.csrfToken).toBe("string");
    session.csrfToken = loginBody.csrfToken as string;
    return session;
  }

  async function createMember(loginValue: string): Promise<MemberIdentity> {
    const password = `Realtime-member-${randomBytes(16).toString("base64url")}`;
    const response = await request(adminSession, "/api/members", "POST", { login: loginValue, password });
    expect(response.status).toBe(201);
    const member = await response.json() as { id: string; login: string };
    return { id: member.id, login: member.login, password };
  }

  async function createChannel(name: string): Promise<ChannelIdentity> {
    const response = await request(adminSession, "/api/channels", "POST", { name });
    expect(response.status).toBe(201);
    return response.json() as Promise<ChannelIdentity>;
  }

  function connect(session: HttpSession): Promise<Socket> {
    if (!session.cookie) throw new Error("Authenticated session cookie is missing");
    const socket = io(`${baseUrl}/realtime`, {
      autoConnect: false,
      forceNew: true,
      reconnection: false,
      timeout: 5_000,
      extraHeaders: { cookie: session.cookie, origin: appOrigin }
    });
    liveSockets.add(socket);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.disconnect();
        reject(new Error("Realtime connection readiness timed out"));
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

  function waitForEvent(socket: Socket, event: string, timeoutMs = 8_000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.off(event, listener);
        reject(new Error(`Socket did not receive ${event}`));
      }, timeoutMs);
      const listener = (payload: unknown) => {
        clearTimeout(timer);
        resolve(payload);
      };
      socket.once(event, listener);
    });
  }

  function waitForEventMatching(
    socket: Socket,
    event: string,
    matches: (payload: unknown) => boolean,
    timeoutMs = 8_000
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.off(event, listener);
        reject(new Error(`Socket did not receive matching ${event}`));
      }, timeoutMs);
      const listener = (payload: unknown) => {
        if (!matches(payload)) return;
        clearTimeout(timer);
        socket.off(event, listener);
        resolve(payload);
      };
      socket.on(event, listener);
    });
  }

  function expectRevokedPayload(payload: unknown, channelId: string): void {
    expect(payload).toMatchObject({ channelId });
    const reason = (payload as { reason?: unknown }).reason;
    expect(typeof reason).toBe("string");
    expect((reason as string).trim().length).toBeGreaterThan(0);
  }

  async function expectNoEvent(socket: Socket, event: string, timeoutMs = 700): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.off(event, listener);
        resolve();
      }, timeoutMs);
      const listener = (payload: unknown) => {
        clearTimeout(timer);
        reject(new Error(`Socket unexpectedly received ${event}: ${JSON.stringify(payload)}`));
      };
      socket.once(event, listener);
    });
  }

  function subscribe(socket: Socket, payload: unknown): Promise<{ event: string; value: unknown }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.off("channel:subscribed", onSubscribed);
        socket.off("channel:subscribe:error", onError);
        reject(new Error("Channel subscription response timed out"));
      }, 8_000);
      const done = (event: string, value: unknown) => {
        clearTimeout(timer);
        socket.off("channel:subscribed", onSubscribed);
        socket.off("channel:subscribe:error", onError);
        resolve({ event, value });
      };
      const onSubscribed = (value: unknown) => done("channel:subscribed", value);
      const onError = (value: unknown) => done("channel:subscribe:error", value);
      socket.once("channel:subscribed", onSubscribed);
      socket.once("channel:subscribe:error", onError);
      socket.emit("channel:subscribe", payload);
    });
  }

  async function renameChannel(channelId: string, name: string): Promise<Response> {
    return request(adminSession, `/api/channels/${channelId}`, "PATCH", { name });
  }

  async function setMemberViewOverride(channelId: string, memberId: string, effect: "allow" | "deny" | "unset"): Promise<Response> {
    return request(adminSession, `/api/channels/${channelId}/overrides`, "PUT", {
      overrides: [{ subject: "member", subjectId: memberId, permission: "VIEW_CHANNEL", effect }]
    });
  }

  beforeAll(async () => {
    const database = new URL(process.env.TEST_DATABASE_URL ?? "");
    expect(database.hostname).toBe("db");
    expect(database.pathname).toMatch(/^\/decentracord_test/u);
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 6, connectionTimeoutMillis: 3_000 });
    adminSession = await login(adminCredentials);
  }, 30_000);

  afterAll(async () => {
    for (const socket of liveSockets) socket.disconnect();
    await pool?.end();
  });

  it("authorizes channel subscriptions and revokes delivery after committed access changes", async () => {
    const suffix = randomBytes(5).toString("hex");
    const viewerRole = await pool.query<{ id: string }>(
      "INSERT INTO roles (name, position, permissions) VALUES ($1, 20, $2::jsonb) RETURNING id",
      [`realtime-viewer-${suffix}`, JSON.stringify(["VIEW_CHANNEL"])]
    );
    const viewerRoleId = viewerRole.rows[0]?.id;
    if (!viewerRoleId) throw new Error("Viewer role was not created");

    const first = await createMember(`realtime_first_${suffix}`);
    const second = await createMember(`realtime_second_${suffix}`);
    await pool.query(
      "INSERT INTO user_roles (user_id, role_id) VALUES ($1, $3), ($2, $3)",
      [first.id, second.id, viewerRoleId]
    );
    const firstSession = await login({ login: first.login, password: first.password });
    const secondSession = await login({ login: second.login, password: second.password });
    const firstSocket = await connect(firstSession);
    const secondSocket = await connect(secondSession);

    const channel = await createChannel(`realtime_channel_${suffix}`);
    const invalidSubscription = await subscribe(firstSocket, { channelId: channel.id, unexpected: true });
    expect(invalidSubscription).toEqual({
      event: "channel:subscribe:error",
      value: { channelId: channel.id, code: "INVALID_REQUEST" }
    });

    await pool.query(
      `INSERT INTO channel_member_overrides (channel_id, user_id, permission, effect)
       VALUES ($1, $2, 'VIEW_CHANNEL', 'deny')
       ON CONFLICT (channel_id, user_id, permission) DO UPDATE SET effect = EXCLUDED.effect`,
      [channel.id, second.id]
    );
    expect(await subscribe(firstSocket, { channelId: channel.id })).toEqual({
      event: "channel:subscribed",
      value: { channelId: channel.id }
    });
    expect(await subscribe(secondSocket, { channelId: channel.id })).toEqual({
      event: "channel:subscribe:error",
      value: { channelId: channel.id, code: "CHANNEL_NOT_FOUND" }
    });
    const firstWhileSecondDenied = waitForEvent(firstSocket, "channel:updated");
    const secondDeniedEvent = expectNoEvent(secondSocket, "channel:updated");
    const deniedName = `denied_${suffix}`;
    expect((await renameChannel(channel.id, deniedName)).status).toBe(200);
    expect(await firstWhileSecondDenied).toEqual({ channelId: channel.id, name: deniedName });
    await secondDeniedEvent;

    await pool.query(
      "DELETE FROM channel_member_overrides WHERE channel_id = $1 AND user_id = $2 AND permission = 'VIEW_CHANNEL'",
      [channel.id, second.id]
    );
    expect(await subscribe(secondSocket, { channelId: channel.id })).toEqual({
      event: "channel:subscribed",
      value: { channelId: channel.id }
    });

    const firstUpdate = waitForEvent(firstSocket, "channel:updated");
    const secondUpdate = waitForEvent(secondSocket, "channel:updated");
    const positiveName = `positive_${suffix}`;
    const positiveResponse = await renameChannel(channel.id, positiveName);
    expect(positiveResponse.status).toBe(200);
    expect(await firstUpdate).toEqual({ channelId: channel.id, name: positiveName });
    expect(await secondUpdate).toEqual({ channelId: channel.id, name: positiveName });

    await pool.query(
      `INSERT INTO channel_member_overrides (channel_id, user_id, permission, effect)
       VALUES ($1, $2, 'VIEW_CHANNEL', 'deny')
       ON CONFLICT (channel_id, user_id, permission) DO UPDATE SET effect = EXCLUDED.effect`,
      [channel.id, second.id]
    );
    const stillAllowed = waitForEvent(firstSocket, "channel:updated");
    const deniedUpdate = expectNoEvent(secondSocket, "channel:updated");
    const directRevokeName = `direct_${suffix}`;
    const deniedResponse = await renameChannel(channel.id, directRevokeName);
    expect(deniedResponse.status).toBe(200);
    expect(await stillAllowed).toEqual({ channelId: channel.id, name: directRevokeName });
    await deniedUpdate;
    expect(secondSocket.connected).toBe(true);
    expect(await subscribe(secondSocket, { channelId: channel.id })).toEqual({
      event: "channel:subscribe:error",
      value: { channelId: channel.id, code: "CHANNEL_NOT_FOUND" }
    });

    const restoreAccess = await setMemberViewOverride(channel.id, second.id, "unset");
    expect(restoreAccess.status, await restoreAccess.text()).toBe(204);
    expect(await subscribe(secondSocket, { channelId: channel.id })).toEqual({
      event: "channel:subscribed",
      value: { channelId: channel.id }
    });

    const syncPromise = waitForEvent(secondSocket, "channels:sync");
    const revokedPromise = waitForEvent(secondSocket, "channel:revoked");
    const notificationOrder: string[] = [];
    secondSocket.once("channels:sync", () => notificationOrder.push("channels:sync"));
    secondSocket.once("channel:revoked", () => notificationOrder.push("channel:revoked"));
    expect((await setMemberViewOverride(channel.id, second.id, "deny")).status).toBe(204);
    const sync = await syncPromise as { channels?: unknown };
    expect(Array.isArray(sync.channels)).toBe(true);
    expect((sync.channels as Array<{ id: string }>).some((visible) => visible.id === channel.id)).toBe(false);
    expectRevokedPayload(await revokedPromise, channel.id);
    expect(notificationOrder).toEqual(["channels:sync", "channel:revoked"]);
    expect(secondSocket.connected).toBe(true);

    const finalFirstUpdate = waitForEvent(firstSocket, "channel:updated");
    const finalSecondUpdate = expectNoEvent(secondSocket, "channel:updated");
    const finalName = `final_${suffix}`;
    expect((await renameChannel(channel.id, finalName)).status).toBe(200);
    expect(await finalFirstUpdate).toEqual({ channelId: channel.id, name: finalName });
    await finalSecondUpdate;
    expect(secondSocket.connected).toBe(true);
  }, 90_000);

  it("synchronizes live channel visibility when member roles or role permissions change", async () => {
    const suffix = randomBytes(5).toString("hex");
    const roleResult = await pool.query<{ id: string }>(
      "INSERT INTO roles (name, position, permissions) VALUES ($1, 30, $2::jsonb) RETURNING id",
      [`realtime-live-viewer-${suffix}`, JSON.stringify(["VIEW_CHANNEL"])]
    );
    const roleId = roleResult.rows[0]?.id;
    if (!roleId) throw new Error("Live viewer role was not created");

    const member = await createMember(`realtime_live_member_${suffix}`);
    const session = await login({ login: member.login, password: member.password });
    const socket = await connect(session);
    const channel = await createChannel(`realtime_live_channel_${suffix}`);

    expect(await subscribe(socket, { channelId: channel.id })).toEqual({
      event: "channel:subscribe:error",
      value: { channelId: channel.id, code: "CHANNEL_NOT_FOUND" }
    });

    const grantedByAssignment = waitForEvent(socket, "channels:sync");
    expect((await request(adminSession, `/api/members/${member.id}/roles`, "PATCH", { roleIds: [roleId] })).status).toBe(204);
    const assignmentGrant = await grantedByAssignment as { channels?: Array<{ id: string }> };
    expect(assignmentGrant.channels?.some((visible) => visible.id === channel.id)).toBe(true);
    expect(await subscribe(socket, { channelId: channel.id })).toEqual({
      event: "channel:subscribed",
      value: { channelId: channel.id }
    });

    const assignmentSync = waitForEvent(socket, "channels:sync");
    const assignmentRevoke = waitForEventMatching(
      socket,
      "channel:revoked",
      (payload) => typeof payload === "object" && payload !== null && "channelId" in payload && payload.channelId === channel.id
    );
    expect((await request(adminSession, `/api/members/${member.id}/roles`, "PATCH", { roleIds: [] })).status).toBe(204);
    const assignmentRevocation = await assignmentSync as { channels?: Array<{ id: string }> };
    expect(assignmentRevocation.channels?.some((visible) => visible.id === channel.id)).toBe(false);
    expectRevokedPayload(await assignmentRevoke, channel.id);
    expect(socket.connected).toBe(true);
    expect(await subscribe(socket, { channelId: channel.id })).toEqual({
      event: "channel:subscribe:error",
      value: { channelId: channel.id, code: "CHANNEL_NOT_FOUND" }
    });

    const reassignedByApi = waitForEvent(socket, "channels:sync");
    expect((await request(adminSession, `/api/members/${member.id}/roles`, "PATCH", { roleIds: [roleId] })).status).toBe(204);
    const reassignmentGrant = await reassignedByApi as { channels?: Array<{ id: string }> };
    expect(reassignmentGrant.channels?.some((visible) => visible.id === channel.id)).toBe(true);
    expect(await subscribe(socket, { channelId: channel.id })).toEqual({
      event: "channel:subscribed",
      value: { channelId: channel.id }
    });

    const revokedByRoleChange = waitForEvent(socket, "channels:sync");
    const roleRevoked = waitForEventMatching(
      socket,
      "channel:revoked",
      (payload) => typeof payload === "object" && payload !== null && "channelId" in payload && payload.channelId === channel.id
    );
    const removePermission = await request(adminSession, `/api/roles/${roleId}`, "PATCH", { permissions: [] });
    expect(removePermission.status).toBe(200);
    const roleRevocation = await revokedByRoleChange as { channels?: Array<{ id: string }> };
    expect(roleRevocation.channels?.some((visible) => visible.id === channel.id)).toBe(false);
    expectRevokedPayload(await roleRevoked, channel.id);
    expect(socket.connected).toBe(true);
    expect(await subscribe(socket, { channelId: channel.id })).toEqual({
      event: "channel:subscribe:error",
      value: { channelId: channel.id, code: "CHANNEL_NOT_FOUND" }
    });

    const roleGrant = waitForEvent(socket, "channels:sync");
    const restorePermission = await request(adminSession, `/api/roles/${roleId}`, "PATCH", { permissions: ["VIEW_CHANNEL"] });
    expect(restorePermission.status).toBe(200);
    const roleGrantSync = await roleGrant as { channels?: Array<{ id: string }> };
    expect(roleGrantSync.channels?.some((visible) => visible.id === channel.id)).toBe(true);
    expect(await subscribe(socket, { channelId: channel.id })).toEqual({
      event: "channel:subscribed",
      value: { channelId: channel.id }
    });
    expect(socket.connected).toBe(true);
  }, 90_000);
}
