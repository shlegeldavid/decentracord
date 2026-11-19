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
const inContainer = process.env.READ_JOURNAL_TEST_IN_CONTAINER === "true";

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
  describe("read journal integration", () => {
    let fixtureDirectory = "";
    let projectName = "";
    let envFile = "";
    let overrideFile = "";

    function run(args: string[], timeout = commandTimeoutMs) {
      return compose(projectName, envFile, overrideFile, args, timeout);
    }

    beforeAll(() => {
      fixtureDirectory = mkdtempSync(join(tmpdir(), "decentracord-read-journal-"));
      const suffix = randomBytes(6).toString("hex");
      projectName = `decentracord-read-journal-${suffix}`;
      const databaseName = `decentracord_test_${suffix}`;
      const databaseUser = `read_journal_${suffix.slice(0, 10)}`;
      const databasePassword = randomBytes(24).toString("base64url");
      const adminLogin = `read_journal_admin_${suffix.slice(0, 10)}`;
      const adminPassword = `Read-journal-admin-${randomBytes(18).toString("base64url")}`;
      const secretFile = join(fixtureDirectory, "db_password");
      envFile = join(fixtureDirectory, "compose.env");
      overrideFile = join(fixtureDirectory, "compose.read-journal.yaml");
      const buildxConfig = join(fixtureDirectory, "buildx");
      mkdirSync(buildxConfig, { mode: 0o700 });
      writeFileSync(secretFile, databasePassword, { mode: 0o600 });
      chmodSync(secretFile, 0o600);
      writeFileSync(envFile, [
        `DB_PASSWORD_SECRET_FILE=${secretFile}`,
        `DB_PASSWORD=${databasePassword}`,
        `DB_NAME=${databaseName}`,
        `DB_USER=${databaseUser}`,
        `READ_JOURNAL_TEST_ADMIN_LOGIN=${adminLogin}`,
        `READ_JOURNAL_TEST_ADMIN_PASSWORD=${adminPassword}`,
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
        `    image: ${JSON.stringify(`decentracord-read-journal-runner:${suffix}`)}`,
        '    entrypoint: ["npm", "run", "test:integration", "--", "tests/integration/read-journal.test.ts"]',
        "    environment:",
        "      NODE_ENV: test",
        "      READ_JOURNAL_TEST_IN_CONTAINER: \"true\"",
        "      READ_JOURNAL_TEST_BASE_URL: http://app:3000",
        "      READ_JOURNAL_TEST_ADMIN_LOGIN: ${READ_JOURNAL_TEST_ADMIN_LOGIN}",
        "      READ_JOURNAL_TEST_ADMIN_PASSWORD: ${READ_JOURNAL_TEST_ADMIN_PASSWORD}",
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

    it("runs read journal checks against an isolated PostgreSQL database", () => {
      const args = ["run", "--rm", "--no-deps", "-T", "-e", "READ_JOURNAL_TEST_IN_CONTAINER=true", "test-runner"];
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
    seq: number;
    content: string;
  }

  interface MessageReader {
    userId: string;
    login: string;
    readAt: string;
  }

  const baseUrl = process.env.READ_JOURNAL_TEST_BASE_URL ?? "http://app:3000";
  const appOrigin = new URL(baseUrl).origin;
  const adminCredentials = {
    login: process.env.READ_JOURNAL_TEST_ADMIN_LOGIN ?? "",
    password: process.env.READ_JOURNAL_TEST_ADMIN_PASSWORD ?? ""
  };
  let pool: Pool;
  let adminSession: HttpSession;

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
    const password = `Read-journal-member-${randomBytes(16).toString("base64url")}`;
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
    if (!id) throw new Error("Read journal test role was not created");
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

  async function denyChannelAccess(channelId: string, userId: string): Promise<void> {
    await pool.query(
      `INSERT INTO channel_member_overrides (channel_id, user_id, permission, effect)
       VALUES ($1, $2, 'VIEW_CHANNEL', 'deny')
       ON CONFLICT (channel_id, user_id, permission) DO UPDATE SET effect = EXCLUDED.effect`,
      [channelId, userId]
    );
  }

  async function expectError(response: Response, status: number, code: string): Promise<void> {
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code } });
  }

  async function sendMessage(session: HttpSession, channelId: string, content: string): Promise<MessageView> {
    const response = await request(session, `/api/channels/${channelId}/messages`, "POST", {
      content,
      clientRequestId: randomUUID()
    });
    expect(response.status).toBe(201);
    return response.json() as Promise<MessageView>;
  }

  async function markRead(session: HttpSession, channelId: string, seq: number): Promise<Response> {
    return request(session, `/api/channels/${channelId}/read`, "POST", { seq });
  }

  async function listReaders(session: HttpSession, channelId: string, messageId: string): Promise<MessageReader[]> {
    const response = await request(session, `/api/channels/${channelId}/messages/${messageId}/readers`);
    expect(response.status).toBe(200);
    const body = await response.json() as { readers?: unknown };
    expect(Array.isArray(body.readers)).toBe(true);
    return body.readers as MessageReader[];
  }

  async function journalRows(userId: string, channelId: string): Promise<number> {
    const result = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM channel_read_journal WHERE user_id = $1 AND channel_id = $2",
      [userId, channelId]
    );
    return result.rows[0]?.count ?? 0;
  }

  async function readCursor(userId: string, channelId: string): Promise<number> {
    const result = await pool.query<{ last_read_seq: number }>(
      "SELECT COALESCE(last_read_seq, 0)::int AS last_read_seq FROM channel_reads WHERE user_id = $1 AND channel_id = $2",
      [userId, channelId]
    );
    return result.rows[0]?.last_read_seq ?? 0;
  }

  beforeAll(async () => {
    const database = new URL(process.env.TEST_DATABASE_URL ?? "");
    expect(database.hostname).toBe("db");
    expect(database.pathname).toMatch(/^\/decentracord_test_[a-f0-9]+$/u);
    expect(new URL(baseUrl).hostname).toBe("app");
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4, connectionTimeoutMillis: 3_000 });
    adminSession = await login(adminCredentials);
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
  });

  it("reports only the readers of a message to its author", async () => {
    const suffix = randomBytes(5).toString("hex");
    const senderRoleId = await createRole(`read_journal_sender_${suffix}`, 20, ["VIEW_CHANNEL", "SEND_MESSAGES"]);
    const author = await createMember(`read_journal_author_${suffix}`);
    const reader = await createMember(`read_journal_reader_${suffix}`);
    const silent = await createMember(`read_journal_silent_${suffix}`);
    const revoked = await createMember(`read_journal_revoked_${suffix}`);
    const outsider = await createMember(`read_journal_outsider_${suffix}`);
    await Promise.all([
      assignRole(author.id, senderRoleId),
      assignRole(reader.id, senderRoleId),
      assignRole(silent.id, senderRoleId),
      assignRole(revoked.id, senderRoleId),
      assignRole(outsider.id, senderRoleId)
    ]);

    const channel = await createChannel(`read_journal_channel_${suffix}`);
    expect((await setOverrides(channel.id, [
      { subject: "everyone", subjectId: null, permission: "VIEW_CHANNEL", effect: "allow" },
      { subject: "everyone", subjectId: null, permission: "SEND_MESSAGES", effect: "allow" }
    ])).status).toBe(204);
    await denyChannelAccess(channel.id, outsider.id);

    const authorSession = await login(author);
    const readerSession = await login(reader);
    const silentSession = await login(silent);
    const revokedSession = await login(revoked);
    const outsiderSession = await login(outsider);

    // Историческое сообщение: читатель ещё не входил в канал.
    const historical = await sendMessage(authorSession, channel.id, "историческое сообщение");
    expect((await markRead(readerSession, channel.id, historical.seq)).status).toBe(204);
    const historicalReaders = await listReaders(authorSession, channel.id, historical.id);
    expect(historicalReaders.map((entry) => entry.userId)).not.toContain(reader.id);

    // Сообщение после входа в канал: читатель в списке со временем прочтения.
    const fresh = await sendMessage(authorSession, channel.id, "сообщение после входа");
    expect((await markRead(readerSession, channel.id, fresh.seq)).status).toBe(204);
    const freshReaders = await listReaders(authorSession, channel.id, fresh.id);
    const freshReader = freshReaders.find((entry) => entry.userId === reader.id);
    expect(freshReader).toBeDefined();
    expect(freshReader?.login).toBe(reader.login);
    expect(typeof freshReader?.readAt).toBe("string");
    expect(Number.isNaN(new Date(freshReader?.readAt ?? "").getTime())).toBe(false);
    // Участник, ни разу не открывавший канал, в списке не появляется.
    expect(freshReaders.map((entry) => entry.userId)).not.toContain(silent.id);
    // Автор своего сообщения в списке не показывается.
    expect(freshReaders.map((entry) => entry.userId)).not.toContain(author.id);

    // Список читателей доступен только автору сообщения.
    await expectError(
      await request(readerSession, `/api/channels/${channel.id}/messages/${fresh.id}/readers`),
      403,
      "FORBIDDEN"
    );
    // Без права чтения канал не подтверждается — 404, а не 403.
    await expectError(
      await request(outsiderSession, `/api/channels/${channel.id}/messages/${fresh.id}/readers`),
      404,
      "CHANNEL_NOT_FOUND"
    );
    // Участник без доступа к каналу не может и отметку прочтения сделать.
    expect((await markRead(outsiderSession, channel.id, fresh.seq)).status).toBe(404);

    // Прочитавший, у которого затем отозван доступ к каналу, в списке отсутствует.
    expect((await markRead(revokedSession, channel.id, historical.seq)).status).toBe(204);
    const readable = await sendMessage(authorSession, channel.id, "сообщение до отзыва доступа");
    expect((await markRead(revokedSession, channel.id, readable.seq)).status).toBe(204);
    const beforeRevoke = await listReaders(authorSession, channel.id, readable.id);
    expect(beforeRevoke.map((entry) => entry.userId)).toContain(revoked.id);
    await denyChannelAccess(channel.id, revoked.id);
    const afterRevoke = await listReaders(authorSession, channel.id, readable.id);
    expect(afterRevoke.map((entry) => entry.userId)).not.toContain(revoked.id);

    // Журнал пополняется только при реальном продвижении курсора.
    const rowsBeforeRepeat = await journalRows(reader.id, channel.id);
    expect(rowsBeforeRepeat).toBeGreaterThan(0);
    expect((await markRead(readerSession, channel.id, fresh.seq)).status).toBe(204);
    expect(await journalRows(reader.id, channel.id)).toBe(rowsBeforeRepeat);

    const newest = await sendMessage(authorSession, channel.id, "следующее сообщение");
    expect((await markRead(readerSession, channel.id, newest.seq)).status).toBe(204);
    expect(await journalRows(reader.id, channel.id)).toBe(rowsBeforeRepeat + 1);
    expect(await readCursor(reader.id, channel.id)).toBe(newest.seq);

    // Счётчики непрочитанных продолжают считаться по channel_reads.
    const readerChannels = await request(readerSession, "/api/channels");
    expect(readerChannels.status).toBe(200);
    const readerChannelsBody = await readerChannels.json() as {
      channels: Array<{ id: string; unreadCount?: unknown }>;
    };
    expect(readerChannelsBody.channels.find((entry) => entry.id === channel.id)?.unreadCount).toBe(0);
    const silentChannels = await request(silentSession, "/api/channels");
    expect(silentChannels.status).toBe(200);
    const silentChannelsBody = await silentChannels.json() as {
      channels: Array<{ id: string; unreadCount?: unknown }>;
    };
    const silentUnread = silentChannelsBody.channels.find((entry) => entry.id === channel.id)?.unreadCount;
    expect(typeof silentUnread).toBe("number");
    expect(silentUnread).toBeGreaterThan(0);

    // Удалённое сообщение не раскрывает список читателей.
    const removed = await sendMessage(authorSession, channel.id, "удаляемое сообщение");
    const deleteResponse = await request(
      authorSession,
      `/api/channels/${channel.id}/messages/${removed.id}`,
      "DELETE"
    );
    expect(deleteResponse.status).toBe(204);
    await expectError(
      await request(authorSession, `/api/channels/${channel.id}/messages/${removed.id}/readers`),
      404,
      "MESSAGE_NOT_FOUND"
    );
  }, 120_000);
}
