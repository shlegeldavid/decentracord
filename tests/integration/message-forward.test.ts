import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const commandTimeoutMs = 180_000;
const inContainer = process.env.MESSAGE_FORWARD_TEST_IN_CONTAINER === "true";

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
  describe("message forward integration", () => {
    let fixtureDirectory = "";
    let projectName = "";
    let envFile = "";
    let overrideFile = "";

    function run(args: string[], timeout = commandTimeoutMs) {
      return compose(projectName, envFile, overrideFile, args, timeout);
    }

    beforeAll(() => {
      fixtureDirectory = mkdtempSync(join(tmpdir(), "decentracord-message-forward-"));
      const suffix = randomBytes(6).toString("hex");
      projectName = `decentracord-message-forward-${suffix}`;
      const databaseName = `decentracord_test_${suffix}`;
      const databaseUser = `message_forward_${suffix.slice(0, 10)}`;
      const databasePassword = randomBytes(24).toString("base64url");
      const adminLogin = `message_forward_admin_${suffix.slice(0, 10)}`;
      const adminPassword = `Message-forward-admin-${randomBytes(18).toString("base64url")}`;
      const secretFile = join(fixtureDirectory, "db_password");
      envFile = join(fixtureDirectory, "compose.env");
      overrideFile = join(fixtureDirectory, "compose.message-forward.yaml");
      const buildxConfig = join(fixtureDirectory, "buildx");
      mkdirSync(buildxConfig, { mode: 0o700 });
      writeFileSync(secretFile, databasePassword, { mode: 0o600 });
      chmodSync(secretFile, 0o600);
      writeFileSync(envFile, [
        `DB_PASSWORD_SECRET_FILE=${secretFile}`,
        `DB_PASSWORD=${databasePassword}`,
        `DB_NAME=${databaseName}`,
        `DB_USER=${databaseUser}`,
        `MESSAGE_FORWARD_TEST_ADMIN_LOGIN=${adminLogin}`,
        `MESSAGE_FORWARD_TEST_ADMIN_PASSWORD=${adminPassword}`,
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
        `    image: ${JSON.stringify(`decentracord-message-forward-runner:${suffix}`)}`,
        '    entrypoint: ["npm", "run", "test:integration", "--", "tests/integration/message-forward.test.ts"]',
        "    environment:",
        "      NODE_ENV: test",
        "      MESSAGE_FORWARD_TEST_IN_CONTAINER: \"true\"",
        "      MESSAGE_FORWARD_TEST_BASE_URL: http://app:3000",
        "      MESSAGE_FORWARD_TEST_ADMIN_LOGIN: ${MESSAGE_FORWARD_TEST_ADMIN_LOGIN}",
        "      MESSAGE_FORWARD_TEST_ADMIN_PASSWORD: ${MESSAGE_FORWARD_TEST_ADMIN_PASSWORD}",
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

    it("runs message forward checks against an isolated PostgreSQL database", () => {
      const args = ["run", "--rm", "--no-deps", "-T", "-e", "MESSAGE_FORWARD_TEST_IN_CONTAINER=true", "test-runner"];
      assertComposeSucceeded(run(args, 600_000), args);
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

  interface ForwardedFrom {
    messageId: string;
    channelId: string;
    authorLogin: string;
    originalDeleted: boolean;
  }

  interface MessageView {
    id: string;
    channelId: string;
    authorId: string;
    authorLogin: string;
    seq: number;
    content: string;
    mentions: Array<{ id: string; login: string }>;
    forwardedFrom: ForwardedFrom | null;
  }

  const baseUrl = process.env.MESSAGE_FORWARD_TEST_BASE_URL ?? "http://app:3000";
  const appOrigin = new URL(baseUrl).origin;
  const adminCredentials = {
    login: process.env.MESSAGE_FORWARD_TEST_ADMIN_LOGIN ?? "",
    password: process.env.MESSAGE_FORWARD_TEST_ADMIN_PASSWORD ?? ""
  };
  let pool: Pool;
  let adminSession: HttpSession;
  let memberSession: HttpSession;
  let member: MemberIdentity;
  let sourceChannel: ChannelIdentity;
  let targetChannel: ChannelIdentity;
  let readOnlyChannel: ChannelIdentity;
  let hiddenChannel: ChannelIdentity;

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
    const password = `Message-forward-member-${randomBytes(16).toString("base64url")}`;
    const response = await request(adminSession, "/api/members", "POST", { login: loginValue, password });
    expect(response.status).toBe(201);
    const created = await response.json() as { id: string; login: string };
    return { id: created.id, login: created.login, password };
  }

  async function createRole(name: string, position: number, permissions: string[]): Promise<string> {
    const result = await pool.query<{ id: string }>(
      "INSERT INTO roles (system_key, name, position, permissions) VALUES (NULL, $1, $2, $3::jsonb) RETURNING id::text AS id",
      [name, position, JSON.stringify(permissions)]
    );
    const id = result.rows[0]?.id;
    if (!id) throw new Error("Message forward test role was not created");
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

  async function sendMessage(session: HttpSession, channelId: string, content: string): Promise<MessageView> {
    const response = await request(session, `/api/channels/${channelId}/messages`, "POST", {
      content,
      clientRequestId: randomUUID()
    });
    expect(response.status).toBe(201);
    return response.json() as Promise<MessageView>;
  }

  async function forwardMessage(
    session: HttpSession,
    sourceChannelId: string,
    messageId: string,
    targetChannelId: string
  ): Promise<Response> {
    return request(
      session,
      `/api/channels/${sourceChannelId}/messages/${messageId}/forward`,
      "POST",
      { targetChannelId }
    );
  }

  async function listMessages(session: HttpSession, channelId: string): Promise<MessageView[]> {
    const response = await request(session, `/api/channels/${channelId}/messages?limit=50`);
    expect(response.status).toBe(200);
    const body = await response.json() as { messages?: unknown[] };
    expect(Array.isArray(body.messages)).toBe(true);
    return body.messages as MessageView[];
  }

  async function expectError(response: Response, status: number, code: string): Promise<void> {
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code } });
  }

  async function mentionRows(messageId: string): Promise<number> {
    const result = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM message_mentions WHERE message_id = $1",
      [messageId]
    );
    return result.rows[0]?.count ?? 0;
  }

  async function forwardRow(messageId: string): Promise<{
    forwarded_from_message_id: string | null;
    forwarded_from_channel_id: string | null;
  } | null> {
    const result = await pool.query<{
      forwarded_from_message_id: string | null;
      forwarded_from_channel_id: string | null;
    }>(
      "SELECT forwarded_from_message_id::text AS forwarded_from_message_id, forwarded_from_channel_id::text AS forwarded_from_channel_id FROM messages WHERE id = $1",
      [messageId]
    );
    return result.rows[0] ?? null;
  }

  beforeAll(async () => {
    const database = new URL(process.env.TEST_DATABASE_URL ?? "");
    expect(database.hostname).toBe("db");
    expect(database.pathname).toMatch(/^\/decentracord_test_[a-f0-9]+$/u);
    expect(new URL(baseUrl).hostname).toBe("app");
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8, connectionTimeoutMillis: 3_000 });
    adminSession = await login(adminCredentials);

    const suffix = randomBytes(5).toString("hex");
    const memberRoleId = await createRole(`forward_member_${suffix}`, 30, ["VIEW_CHANNEL", "SEND_MESSAGES"]);
    member = await createMember(`forward_member_${suffix}`);
    await assignRole(member.id, memberRoleId);

    sourceChannel = await createChannel(`forward_source_${suffix}`);
    targetChannel = await createChannel(`forward_target_${suffix}`);
    readOnlyChannel = await createChannel(`forward_readonly_${suffix}`);
    hiddenChannel = await createChannel(`forward_hidden_${suffix}`);

    const sendable = [
      { subject: "everyone", subjectId: null, permission: "VIEW_CHANNEL", effect: "allow" },
      { subject: "everyone", subjectId: null, permission: "SEND_MESSAGES", effect: "allow" }
    ];
    const readOnly = [
      { subject: "everyone", subjectId: null, permission: "VIEW_CHANNEL", effect: "allow" },
      { subject: "everyone", subjectId: null, permission: "SEND_MESSAGES", effect: "deny" }
    ];
    const hidden = [
      { subject: "everyone", subjectId: null, permission: "VIEW_CHANNEL", effect: "deny" }
    ];
    expect((await setOverrides(sourceChannel.id, sendable)).status).toBe(204);
    expect((await setOverrides(targetChannel.id, sendable)).status).toBe(204);
    expect((await setOverrides(readOnlyChannel.id, readOnly)).status).toBe(204);
    expect((await setOverrides(hiddenChannel.id, hidden)).status).toBe(204);

    memberSession = await login(member);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
  });

  it("forwards a message into a sendable channel and keeps the original in place", async () => {
    const content = `сообщение для пересылки @${member.login}`;
    const original = await sendMessage(adminSession, sourceChannel.id, content);
    // Упоминание в оригинале есть — в пересланной копии его быть не должно.
    expect(original.mentions.length).toBeGreaterThan(0);

    const response = await forwardMessage(memberSession, sourceChannel.id, original.id, targetChannel.id);
    expect(response.status).toBe(201);
    const forwarded = await response.json() as MessageView;

    // Пометка называет автора оригинала, а не пересылающего.
    expect(forwarded.forwardedFrom).toMatchObject({
      messageId: original.id,
      channelId: sourceChannel.id,
      authorLogin: adminCredentials.login,
      originalDeleted: false
    });
    expect(forwarded.authorLogin).toBe(member.login);
    // Форматирование сохраняется дословно.
    expect(forwarded.content).toBe(original.content);
    // Упоминания не переносятся.
    expect(forwarded.mentions).toEqual([]);
    expect(await mentionRows(forwarded.id)).toBe(0);
    expect(forwarded.channelId).toBe(targetChannel.id);

    // Оригинал остаётся в канале-источнике.
    const sourceHistory = await listMessages(memberSession, sourceChannel.id);
    expect(sourceHistory.some((message) => message.id === original.id)).toBe(true);
    const targetHistory = await listMessages(memberSession, targetChannel.id);
    expect(targetHistory.some((message) => message.id === forwarded.id)).toBe(true);
    expect(targetHistory.some((message) => message.id === original.id)).toBe(false);
  }, 60_000);

  it("refuses to forward from a channel the participant cannot read", async () => {
    const original = await sendMessage(adminSession, sourceChannel.id, "сообщение для проверки доступа к источнику");
    const response = await forwardMessage(memberSession, hiddenChannel.id, original.id, targetChannel.id);
    await expectError(response, 404, "CHANNEL_NOT_FOUND");
  }, 60_000);

  it("refuses to forward a deleted or unknown message", async () => {
    const deleted = await sendMessage(adminSession, sourceChannel.id, "удалённое сообщение для пересылки");
    expect((await request(adminSession, `/api/channels/${sourceChannel.id}/messages/${deleted.id}`, "DELETE")).status).toBe(204);

    await expectError(
      await forwardMessage(memberSession, sourceChannel.id, deleted.id, targetChannel.id),
      404,
      "MESSAGE_NOT_FOUND"
    );
    await expectError(
      await forwardMessage(memberSession, sourceChannel.id, randomUUID(), targetChannel.id),
      404,
      "MESSAGE_NOT_FOUND"
    );
    // Сообщение из другого канала в этом канале не пересылается.
    const foreign = await sendMessage(adminSession, targetChannel.id, "сообщение из другого канала");
    await expectError(
      await forwardMessage(memberSession, sourceChannel.id, foreign.id, targetChannel.id),
      404,
      "MESSAGE_NOT_FOUND"
    );
  }, 60_000);

  it("refuses to forward into a channel the participant cannot write to", async () => {
    const original = await sendMessage(adminSession, sourceChannel.id, "сообщение для проверки цели");
    const response = await forwardMessage(memberSession, sourceChannel.id, original.id, readOnlyChannel.id);
    await expectError(response, 403, "SEND_NOT_ALLOWED");
    // Копия в целевом канале не создаётся.
    expect(await listMessages(memberSession, readOnlyChannel.id)).toHaveLength(0);
  }, 60_000);

  it("rejects malformed forward requests", async () => {
    const original = await sendMessage(adminSession, sourceChannel.id, "сообщение для проверки тела запроса");
    const path = `/api/channels/${sourceChannel.id}/messages/${original.id}/forward`;

    await expectError(
      await request(memberSession, path, "POST", { targetChannelId: targetChannel.id, extra: true }),
      400,
      "INVALID_REQUEST"
    );
    await expectError(
      await request(memberSession, path, "POST", {}),
      400,
      "INVALID_REQUEST"
    );
    await expectError(
      await request(memberSession, path, "POST", { targetChannelId: "не-uuid" }),
      400,
      "INVALID_REQUEST"
    );
    await expectError(
      await request(memberSession, path, "POST", { targetChannelId: randomUUID() }),
      404,
      "CHANNEL_NOT_FOUND"
    );
  }, 60_000);

  it("inherits the attribution of the original when a forwarded message is forwarded again", async () => {
    const original = await sendMessage(adminSession, sourceChannel.id, "оригинал для цепочки пересылок");
    const firstForward = await forwardMessage(memberSession, sourceChannel.id, original.id, targetChannel.id);
    expect(firstForward.status).toBe(201);
    const forwarded = await firstForward.json() as MessageView;

    const secondForward = await forwardMessage(adminSession, targetChannel.id, forwarded.id, sourceChannel.id);
    expect(secondForward.status).toBe(201);
    const chained = await secondForward.json() as MessageView;

    // Атрибуция остаётся у оригинала: цепочек не возникает.
    expect(chained.forwardedFrom).toMatchObject({
      messageId: original.id,
      channelId: sourceChannel.id,
      authorLogin: adminCredentials.login,
      originalDeleted: false
    });
    expect(chained.forwardedFrom?.messageId).not.toBe(forwarded.id);
    const row = await forwardRow(chained.id);
    expect(row?.forwarded_from_message_id).toBe(original.id);
    expect(row?.forwarded_from_channel_id).toBe(sourceChannel.id);
  }, 60_000);

  it("lets a participant forward a message out of a channel they can only read", async () => {
    const original = await sendMessage(adminSession, readOnlyChannel.id, "сообщение из канала только для чтения");
    const response = await forwardMessage(memberSession, readOnlyChannel.id, original.id, targetChannel.id);
    expect(response.status).toBe(201);
    const forwarded = await response.json() as MessageView;
    expect(forwarded.forwardedFrom).toMatchObject({
      messageId: original.id,
      channelId: readOnlyChannel.id,
      authorLogin: adminCredentials.login
    });
  }, 60_000);

  it("marks the original as deleted after it is removed", async () => {
    const original = await sendMessage(adminSession, sourceChannel.id, "оригинал, который удалят");
    const response = await forwardMessage(memberSession, sourceChannel.id, original.id, targetChannel.id);
    expect(response.status).toBe(201);
    const forwarded = await response.json() as MessageView;
    expect(forwarded.forwardedFrom?.originalDeleted).toBe(false);

    expect((await request(adminSession, `/api/channels/${sourceChannel.id}/messages/${original.id}`, "DELETE")).status).toBe(204);

    const history = await listMessages(memberSession, targetChannel.id);
    const stored = history.find((message) => message.id === forwarded.id);
    expect(stored?.forwardedFrom?.originalDeleted).toBe(true);
    expect(stored?.forwardedFrom?.authorLogin).toBe(adminCredentials.login);
  }, 60_000);
}
