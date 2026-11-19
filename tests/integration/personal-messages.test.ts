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
const inContainer = process.env.PERSONAL_MESSAGES_TEST_IN_CONTAINER === "true";

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
  describe("personal messages integration", () => {
    let fixtureDirectory = "";
    let projectName = "";
    let envFile = "";
    let overrideFile = "";

    function run(args: string[], timeout = commandTimeoutMs) {
      return compose(projectName, envFile, overrideFile, args, timeout);
    }

    beforeAll(() => {
      fixtureDirectory = mkdtempSync(join(tmpdir(), "decentracord-personal-messages-"));
      const suffix = randomBytes(6).toString("hex");
      projectName = `decentracord-personal-messages-${suffix}`;
      const databaseName = `decentracord_test_${suffix}`;
      const databaseUser = `personal_${suffix.slice(0, 10)}`;
      const databasePassword = randomBytes(24).toString("base64url");
      const adminLogin = `personal_admin_${suffix.slice(0, 10)}`;
      const adminPassword = `Personal-admin-${randomBytes(18).toString("base64url")}`;
      const secretFile = join(fixtureDirectory, "db_password");
      envFile = join(fixtureDirectory, "compose.env");
      overrideFile = join(fixtureDirectory, "compose.personal-messages.yaml");
      const buildxConfig = join(fixtureDirectory, "buildx");
      mkdirSync(buildxConfig, { mode: 0o700 });
      writeFileSync(secretFile, databasePassword, { mode: 0o600 });
      chmodSync(secretFile, 0o600);
      writeFileSync(envFile, [
        `DB_PASSWORD_SECRET_FILE=${secretFile}`,
        `DB_PASSWORD=${databasePassword}`,
        `DB_NAME=${databaseName}`,
        `DB_USER=${databaseUser}`,
        `PERSONAL_MESSAGES_TEST_ADMIN_LOGIN=${adminLogin}`,
        `PERSONAL_MESSAGES_TEST_ADMIN_PASSWORD=${adminPassword}`,
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
        `    image: ${JSON.stringify(`decentracord-personal-messages-runner:${suffix}`)}`,
        '    entrypoint: ["npm", "run", "test:integration", "--", "tests/integration/personal-messages.test.ts"]',
        "    environment:",
        "      NODE_ENV: test",
        "      PERSONAL_MESSAGES_TEST_IN_CONTAINER: \"true\"",
        "      PERSONAL_MESSAGES_TEST_BASE_URL: http://app:3000",
        "      PERSONAL_MESSAGES_TEST_ADMIN_LOGIN: ${PERSONAL_MESSAGES_TEST_ADMIN_LOGIN}",
        "      PERSONAL_MESSAGES_TEST_ADMIN_PASSWORD: ${PERSONAL_MESSAGES_TEST_ADMIN_PASSWORD}",
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

    it("creates, reads and lists personal conversations", () => {
      const args = ["run", "--rm", "--no-deps", "-T", "-e", "PERSONAL_MESSAGES_TEST_IN_CONTAINER=true", "test-runner"];
      const result = run(args, 600_000);
      if (result.status !== 0) {
        const logs = run(["logs", "--no-color", "app"], 30_000);
        process.stderr.write(`App logs after personal messages failure:\n${logs.stdout ?? ""}${logs.stderr ?? ""}\n`);
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

  interface ConversationView {
    id: string;
    kind: "direct" | "group";
    participants: Array<{ id: string; login: string; presence: "online" | "offline" }>;
    lastMessageAt: string | null;
    createdAt: string;
    unreadCount: number;
    canManageMembers: boolean;
  }

  const baseUrl = process.env.PERSONAL_MESSAGES_TEST_BASE_URL ?? "http://app:3000";
  const appOrigin = new URL(baseUrl).origin;
  const adminCredentials = {
    login: process.env.PERSONAL_MESSAGES_TEST_ADMIN_LOGIN ?? "",
    password: process.env.PERSONAL_MESSAGES_TEST_ADMIN_PASSWORD ?? ""
  };
  let pool: Pool;
  let adminSession: HttpSession;
  const liveSockets = new Set<Socket>();

  interface MessageSnapshot {
    id: string;
    channelId: string | null;
    conversationId: string | null;
    authorId: string;
    seq: number;
    updatedSeq: number;
    content: string;
    clientRequestId: string;
    deleted: boolean;
    editedAt?: string | null;
    mentions?: Array<{ id: string; login: string }>;
    forwardedFrom?: ForwardedFromSnapshot | null;
  }

  interface ForwardedFromSnapshot {
    messageId: string;
    channelId: string | null;
    conversationId: string | null;
    authorLogin: string;
    originalDeleted: boolean;
  }

  interface MessageHistoryBody {
    messages: MessageSnapshot[];
    hasMore: boolean;
    cursor: number;
  }

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
    const password = `Personal-member-${randomBytes(16).toString("base64url")}`;
    const response = await request(adminSession, "/api/members", "POST", { login: loginValue, password });
    expect(response.status).toBe(201);
    const member = await response.json() as { id: string; login: string };
    return { id: member.id, login: member.login, password };
  }

  async function expectError(response: Response, status: number, code: string): Promise<void> {
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(status);
    expect(body).toMatchObject({ error: { code } });
  }

  async function activateMember(actor: HttpSession, participantIds: string[]): Promise<Response> {
    return request(actor, "/api/conversations", "POST", { participantIds });
  }

  async function createConversationFor(actor: HttpSession, peerIds: string[]): Promise<ConversationView> {
    const response = await activateMember(actor, peerIds);
    const body = await response.json() as ConversationView;
    expect(response.status, JSON.stringify(body)).toBe(201);
    return body;
  }

  function conversationMessagesPath(conversationId: string): string {
    return `/api/conversations/${conversationId}/messages`;
  }

  async function unreadCountOf(session: HttpSession, conversationId: string): Promise<number> {
    const response = await request(session, "/api/conversations");
    expect(response.status).toBe(200);
    const body = await response.json() as { conversations: ConversationView[] };
    return body.conversations.find((conversation) => conversation.id === conversationId)?.unreadCount ?? -1;
  }

  async function conversationIdsOf(session: HttpSession): Promise<string[]> {
    const response = await request(session, "/api/conversations");
    expect(response.status).toBe(200);
    const body = await response.json() as { conversations: ConversationView[] };
    return body.conversations.map((conversation) => conversation.id);
  }

  async function lastReadSeqOf(conversationId: string, userId: string): Promise<number> {
    const result = await pool.query<{ last_read_seq: number }>(
      "SELECT last_read_seq::int AS last_read_seq FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2",
      [conversationId, userId]
    );
    return result.rows[0]?.last_read_seq ?? -1;
  }

  async function closedAtOf(conversationId: string, userId: string): Promise<Date | null> {
    const result = await pool.query<{ closed_at: Date | null }>(
      "SELECT closed_at FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2",
      [conversationId, userId]
    );
    const row = result.rows[0];
    if (!row) throw new Error("Conversation participant row was not found");
    return row.closed_at;
  }

  // Роль создаётся штатным API: проверка «право модератора в переписке не
  // действует» должна опираться на ту же модель прав, что у продукта.
  async function createRole(name: string, permissions: string[]): Promise<string> {
    const response = await request(adminSession, "/api/roles", "POST", { name, permissions });
    const body = await response.json() as { id?: unknown };
    expect(response.status, JSON.stringify(body)).toBe(201);
    expect(typeof body.id).toBe("string");
    return body.id as string;
  }

  async function assignRoles(memberId: string, roleIds: string[]): Promise<void> {
    const response = await request(adminSession, `/api/members/${memberId}/roles`, "PATCH", { roleIds });
    expect(response.status, await response.text()).toBe(204);
  }

  // Канал, видимый всем и открытый для отправки: в нём проверяется, что право
  // «Управлять сообщениями» действительно есть, а в переписке — нет.
  async function createSendableChannel(name: string): Promise<{ id: string; name: string }> {
    const created = await request(adminSession, "/api/channels", "POST", { name });
    const channel = await created.json() as { id: string; name: string };
    expect(created.status, JSON.stringify(channel)).toBe(201);
    const overrides = await request(adminSession, `/api/channels/${channel.id}/overrides`, "PUT", {
      overrides: [
        { subject: "everyone", subjectId: null, permission: "VIEW_CHANNEL", effect: "allow" },
        { subject: "everyone", subjectId: null, permission: "SEND_MESSAGES", effect: "allow" }
      ]
    });
    expect(overrides.status).toBe(204);
    return { id: channel.id, name: channel.name };
  }

  async function sendToChannel(session: HttpSession, channelId: string, content: string): Promise<MessageSnapshot> {
    const response = await request(session, `/api/channels/${channelId}/messages`, "POST", {
      content,
      clientRequestId: randomUUID()
    });
    const body = await response.json() as MessageSnapshot;
    expect(response.status, JSON.stringify(body)).toBe(201);
    return body;
  }

  async function mentionRows(messageId: string): Promise<number> {
    const result = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM message_mentions WHERE message_id = $1",
      [messageId]
    );
    return result.rows[0]?.count ?? 0;
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
      socket.once("session:ready", () => { ready = true; finish(); });
      socket.once("connect_error", (error) => {
        clearTimeout(timer);
        socket.disconnect();
        reject(error);
      });
      socket.connect();
    });
  }

  function waitForEvent(socket: Socket, event: string, timeoutMs = 5_000): Promise<unknown> {
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

  function expectNoEvent(socket: Socket, event: string, timeoutMs = 1_000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
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

  it("creates a direct conversation idempotently and rejects self, disabled and malformed requests", async () => {
    const suffix = randomBytes(5).toString("hex");
    const actor = await createMember(`personal_actor_${suffix}`);
    const peer = await createMember(`personal_peer_${suffix}`);
    const disabled = await createMember(`personal_disabled_${suffix}`);
    const actorSession = await login(actor);

    const createdResponse = await activateMember(actorSession, [peer.id]);
    const createdBody = await createdResponse.json() as ConversationView;
    expect(createdResponse.status, JSON.stringify(createdBody)).toBe(201);
    expect(createdBody.kind).toBe("direct");
    expect(createdBody.unreadCount).toBe(0);
    expect(createdBody.canManageMembers).toBe(false);
    expect(createdBody.lastMessageAt).toBeNull();
    expect(createdBody.participants.map((participant) => participant.id).sort()).toEqual([actor.id, peer.id].sort());
    expect(createdBody.participants.every((participant) => participant.login.length > 0)).toBe(true);

    // Повторное создание с той же парой возвращает ту же переписку.
    const repeatedResponse = await activateMember(actorSession, [peer.id]);
    const repeatedBody = await repeatedResponse.json() as ConversationView;
    expect(repeatedResponse.status, JSON.stringify(repeatedBody)).toBe(201);
    expect(repeatedBody.id).toBe(createdBody.id);

    const dmKey = [actor.id, peer.id].sort().join(":");
    const directRows = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM conversations WHERE kind = 'direct' AND dm_key = $1",
      [dmKey]
    );
    expect(directRows.rows[0]?.count).toBe(1);

    await expectError(await activateMember(actorSession, [actor.id]), 400, "SELF_CONVERSATION");
    await expectError(await activateMember(actorSession, [peer.id, "not-a-uuid"]), 400, "INVALID_REQUEST");
    await expectError(
      await request(actorSession, "/api/conversations", "POST", { participantIds: [peer.id], extra: true }),
      400,
      "INVALID_REQUEST"
    );
    await expectError(await request(actorSession, "/api/conversations", "POST", { participantIds: [] }), 400, "INVALID_REQUEST");
    await expectError(await activateMember(actorSession, [peer.id, peer.id]), 400, "INVALID_REQUEST");

    const disableResponse = await request(adminSession, `/api/members/${disabled.id}/disable`, "POST");
    expect(disableResponse.status).toBe(204);
    await expectError(await activateMember(actorSession, [disabled.id]), 404, "PARTICIPANT_NOT_FOUND");
    await expectError(await activateMember(actorSession, ["6f1cbf7e-9a52-4a1e-8f0c-0b5f52a1e1a1"]), 404, "PARTICIPANT_NOT_FOUND");
  }, 120_000);

  it("refuses a group bigger than the ten person limit", async () => {
    const suffix = randomBytes(5).toString("hex");
    const actor = await createMember(`personal_limit_actor_${suffix}`);
    const actorSession = await login(actor);
    const invited: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      const member = await createMember(`personal_limit_${index}_${suffix}`);
      invited.push(member.id);
    }
    await expectError(await activateMember(actorSession, invited), 409, "TOO_MANY_PARTICIPANTS");
  }, 120_000);

  it("creates a group without a dm_key and lets only participants read it", async () => {
    const suffix = randomBytes(5).toString("hex");
    const actor = await createMember(`personal_group_actor_${suffix}`);
    const first = await createMember(`personal_group_first_${suffix}`);
    const second = await createMember(`personal_group_second_${suffix}`);
    const outsider = await createMember(`personal_outsider_${suffix}`);
    const actorSession = await login(actor);
    const outsiderSession = await login(outsider);

    const groupResponse = await activateMember(actorSession, [first.id, second.id]);
    const group = await groupResponse.json() as ConversationView;
    expect(groupResponse.status, JSON.stringify(group)).toBe(201);
    expect(group.kind).toBe("group");
    expect(group.participants).toHaveLength(3);
    expect(group.canManageMembers).toBe(true);

    const storedGroup = await pool.query<{ kind: string; dm_key: string | null }>(
      "SELECT kind, dm_key FROM conversations WHERE id = $1",
      [group.id]
    );
    expect(storedGroup.rows[0]?.kind).toBe("group");
    expect(storedGroup.rows[0]?.dm_key).toBeNull();

    const ownRead = await request(actorSession, `/api/conversations/${group.id}`);
    expect(ownRead.status).toBe(200);
    expect((await ownRead.json() as ConversationView).id).toBe(group.id);

    // Не-участник получает 404, а не 403: код не подтверждает существование переписки.
    await expectError(await request(outsiderSession, `/api/conversations/${group.id}`), 404, "CONVERSATION_NOT_FOUND");

    // Право ADMINISTRATOR не даёт доступа к чужой переписке.
    const adminRole = await pool.query<{ id: string }>("SELECT id::text AS id FROM roles WHERE system_key = 'administrator'");
    const adminRoleId = adminRole.rows[0]?.id;
    if (!adminRoleId) throw new Error("Administrator role was not created");
    await pool.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)", [outsider.id, adminRoleId]);
    await expectError(await request(outsiderSession, `/api/conversations/${group.id}`), 404, "CONVERSATION_NOT_FOUND");

    const outsiderList = await request(outsiderSession, "/api/conversations");
    expect(outsiderList.status).toBe(200);
    const outsiderConversations = (await outsiderList.json() as { conversations: ConversationView[] }).conversations;
    expect(outsiderConversations.some((conversation) => conversation.id === group.id)).toBe(false);

    await expectError(await request(outsiderSession, "/api/conversations/not-a-uuid"), 400, "INVALID_REQUEST");
  }, 120_000);

  it("lists only own conversations with the freshest first", async () => {
    const suffix = randomBytes(5).toString("hex");
    const actor = await createMember(`personal_list_actor_${suffix}`);
    const firstPeer = await createMember(`personal_list_first_${suffix}`);
    const secondPeer = await createMember(`personal_list_second_${suffix}`);
    const actorSession = await login(actor);
    const firstPeerSession = await login(firstPeer);

    const firstResponse = await activateMember(actorSession, [firstPeer.id]);
    const first = await firstResponse.json() as ConversationView;
    expect(firstResponse.status).toBe(201);
    const secondResponse = await activateMember(actorSession, [secondPeer.id]);
    const second = await secondResponse.json() as ConversationView;
    expect(secondResponse.status).toBe(201);

    const listResponse = await request(actorSession, "/api/conversations");
    expect(listResponse.status).toBe(200);
    const conversations = (await listResponse.json() as { conversations: ConversationView[] }).conversations;
    const ownIds = conversations.map((conversation) => conversation.id);
    expect(ownIds).toContain(first.id);
    expect(ownIds).toContain(second.id);
    // Сообщений пока нет: свежесть считается по времени создания.
    expect(ownIds.indexOf(second.id)).toBeLessThan(ownIds.indexOf(first.id));
    for (const conversation of conversations) {
      expect(conversation.participants.some((participant) => participant.id === actor.id)).toBe(true);
    }

    // Собеседник видит переписку наравне с создателем.
    const peerList = await request(firstPeerSession, "/api/conversations");
    expect(peerList.status).toBe(200);
    const peerConversations = (await peerList.json() as { conversations: ConversationView[] }).conversations;
    expect(peerConversations.some((conversation) => conversation.id === first.id)).toBe(true);
  }, 120_000);

  it("sends conversation messages idempotently and validates the body", async () => {
    const suffix = randomBytes(5).toString("hex");
    const actor = await createMember(`personal_send_actor_${suffix}`);
    const peer = await createMember(`personal_send_peer_${suffix}`);
    const actorSession = await login(actor);
    const conversation = await createConversationFor(actorSession, [peer.id]);
    const path = conversationMessagesPath(conversation.id);

    const clientRequestId = randomUUID();
    const firstResponse = await request(actorSession, path, "POST", {
      content: "Привет, это личное сообщение",
      clientRequestId
    });
    const firstBody = await firstResponse.json() as MessageSnapshot;
    expect(firstResponse.status, JSON.stringify(firstBody)).toBe(201);
    expect(firstBody.conversationId).toBe(conversation.id);
    expect(firstBody.channelId).toBeNull();
    expect(firstBody.authorId).toBe(actor.id);
    expect(firstBody.seq).toBe(1);
    expect(firstBody.clientRequestId).toBe(clientRequestId);

    // Повтор с тем же clientRequestId возвращает ту же строку.
    const repeatedResponse = await request(actorSession, path, "POST", {
      content: "Привет, это личное сообщение",
      clientRequestId
    });
    const repeatedBody = await repeatedResponse.json() as MessageSnapshot;
    expect(repeatedResponse.status, JSON.stringify(repeatedBody)).toBe(201);
    expect(repeatedBody.id).toBe(firstBody.id);

    const stored = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM messages WHERE conversation_id = $1",
      [conversation.id]
    );
    expect(stored.rows[0]?.count).toBe(1);

    await expectError(
      await request(actorSession, path, "POST", { content: "x".repeat(2001), clientRequestId: randomUUID() }),
      400,
      "INVALID_REQUEST"
    );
    await expectError(
      await request(actorSession, path, "POST", { content: "ok", clientRequestId: randomUUID(), extra: true }),
      400,
      "INVALID_REQUEST"
    );
    await expectError(
      await request(actorSession, path, "POST", { content: "ok", clientRequestId: "not-a-uuid" }),
      400,
      "INVALID_REQUEST"
    );
  }, 120_000);

  it("returns conversation history and catch-up pages by cursor", async () => {
    const suffix = randomBytes(5).toString("hex");
    const actor = await createMember(`personal_history_actor_${suffix}`);
    const peer = await createMember(`personal_history_peer_${suffix}`);
    const actorSession = await login(actor);
    const conversation = await createConversationFor(actorSession, [peer.id]);
    const path = conversationMessagesPath(conversation.id);

    for (const content of ["первое", "второе", "третье"]) {
      const response = await request(actorSession, path, "POST", { content, clientRequestId: randomUUID() });
      expect(response.status).toBe(201);
    }

    const historyResponse = await request(actorSession, path);
    const history = await historyResponse.json() as MessageHistoryBody;
    expect(historyResponse.status).toBe(200);
    expect(history.messages.map((message) => message.seq)).toEqual([1, 2, 3]);
    expect(history.messages.map((message) => message.content)).toEqual(["первое", "второе", "третье"]);
    expect(history.cursor).toBe(3);
    expect(history.hasMore).toBe(false);

    const earlierResponse = await request(actorSession, `${path}?before=2`);
    const earlier = await earlierResponse.json() as MessageHistoryBody;
    expect(earlierResponse.status).toBe(200);
    expect(earlier.messages.map((message) => message.content)).toEqual(["первое"]);

    const catchUpResponse = await request(actorSession, `${path}?after=1`);
    const catchUp = await catchUpResponse.json() as MessageHistoryBody;
    expect(catchUpResponse.status).toBe(200);
    expect(catchUp.messages.map((message) => message.seq)).toEqual([2, 3]);
    expect(catchUp.cursor).toBe(3);

    await expectError(await request(actorSession, `${path}?before=1&after=1`), 400, "INVALID_REQUEST");
    await expectError(await request(actorSession, `${path}?limit=0`), 400, "INVALID_REQUEST");
  }, 120_000);

  it("keeps conversation messages out of channels and channel unread counters", async () => {
    const suffix = randomBytes(5).toString("hex");
    const actor = await createMember(`personal_isolation_actor_${suffix}`);
    const peer = await createMember(`personal_isolation_peer_${suffix}`);
    const actorSession = await login(actor);
    const peerSession = await login(peer);

    // Канал, видимый всем: участник переписки — тот же пользователь.
    const channelResponse = await request(adminSession, "/api/channels", "POST", { name: `personal_isolation_${suffix}` });
    const channel = await channelResponse.json() as { id: string };
    expect(channelResponse.status, JSON.stringify(channel)).toBe(201);
    const overridesResponse = await request(adminSession, `/api/channels/${channel.id}/overrides`, "PUT", {
      overrides: [
        { subject: "everyone", subjectId: null, permission: "VIEW_CHANNEL", effect: "allow" },
        { subject: "everyone", subjectId: null, permission: "SEND_MESSAGES", effect: "allow" }
      ]
    });
    expect(overridesResponse.status).toBe(204);

    const channelMessageResponse = await request(actorSession, `/api/channels/${channel.id}/messages`, "POST", {
      content: "канальное сообщение",
      clientRequestId: randomUUID()
    });
    const channelMessage = await channelMessageResponse.json() as MessageSnapshot;
    expect(channelMessageResponse.status, JSON.stringify(channelMessage)).toBe(201);

    const conversation = await createConversationFor(actorSession, [peer.id]);
    const conversationMessageResponse = await request(peerSession, conversationMessagesPath(conversation.id), "POST", {
      content: "личное сообщение",
      clientRequestId: randomUUID()
    });
    const conversationMessage = await conversationMessageResponse.json() as MessageSnapshot;
    expect(conversationMessageResponse.status).toBe(201);
    expect(conversationMessage.channelId).toBeNull();

    // История канала не содержит сообщений переписки.
    const channelHistoryResponse = await request(actorSession, `/api/channels/${channel.id}/messages`);
    const channelHistory = await channelHistoryResponse.json() as MessageHistoryBody;
    expect(channelHistoryResponse.status).toBe(200);
    expect(channelHistory.messages.map((message) => message.id)).toEqual([channelMessage.id]);
    expect(channelHistory.messages.every((message) => message.conversationId === null)).toBe(true);

    // Все строки без канала — сообщения переписок.
    const unscoped = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM messages WHERE channel_id IS NULL"
    );
    const scopedCount = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM messages WHERE conversation_id IS NOT NULL"
    );
    expect(unscoped.rows[0]?.count).toBe(scopedCount.rows[0]?.count);

    // Счётчики каналов от переписки не растут.
    const peerChannelMessageResponse = await request(peerSession, `/api/channels/${channel.id}/messages`, "POST", {
      content: "сообщение в канал",
      clientRequestId: randomUUID()
    });
    expect(peerChannelMessageResponse.status).toBe(201);
    const unreadBeforeResponse = await request(actorSession, "/api/channels");
    const unreadBefore = await unreadBeforeResponse.json() as { channels: Array<{ id: string; unreadCount?: number }> };
    const unreadCountBefore = unreadBefore.channels.find((entry) => entry.id === channel.id)?.unreadCount;
    expect(unreadCountBefore).toBeGreaterThanOrEqual(1);

    const secondConversationMessage = await request(peerSession, conversationMessagesPath(conversation.id), "POST", {
      content: "ещё одно личное",
      clientRequestId: randomUUID()
    });
    expect(secondConversationMessage.status).toBe(201);

    const unreadAfterResponse = await request(actorSession, "/api/channels");
    const unreadAfter = await unreadAfterResponse.json() as { channels: Array<{ id: string; unreadCount?: number }> };
    expect(unreadAfter.channels.find((entry) => entry.id === channel.id)?.unreadCount).toBe(unreadCountBefore);
  }, 180_000);

  it("refuses history and sending to a conversation for a non-participant", async () => {
    const suffix = randomBytes(5).toString("hex");
    const actor = await createMember(`personal_access_actor_${suffix}`);
    const peer = await createMember(`personal_access_peer_${suffix}`);
    const outsider = await createMember(`personal_access_outsider_${suffix}`);
    const actorSession = await login(actor);
    const outsiderSession = await login(outsider);
    const conversation = await createConversationFor(actorSession, [peer.id]);
    const path = conversationMessagesPath(conversation.id);

    const ownHistory = await request(actorSession, path);
    expect(ownHistory.status).toBe(200);

    await expectError(await request(outsiderSession, path), 404, "CONVERSATION_NOT_FOUND");
    await expectError(
      await request(outsiderSession, path, "POST", { content: "чужое", clientRequestId: randomUUID() }),
      404,
      "CONVERSATION_NOT_FOUND"
    );

    // Не-участник не оставил строку: история переписки пуста.
    const history = await (await request(actorSession, path)).json() as MessageHistoryBody;
    expect(history.messages).toEqual([]);
  }, 120_000);

  it("delivers conversation events to participants only and never twice", async () => {
    const suffix = randomBytes(5).toString("hex");
    const actor = await createMember(`personal_event_actor_${suffix}`);
    const peer = await createMember(`personal_event_peer_${suffix}`);
    const outsider = await createMember(`personal_event_outsider_${suffix}`);
    const actorSession = await login(actor);
    const peerSession = await login(peer);
    const outsiderSession = await login(outsider);
    const peerSocket = await connect(peerSession);
    const outsiderSocket = await connect(outsiderSession);
    const conversation = await createConversationFor(actorSession, [peer.id]);
    const path = conversationMessagesPath(conversation.id);

    const outsiderEvents = expectNoEvent(outsiderSocket, "conversation:message:created", 1_000);
    const peerEvent = waitForEvent(peerSocket, "conversation:message:created", 5_000);
    const clientRequestId = randomUUID();
    const sentResponse = await request(actorSession, path, "POST", { content: "собеседнику сразу", clientRequestId });
    const sent = await sentResponse.json() as MessageSnapshot;
    expect(sentResponse.status).toBe(201);

    const delivered = await peerEvent as { conversationId: string; message: MessageSnapshot };
    expect(delivered.conversationId).toBe(conversation.id);
    expect(delivered.message.id).toBe(sent.id);
    expect(delivered.message.conversationId).toBe(conversation.id);
    expect(delivered.message.channelId).toBeNull();
    await outsiderEvents;

    // Идемпотентный повтор не порождает второго события.
    const repeatedEvent = expectNoEvent(peerSocket, "conversation:message:created", 1_000);
    const repeatedResponse = await request(actorSession, path, "POST", { content: "собеседнику сразу", clientRequestId });
    const repeated = await repeatedResponse.json() as MessageSnapshot;
    expect(repeatedResponse.status).toBe(201);
    expect(repeated.id).toBe(sent.id);
    await repeatedEvent;

    peerSocket.disconnect();
    outsiderSocket.disconnect();
  }, 120_000);

  it("counts unread conversation messages and advances the read cursor forward only", async () => {
    const suffix = randomBytes(5).toString("hex");
    const actor = await createMember(`personal_unread_actor_${suffix}`);
    const peer = await createMember(`personal_unread_peer_${suffix}`);
    const outsider = await createMember(`personal_unread_outsider_${suffix}`);
    const actorSession = await login(actor);
    const peerSession = await login(peer);
    const outsiderSession = await login(outsider);
    const conversation = await createConversationFor(actorSession, [peer.id]);
    const path = conversationMessagesPath(conversation.id);
    const readPath = `/api/conversations/${conversation.id}/read`;

    const firstResponse = await request(peerSession, path, "POST", { content: "первое", clientRequestId: randomUUID() });
    const first = await firstResponse.json() as MessageSnapshot;
    expect(firstResponse.status).toBe(201);
    const secondResponse = await request(peerSession, path, "POST", { content: "второе", clientRequestId: randomUUID() });
    const second = await secondResponse.json() as MessageSnapshot;
    expect(secondResponse.status).toBe(201);
    expect(second.seq).toBe(first.seq + 1);

    // счётчик — число чужих неудалённых сообщений выше курсора.
    expect(await unreadCountOf(actorSession, conversation.id)).toBe(2);

    // Своё сообщение счётчик не увеличивает.
    expect((await request(actorSession, path, "POST", { content: "своё", clientRequestId: randomUUID() })).status).toBe(201);
    expect(await unreadCountOf(actorSession, conversation.id)).toBe(2);

    // Мягко удалённое сообщение счётчик не увеличивает.
    await pool.query("UPDATE messages SET deleted_at = now() WHERE id = $1", [first.id]);
    expect(await unreadCountOf(actorSession, conversation.id)).toBe(1);

    // отметка прочтения сбрасывает счётчик.
    const readResponse = await request(actorSession, readPath, "POST", { seq: 2 });
    expect(readResponse.status).toBe(204);
    expect(await unreadCountOf(actorSession, conversation.id)).toBe(0);
    expect(await lastReadSeqOf(conversation.id, actor.id)).toBe(2);

    // Повтор с меньшим seq курсор не откатывает.
    expect((await request(actorSession, readPath, "POST", { seq: 1 })).status).toBe(204);
    expect(await lastReadSeqOf(conversation.id, actor.id)).toBe(2);

    // seq больше last_seq не «прочитывает» будущее.
    expect((await request(actorSession, readPath, "POST", { seq: 999 })).status).toBe(204);
    const lastSeq = await pool.query<{ last_seq: number }>(
      "SELECT last_seq::int AS last_seq FROM conversations WHERE id = $1",
      [conversation.id]
    );
    const cursor = await lastReadSeqOf(conversation.id, actor.id);
    expect(cursor).toBeLessThanOrEqual(lastSeq.rows[0]?.last_seq ?? -1);
    expect(cursor).toBe(lastSeq.rows[0]?.last_seq ?? -1);

    // Тело разбирается по allow-list: один целый неотрицательный seq.
    for (const body of [{ seq: -1 }, { seq: "2" }, { seq: 2, extra: true }, {}, { seq: 1.5 }]) {
      await expectError(await request(actorSession, readPath, "POST", body), 400, "INVALID_REQUEST");
    }
    await expectError(
      await request(actorSession, "/api/conversations/not-a-uuid/read", "POST", { seq: 0 }),
      400,
      "INVALID_REQUEST"
    );
    // Не-участник не узнаёт о переписке и не двигает чужой курсор.
    await expectError(await request(outsiderSession, readPath, "POST", { seq: 1 }), 404, "CONVERSATION_NOT_FOUND");
    expect(await lastReadSeqOf(conversation.id, outsider.id)).toBe(-1);
  }, 120_000);

  it("closes a conversation for the caller only and reopens it on a new message", async () => {
    const suffix = randomBytes(5).toString("hex");
    const actor = await createMember(`personal_close_actor_${suffix}`);
    const peer = await createMember(`personal_close_peer_${suffix}`);
    const outsider = await createMember(`personal_close_outsider_${suffix}`);
    const actorSession = await login(actor);
    const peerSession = await login(peer);
    const outsiderSession = await login(outsider);
    const conversation = await createConversationFor(actorSession, [peer.id]);
    const path = conversationMessagesPath(conversation.id);
    const closePath = `/api/conversations/${conversation.id}/close`;
    const clientRequestId = randomUUID();

    expect((await request(peerSession, path, "POST", { content: "до закрытия", clientRequestId })).status).toBe(201);

    // закрытие действует только на вызвавшего.
    expect((await request(actorSession, closePath, "POST")).status).toBe(204);
    expect(await conversationIdsOf(actorSession)).not.toContain(conversation.id);
    expect(await conversationIdsOf(peerSession)).toContain(conversation.id);
    expect(await closedAtOf(conversation.id, actor.id)).not.toBeNull();
    expect(await closedAtOf(conversation.id, peer.id)).toBeNull();

    // История не удалена: прямой GET и история продолжают работать.
    const direct = await request(actorSession, `/api/conversations/${conversation.id}`);
    expect(direct.status).toBe(200);
    const history = await (await request(actorSession, path)).json() as MessageHistoryBody;
    expect(history.messages.map((message) => message.content)).toEqual(["до закрытия"]);

    // Новое сообщение снимает closed_at у всех участников и возвращает строку.
    expect((await request(peerSession, path, "POST", { content: "после закрытия", clientRequestId: randomUUID() })).status).toBe(201);
    expect(await conversationIdsOf(actorSession)).toContain(conversation.id);
    expect(await closedAtOf(conversation.id, actor.id)).toBeNull();
    expect(await closedAtOf(conversation.id, peer.id)).toBeNull();

    // Идемпотентный повтор уже существующего сообщения закрытую переписку не возвращает.
    expect((await request(actorSession, closePath, "POST")).status).toBe(204);
    expect(await closedAtOf(conversation.id, actor.id)).not.toBeNull();
    const repeated = await request(peerSession, path, "POST", { content: "до закрытия", clientRequestId });
    expect(repeated.status).toBe(201);
    expect((await repeated.json() as MessageSnapshot).content).toBe("до закрытия");
    expect(await closedAtOf(conversation.id, actor.id)).not.toBeNull();
    expect(await conversationIdsOf(actorSession)).not.toContain(conversation.id);

    // Посторонний закрыть чужую переписку не может.
    await expectError(await request(outsiderSession, closePath, "POST"), 404, "CONVERSATION_NOT_FOUND");
  }, 120_000);

  it("hides a direct conversation when the peer is disabled and keeps its history", async () => {
    const suffix = randomBytes(5).toString("hex");
    const actor = await createMember(`personal_hide_actor_${suffix}`);
    const peer = await createMember(`personal_hide_peer_${suffix}`);
    const actorSession = await login(actor);
    const peerSession = await login(peer);
    const conversation = await createConversationFor(actorSession, [peer.id]);
    const path = conversationMessagesPath(conversation.id);

    expect((await request(peerSession, path, "POST", { content: "привет", clientRequestId: randomUUID() })).status).toBe(201);
    expect(await conversationIdsOf(actorSession)).toContain(conversation.id);

    const actorSocket = await connect(actorSession);
    const syncEvent = waitForEvent(actorSocket, "conversations:sync", 5_000);
    const disableResponse = await request(adminSession, `/api/members/${peer.id}/disable`, "POST");
    expect(disableResponse.status).toBe(204);
    // Сигнал, а не список: запросов в БД на стороне гейтвея нет.
    expect(await syncEvent).toMatchObject({ conversations: null });

    // скрытие — фильтр списка. API и история у активного участника работают.
    expect(await conversationIdsOf(actorSession)).not.toContain(conversation.id);
    const direct = await request(actorSession, `/api/conversations/${conversation.id}`);
    expect(direct.status).toBe(200);
    const history = await (await request(actorSession, path)).json() as MessageHistoryBody;
    expect(history.messages.map((message) => message.content)).toEqual(["привет"]);
    expect((await request(actorSession, path, "POST", { content: "после скрытия", clientRequestId: randomUUID() })).status).toBe(201);

    // Возврат активности участника — прямым SQL в фикстуре: поверхности включения
    // в продукте нет, `POST /api/members` создаёт нового пользователя.
    await pool.query("UPDATE users SET active = true, auth_version = auth_version + 1 WHERE id = $1", [peer.id]);
    expect(await conversationIdsOf(actorSession)).toContain(conversation.id);

    actorSocket.disconnect();
  }, 120_000);

  it("keeps a group with a disabled participant visible", async () => {
    const suffix = randomBytes(5).toString("hex");
    const actor = await createMember(`personal_group_hide_actor_${suffix}`);
    const first = await createMember(`personal_group_hide_first_${suffix}`);
    const second = await createMember(`personal_group_hide_second_${suffix}`);
    const actorSession = await login(actor);

    const group = await createConversationFor(actorSession, [first.id, second.id]);
    expect(group.kind).toBe("group");
    expect((await request(adminSession, `/api/members/${second.id}/disable`, "POST")).status).toBe(204);

    // Группа остаётся видимой, отключённого участника в составе нет (допущение A2).
    const list = await request(actorSession, "/api/conversations");
    const conversations = (await list.json() as { conversations: ConversationView[] }).conversations;
    const found = conversations.find((conversation) => conversation.id === group.id);
    expect(found).toBeDefined();
    expect(found?.participants.map((participant) => participant.id)).not.toContain(second.id);
    expect(found?.participants.map((participant) => participant.id)).toContain(first.id);
  }, 120_000);

  it("lets only the author edit and delete a conversation message and keeps the three day window", async () => {
    const suffix = randomBytes(5).toString("hex");
    const author = await createMember(`personal_edit_author_${suffix}`);
    const peer = await createMember(`personal_edit_peer_${suffix}`);
    const authorSession = await login(author);
    const peerSession = await login(peer);
    const conversation = await createConversationFor(authorSession, [peer.id]);
    const path = conversationMessagesPath(conversation.id);

    const sentResponse = await request(authorSession, path, "POST", {
      content: "черновик сообщения",
      clientRequestId: randomUUID()
    });
    const sent = await sentResponse.json() as MessageSnapshot;
    expect(sentResponse.status, JSON.stringify(sent)).toBe(201);
    const messagePath = `${path}/${sent.id}`;

    // автор правит своё сообщение, второй участник получает событие.
    const peerSocket = await connect(peerSession);
    const updatedEvent = waitForEvent(peerSocket, "conversation:message:updated", 5_000);
    const editResponse = await request(authorSession, messagePath, "PATCH", { content: "исправленное сообщение" });
    const edited = await editResponse.json() as MessageSnapshot;
    expect(editResponse.status, JSON.stringify(edited)).toBe(200);
    expect(edited.content).toBe("исправленное сообщение");
    expect(edited.editedAt).not.toBeNull();
    const delivered = await updatedEvent as { conversationId: string; message: MessageSnapshot };
    expect(delivered.conversationId).toBe(conversation.id);
    expect(delivered.message.id).toBe(sent.id);
    expect(delivered.message.content).toBe("исправленное сообщение");

    // Чужое сообщение не правит даже второй участник переписки.
    await expectError(
      await request(peerSession, messagePath, "PATCH", { content: "чужое" }),
      403,
      "FORBIDDEN"
    );
    // Тело разбирается по allow-list.
    for (const body of [{}, { content: "x", extra: true }, { content: "" }, { content: "x".repeat(2001) }]) {
      await expectError(await request(authorSession, messagePath, "PATCH", body), 400, "INVALID_REQUEST");
    }

    // Окно правки — те же три дня, что в каналах (допущение A7).
    await pool.query("UPDATE messages SET created_at = now() - interval '4 days' WHERE id = $1", [sent.id]);
    await expectError(
      await request(authorSession, messagePath, "PATCH", { content: "слишком поздно" }),
      403,
      "EDIT_WINDOW_EXPIRED"
    );

    // Удаление чужого сообщения запрещено, своё удаляется и приходит tombstone.
    const peerMessageResponse = await request(peerSession, path, "POST", {
      content: "чужое сообщение",
      clientRequestId: randomUUID()
    });
    const peerMessage = await peerMessageResponse.json() as MessageSnapshot;
    expect(peerMessageResponse.status).toBe(201);
    await expectError(await request(authorSession, `${path}/${peerMessage.id}`, "DELETE"), 403, "FORBIDDEN");

    const deleteResponse = await request(authorSession, messagePath, "DELETE");
    expect(deleteResponse.status).toBe(204);
    // История мягко удалённое не отдаёт — tombstone виден в догоне.
    const catchUpResponse = await request(authorSession, `${path}?after=0`);
    const catchUp = await catchUpResponse.json() as MessageHistoryBody;
    expect(catchUpResponse.status).toBe(200);
    const tombstone = catchUp.messages.find((message) => message.id === sent.id);
    expect(tombstone?.deleted).toBe(true);
    expect(typeof tombstone?.updatedSeq).toBe("number");
    // Повтор над удалённым — 404: сообщение уже не существует для правки.
    await expectError(await request(authorSession, messagePath, "PATCH", { content: "воскрешение" }), 404, "MESSAGE_NOT_FOUND");
    await expectError(await request(authorSession, messagePath, "DELETE"), 404, "MESSAGE_NOT_FOUND");

    peerSocket.disconnect();
  }, 120_000);

  it("does not apply the manage messages right inside a conversation", async () => {
    const suffix = randomBytes(5).toString("hex");
    const author = await createMember(`personal_mod_author_${suffix}`);
    const moderator = await createMember(`personal_mod_owner_${suffix}`);
    const authorSession = await login(author);
    const moderatorSession = await login(moderator);
    const roleId = await createRole(`personal_moderator_${suffix}`, [
      "VIEW_CHANNEL",
      "SEND_MESSAGES",
      "MANAGE_MESSAGES"
    ]);
    await assignRoles(moderator.id, [roleId]);

    // Контрольная проверка: в канале право действительно есть.
    const channel = await createSendableChannel(`personal_mod_channel_${suffix}`);
    const channelMessage = await sendToChannel(authorSession, channel.id, "канальное сообщение");
    const channelDelete = await request(moderatorSession, `/api/channels/${channel.id}/messages/${channelMessage.id}`, "DELETE");
    expect(channelDelete.status).toBe(204);

    // В переписке то же право не действует: модератор удаляет только своё.
    const conversation = await createConversationFor(authorSession, [moderator.id]);
    const path = conversationMessagesPath(conversation.id);
    const conversationMessageResponse = await request(authorSession, path, "POST", {
      content: "сообщение в переписке",
      clientRequestId: randomUUID()
    });
    const conversationMessage = await conversationMessageResponse.json() as MessageSnapshot;
    expect(conversationMessageResponse.status).toBe(201);

    await expectError(
      await request(moderatorSession, `${path}/${conversationMessage.id}`, "DELETE"),
      403,
      "FORBIDDEN"
    );
    await expectError(
      await request(moderatorSession, `${path}/${conversationMessage.id}`, "PATCH", { content: "правка модератора" }),
      403,
      "FORBIDDEN"
    );
    const stored = await pool.query<{ deleted_at: Date | null; content: string }>(
      "SELECT deleted_at, content FROM messages WHERE id = $1",
      [conversationMessage.id]
    );
    expect(stored.rows[0]?.deleted_at).toBeNull();
    expect(stored.rows[0]?.content).toBe("сообщение в переписке");
  }, 120_000);

  it("forwards between channels and conversations in both directions without mentions", async () => {
    const suffix = randomBytes(5).toString("hex");
    const author = await createMember(`personal_forward_author_${suffix}`);
    const peer = await createMember(`personal_forward_peer_${suffix}`);
    const outsider = await createMember(`personal_forward_outsider_${suffix}`);
    const insider = await createMember(`personal_forward_insider_${suffix}`);
    const authorSession = await login(author);
    const peerSession = await login(peer);
    const outsiderSession = await login(outsider);
    const channel = await createSendableChannel(`personal_forward_channel_${suffix}`);
    const conversation = await createConversationFor(authorSession, [peer.id]);

    // Оригинал с упоминанием: при пересылке упоминания не переносятся.
    const original = await sendToChannel(authorSession, channel.id, `пересылаемое @${peer.login}`);

    // Канал → переписка.
    const toConversationResponse = await request(
      authorSession,
      `/api/channels/${channel.id}/messages/${original.id}/forward`,
      "POST",
      { targetConversationId: conversation.id }
    );
    const toConversation = await toConversationResponse.json() as MessageSnapshot;
    expect(toConversationResponse.status, JSON.stringify(toConversation)).toBe(201);
    expect(toConversation.channelId).toBeNull();
    expect(toConversation.conversationId).toBe(conversation.id);
    expect(toConversation.mentions).toEqual([]);
    expect(toConversation.forwardedFrom).toEqual({
      messageId: original.id,
      channelId: channel.id,
      conversationId: null,
      authorLogin: author.login,
      originalDeleted: false
    });
    expect(await mentionRows(toConversation.id)).toBe(0);

    // Переписка → канал.
    const toChannelResponse = await request(
      authorSession,
      `/api/conversations/${conversation.id}/messages/${toConversation.id}/forward`,
      "POST",
      { targetChannelId: channel.id }
    );
    const toChannel = await toChannelResponse.json() as MessageSnapshot;
    expect(toChannelResponse.status, JSON.stringify(toChannel)).toBe(201);
    expect(toChannel.channelId).toBe(channel.id);
    expect(toChannel.conversationId).toBeNull();
    expect(toChannel.mentions).toEqual([]);
    expect(toChannel.forwardedFrom).toEqual({
      messageId: original.id,
      channelId: channel.id,
      conversationId: null,
      authorLogin: author.login,
      originalDeleted: false
    });

    // Переписка → переписка: атрибуция указывает на область-источник. Оригинал
    // берётся обычный: у пересланного копии наследуется атрибуция его оригинала.
    const secondConversation = await createConversationFor(peerSession, [author.id, insider.id]);
    const nativeMessageResponse = await request(peerSession, conversationMessagesPath(conversation.id), "POST", {
      content: "сообщение переписки без пересылки",
      clientRequestId: randomUUID()
    });
    const nativeMessage = await nativeMessageResponse.json() as MessageSnapshot;
    expect(nativeMessageResponse.status).toBe(201);
    const conversationToConversationResponse = await request(
      authorSession,
      `/api/conversations/${conversation.id}/messages/${nativeMessage.id}/forward`,
      "POST",
      { targetConversationId: secondConversation.id }
    );
    const forwardedCopy = await conversationToConversationResponse.json() as MessageSnapshot;
    expect(conversationToConversationResponse.status, JSON.stringify(forwardedCopy)).toBe(201);
    expect(forwardedCopy.conversationId).toBe(secondConversation.id);
    expect(forwardedCopy.forwardedFrom?.conversationId).toBe(conversation.id);
    expect(forwardedCopy.forwardedFrom?.channelId).toBeNull();
    expect(forwardedCopy.forwardedFrom?.messageId).toBe(nativeMessage.id);
    expect(forwardedCopy.forwardedFrom?.authorLogin).toBe(peer.login);
    expect(forwardedCopy.mentions).toEqual([]);

    // Источник и цель проверяются независимо.
    await expectError(
      await request(
        outsiderSession,
        `/api/channels/${channel.id}/messages/${original.id}/forward`,
        "POST",
        { targetConversationId: secondConversation.id }
      ),
      404,
      "CONVERSATION_NOT_FOUND"
    );
    const outsiderConversation = await createConversationFor(outsiderSession, [peer.id]);
    await expectError(
      await request(
        authorSession,
        `/api/channels/${channel.id}/messages/${original.id}/forward`,
        "POST",
        { targetConversationId: outsiderConversation.id }
      ),
      404,
      "CONVERSATION_NOT_FOUND"
    );
    await expectError(
      await request(
        outsiderSession,
        `/api/conversations/${conversation.id}/messages/${toConversation.id}/forward`,
        "POST",
        { targetChannelId: channel.id }
      ),
      404,
      "CONVERSATION_NOT_FOUND"
    );

    // Тело пересылки — ровно один ключ цели.
    for (const body of [
      {},
      { targetChannelId: channel.id, targetConversationId: conversation.id },
      { targetConversationId: conversation.id, extra: true },
      { targetChannelId: "not-a-uuid" }
    ]) {
      await expectError(
        await request(authorSession, `/api/channels/${channel.id}/messages/${original.id}/forward`, "POST", body),
        400,
        "INVALID_REQUEST"
      );
    }
    await expectError(
      await request(peerSession, `/api/conversations/${conversation.id}/messages/not-a-uuid/forward`, "POST", {
        targetConversationId: conversation.id
      }),
      400,
      "INVALID_REQUEST"
    );
  }, 180_000);

  it("has no readers and pins routes for conversations", async () => {
    const suffix = randomBytes(5).toString("hex");
    const author = await createMember(`personal_routes_author_${suffix}`);
    const peer = await createMember(`personal_routes_peer_${suffix}`);
    const authorSession = await login(author);
    const conversation = await createConversationFor(authorSession, [peer.id]);
    const path = conversationMessagesPath(conversation.id);
    const sentResponse = await request(authorSession, path, "POST", {
      content: "сообщение без закреплений",
      clientRequestId: randomUUID()
    });
    const sent = await sentResponse.json() as MessageSnapshot;
    expect(sentResponse.status).toBe(201);

    // маршрутов «кто прочитал» и закреплений у переписки нет.
    // Незарегистрированный путь к API отсекает белый список до роутера,
    // поэтому ответ — 404 (маршрут зарегистрирован, но пуст) или 401;
    // данных в обоих случаях нет.
    const missingRoutes: Array<[string, string, unknown]> = [
      ["GET", `${path}/${sent.id}/readers`, undefined],
      ["GET", `/api/conversations/${conversation.id}/pins`, undefined],
      ["POST", `/api/conversations/${conversation.id}/pins`, { messageId: sent.id }]
    ];
    for (const [method, route, body] of missingRoutes) {
      const response = await request(authorSession, route, method, body);
      expect([401, 404], `${method} ${route}: ${response.status}`).toContain(response.status);
      const payload = await response.json() as Record<string, unknown>;
      expect(payload.readers).toBeUndefined();
      expect(payload.pins).toBeUndefined();
    }

    // Канальные маршруты чтения и закреплений не задеты.
    const channel = await createSendableChannel(`personal_routes_channel_${suffix}`);
    const channelMessage = await sendToChannel(authorSession, channel.id, "канальное сообщение");
    const readers = await request(authorSession, `/api/channels/${channel.id}/messages/${channelMessage.id}/readers`);
    expect(readers.status).toBe(200);
    const pins = await request(authorSession, `/api/channels/${channel.id}/pins`);
    expect(pins.status).toBe(200);
  }, 120_000);

  it("rejects an anonymous request before the route is served", async () => {
    const anonymous: HttpSession = {};
    const response = await request(anonymous, "/api/conversations");
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "UNAUTHORIZED" } });

    const list = await request(adminSession, "/api/conversations");
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ conversations: expect.any(Array) });
  }, 60_000);
}
