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
const inContainer = process.env.CONVERSATION_MEMBERSHIP_TEST_IN_CONTAINER === "true";

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
  describe("conversation membership integration", () => {
    let fixtureDirectory = "";
    let projectName = "";
    let envFile = "";
    let overrideFile = "";

    function run(args: string[], timeout = commandTimeoutMs) {
      return compose(projectName, envFile, overrideFile, args, timeout);
    }

    beforeAll(() => {
      fixtureDirectory = mkdtempSync(join(tmpdir(), "decentracord-conversation-membership-"));
      const suffix = randomBytes(6).toString("hex");
      projectName = `decentracord-conversation-membership-${suffix}`;
      const databaseName = `decentracord_test_${suffix}`;
      const databaseUser = `membership_${suffix.slice(0, 10)}`;
      const databasePassword = randomBytes(24).toString("base64url");
      const adminLogin = `membership_admin_${suffix.slice(0, 10)}`;
      const adminPassword = `Membership-admin-${randomBytes(18).toString("base64url")}`;
      const secretFile = join(fixtureDirectory, "db_password");
      envFile = join(fixtureDirectory, "compose.env");
      overrideFile = join(fixtureDirectory, "compose.conversation-membership.yaml");
      const buildxConfig = join(fixtureDirectory, "buildx");
      mkdirSync(buildxConfig, { mode: 0o700 });
      writeFileSync(secretFile, databasePassword, { mode: 0o600 });
      chmodSync(secretFile, 0o600);
      writeFileSync(envFile, [
        `DB_PASSWORD_SECRET_FILE=${secretFile}`,
        `DB_PASSWORD=${databasePassword}`,
        `DB_NAME=${databaseName}`,
        `DB_USER=${databaseUser}`,
        `CONVERSATION_MEMBERSHIP_TEST_ADMIN_LOGIN=${adminLogin}`,
        `CONVERSATION_MEMBERSHIP_TEST_ADMIN_PASSWORD=${adminPassword}`,
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
        `    image: ${JSON.stringify(`decentracord-conversation-membership-runner:${suffix}`)}`,
        '    entrypoint: ["npm", "run", "test:integration", "--", "tests/integration/conversation-membership.test.ts"]',
        "    environment:",
        "      NODE_ENV: test",
        "      CONVERSATION_MEMBERSHIP_TEST_IN_CONTAINER: \"true\"",
        "      CONVERSATION_MEMBERSHIP_TEST_BASE_URL: http://app:3000",
        "      CONVERSATION_MEMBERSHIP_TEST_ADMIN_LOGIN: ${CONVERSATION_MEMBERSHIP_TEST_ADMIN_LOGIN}",
        "      CONVERSATION_MEMBERSHIP_TEST_ADMIN_PASSWORD: ${CONVERSATION_MEMBERSHIP_TEST_ADMIN_PASSWORD}",
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

    it("changes group membership by right and hides history behind the flag", () => {
      const args = ["run", "--rm", "--no-deps", "-T", "-e", "CONVERSATION_MEMBERSHIP_TEST_IN_CONTAINER=true", "test-runner"];
      const result = run(args, 600_000);
      // Отчёт внутреннего прогона виден и при успехе: иначе число проверок
      // состава, набора и видимости истории не проверить по логу.
      process.stdout.write(result.stdout ?? "");
      if (result.status !== 0) {
        const logs = run(["logs", "--no-color", "app"], 30_000);
        process.stderr.write(`App logs after conversation membership failure:\n${logs.stdout ?? ""}${logs.stderr ?? ""}\n`);
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

  interface ConversationParticipantView {
    id: string;
    login: string;
    presence: "online" | "offline";
    canAddParticipants: boolean;
  }

  interface ConversationView {
    id: string;
    kind: "direct" | "group";
    participants: ConversationParticipantView[];
    lastMessageAt: string | null;
    createdAt: string;
    unreadCount: number;
    canManageMembers: boolean;
    isCreator: boolean;
  }

  interface MessageMentionView {
    id: string;
    login: string;
  }

  interface MessageSnapshot {
    id: string;
    conversationId: string | null;
    seq: number;
    updatedSeq: number;
    content: string;
    mentions: MessageMentionView[];
  }

  interface MessageHistoryBody {
    messages: MessageSnapshot[];
    hasMore: boolean;
    cursor: number;
  }

  const baseUrl = process.env.CONVERSATION_MEMBERSHIP_TEST_BASE_URL ?? "http://app:3000";
  const appOrigin = new URL(baseUrl).origin;
  const adminCredentials = {
    login: process.env.CONVERSATION_MEMBERSHIP_TEST_ADMIN_LOGIN ?? "",
    password: process.env.CONVERSATION_MEMBERSHIP_TEST_ADMIN_PASSWORD ?? ""
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
    const password = `Membership-member-${randomBytes(16).toString("base64url")}`;
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

  async function createConversationFor(actor: HttpSession, peerIds: string[]): Promise<ConversationView> {
    const response = await request(actor, "/api/conversations", "POST", { participantIds: peerIds });
    const body = await response.json() as ConversationView;
    expect(response.status, JSON.stringify(body)).toBe(201);
    return body;
  }

  function participantsPath(conversationId: string): string {
    return `/api/conversations/${conversationId}/participants`;
  }

  function participantPath(conversationId: string, userId: string): string {
    return `${participantsPath(conversationId)}/${userId}`;
  }

  function messagesPath(conversationId: string): string {
    return `/api/conversations/${conversationId}/messages`;
  }

  async function send(actor: HttpSession, conversationId: string, content: string): Promise<MessageSnapshot> {
    const response = await request(actor, messagesPath(conversationId), "POST", {
      content,
      clientRequestId: randomUUID()
    });
    const body = await response.json() as MessageSnapshot;
    expect(response.status, JSON.stringify(body)).toBe(201);
    return body;
  }

  async function history(actor: HttpSession, conversationId: string, query = ""): Promise<MessageHistoryBody> {
    const response = await request(actor, `${messagesPath(conversationId)}${query}`);
    const body = await response.json() as MessageHistoryBody;
    expect(response.status, JSON.stringify(body)).toBe(200);
    return body;
  }

  async function conversationOf(session: HttpSession, conversationId: string): Promise<ConversationView | undefined> {
    const response = await request(session, "/api/conversations");
    expect(response.status).toBe(200);
    const body = await response.json() as { conversations: ConversationView[] };
    return body.conversations.find((conversation) => conversation.id === conversationId);
  }

  async function participantIdsOf(conversationId: string): Promise<string[]> {
    const result = await pool.query<{ user_id: string }>(
      "SELECT user_id::text AS user_id FROM conversation_participants WHERE conversation_id = $1",
      [conversationId]
    );
    return result.rows.map((row) => row.user_id);
  }

  async function mentionRowsOf(messageId: string): Promise<string[]> {
    const result = await pool.query<{ user_id: string }>(
      "SELECT user_id::text AS user_id FROM message_mentions WHERE message_id = $1",
      [messageId]
    );
    return result.rows.map((row) => row.user_id);
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

  function sleep(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, timeoutMs));
  }

  // Следы набора в базе: состояние набора сервер не хранит, поэтому
  // число сообщений и строк состава не меняется, а таблицы состояния нет.
  async function typingFootprint(conversationId: string): Promise<{ messages: number; participants: number; table: string | null }> {
    const messages = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM messages WHERE conversation_id = $1",
      [conversationId]
    );
    const participants = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM conversation_participants WHERE conversation_id = $1",
      [conversationId]
    );
    const table = await pool.query<{ name: string | null }>("SELECT to_regclass('typing_state')::text AS name");
    return {
      messages: messages.rows[0]?.count ?? 0,
      participants: participants.rows[0]?.count ?? 0,
      table: table.rows[0]?.name ?? null
    };
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

  it("adds a participant with the flag on and lets them read the whole history", async () => {
    const suffix = randomBytes(5).toString("hex");
    const creator = await createMember(`membership_history_on_creator_${suffix}`);
    const first = await createMember(`membership_history_on_first_${suffix}`);
    const second = await createMember(`membership_history_on_second_${suffix}`);
    const late = await createMember(`membership_history_on_late_${suffix}`);
    const creatorSession = await login(creator);
    const lateSession = await login(late);

    const group = await createConversationFor(creatorSession, [first.id, second.id]);
    expect(group.kind).toBe("group");
    expect(group.isCreator).toBe(true);
    await send(creatorSession, group.id, "первое до добавления");
    await send(creatorSession, group.id, "второе до добавления");

    const added = await request(creatorSession, participantsPath(group.id), "POST", {
      userId: late.id,
      showHistory: true
    });
    expect(added.status).toBe(204);

    // Вся история видна: граница видимости осталась нулевой.
    const visibleHistory = await history(lateSession, group.id);
    expect(visibleHistory.messages.map((message) => message.content))
      .toEqual(["первое до добавления", "второе до добавления"]);
    // История не считается непрочитанной: бейдж не появляется (Q3).
    expect((await conversationOf(lateSession, group.id))?.unreadCount).toBe(0);
    expect(await participantIdsOf(group.id)).toContain(late.id);

    // Неучастник по-прежнему не видит переписку.
    const outsider = await createMember(`membership_history_on_outsider_${suffix}`);
    const outsiderSession = await login(outsider);
    await expectError(await request(outsiderSession, messagesPath(group.id)), 404, "CONVERSATION_NOT_FOUND");
  }, 120_000);

  it("hides the history from a participant added without the flag", async () => {
    const suffix = randomBytes(5).toString("hex");
    const creator = await createMember(`membership_history_off_creator_${suffix}`);
    const peer = await createMember(`membership_history_off_peer_${suffix}`);
    const witness = await createMember(`membership_history_off_witness_${suffix}`);
    const late = await createMember(`membership_history_off_late_${suffix}`);
    const creatorSession = await login(creator);
    const lateSession = await login(late);

    // Двое приглашённых: один участник в теле создания даёт переписку на двоих.
    const group = await createConversationFor(creatorSession, [peer.id, witness.id]);
    expect(group.kind).toBe("group");
    await send(creatorSession, group.id, "скрытое первое");
    await send(creatorSession, group.id, "скрытое второе");

    const added = await request(creatorSession, participantsPath(group.id), "POST", {
      userId: late.id,
      showHistory: false
    });
    expect(added.status).toBe(204);

    // Сообщения до добавления скрыты, но непрочитанными не считаются.
    const hiddenHistory = await history(lateSession, group.id);
    expect(hiddenHistory.messages).toEqual([]);
    expect((await conversationOf(lateSession, group.id))?.unreadCount).toBe(0);

    // Догон с нуля не отдаёт скрытые сообщения и поднимает курсор до границы.
    const catchUp = await history(lateSession, group.id, "?after=0");
    expect(catchUp.messages).toEqual([]);
    const stored = await pool.query<{ visible_from_seq: number; last_seq: number }>(
      `SELECT p.visible_from_seq::int AS visible_from_seq, c.last_seq::int AS last_seq
       FROM conversation_participants AS p
       JOIN conversations AS c ON c.id = p.conversation_id
       WHERE p.conversation_id = $1 AND p.user_id = $2`,
      [group.id, late.id]
    );
    const boundary = stored.rows[0];
    expect(boundary?.visible_from_seq).toBe(boundary?.last_seq);
    expect(catchUp.cursor).toBeGreaterThanOrEqual(boundary?.visible_from_seq ?? 0);

    // Новое сообщение после добавления видно и поднимает счётчик.
    const fresh = await send(creatorSession, group.id, "после добавления");
    const afterJoin = await history(lateSession, group.id);
    expect(afterJoin.messages.map((message) => message.content)).toEqual(["после добавления"]);
    const catchUpAfter = await history(lateSession, group.id, "?after=0");
    expect(catchUpAfter.messages.map((message) => message.id)).toEqual([fresh.id]);
    expect((await conversationOf(lateSession, group.id))?.unreadCount).toBe(1);
  }, 120_000);

  it("grants the right to add members only through the creator", async () => {
    const suffix = randomBytes(5).toString("hex");
    const creator = await createMember(`membership_right_creator_${suffix}`);
    const holder = await createMember(`membership_right_holder_${suffix}`);
    const plain = await createMember(`membership_right_plain_${suffix}`);
    const extra = await createMember(`membership_right_extra_${suffix}`);
    const next = await createMember(`membership_right_next_${suffix}`);
    const creatorSession = await login(creator);
    const holderSession = await login(holder);
    const plainSession = await login(plain);

    const group = await createConversationFor(creatorSession, [holder.id, plain.id]);

    // Без права состав менять нельзя.
    await expectError(
      await request(plainSession, participantsPath(group.id), "POST", { userId: extra.id, showHistory: true }),
      403,
      "CANNOT_ADD_PARTICIPANTS"
    );

    // Создатель выдаёт право; у носителя появляется управление составом.
    const granted = await request(creatorSession, participantPath(group.id, holder.id), "PATCH", {
      canAddParticipants: true
    });
    expect(granted.status).toBe(204);
    const holderView = await conversationOf(holderSession, group.id);
    expect(holderView?.canManageMembers).toBe(true);
    // Переключатель права показывается только создателю.
    expect(holderView?.isCreator).toBe(false);
    expect(holderView?.participants.find((participant) => participant.id === holder.id)?.canAddParticipants)
      .toBe(true);

    // Носитель права добавляет участника.
    expect((await request(holderSession, participantsPath(group.id), "POST", {
      userId: extra.id,
      showHistory: true
    })).status).toBe(204);
    expect(await participantIdsOf(group.id)).toContain(extra.id);

    // Но передать право дальше не может: это делает только создатель.
    await expectError(
      await request(holderSession, participantPath(group.id, plain.id), "PATCH", { canAddParticipants: true }),
      403,
      "FORBIDDEN"
    );
    expect((await conversationOf(plainSession, group.id))?.canManageMembers).toBe(false);

    // Отзыв права возвращает 403 на добавление.
    expect((await request(creatorSession, participantPath(group.id, holder.id), "PATCH", {
      canAddParticipants: false
    })).status).toBe(204);
    await expectError(
      await request(holderSession, participantsPath(group.id), "POST", { userId: next.id, showHistory: true }),
      403,
      "CANNOT_ADD_PARTICIPANTS"
    );

    // Тело права разбирается по allow-list.
    for (const body of [{ canAddParticipants: "true" }, {}, { canAddParticipants: true, extra: true }]) {
      await expectError(await request(creatorSession, participantPath(group.id, plain.id), "PATCH", body), 400, "INVALID_REQUEST");
    }
    // Тело добавления тоже: ровно ключи userId и showHistory.
    for (const body of [{ userId: extra.id }, { userId: "not-a-uuid", showHistory: true }, { userId: extra.id, showHistory: true, extra: true }]) {
      await expectError(await request(creatorSession, participantsPath(group.id), "POST", body), 400, "INVALID_REQUEST");
    }
  }, 120_000);

  it("refuses a direct conversation, a duplicate, an oversized group and a disabled participant", async () => {
    const suffix = randomBytes(5).toString("hex");
    const creator = await createMember(`membership_limits_creator_${suffix}`);
    const peer = await createMember(`membership_limits_peer_${suffix}`);
    const disabled = await createMember(`membership_limits_disabled_${suffix}`);
    const creatorSession = await login(creator);

    // Переписку на двоих нельзя расширить третьим.
    const direct = await createConversationFor(creatorSession, [peer.id]);
    expect(direct.kind).toBe("direct");
    const third = await createMember(`membership_limits_third_${suffix}`);
    await expectError(
      await request(creatorSession, participantsPath(direct.id), "POST", { userId: third.id, showHistory: true }),
      409,
      "CONVERSATION_NOT_GROUP"
    );
    await expectError(
      await request(creatorSession, participantPath(direct.id, peer.id), "DELETE"),
      409,
      "CONVERSATION_NOT_GROUP"
    );

    // Предел группы — десять человек включая создателя.
    const invited: string[] = [];
    for (let index = 0; index < 9; index += 1) {
      const member = await createMember(`membership_limits_${index}_${suffix}`);
      invited.push(member.id);
    }
    const group = await createConversationFor(creatorSession, invited);
    expect(group.participants).toHaveLength(10);
    await expectError(
      await request(creatorSession, participantsPath(group.id), "POST", { userId: third.id, showHistory: true }),
      409,
      "TOO_MANY_PARTICIPANTS"
    );

    // Повторное добавление и добавление отключённого.
    const repeatedGroup = await createConversationFor(creatorSession, [peer.id, third.id]);
    await expectError(
      await request(creatorSession, participantsPath(repeatedGroup.id), "POST", { userId: peer.id, showHistory: true }),
      409,
      "ALREADY_PARTICIPANT"
    );
    expect((await request(adminSession, `/api/members/${disabled.id}/disable`, "POST")).status).toBe(204);
    await expectError(
      await request(creatorSession, participantsPath(repeatedGroup.id), "POST", { userId: disabled.id, showHistory: true }),
      404,
      "PARTICIPANT_NOT_FOUND"
    );

    // Создателя убрать нельзя.
    await expectError(
      await request(creatorSession, participantPath(repeatedGroup.id, creator.id), "DELETE"),
      409,
      "CREATOR_CANNOT_BE_REMOVED"
    );
    // Не-участник не управляет чужим составом.
    const outsider = await createMember(`membership_limits_outsider_${suffix}`);
    const outsiderSession = await login(outsider);
    await expectError(
      await request(outsiderSession, participantsPath(repeatedGroup.id), "POST", { userId: outsider.id, showHistory: true }),
      404,
      "CONVERSATION_NOT_FOUND"
    );
    await expectError(
      await request(outsiderSession, participantPath(repeatedGroup.id, peer.id), "DELETE"),
      404,
      "CONVERSATION_NOT_FOUND"
    );
  }, 180_000);

  it("removes a participant and keeps their messages without delivering new events", async () => {
    const suffix = randomBytes(5).toString("hex");
    const creator = await createMember(`membership_remove_creator_${suffix}`);
    const removed = await createMember(`membership_remove_target_${suffix}`);
    const witness = await createMember(`membership_remove_witness_${suffix}`);
    const creatorSession = await login(creator);
    const removedSession = await login(removed);
    const witnessSession = await login(witness);

    const group = await createConversationFor(creatorSession, [removed.id, witness.id]);
    const kept = await send(removedSession, group.id, "сообщение удалённого");

    const removedSocket = await connect(removedSession);
    const witnessSocket = await connect(witnessSession);
    const silentRemoved = expectNoEvent(removedSocket, "conversation:message:created", 1_000);

    expect((await request(creatorSession, participantPath(group.id, removed.id), "DELETE")).status).toBe(204);
    expect(await participantIdsOf(group.id)).not.toContain(removed.id);

    // Сообщения принадлежат переписке: строка остаётся у остальных.
    const witnessHistory = await history(witnessSession, group.id);
    expect(witnessHistory.messages.map((message) => message.id)).toContain(kept.id);

    // Новое сообщение доходит до оставшегося, но не до удалённого.
    const witnessDelivery = waitForEvent(witnessSocket, "conversation:message:created", 5_000);
    await send(creatorSession, group.id, "после удаления");
    expect(await witnessDelivery).toMatchObject({ conversationId: group.id });
    await silentRemoved;

    // Удалённый теряет доступ к истории и отправке.
    await expectError(await request(removedSession, messagesPath(group.id)), 404, "CONVERSATION_NOT_FOUND");
    await expectError(
      await request(removedSession, messagesPath(group.id), "POST", { content: "ещё", clientRequestId: randomUUID() }),
      404,
      "CONVERSATION_NOT_FOUND"
    );
    expect((await conversationOf(removedSession, group.id))).toBeUndefined();

    removedSocket.disconnect();
    witnessSocket.disconnect();
  }, 120_000);

  it("resolves mentions only inside the conversation", async () => {
    const suffix = randomBytes(5).toString("hex");
    const creator = await createMember(`membership_mention_creator_${suffix}`);
    const insider = await createMember(`membership_mention_insider_${suffix}`);
    const witness = await createMember(`membership_mention_witness_${suffix}`);
    const outsider = await createMember(`membership_mention_outsider_${suffix}`);
    const creatorSession = await login(creator);

    // Двое приглашённых: упоминания проверяются в групповой переписке.
    const group = await createConversationFor(creatorSession, [insider.id, witness.id]);
    expect(group.kind).toBe("group");

    // Упоминание участника резолвится и попадает в строки упоминаний.
    const inside = await send(creatorSession, group.id, `привет @${insider.login}`);
    expect(inside.mentions.map((mention) => mention.id)).toEqual([insider.id]);
    expect(await mentionRowsOf(inside.id)).toEqual([insider.id]);

    // Логин вне переписки остаётся текстом и строки не создаёт.
    const outside = await send(creatorSession, group.id, `привет @${outsider.login}`);
    expect(outside.mentions).toEqual([]);
    expect(await mentionRowsOf(outside.id)).toEqual([]);

    // История отдаёт те же упоминания, что и ответ на отправку.
    const stored = await history(creatorSession, group.id);
    expect(stored.messages.find((message) => message.id === inside.id)?.mentions.map((mention) => mention.login))
      .toEqual([insider.login]);
  }, 120_000);

  it("reports the composition and the creator flag in the conversation list", async () => {
    const suffix = randomBytes(5).toString("hex");
    const creator = await createMember(`membership_list_creator_${suffix}`);
    const first = await createMember(`membership_list_first_${suffix}`);
    const second = await createMember(`membership_list_second_${suffix}`);
    const creatorSession = await login(creator);
    const firstSession = await login(first);

    const group = await createConversationFor(creatorSession, [first.id, second.id]);

    const creatorView = await conversationOf(creatorSession, group.id);
    expect(creatorView?.isCreator).toBe(true);
    expect(creatorView?.canManageMembers).toBe(true);
    expect(creatorView?.participants.map((participant) => participant.id).sort()).toEqual([creator.id, first.id, second.id].sort());
    expect(creatorView?.participants.every((participant) =>
      participant.presence === "online" || participant.presence === "offline")).toBe(true);

    // Остальные видят состав, но не себя создателем и без права управления.
    const firstView = await conversationOf(firstSession, group.id);
    expect(firstView?.isCreator).toBe(false);
    expect(firstView?.canManageMembers).toBe(false);
    expect(firstView?.participants.map((participant) => participant.login).sort()).toEqual(
      [creator.login, first.login, second.login].sort()
    );
    expect(firstView?.participants.find((participant) => participant.id === first.id)?.canAddParticipants).toBe(false);

    // Переписка на двоих: управлять составом нельзя ни создателю, ни собеседнику.
    const direct = await createConversationFor(creatorSession, [first.id]);
    expect(direct.kind).toBe("direct");
    expect((await conversationOf(creatorSession, direct.id))?.canManageMembers).toBe(false);
    expect((await conversationOf(firstSession, direct.id))?.canManageMembers).toBe(false);
  }, 120_000);

  it("forwards typing to the other participants and keeps no state on the server", async () => {
    const suffix = randomBytes(5).toString("hex");
    const author = await createMember(`typing_author_${suffix}`);
    const peer = await createMember(`typing_peer_${suffix}`);
    const witness = await createMember(`typing_witness_${suffix}`);
    const outsider = await createMember(`typing_outsider_${suffix}`);
    const authorSession = await login(author);
    const peerSession = await login(peer);
    const outsiderSession = await login(outsider);

    const group = await createConversationFor(authorSession, [peer.id, witness.id]);
    const authorSocket = await connect(authorSession);
    const peerSocket = await connect(peerSession);
    const outsiderSocket = await connect(outsiderSession);

    const ownEvents: unknown[] = [];
    authorSocket.on("conversation:typing", (payload: unknown) => ownEvents.push(payload));
    const peerEvents: unknown[] = [];
    peerSocket.on("conversation:typing", (payload: unknown) => peerEvents.push(payload));
    const outsiderEvents: unknown[] = [];
    outsiderSocket.on("conversation:typing", (payload: unknown) => outsiderEvents.push(payload));
    // Ответов на набор быть не должно ни у кого: ошибка стала бы оракулом
    // существования переписки.
    const errors: unknown[] = [];
    for (const socket of [authorSocket, peerSocket, outsiderSocket]) {
      for (const event of ["conversation:typing:error", "error", "exception"]) {
        socket.on(event, (payload: unknown) => errors.push(payload));
      }
    }

    // Транспорт: событие доходит второму участнику с логином из базы, а не из
    // клиентского payload.
    const delivery = waitForEvent(peerSocket, "conversation:typing", 5_000);
    authorSocket.emit("conversation:typing", { conversationId: group.id });
    expect(await delivery).toEqual({ conversationId: group.id, userId: author.id, login: author.login });

    // Отправитель своего же события не получает.
    await expectNoEvent(authorSocket, "conversation:typing", 1_000);
    expect(ownEvents).toHaveLength(0);
    expect(peerEvents).toHaveLength(1);

    // Невалидный payload игнорируется молча: ни события, ни ошибки.
    for (const payload of [{ conversationId: group.id, extra: true }, { conversationId: "not-a-uuid" }, "строка"]) {
      authorSocket.emit("conversation:typing", payload);
    }
    await sleep(1_000);
    expect(peerEvents).toHaveLength(1);
    expect(errors).toHaveLength(0);

    // Троттлинг: два события подряд дают ровно одно.
    const beforeThrottle = peerEvents.length;
    authorSocket.emit("conversation:typing", { conversationId: group.id });
    authorSocket.emit("conversation:typing", { conversationId: group.id });
    await sleep(1_200);
    expect(peerEvents.length - beforeThrottle).toBe(1);

    // состояние набора не сохраняется — после двух событий число строк в
    // базе то же, а таблицы состояния нет.
    const beforeTyping = await typingFootprint(group.id);
    authorSocket.emit("conversation:typing", { conversationId: group.id });
    await sleep(1_200);
    authorSocket.emit("conversation:typing", { conversationId: group.id });
    await sleep(1_200);
    expect(await typingFootprint(group.id)).toEqual(beforeTyping);
    expect(beforeTyping.table).toBeNull();

    // Посторонний: ни события у участников, ни ошибки у него самого — набор не
    // подтверждает существование переписки.
    const beforeOutsider = peerEvents.length;
    outsiderSocket.emit("conversation:typing", { conversationId: group.id });
    outsiderSocket.emit("conversation:typing", { conversationId: randomUUID() });
    await expectNoEvent(outsiderSocket, "conversation:typing", 1_000);
    await sleep(200);
    expect(peerEvents).toHaveLength(beforeOutsider);
    expect(outsiderEvents).toHaveLength(0);
    expect(errors).toHaveLength(0);

    authorSocket.disconnect();
    peerSocket.disconnect();
    outsiderSocket.disconnect();
  }, 120_000);

  it("rejects an anonymous request before the route is served", async () => {
    // CSRF-токен выдаётся анонимной сессии: 401 доказывает, что маршрут прошёл
    // белый список и упёрся в проверку входа, а не в 404 от роутера.
    const anonymous: HttpSession = {};
    const csrfResponse = await request(anonymous, "/api/auth/csrf");
    expect(csrfResponse.status).toBe(200);
    const csrfBody = await csrfResponse.json() as { csrfToken?: unknown };
    expect(typeof csrfBody.csrfToken).toBe("string");
    anonymous.csrfToken = csrfBody.csrfToken as string;

    const conversationId = "6f1cbf7e-9a52-4a1e-8f0c-0b5f52a1e1a1";
    const participantId = "6f1cbf7e-9a52-4a1e-8f0c-0b5f52a1e1a2";
    const addResponse = await request(anonymous, participantsPath(conversationId), "POST", {
      userId: participantId,
      showHistory: true
    });
    expect(addResponse.status).toBe(401);
    expect(await addResponse.json()).toMatchObject({ error: { code: "UNAUTHORIZED" } });

    const rightResponse = await request(anonymous, participantPath(conversationId, participantId), "PATCH", {
      canAddParticipants: true
    });
    expect(rightResponse.status).toBe(401);
    expect(await rightResponse.json()).toMatchObject({ error: { code: "UNAUTHORIZED" } });

    const removeResponse = await request(anonymous, participantPath(conversationId, participantId), "DELETE");
    expect(removeResponse.status).toBe(401);
    expect(await removeResponse.json()).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  }, 60_000);
}
