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
const inContainer = process.env.MESSAGE_AUTHOR_ROLES_TEST_IN_CONTAINER === "true";

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
    "docker compose " + args.join(" ") + " failed: " + (result.error?.message ?? "") +
      "\n" + (result.stdout ?? "") + "\n" + (result.stderr ?? "")
  );
}

if (!inContainer) {
  describe("message author roles integration", () => {
    let fixtureDirectory = "";
    let projectName = "";
    let envFile = "";
    let overrideFile = "";

    function run(args: string[], timeout = commandTimeoutMs) {
      return compose(projectName, envFile, overrideFile, args, timeout);
    }

    beforeAll(() => {
      fixtureDirectory = mkdtempSync(join(tmpdir(), "decentracord-message-author-roles-"));
      const suffix = randomBytes(6).toString("hex");
      projectName = "decentracord-message-author-roles-" + suffix;
      const databaseName = "decentracord_test_" + suffix;
      const databaseUser = "message_roles_" + suffix.slice(0, 10);
      const databasePassword = randomBytes(24).toString("base64url");
      const adminLogin = "author_roles_admin_" + suffix.slice(0, 10);
      const adminPassword = "Author-roles-admin-" + randomBytes(18).toString("base64url");
      const secretFile = join(fixtureDirectory, "db_password");
      envFile = join(fixtureDirectory, "compose.env");
      overrideFile = join(fixtureDirectory, "compose.message-author-roles.yaml");
      const buildxConfig = join(fixtureDirectory, "buildx");
      mkdirSync(buildxConfig, { mode: 0o700 });
      writeFileSync(secretFile, databasePassword, { mode: 0o600 });
      chmodSync(secretFile, 0o600);
      writeFileSync(envFile, [
        "DB_PASSWORD_SECRET_FILE=" + secretFile,
        "DB_PASSWORD=" + databasePassword,
        "DB_NAME=" + databaseName,
        "DB_USER=" + databaseUser,
        "MESSAGE_AUTHOR_ROLES_ADMIN_LOGIN=" + adminLogin,
        "MESSAGE_AUTHOR_ROLES_ADMIN_PASSWORD=" + adminPassword,
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
        "      context: " + JSON.stringify(projectRoot),
        "      dockerfile: Dockerfile",
        "      target: test-runner",
        "    image: " + JSON.stringify("decentracord-message-author-roles-runner:" + suffix),
        '    entrypoint: ["npm", "run", "test:integration", "--", "tests/integration/message-author-roles.test.ts"]',
        "    environment:",
        '      MESSAGE_AUTHOR_ROLES_TEST_IN_CONTAINER: "true"',
        "      MESSAGE_AUTHOR_ROLES_TEST_BASE_URL: http://app:3000",
        "      MESSAGE_AUTHOR_ROLES_ADMIN_LOGIN: " + "$" + "{MESSAGE_AUTHOR_ROLES_ADMIN_LOGIN}",
        "      MESSAGE_AUTHOR_ROLES_ADMIN_PASSWORD: " + "$" + "{MESSAGE_AUTHOR_ROLES_ADMIN_PASSWORD}",
        "      TEST_DATABASE_URL: postgresql://" + databaseUser + ":" + databasePassword + "@db:5432/" + databaseName,
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
      const bootstrapArgs = ["run", "--rm", "--no-deps", "-T", "-i", "-e", "DB_NAME=" + databaseName, "app", "bootstrap-admin", "--login", adminLogin];
      const bootstrap = spawnSync("docker", [
        "compose", "--project-name", projectName, "--env-file", envFile,
        "--file", join(projectRoot, "compose.yaml"), "--file", overrideFile, ...bootstrapArgs
      ], {
        cwd: projectRoot,
        encoding: "utf8",
        env: process.env,
        input: adminPassword + "\n",
        maxBuffer: 2 * 1024 * 1024,
        timeout: commandTimeoutMs
      });
      assertComposeSucceeded(bootstrap, bootstrapArgs);
      assert.ok(!((bootstrap.stdout ?? "") + "\n" + (bootstrap.stderr ?? "")).includes(adminPassword), "bootstrap output leaked the administrator password");
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

    it("returns author roles, member presence, read cursors, and revocation reasons from PostgreSQL and realtime", () => {
      const args = ["run", "--rm", "--no-deps", "-T", "-e", "MESSAGE_AUTHOR_ROLES_TEST_IN_CONTAINER=true", "test-runner"];
      const result = run(args, 600_000);
      if (result.status !== 0) {
        const logs = run(["logs", "--no-color", "app"], 30_000);
        process.stderr.write("App logs after message author roles failure:\n" + (logs.stdout ?? "") + (logs.stderr ?? "") + "\n");
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

  interface AuthorRole {
    id: string;
    name: string;
    color: string | null;
    position: number;
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
    authorRoles: AuthorRole[];
    editedAt: string | null;
    deleted: boolean;
    clientRequestId: string;
    createdAt: string;
  }

  const baseUrl = process.env.MESSAGE_AUTHOR_ROLES_TEST_BASE_URL ?? "http://app:3000";
  const appOrigin = new URL(baseUrl).origin;
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
    const response = await request(session, "/api/auth/login", "POST", {
      login: credentials.login,
      password: credentials.password
    });
    if (response.status !== 200) {
      throw new Error("Login failed (" + response.status + "): " + JSON.stringify(await response.json()));
    }
    const body = await response.json() as { csrfToken?: unknown };
    expect(typeof body.csrfToken).toBe("string");
    session.csrfToken = body.csrfToken as string;
    return session;
  }

  async function createMember(loginValue: string): Promise<MemberIdentity> {
    const password = "Message-member-" + randomBytes(16).toString("base64url");
    const response = await request(adminSession, "/api/members", "POST", { login: loginValue, password });
    expect(response.status).toBe(201);
    const member = await response.json() as { id: string; login: string };
    return { id: member.id, login: member.login, password };
  }

  async function createRole(name: string, position: number, permissions: string[], color: string | null): Promise<string> {
    const result = await pool.query<{ id: string }>(
      "INSERT INTO roles (system_key, name, position, permissions, color) VALUES (NULL, $1, $2, $3::jsonb, $4) RETURNING id::text AS id",
      [name, position, JSON.stringify(permissions), color]
    );
    const id = result.rows[0]?.id;
    if (!id) throw new Error("Message author roles test role was not created");
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
    return request(adminSession, "/api/channels/" + channelId + "/overrides", "PUT", { overrides });
  }

  function connect(session: HttpSession): Promise<Socket> {
    if (!session.cookie) throw new Error("Authenticated session cookie is missing");
    const socket = io(baseUrl + "/realtime", {
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
        reject(new Error("Socket did not receive " + event));
      }, timeoutMs);
      const listener = (payload: unknown) => {
        clearTimeout(timer);
        resolve(payload);
      };
      socket.once(event, listener);
    });
  }

  function subscribe(socket: Socket, channelId: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.off("channel:subscribed", onSubscribed);
        socket.off("channel:subscribe:error", onError);
        reject(new Error("Channel subscription response timed out"));
      }, 8_000);
      const done = (value: unknown) => {
        clearTimeout(timer);
        socket.off("channel:subscribed", onSubscribed);
        socket.off("channel:subscribe:error", onError);
        resolve(value);
      };
      const onSubscribed = (value: unknown) => done({ event: "channel:subscribed", value });
      const onError = (value: unknown) => done({ event: "channel:subscribe:error", value });
      socket.once("channel:subscribed", onSubscribed);
      socket.once("channel:subscribe:error", onError);
      socket.emit("channel:subscribe", { channelId });
    });
  }

  beforeAll(async () => {
    const database = new URL(process.env.TEST_DATABASE_URL ?? "");
    expect(database.hostname).toBe("db");
    expect(database.pathname).toMatch(/^\/decentracord_test_[a-f0-9]+$/u);
    expect(new URL(baseUrl).hostname).toBe("app");
    expect(new URL(baseUrl).port).toBe("3000");
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8, connectionTimeoutMillis: 3_000 });
    adminSession = await login({
      login: process.env.MESSAGE_AUTHOR_ROLES_ADMIN_LOGIN ?? "",
      password: process.env.MESSAGE_AUTHOR_ROLES_ADMIN_PASSWORD ?? ""
    });
  }, 30_000);

  afterAll(async () => {
    for (const socket of liveSockets) socket.disconnect();
    await pool?.end();
  });

  it("returns author roles, member presence, read cursors, and revocation reasons", async () => {
    const suffix = randomBytes(5).toString("hex");
    const lowRoleName = "author-low-" + suffix;
    const highRoleName = "author-high-" + suffix;
    const viewerRoleName = "author-viewer-" + suffix;
    const lowRoleId = await createRole(lowRoleName, 10, ["VIEW_CHANNEL", "SEND_MESSAGES"], "#2563eb");
    const highRoleId = await createRole(highRoleName, 30, ["VIEW_CHANNEL", "SEND_MESSAGES"], "#dc2626");
    const viewerRoleId = await createRole(viewerRoleName, 5, ["VIEW_CHANNEL"], null);
    const author = await createMember("author_roles_author_" + suffix);
    const viewer = await createMember("author_roles_viewer_" + suffix);
    const hidden = await createMember("author_roles_hidden_" + suffix);
    await Promise.all([
      assignRole(author.id, lowRoleId),
      assignRole(author.id, highRoleId),
      assignRole(viewer.id, viewerRoleId)
    ]);
    const channel = await createChannel("author_roles_channel_" + suffix);
    const authorSession = await login(author);
    const viewerSession = await login(viewer);
    const authorSocket = await connect(authorSession);
    const viewerSocket = await connect(viewerSession);
    expect(await subscribe(authorSocket, channel.id)).toEqual({
      event: "channel:subscribed",
      value: { channelId: channel.id }
    });
    expect(await subscribe(viewerSocket, channel.id)).toEqual({
      event: "channel:subscribed",
      value: { channelId: channel.id }
    });

    const membersResponse = await request(authorSession, "/api/channels/" + channel.id + "/members");
    expect(membersResponse.status).toBe(200);
    const membersBody = await membersResponse.json() as {
      members: Array<{
        id: string;
        login: string;
        roles: AuthorRole[];
        presence: string;
      }>;
    };
    expect(membersBody.members.every((member) =>
      Array.isArray(member.roles) && ["online", "offline"].includes(member.presence)
    )).toBe(true);
    const authorMember = membersBody.members.find((member) => member.id === author.id);
    const viewerMember = membersBody.members.find((member) => member.id === viewer.id);
    expect(authorMember?.presence).toBe("online");
    expect(viewerMember?.presence).toBe("online");
    expect(membersBody.members.some((member) => member.id === hidden.id)).toBe(false);

    const expectedAuthorRoles: AuthorRole[] = [
      { id: highRoleId, name: highRoleName, color: "#dc2626", position: 30 },
      { id: lowRoleId, name: lowRoleName, color: "#2563eb", position: 10 }
    ];
    expect(authorMember?.roles).toEqual(expectedAuthorRoles);
    expect(viewerMember?.roles).toEqual([
      { id: viewerRoleId, name: viewerRoleName, color: null, position: 5 }
    ]);

    const realtimeMessagePromise = waitForEvent(viewerSocket, "message:created");
    const requestId = randomUUID();
    const sendResponse = await request(authorSession, "/api/channels/" + channel.id + "/messages", "POST", {
      content: "message with colored author",
      clientRequestId: requestId
    });
    expect(sendResponse.status).toBe(201);
    const sentMessage = await sendResponse.json() as MessageView;
    expect(sentMessage.authorRoles).toEqual(expectedAuthorRoles);

    const historyResponse = await request(authorSession, "/api/channels/" + channel.id + "/messages");
    expect(historyResponse.status).toBe(200);
    const history = await historyResponse.json() as { messages: MessageView[] };
    const historyMessage = history.messages.find((message) => message.id === sentMessage.id);
    expect(historyMessage?.authorRoles).toEqual(expectedAuthorRoles);
    const realtimeEvent = await realtimeMessagePromise as { channelId: string; message: MessageView };
    expect(realtimeEvent).toEqual({ channelId: channel.id, message: sentMessage });
    expect(realtimeEvent.message.authorRoles).toEqual(expectedAuthorRoles);

    const viewerChannelsResponse = await request(viewerSession, "/api/channels");
    expect(viewerChannelsResponse.status).toBe(200);
    const viewerChannels = await viewerChannelsResponse.json() as {
      channels: Array<{ id: string; unreadCount: unknown; lastReadSeq: unknown }>;
    };
    expect(viewerChannels.channels.every((entry) =>
      typeof entry.unreadCount === "number" && typeof entry.lastReadSeq === "number"
    )).toBe(true);
    expect(viewerChannels.channels.find((entry) => entry.id === channel.id)).toMatchObject({
      unreadCount: 1,
      lastReadSeq: 0
    });

    const markReadResponse = await request(viewerSession, "/api/channels/" + channel.id + "/read", "POST", {
      seq: sentMessage.seq
    });
    expect(markReadResponse.status).toBe(204);
    const viewerChannelsAfterReadResponse = await request(viewerSession, "/api/channels");
    const viewerChannelsAfterRead = await viewerChannelsAfterReadResponse.json() as {
      channels: Array<{ id: string; unreadCount: unknown; lastReadSeq: unknown }>;
    };
    expect(viewerChannelsAfterReadResponse.status).toBe(200);
    expect(viewerChannelsAfterRead.channels.find((entry) => entry.id === channel.id)).toMatchObject({
      unreadCount: 0,
      lastReadSeq: sentMessage.seq
    });
    const channelResponse = await request(viewerSession, "/api/channels/" + channel.id);
    expect(channelResponse.status).toBe(200);
    const channelBody = await channelResponse.json() as {
      channel: { unreadCount: unknown; lastReadSeq: unknown };
    };
    expect(channelBody.channel).toMatchObject({ unreadCount: 0, lastReadSeq: sentMessage.seq });

    const revokedEventPromise = waitForEvent(viewerSocket, "channel:revoked");
    const revokeResponse = await setOverrides(channel.id, [
      { subject: "member", subjectId: viewer.id, permission: "VIEW_CHANNEL", effect: "deny" }
    ]);
    expect(revokeResponse.status).toBe(204);
    const revokedEvent = await revokedEventPromise as { channelId: string; reason: unknown };
    expect(revokedEvent.channelId).toBe(channel.id);
    expect(typeof revokedEvent.reason).toBe("string");
    expect((revokedEvent.reason as string).trim().length).toBeGreaterThan(0);
    const membersAfterRevokeResponse = await request(authorSession, "/api/channels/" + channel.id + "/members");
    const membersAfterRevoke = await membersAfterRevokeResponse.json() as {
      members: Array<{ id: string }>;
    };
    expect(membersAfterRevoke.members.some((member) => member.id === viewer.id)).toBe(false);
  }, 90_000);
}
