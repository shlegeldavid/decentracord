import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
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
const inContainer = process.env.MESSAGING_TEST_IN_CONTAINER === "true";

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
  describe("messaging integration", () => {
    let fixtureDirectory = "";
    let projectName = "";
    let envFile = "";
    let overrideFile = "";

    function run(args: string[], timeout = commandTimeoutMs) {
      return compose(projectName, envFile, overrideFile, args, timeout);
    }

    beforeAll(() => {
      fixtureDirectory = mkdtempSync(join(tmpdir(), "decentracord-messaging-"));
      const suffix = randomBytes(6).toString("hex");
      projectName = `decentracord-messaging-${suffix}`;
      const databaseName = `decentracord_test_${suffix}`;
      const databaseUser = `messaging_${suffix.slice(0, 10)}`;
      const databasePassword = randomBytes(24).toString("base64url");
      const adminLogin = `messaging_admin_${suffix.slice(0, 10)}`;
      const adminPassword = `Messaging-admin-${randomBytes(18).toString("base64url")}`;
      const secretFile = join(fixtureDirectory, "db_password");
      envFile = join(fixtureDirectory, "compose.env");
      overrideFile = join(fixtureDirectory, "compose.messaging.yaml");
      const buildxConfig = join(fixtureDirectory, "buildx");
      mkdirSync(buildxConfig, { mode: 0o700 });
      writeFileSync(secretFile, databasePassword, { mode: 0o600 });
      chmodSync(secretFile, 0o600);
      writeFileSync(envFile, [
        `DB_PASSWORD_SECRET_FILE=${secretFile}`,
        `DB_PASSWORD=${databasePassword}`,
        `DB_NAME=${databaseName}`,
        `DB_USER=${databaseUser}`,
        `MESSAGING_TEST_ADMIN_LOGIN=${adminLogin}`,
        `MESSAGING_TEST_ADMIN_PASSWORD=${adminPassword}`,
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
        `    image: ${JSON.stringify(`decentracord-messaging-runner:${suffix}`)}`,
        '    entrypoint: ["npm", "run", "test:integration", "--", "tests/integration/messaging.test.ts"]',
        "    environment:",
        "      NODE_ENV: test",
        "      MESSAGING_TEST_IN_CONTAINER: \"true\"",
        "      MESSAGING_TEST_BASE_URL: http://app:3000",
        "      MESSAGING_TEST_ADMIN_LOGIN: ${MESSAGING_TEST_ADMIN_LOGIN}",
        "      MESSAGING_TEST_ADMIN_PASSWORD: ${MESSAGING_TEST_ADMIN_PASSWORD}",
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

    it("stores, delivers, edits, deletes, and catches up channel messages", () => {
      const args = ["run", "--rm", "--no-deps", "-T", "-e", "MESSAGING_TEST_IN_CONTAINER=true", "test-runner"];
      const result = run(args, 600_000);
      if (result.status !== 0) {
        const logs = run(["logs", "--no-color", "app"], 30_000);
        process.stderr.write(`App logs after messaging failure:\n${logs.stdout ?? ""}${logs.stderr ?? ""}\n`);
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

  interface MessageView {
    id: string;
    channelId: string;
    authorId: string;
    authorLogin: string;
    seq: number;
    updatedSeq: number;
    content: string;
    mentions: Array<{ id: string; login: string }>;
    editedAt: string | null;
    deleted: boolean;
    clientRequestId: string;
    createdAt: string;
  }

  interface MessageListResponse {
    messages: MessageView[];
    hasMore: boolean;
    cursor: number;
  }

  const baseUrl = process.env.MESSAGING_TEST_BASE_URL ?? "http://app:3000";
  const appOrigin = new URL(baseUrl).origin;
  const adminCredentials = {
    login: process.env.MESSAGING_TEST_ADMIN_LOGIN ?? "",
    password: process.env.MESSAGING_TEST_ADMIN_PASSWORD ?? ""
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
    const loginResponse = await request(session, "/api/auth/login", "POST", {
      login: credentials.login,
      password: credentials.password
    });
    if (loginResponse.status !== 200) {
      throw new Error(`Login failed (${loginResponse.status}): ${JSON.stringify(await loginResponse.json())}`);
    }
    const loginBody = await loginResponse.json() as { csrfToken?: unknown };
    expect(typeof loginBody.csrfToken).toBe("string");
    session.csrfToken = loginBody.csrfToken as string;
    return session;
  }

  async function createMember(loginValue: string): Promise<MemberIdentity> {
    const password = `Messaging-member-${randomBytes(16).toString("base64url")}`;
    const response = await request(adminSession, "/api/members", "POST", { login: loginValue, password });
    expect(response.status).toBe(201);
    const member = await response.json() as { id: string; login: string };
    return { id: member.id, login: member.login, password };
  }

  async function createRole(name: string, position: number, permissions: string[]): Promise<string> {
    const result = await pool.query<{ id: string }>(
      "INSERT INTO roles (system_key, name, position, permissions) VALUES (NULL, $1, $2, $3::jsonb) RETURNING id::text AS id",
      [name, position, JSON.stringify(permissions)]
    );
    const id = result.rows[0]?.id;
    if (!id) throw new Error("Messaging test role was not created");
    return id;
  }

  async function assignRole(memberId: string, roleId: string): Promise<void> {
    await pool.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)", [memberId, roleId]);
  }

  async function createChannel(name: string): Promise<ChannelIdentity> {
    const response = await request(adminSession, "/api/channels", "POST", { name });
    expect(response.status).toBe(201);
    return response.json() as Promise<ChannelIdentity>;
  }

  async function setOverrides(channelId: string, overrides: unknown[]): Promise<Response> {
    return request(adminSession, `/api/channels/${channelId}/overrides`, "PUT", { overrides });
  }

  async function expectError(response: Response, status: number, code: string): Promise<void> {
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code } });
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

  beforeAll(async () => {
    const database = new URL(process.env.TEST_DATABASE_URL ?? "");
    expect(database.hostname).toBe("db");
    expect(database.pathname).toMatch(/^\/decentracord_test_[a-f0-9]+$/u);
    expect(new URL(baseUrl).hostname).toBe("app");
    expect(new URL(baseUrl).port).toBe("3000");
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8, connectionTimeoutMillis: 3_000 });
    adminSession = await login(adminCredentials);
  }, 30_000);

  afterAll(async () => {
    for (const socket of liveSockets) socket.disconnect();
    await pool?.end();
  });

  it("stores, delivers, edits, deletes, and catches up channel messages", async () => {
    const suffix = randomBytes(5).toString("hex");
    const senderRoleId = await createRole(`messaging-sender-${suffix}`, 20, ["VIEW_CHANNEL", "SEND_MESSAGES"]);
    const managerRoleId = await createRole(`messaging-manager-${suffix}`, 21, ["VIEW_CHANNEL", "SEND_MESSAGES", "MANAGE_MESSAGES"]);
    const viewerRoleId = await createRole(`messaging-viewer-${suffix}`, 22, ["VIEW_CHANNEL"]);
    const sender = await createMember(`messaging_sender_${suffix}`);
    const recipient = await createMember(`messaging_recipient_${suffix}`);
    const manager = await createMember(`messaging_manager_${suffix}`);
    const viewer = await createMember(`messaging_viewer_${suffix}`);
    const revoked = await createMember(`messaging_revoked_${suffix}`);
    const outsider = await createMember(`messaging_outsider_${suffix}`);
    const administrator = await createMember(`messaging_admin_${suffix}`);
    await Promise.all([
      assignRole(sender.id, senderRoleId),
      assignRole(recipient.id, senderRoleId),
      assignRole(manager.id, managerRoleId),
      assignRole(viewer.id, viewerRoleId),
      assignRole(revoked.id, viewerRoleId),
      assignRole(outsider.id, viewerRoleId)
    ]);
    const adminRole = await pool.query<{ id: string }>("SELECT id::text AS id FROM roles WHERE system_key = 'administrator'");
    const adminRoleId = adminRole.rows[0]?.id;
    if (!adminRoleId) throw new Error("Administrator role was not created");
    await assignRole(administrator.id, adminRoleId);

    const channel = await createChannel(`messaging_channel_${suffix}`);
    const readOnlyChannel = await createChannel(`messaging_readonly_${suffix}`);
    const singleMessageChannel = await createChannel(`messaging_single_${suffix}`);
    const sendableOverrides = [
      { subject: "everyone", subjectId: null, permission: "VIEW_CHANNEL", effect: "allow" },
      { subject: "everyone", subjectId: null, permission: "SEND_MESSAGES", effect: "allow" }
    ];
    expect((await setOverrides(channel.id, sendableOverrides)).status).toBe(204);
    expect((await setOverrides(singleMessageChannel.id, sendableOverrides)).status).toBe(204);
    expect((await setOverrides(readOnlyChannel.id, [
      { subject: "everyone", subjectId: null, permission: "VIEW_CHANNEL", effect: "allow" },
      { subject: "everyone", subjectId: null, permission: "SEND_MESSAGES", effect: "deny" }
    ])).status).toBe(204);
    await pool.query(
      `INSERT INTO channel_member_overrides (channel_id, user_id, permission, effect)
       VALUES ($1, $2, 'VIEW_CHANNEL', 'deny')
       ON CONFLICT (channel_id, user_id, permission) DO UPDATE SET effect = EXCLUDED.effect`,
      [channel.id, outsider.id]
    );

    const senderSession = await login(sender);
    const recipientSession = await login(recipient);
    const managerSession = await login(manager);
    let viewerSession = await login(viewer);
    const revokedSession = await login(revoked);
    const outsiderSession = await login(outsider);
    const administratorSession = await login(administrator);
    const senderSocket = await connect(senderSession);
    const recipientSocket = await connect(recipientSession);
    const revokedSocket = await connect(revokedSession);
    const outsiderSocket = await connect(outsiderSession);
    expect(await subscribe(senderSocket, { channelId: channel.id })).toEqual({
      event: "channel:subscribed",
      value: { channelId: channel.id }
    });
    expect(await subscribe(recipientSocket, { channelId: channel.id })).toEqual({
      event: "channel:subscribed",
      value: { channelId: channel.id }
    });
    expect(await subscribe(revokedSocket, { channelId: channel.id })).toEqual({
      event: "channel:subscribed",
      value: { channelId: channel.id }
    });
    expect(await subscribe(outsiderSocket, { channelId: channel.id })).toEqual({
      event: "channel:subscribe:error",
      value: { channelId: channel.id, code: "CHANNEL_NOT_FOUND" }
    });

    const membersResponse = await request(senderSession, `/api/channels/${channel.id}/members`);
    expect(membersResponse.status).toBe(200);
    const membersBody = await membersResponse.json() as { members: Array<{ id: string; login: string }> };
    expect(membersBody.members.some((member) => member.id === sender.id)).toBe(true);
    expect(membersBody.members.some((member) => member.id === recipient.id)).toBe(true);
    expect(membersBody.members.some((member) => member.id === outsider.id)).toBe(false);

    const clientRequestId = randomUUID();
    const sentEventPromise = waitForEvent(recipientSocket, "message:created");
    const outsideEventPromise = expectNoEvent(outsiderSocket, "message:created", 1_000);
    const sentResponse = await request(senderSession, `/api/channels/${channel.id}/messages`, "POST", {
      content: `hello @${recipient.login} @${outsider.login}`,
      clientRequestId
    });
    const sentResponseBody = await sentResponse.json() as unknown;
    expect(sentResponse.status, JSON.stringify(sentResponseBody)).toBe(201);
    const sentMessage = sentResponseBody as MessageView;
    expect(sentMessage).toMatchObject({
      channelId: channel.id,
      authorId: sender.id,
      authorLogin: sender.login,
      content: `hello @${recipient.login} @${outsider.login}`,
      clientRequestId,
      deleted: false
    });
    expect(typeof sentMessage.seq).toBe("number");
    expect(typeof sentMessage.updatedSeq).toBe("number");
    expect(sentMessage.mentions).toEqual([{ id: recipient.id, login: recipient.login }]);
    const sentEvent = await sentEventPromise as { channelId: string; message: MessageView };
    expect(sentEvent).toEqual({ channelId: channel.id, message: sentMessage });
    expect(sentEvent.message.authorLogin).toBe(sender.login);
    expect(Array.isArray(sentEvent.message.mentions)).toBe(true);
    expect(typeof sentEvent.message.seq).toBe("number");
    expect(typeof sentEvent.message.updatedSeq).toBe("number");
    await outsideEventPromise;

    const senderChannelsResponse = await request(senderSession, "/api/channels");
    expect(senderChannelsResponse.status).toBe(200);
    const senderChannelsBody = await senderChannelsResponse.json() as {
      channels: Array<{ id: string; unreadCount?: unknown }>;
    };
    const senderChannelBeforeUnread = senderChannelsBody.channels.find((entry) => entry.id === channel.id);
    expect(typeof senderChannelBeforeUnread?.unreadCount).toBe("number");
    expect(senderChannelBeforeUnread?.unreadCount).toBe(0);

    const readPastResponse = await request(recipientSession, `/api/channels/${channel.id}/messages`, "POST", {
      content: "unread before read cursor",
      clientRequestId: randomUUID()
    });
    expect(readPastResponse.status).toBe(201);
    const readPastMessage = await readPastResponse.json() as MessageView;
    const readCursorResponse = await request(senderSession, `/api/channels/${channel.id}/messages`, "POST", {
      content: "read cursor sequence",
      clientRequestId: randomUUID()
    });
    expect(readCursorResponse.status).toBe(201);
    const readCursorMessage = await readCursorResponse.json() as MessageView;
    const updateReadPastResponse = await request(
      recipientSession,
      `/api/channels/${channel.id}/messages/${readPastMessage.id}`,
      "PATCH",
      { content: "updated before the read cursor" }
    );
    expect(updateReadPastResponse.status).toBe(200);
    const updatedReadPastMessage = await updateReadPastResponse.json() as MessageView;
    expect(updatedReadPastMessage.seq).toBe(readPastMessage.seq);
    expect(updatedReadPastMessage.updatedSeq).toBeGreaterThan(readCursorMessage.seq);
    const unreadAfterCursorResponse = await request(recipientSession, `/api/channels/${channel.id}/messages`, "POST", {
      content: "unread after read cursor",
      clientRequestId: randomUUID()
    });
    expect(unreadAfterCursorResponse.status).toBe(201);

    const unreadBeforeMarkResponse = await request(senderSession, "/api/channels");
    const unreadBeforeMark = await unreadBeforeMarkResponse.json() as {
      channels: Array<{ id: string; unreadCount?: unknown }>;
    };
    expect(unreadBeforeMarkResponse.status).toBe(200);
    const unreadChannelBeforeMark = unreadBeforeMark.channels.find((entry) => entry.id === channel.id);
    expect(typeof unreadChannelBeforeMark?.unreadCount).toBe("number");
    expect(unreadChannelBeforeMark?.unreadCount).toBe(2);

    const markReadResponse = await request(senderSession, `/api/channels/${channel.id}/read`, "POST", {
      seq: readCursorMessage.seq
    });
    expect(markReadResponse.status).toBe(204);
    expect(await markReadResponse.text()).toBe("");
    const unreadAfterMarkResponse = await request(senderSession, "/api/channels");
    const unreadAfterMark = await unreadAfterMarkResponse.json() as {
      channels: Array<{ id: string; unreadCount?: unknown }>;
    };
    expect(unreadAfterMarkResponse.status).toBe(200);
    expect(unreadAfterMark.channels.find((entry) => entry.id === channel.id)?.unreadCount).toBe(1);

    const channelAfterMarkResponse = await request(senderSession, `/api/channels/${channel.id}`);
    expect(channelAfterMarkResponse.status).toBe(200);
    const channelAfterMark = await channelAfterMarkResponse.json() as {
      channel: { id: string; unreadCount?: unknown };
    };
    expect(channelAfterMark.channel.id).toBe(channel.id);
    expect(channelAfterMark.channel.unreadCount).toBe(1);
    expect(typeof channelAfterMark.channel.unreadCount).toBe("number");

    const markReadAboveMaximumResponse = await request(senderSession, `/api/channels/${channel.id}/read`, "POST", {
      seq: 1_000_000
    });
    expect(markReadAboveMaximumResponse.status).toBe(204);
    const unreadAfterClampResponse = await request(senderSession, "/api/channels");
    const unreadAfterClamp = await unreadAfterClampResponse.json() as {
      channels: Array<{ id: string; unreadCount?: unknown }>;
    };
    expect(unreadAfterClamp.channels.find((entry) => entry.id === channel.id)?.unreadCount).toBe(0);
    const markReadLowerResponse = await request(senderSession, `/api/channels/${channel.id}/read`, "POST", { seq: 0 });
    expect(markReadLowerResponse.status).toBe(204);
    const unreadAfterLowerResponse = await request(senderSession, "/api/channels");
    const unreadAfterLower = await unreadAfterLowerResponse.json() as {
      channels: Array<{ id: string; unreadCount?: unknown }>;
    };
    expect(unreadAfterLower.channels.find((entry) => entry.id === channel.id)?.unreadCount).toBe(0);
    await expectError(await request(senderSession, `/api/channels/${channel.id}/read`, "POST", { seq: 0, extra: true }), 400, "INVALID_REQUEST");

    const duplicateResponse = await request(senderSession, `/api/channels/${channel.id}/messages`, "POST", {
      content: `hello @${recipient.login} @${outsider.login}`,
      clientRequestId
    });
    expect(duplicateResponse.status).toBe(201);
    const duplicateMessage = await duplicateResponse.json() as MessageView;
    expect(duplicateMessage.id).toBe(sentMessage.id);
    expect(duplicateMessage.seq).toBe(sentMessage.seq);
    const duplicateCount = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM messages WHERE channel_id = $1 AND author_id = $2 AND client_request_id = $3",
      [channel.id, sender.id, clientRequestId]
    );
    expect(duplicateCount.rows[0]?.count).toBe(1);

    const singleRequestId = randomUUID();
    const singleSend = await request(senderSession, `/api/channels/${singleMessageChannel.id}/messages`, "POST", {
      content: "only message",
      clientRequestId: singleRequestId
    });
    expect(singleSend.status).toBe(201);
    const singleMessage = await singleSend.json() as MessageView;
    const singleHistoryResponse = await request(viewerSession, `/api/channels/${singleMessageChannel.id}/messages`);
    expect(singleHistoryResponse.status).toBe(200);
    const singleHistory = await singleHistoryResponse.json() as MessageListResponse;
    expect(Object.keys(singleHistory).sort()).toEqual(["cursor", "hasMore", "messages"]);
    expect(singleHistory.messages).toHaveLength(1);
    expect(singleHistory.messages[0]?.id).toBe(singleMessage.id);
    expect(typeof singleHistory.cursor).toBe("number");
    expect(typeof singleHistory.hasMore).toBe("boolean");
    const singleCursorInDatabase = await pool.query<{ last_seq: number }>(
      "SELECT last_seq::int AS last_seq FROM channels WHERE id = $1",
      [singleMessageChannel.id]
    );
    expect(singleHistory.cursor).toBe(singleCursorInDatabase.rows[0]?.last_seq);

    const catchUpFirstResponse = await request(recipientSession, `/api/channels/${singleMessageChannel.id}/messages`, "POST", {
      content: "first message after cursor",
      clientRequestId: randomUUID()
    });
    expect(catchUpFirstResponse.status).toBe(201);
    const catchUpFirstMessage = await catchUpFirstResponse.json() as MessageView;
    const catchUpSecondResponse = await request(recipientSession, `/api/channels/${singleMessageChannel.id}/messages`, "POST", {
      content: "second message after cursor",
      clientRequestId: randomUUID()
    });
    expect(catchUpSecondResponse.status).toBe(201);
    const catchUpSecondMessage = await catchUpSecondResponse.json() as MessageView;
    const twoMessageCatchUpResponse = await request(
      viewerSession,
      `/api/channels/${singleMessageChannel.id}/messages?after=${singleHistory.cursor}`
    );
    expect(twoMessageCatchUpResponse.status).toBe(200);
    const twoMessageCatchUp = await twoMessageCatchUpResponse.json() as MessageListResponse;
    expect(twoMessageCatchUp.messages.map((message) => message.id)).toEqual([catchUpFirstMessage.id, catchUpSecondMessage.id]);
    expect(twoMessageCatchUp.messages).toHaveLength(2);
    expect(twoMessageCatchUp.messages[0]?.updatedSeq).toBeLessThan(twoMessageCatchUp.messages[1]?.updatedSeq ?? 0);
    expect(twoMessageCatchUp.cursor).toBeGreaterThan(singleHistory.cursor);
    const repeatedCatchUpResponse = await request(
      viewerSession,
      `/api/channels/${singleMessageChannel.id}/messages?after=${twoMessageCatchUp.cursor}`
    );
    expect(repeatedCatchUpResponse.status).toBe(200);
    const repeatedCatchUp = await repeatedCatchUpResponse.json() as MessageListResponse;
    expect(repeatedCatchUp.messages).toEqual([]);

    const historyResponse = await request(viewerSession, `/api/channels/${channel.id}/messages`);
    expect(historyResponse.status).toBe(200);
    const history = await historyResponse.json() as MessageListResponse;
    expect(Object.keys(history).sort()).toEqual(["cursor", "hasMore", "messages"]);
    expect(typeof history.cursor).toBe("number");
    expect(typeof history.hasMore).toBe("boolean");
    expect(history.messages.find((message) => message.id === sentMessage.id)?.mentions).toEqual([
      { id: recipient.id, login: recipient.login }
    ]);
    const historyCursorInDatabase = await pool.query<{ last_seq: number }>(
      "SELECT last_seq::int AS last_seq FROM channels WHERE id = $1",
      [channel.id]
    );
    expect(history.cursor).toBe(historyCursorInDatabase.rows[0]?.last_seq);
    await expectError(await request(viewerSession, `/api/channels/${channel.id}/messages?before=0&after=0`), 400, "INVALID_REQUEST");
    await expectError(await request(viewerSession, `/api/channels/${channel.id}/messages?limit=101`), 400, "INVALID_REQUEST");

    const editableRequestId = randomUUID();
    const editableResponse = await request(senderSession, `/api/channels/${channel.id}/messages`, "POST", {
      content: `please edit @${recipient.login}`,
      clientRequestId: editableRequestId
    });
    expect(editableResponse.status).toBe(201);
    const editableMessage = await editableResponse.json() as MessageView;
    expect(editableMessage.mentions).toEqual([{ id: recipient.id, login: recipient.login }]);
    const editEventPromise = waitForEvent(recipientSocket, "message:updated");
    const editResponse = await request(senderSession, `/api/channels/${channel.id}/messages/${editableMessage.id}`, "PATCH", {
      content: "edited without a mention"
    });
    expect(editResponse.status).toBe(200);
    const editedMessage = await editResponse.json() as MessageView;
    expect(editedMessage.content).toBe("edited without a mention");
    expect(editedMessage.editedAt).not.toBeNull();
    expect(editedMessage.mentions).toEqual([]);
    expect(typeof editedMessage.updatedSeq).toBe("number");
    const editEvent = await editEventPromise as { channelId: string; message: MessageView };
    expect(editEvent).toEqual({ channelId: channel.id, message: editedMessage });
    expect(editEvent.message.authorLogin).toBe(sender.login);
    expect(Array.isArray(editEvent.message.mentions)).toBe(true);
    expect(typeof editEvent.message.updatedSeq).toBe("number");

    const foreignRequestId = randomUUID();
    const foreignResponse = await request(recipientSession, `/api/channels/${channel.id}/messages`, "POST", {
      content: "recipient message",
      clientRequestId: foreignRequestId
    });
    expect(foreignResponse.status).toBe(201);
    const foreignMessage = await foreignResponse.json() as MessageView;
    await expectError(await request(senderSession, `/api/channels/${channel.id}/messages/${foreignMessage.id}`, "PATCH", {
      content: "unauthorized edit"
    }), 403, "FORBIDDEN");
    await expectError(await request(managerSession, `/api/channels/${channel.id}/messages/${foreignMessage.id}`, "PATCH", {
      content: "management does not grant edits"
    }), 403, "FORBIDDEN");

    const oldRequestId = randomUUID();
    const oldResponse = await request(senderSession, `/api/channels/${channel.id}/messages`, "POST", {
      content: "old message",
      clientRequestId: oldRequestId
    });
    expect(oldResponse.status).toBe(201);
    const oldMessage = await oldResponse.json() as MessageView;
    await pool.query("UPDATE messages SET created_at = now() - interval '4 days' WHERE id = $1", [oldMessage.id]);
    await expectError(await request(senderSession, `/api/channels/${channel.id}/messages/${oldMessage.id}`, "PATCH", {
      content: "outside edit window"
    }), 403, "EDIT_WINDOW_EXPIRED");

    const authorDeleteRequestId = randomUUID();
    const authorDeleteResponse = await request(senderSession, `/api/channels/${channel.id}/messages`, "POST", {
      content: "delete my message",
      clientRequestId: authorDeleteRequestId
    });
    expect(authorDeleteResponse.status).toBe(201);
    const authorDeleteMessage = await authorDeleteResponse.json() as MessageView;
    const cursorBeforeDeleteResult = await pool.query<{ last_seq: number }>(
      "SELECT last_seq::int AS last_seq FROM channels WHERE id = $1",
      [channel.id]
    );
    const cursorBeforeDelete = cursorBeforeDeleteResult.rows[0]?.last_seq;
    if (cursorBeforeDelete === undefined) throw new Error("Channel sequence was not found");
    const deleteEventPromise = waitForEvent(recipientSocket, "message:deleted");
    const deleteResponse = await request(senderSession, `/api/channels/${channel.id}/messages/${authorDeleteMessage.id}`, "DELETE");
    expect(deleteResponse.status).toBe(204);
    expect(await deleteResponse.text()).toBe("");
    const deleteEvent = await deleteEventPromise as { channelId: string; messageId: string; updatedSeq: number };
    expect(deleteEvent).toMatchObject({ channelId: channel.id, messageId: authorDeleteMessage.id });
    expect(typeof deleteEvent.updatedSeq).toBe("number");
    expect(deleteEvent.updatedSeq).toBeGreaterThan(cursorBeforeDelete);
    const tombstone = await pool.query<{ deleted_at: Date | null; updated_seq: number }>(
      "SELECT deleted_at, updated_seq::int AS updated_seq FROM messages WHERE id = $1",
      [authorDeleteMessage.id]
    );
    expect(tombstone.rows[0]?.deleted_at).not.toBeNull();
    expect(tombstone.rows[0]?.updated_seq).toBe(deleteEvent.updatedSeq);
    const historyAfterDeleteResponse = await request(viewerSession, `/api/channels/${channel.id}/messages`);
    expect(historyAfterDeleteResponse.status).toBe(200);
    const historyAfterDelete = await historyAfterDeleteResponse.json() as MessageListResponse;
    expect(historyAfterDelete.messages.some((message) => message.id === authorDeleteMessage.id)).toBe(false);
    const catchUpResponse = await request(viewerSession, `/api/channels/${channel.id}/messages?after=${cursorBeforeDelete}`);
    expect(catchUpResponse.status).toBe(200);
    const catchUp = await catchUpResponse.json() as MessageListResponse;
    expect(Object.keys(catchUp).sort()).toEqual(["cursor", "hasMore", "messages"]);
    expect(catchUp.messages).toContainEqual(expect.objectContaining({ id: authorDeleteMessage.id, deleted: true }));
    const deletedInCatchUp = catchUp.messages.find((message) => message.id === authorDeleteMessage.id);
    expect(typeof deletedInCatchUp?.updatedSeq).toBe("number");
    expect(typeof catchUp.cursor).toBe("number");
    expect(catchUp.cursor).toBe(deleteEvent.updatedSeq);

    const managerDeleteEventPromise = waitForEvent(senderSocket, "message:deleted");
    const managerDeleteResponse = await request(managerSession, `/api/channels/${channel.id}/messages/${foreignMessage.id}`, "DELETE");
    expect(managerDeleteResponse.status).toBe(204);
    const managerDeleteEvent = await managerDeleteEventPromise as { channelId: string; messageId: string; updatedSeq: number };
    expect(managerDeleteEvent.messageId).toBe(foreignMessage.id);
    expect(typeof managerDeleteEvent.updatedSeq).toBe("number");
    await expectError(await request(viewerSession, `/api/channels/${channel.id}/messages/${sentMessage.id}`, "DELETE"), 403, "FORBIDDEN");

    const adminDeleteRequestId = randomUUID();
    const adminDeleteMessageResponse = await request(senderSession, `/api/channels/${channel.id}/messages`, "POST", {
      content: "administrator can delete",
      clientRequestId: adminDeleteRequestId
    });
    expect(adminDeleteMessageResponse.status).toBe(201);
    const adminDeleteMessage = await adminDeleteMessageResponse.json() as MessageView;
    const administratorDeleteResponse = await request(administratorSession, `/api/channels/${channel.id}/messages/${adminDeleteMessage.id}`, "DELETE");
    expect(administratorDeleteResponse.status).toBe(204);
    const administratorTombstone = await pool.query<{ deleted_at: Date | null }>(
      "SELECT deleted_at FROM messages WHERE id = $1",
      [adminDeleteMessage.id]
    );
    expect(administratorTombstone.rows[0]?.deleted_at).not.toBeNull();

    await expectError(await request(senderSession, `/api/channels/${readOnlyChannel.id}/messages`, "POST", {
      content: "cannot send here",
      clientRequestId: randomUUID()
    }), 403, "SEND_NOT_ALLOWED");
    await expectError(await request(senderSession, `/api/channels/${channel.id}/messages`, "POST", {
      content: "x".repeat(2001),
      clientRequestId: randomUUID()
    }), 400, "INVALID_REQUEST");
    await expectError(await request(senderSession, `/api/channels/${channel.id}/messages`, "POST", {
      content: "unknown key",
      clientRequestId: randomUUID(),
      extra: true
    }), 400, "INVALID_REQUEST");

    const logoutResponse = await request(viewerSession, "/api/auth/logout", "POST");
    expect(logoutResponse.status).toBe(204);
    viewerSession = await login(viewer);
    const historyAfterReloginResponse = await request(viewerSession, `/api/channels/${channel.id}/messages`);
    expect(historyAfterReloginResponse.status).toBe(200);
    const historyAfterRelogin = await historyAfterReloginResponse.json() as MessageListResponse;
    expect(historyAfterRelogin.messages.some((message) => message.id === sentMessage.id)).toBe(true);
    const storedMessage = await pool.query<{ id: string }>("SELECT id::text AS id FROM messages WHERE id = $1", [sentMessage.id]);
    expect(storedMessage.rows[0]?.id).toBe(sentMessage.id);

    await pool.query(
      `INSERT INTO channel_member_overrides (channel_id, user_id, permission, effect)
       VALUES ($1, $2, 'VIEW_CHANNEL', 'deny')
       ON CONFLICT (channel_id, user_id, permission) DO UPDATE SET effect = EXCLUDED.effect`,
      [channel.id, revoked.id]
    );
    expect(revokedSocket.connected).toBe(true);
    const recipientAfterRevoke = waitForEvent(recipientSocket, "message:created");
    const revokedNoEvent = expectNoEvent(revokedSocket, "message:created", 1_000);
    const revokeCheckResponse = await request(senderSession, `/api/channels/${channel.id}/messages`, "POST", {
      content: "delivery after access revocation",
      clientRequestId: randomUUID()
    });
    expect(revokeCheckResponse.status).toBe(201);
    const revokeCheckMessage = await revokeCheckResponse.json() as MessageView;
    expect((await recipientAfterRevoke as { message: MessageView }).message.id).toBe(revokeCheckMessage.id);
    await revokedNoEvent;
    expect(revokedSocket.connected).toBe(true);
    await expectError(await request(revokedSession, `/api/channels/${channel.id}/messages?before=0`), 404, "CHANNEL_NOT_FOUND");
    await expectError(await request(revokedSession, `/api/channels/${channel.id}/messages?after=0`), 404, "CHANNEL_NOT_FOUND");
    await expectError(await request(revokedSession, `/api/channels/${channel.id}/messages/${sentMessage.id}`, "PATCH", {
      content: "must remain private"
    }), 404, "CHANNEL_NOT_FOUND");
    await expectError(await request(revokedSession, `/api/channels/${channel.id}/messages/${sentMessage.id}`, "DELETE"), 404, "CHANNEL_NOT_FOUND");
  }, 90_000);
}
