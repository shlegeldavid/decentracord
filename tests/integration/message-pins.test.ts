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
const inContainer = process.env.MESSAGE_PINS_TEST_IN_CONTAINER === "true";

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
  describe("message pins integration", () => {
    let fixtureDirectory = "";
    let projectName = "";
    let envFile = "";
    let overrideFile = "";

    function run(args: string[], timeout = commandTimeoutMs) {
      return compose(projectName, envFile, overrideFile, args, timeout);
    }

    beforeAll(() => {
      fixtureDirectory = mkdtempSync(join(tmpdir(), "decentracord-message-pins-"));
      const suffix = randomBytes(6).toString("hex");
      projectName = `decentracord-message-pins-${suffix}`;
      const databaseName = `decentracord_test_${suffix}`;
      const databaseUser = `message_pins_${suffix.slice(0, 10)}`;
      const databasePassword = randomBytes(24).toString("base64url");
      const adminLogin = `message_pins_admin_${suffix.slice(0, 10)}`;
      const adminPassword = `Message-pins-admin-${randomBytes(18).toString("base64url")}`;
      const secretFile = join(fixtureDirectory, "db_password");
      envFile = join(fixtureDirectory, "compose.env");
      overrideFile = join(fixtureDirectory, "compose.message-pins.yaml");
      const buildxConfig = join(fixtureDirectory, "buildx");
      mkdirSync(buildxConfig, { mode: 0o700 });
      writeFileSync(secretFile, databasePassword, { mode: 0o600 });
      chmodSync(secretFile, 0o600);
      writeFileSync(envFile, [
        `DB_PASSWORD_SECRET_FILE=${secretFile}`,
        `DB_PASSWORD=${databasePassword}`,
        `DB_NAME=${databaseName}`,
        `DB_USER=${databaseUser}`,
        `MESSAGE_PINS_TEST_ADMIN_LOGIN=${adminLogin}`,
        `MESSAGE_PINS_TEST_ADMIN_PASSWORD=${adminPassword}`,
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
        `    image: ${JSON.stringify(`decentracord-message-pins-runner:${suffix}`)}`,
        '    entrypoint: ["npm", "run", "test:integration", "--", "tests/integration/message-pins.test.ts"]',
        "    environment:",
        "      NODE_ENV: test",
        "      MESSAGE_PINS_TEST_IN_CONTAINER: \"true\"",
        "      MESSAGE_PINS_TEST_BASE_URL: http://app:3000",
        "      MESSAGE_PINS_TEST_ADMIN_LOGIN: ${MESSAGE_PINS_TEST_ADMIN_LOGIN}",
        "      MESSAGE_PINS_TEST_ADMIN_PASSWORD: ${MESSAGE_PINS_TEST_ADMIN_PASSWORD}",
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

    it("runs message pin checks against an isolated PostgreSQL database", () => {
      const args = ["run", "--rm", "--no-deps", "-T", "-e", "MESSAGE_PINS_TEST_IN_CONTAINER=true", "test-runner"];
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

  interface MessageView {
    id: string;
    channelId: string;
    authorId: string;
    content: string;
    seq: number;
  }

  interface PinnedMessage {
    messageId: string;
    channelId: string;
    authorId: string;
    authorLogin: string;
    authorRoles: Array<{ id: string; name: string; color: string | null; position: number }>;
    content: string;
    mentions: Array<{ id: string; login: string }>;
    createdAt: string;
    pinnedAt: string;
  }

  const baseUrl = process.env.MESSAGE_PINS_TEST_BASE_URL ?? "http://app:3000";
  const appOrigin = new URL(baseUrl).origin;
  const adminCredentials = {
    login: process.env.MESSAGE_PINS_TEST_ADMIN_LOGIN ?? "",
    password: process.env.MESSAGE_PINS_TEST_ADMIN_PASSWORD ?? ""
  };
  let pool: Pool;
  let adminSession: HttpSession;
  let managerSession: HttpSession;
  let authorSession: HttpSession;
  let otherSession: HttpSession;
  let outsiderSession: HttpSession;
  let manager: MemberIdentity;
  let author: MemberIdentity;
  let other: MemberIdentity;
  let channel: ChannelIdentity;
  let secondChannel: ChannelIdentity;
  let manyChannel: ChannelIdentity;

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
    const password = `Message-pins-member-${randomBytes(16).toString("base64url")}`;
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
    if (!id) throw new Error("Message pins test role was not created");
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

  async function pinMessage(session: HttpSession, channelId: string, messageId: string): Promise<Response> {
    return request(session, `/api/channels/${channelId}/pins`, "POST", { messageId });
  }

  async function unpinMessage(session: HttpSession, channelId: string, messageId: string): Promise<Response> {
    return request(session, `/api/channels/${channelId}/pins/${messageId}`, "DELETE");
  }

  async function listPins(session: HttpSession, channelId: string): Promise<PinnedMessage[]> {
    const response = await request(session, `/api/channels/${channelId}/pins`);
    expect(response.status).toBe(200);
    const body = await response.json() as { pins?: unknown };
    expect(Array.isArray(body.pins)).toBe(true);
    return body.pins as PinnedMessage[];
  }

  async function expectError(response: Response, status: number, code: string): Promise<void> {
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code } });
  }

  async function pinRows(channelId: string): Promise<number> {
    const result = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM channel_pins WHERE channel_id = $1",
      [channelId]
    );
    return result.rows[0]?.count ?? 0;
  }

  async function pinRowFor(messageId: string): Promise<{ channel_id: string; pinned_by: string; pinned_at: Date } | null> {
    const result = await pool.query<{ channel_id: string; pinned_by: string; pinned_at: Date }>(
      "SELECT channel_id::text AS channel_id, pinned_by::text AS pinned_by, pinned_at FROM channel_pins WHERE message_id = $1",
      [messageId]
    );
    return result.rows[0] ?? null;
  }

  async function revokeChannelView(channelId: string, memberId: string): Promise<void> {
    await pool.query(
      `INSERT INTO channel_member_overrides (channel_id, user_id, permission, effect)
       VALUES ($1, $2, 'VIEW_CHANNEL', 'deny')
       ON CONFLICT (channel_id, user_id, permission) DO UPDATE SET effect = EXCLUDED.effect`,
      [channelId, memberId]
    );
  }

  beforeAll(async () => {
    const database = new URL(process.env.TEST_DATABASE_URL ?? "");
    expect(database.hostname).toBe("db");
    expect(database.pathname).toMatch(/^\/decentracord_test_[a-f0-9]+$/u);
    expect(new URL(baseUrl).hostname).toBe("app");
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8, connectionTimeoutMillis: 3_000 });
    adminSession = await login(adminCredentials);

    const suffix = randomBytes(5).toString("hex");
    const managerRoleId = await createRole(`pins_manager_${suffix}`, 20, ["VIEW_CHANNEL", "SEND_MESSAGES", "MANAGE_MESSAGES"]);
    const memberRoleId = await createRole(`pins_member_${suffix}`, 21, ["VIEW_CHANNEL", "SEND_MESSAGES"]);
    manager = await createMember(`pins_manager_${suffix}`);
    author = await createMember(`pins_author_${suffix}`);
    other = await createMember(`pins_other_${suffix}`);
    await Promise.all([
      assignRole(manager.id, managerRoleId),
      assignRole(author.id, memberRoleId),
      assignRole(other.id, memberRoleId)
    ]);

    channel = await createChannel(`pins_channel_${suffix}`);
    secondChannel = await createChannel(`pins_second_channel_${suffix}`);
    manyChannel = await createChannel(`pins_many_channel_${suffix}`);
    const sendableOverrides = [
      { subject: "everyone", subjectId: null, permission: "VIEW_CHANNEL", effect: "allow" },
      { subject: "everyone", subjectId: null, permission: "SEND_MESSAGES", effect: "allow" }
    ];
    expect((await setOverrides(channel.id, sendableOverrides)).status).toBe(204);
    expect((await setOverrides(secondChannel.id, sendableOverrides)).status).toBe(204);
    expect((await setOverrides(manyChannel.id, sendableOverrides)).status).toBe(204);

    managerSession = await login(manager);
    authorSession = await login(author);
    otherSession = await login(other);
    // Посторонний участник: к первому каналу доступа нет вовсе.
    const outsider = await createMember(`pins_outsider_${suffix}`);
    await assignRole(outsider.id, memberRoleId);
    await revokeChannelView(channel.id, outsider.id);
    outsiderSession = await login(outsider);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
  });

  it("pins a message with the manage permission and lists it in the channel", async () => {
    const message = await sendMessage(authorSession, channel.id, "сообщение для закрепления");
    const pinned = await pinMessage(managerSession, channel.id, message.id);
    expect(pinned.status).toBe(204);
    expect(await pinned.text()).toBe("");

    const pins = await listPins(managerSession, channel.id);
    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatchObject({
      messageId: message.id,
      channelId: channel.id,
      authorId: author.id,
      authorLogin: author.login,
      content: message.content
    });
    expect(typeof pins[0]?.createdAt).toBe("string");
    expect(typeof pins[0]?.pinnedAt).toBe("string");
    expect(Array.isArray(pins[0]?.authorRoles)).toBe(true);
    expect(Array.isArray(pins[0]?.mentions)).toBe(true);
  }, 60_000);

  it("does not let a participant without the manage permission pin, not even their own message", async () => {
    const message = await sendMessage(authorSession, channel.id, "своё сообщение без права управления");
    await expectError(await pinMessage(authorSession, channel.id, message.id), 403, "FORBIDDEN");
    await expectError(await pinMessage(otherSession, channel.id, message.id), 403, "FORBIDDEN");
    expect(await pinRowFor(message.id)).toBeNull();
  }, 60_000);

  it("lets the author of a pinned message unpin it and refuses a stranger", async () => {
    const message = await sendMessage(authorSession, channel.id, "закреплённое сообщение автора");
    expect((await pinMessage(managerSession, channel.id, message.id)).status).toBe(204);

    // Автор закреплённого сообщения снимает закрепление без права управления.
    const authorUnpin = await unpinMessage(authorSession, channel.id, message.id);
    expect(authorUnpin.status).toBe(204);
    expect(await pinRowFor(message.id)).toBeNull();

    expect((await pinMessage(managerSession, channel.id, message.id)).status).toBe(204);
    // Посторонний участник без права управления снять закрепление не может.
    await expectError(await unpinMessage(otherSession, channel.id, message.id), 403, "FORBIDDEN");
    expect(await pinRowFor(message.id)).not.toBeNull();
    // Участник с правом управления снимает закрепление.
    expect((await unpinMessage(managerSession, channel.id, message.id)).status).toBe(204);
    expect(await pinRowFor(message.id)).toBeNull();
  }, 60_000);

  it("removes the pin when the pinned message is deleted", async () => {
    const message = await sendMessage(authorSession, channel.id, "удаляемое закреплённое сообщение");
    expect((await pinMessage(managerSession, channel.id, message.id)).status).toBe(204);
    expect(await pinRowFor(message.id)).not.toBeNull();

    const deleted = await request(authorSession, `/api/channels/${channel.id}/messages/${message.id}`, "DELETE");
    expect(deleted.status).toBe(204);

    expect(await pinRowFor(message.id)).toBeNull();
    const pins = await listPins(managerSession, channel.id);
    expect(pins.some((pin) => pin.messageId === message.id)).toBe(false);
  }, 60_000);

  it("keeps the pin when the author loses access to the channel", async () => {
    const message = await sendMessage(authorSession, secondChannel.id, "закрепление автора без доступа");
    expect((await pinMessage(managerSession, secondChannel.id, message.id)).status).toBe(204);

    await revokeChannelView(secondChannel.id, author.id);

    const stored = await pinRowFor(message.id);
    expect(stored?.channel_id).toBe(secondChannel.id);
    expect(await pinRows(secondChannel.id)).toBe(1);
    const pins = await listPins(managerSession, secondChannel.id);
    expect(pins.some((pin) => pin.messageId === message.id)).toBe(true);
    // Автор без доступа к каналу список закреплений получить не может.
    await expectError(await request(authorSession, `/api/channels/${secondChannel.id}/pins`), 404, "CHANNEL_NOT_FOUND");
  }, 60_000);

  it("keeps several pins at once and orders them from the newest", async () => {
    const first = await sendMessage(authorSession, manyChannel.id, "первое закрепление");
    const second = await sendMessage(authorSession, manyChannel.id, "второе закрепление");
    const third = await sendMessage(authorSession, manyChannel.id, "третье закрепление");
    for (const message of [first, second, third]) {
      expect((await pinMessage(managerSession, manyChannel.id, message.id)).status).toBe(204);
    }
    expect(await pinRows(manyChannel.id)).toBe(3);

    // Время закрепления задаётся явно, чтобы порядок проверялся однозначно.
    await pool.query(
      "UPDATE channel_pins SET pinned_at = now() - make_interval(mins => $2::int) WHERE message_id = $1",
      [first.id, 30]
    );
    await pool.query(
      "UPDATE channel_pins SET pinned_at = now() - make_interval(mins => $2::int) WHERE message_id = $1",
      [second.id, 20]
    );
    await pool.query(
      "UPDATE channel_pins SET pinned_at = now() - make_interval(mins => $2::int) WHERE message_id = $1",
      [third.id, 10]
    );

    const pins = await listPins(managerSession, manyChannel.id);
    expect(pins.map((pin) => pin.messageId)).toEqual([third.id, second.id, first.id]);
  }, 60_000);

  it("keeps the pin time unchanged when the same message is pinned again", async () => {
    const message = await sendMessage(authorSession, channel.id, "повторное закрепление");
    expect((await pinMessage(managerSession, channel.id, message.id)).status).toBe(204);
    const stored = await pinRowFor(message.id);
    const firstPinnedAt = stored?.pinned_at.getTime();
    expect(typeof firstPinnedAt).toBe("number");

    expect((await pinMessage(managerSession, channel.id, message.id)).status).toBe(204);
    const repeated = await pinRowFor(message.id);
    expect(repeated?.pinned_at.getTime()).toBe(firstPinnedAt);
    expect(await pinRowFor(message.id)).not.toBeNull();
    expect((await unpinMessage(managerSession, channel.id, message.id)).status).toBe(204);
    expect(await pinRowFor(message.id)).toBeNull();
  }, 60_000);

  it("rejects malformed pin requests and messages from another channel", async () => {
    const message = await sendMessage(authorSession, channel.id, "сообщение для проверки разбора");
    const foreign = await sendMessage(otherSession, secondChannel.id, "сообщение из другого канала");

    await expectError(await pinMessage(managerSession, channel.id, "не-uuid"), 400, "INVALID_REQUEST");
    await expectError(
      await request(managerSession, `/api/channels/${channel.id}/pins`, "POST", { messageId: message.id, extra: true }),
      400,
      "INVALID_REQUEST"
    );
    await expectError(await pinMessage(managerSession, channel.id, foreign.id), 404, "MESSAGE_NOT_FOUND");

    const deleted = await sendMessage(authorSession, channel.id, "удалённое сообщение");
    expect((await request(authorSession, `/api/channels/${channel.id}/messages/${deleted.id}`, "DELETE")).status).toBe(204);
    await expectError(await pinMessage(managerSession, channel.id, deleted.id), 404, "MESSAGE_NOT_FOUND");
  }, 60_000);

  it("hides the list of pins from a channel the participant cannot read", async () => {
    await expectError(await request(outsiderSession, `/api/channels/${channel.id}/pins`), 404, "CHANNEL_NOT_FOUND");
    await expectError(await request(outsiderSession, `/api/channels/${channel.id}/pins/${randomUUID()}`, "DELETE"), 404, "CHANNEL_NOT_FOUND");
  }, 60_000);
}
