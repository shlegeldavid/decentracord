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
const inContainer = process.env.READ_RETENTION_TEST_IN_CONTAINER === "true";

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
  describe("read retention integration", () => {
    let fixtureDirectory = "";
    let projectName = "";
    let envFile = "";
    let overrideFile = "";

    function run(args: string[], timeout = commandTimeoutMs) {
      return compose(projectName, envFile, overrideFile, args, timeout);
    }

    beforeAll(() => {
      fixtureDirectory = mkdtempSync(join(tmpdir(), "decentracord-read-retention-"));
      const suffix = randomBytes(6).toString("hex");
      projectName = `decentracord-read-retention-${suffix}`;
      const databaseName = `decentracord_test_${suffix}`;
      const databaseUser = `read_retention_${suffix.slice(0, 10)}`;
      const databasePassword = randomBytes(24).toString("base64url");
      const adminLogin = `read_retention_admin_${suffix.slice(0, 10)}`;
      const adminPassword = `Read-retention-admin-${randomBytes(18).toString("base64url")}`;
      const secretFile = join(fixtureDirectory, "db_password");
      envFile = join(fixtureDirectory, "compose.env");
      overrideFile = join(fixtureDirectory, "compose.read-retention.yaml");
      const buildxConfig = join(fixtureDirectory, "buildx");
      mkdirSync(buildxConfig, { mode: 0o700 });
      writeFileSync(secretFile, databasePassword, { mode: 0o600 });
      chmodSync(secretFile, 0o600);
      writeFileSync(envFile, [
        `DB_PASSWORD_SECRET_FILE=${secretFile}`,
        `DB_PASSWORD=${databasePassword}`,
        `DB_NAME=${databaseName}`,
        `DB_USER=${databaseUser}`,
        `READ_RETENTION_TEST_ADMIN_LOGIN=${adminLogin}`,
        `READ_RETENTION_TEST_ADMIN_PASSWORD=${adminPassword}`,
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
        `    image: ${JSON.stringify(`decentracord-read-retention-runner:${suffix}`)}`,
        '    entrypoint: ["npm", "run", "test:integration", "--", "tests/integration/read-retention.test.ts"]',
        "    environment:",
        "      NODE_ENV: test",
        "      READ_RETENTION_TEST_IN_CONTAINER: \"true\"",
        "      READ_RETENTION_TEST_BASE_URL: http://app:3000",
        "      READ_RETENTION_TEST_ADMIN_LOGIN: ${READ_RETENTION_TEST_ADMIN_LOGIN}",
        "      READ_RETENTION_TEST_ADMIN_PASSWORD: ${READ_RETENTION_TEST_ADMIN_PASSWORD}",
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

    it("runs read retention checks against an isolated PostgreSQL database", () => {
      const args = ["run", "--rm", "--no-deps", "-T", "-e", "READ_RETENTION_TEST_IN_CONTAINER=true", "test-runner"];
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
    seq: number;
  }

  interface ReadRetentionView {
    keepForever: boolean;
    days: number | null;
  }

  const baseUrl = process.env.READ_RETENTION_TEST_BASE_URL ?? "http://app:3000";
  const appOrigin = new URL(baseUrl).origin;
  const adminCredentials = {
    login: process.env.READ_RETENTION_TEST_ADMIN_LOGIN ?? "",
    password: process.env.READ_RETENTION_TEST_ADMIN_PASSWORD ?? ""
  };
  let pool: Pool;
  let adminSession: HttpSession;
  let memberSession: HttpSession;
  let member: MemberIdentity;
  let channel: ChannelIdentity;

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
    const password = `Read-retention-member-${randomBytes(16).toString("base64url")}`;
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
    if (!id) throw new Error("Read retention test role was not created");
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

  async function markRead(session: HttpSession, channelId: string, seq: number): Promise<Response> {
    return request(session, `/api/channels/${channelId}/read`, "POST", { seq });
  }

  async function getReadRetention(session: HttpSession): Promise<ReadRetentionView> {
    const response = await request(session, "/api/organization/read-retention");
    expect(response.status).toBe(200);
    return response.json() as Promise<ReadRetentionView>;
  }

  async function patchReadRetention(session: HttpSession, body: unknown): Promise<Response> {
    return request(session, "/api/organization/read-retention", "PATCH", body);
  }

  async function expectError(response: Response, status: number, code: string): Promise<void> {
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code } });
  }

  async function journalRows(userId: string, channelId: string): Promise<number> {
    const result = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM channel_read_journal WHERE user_id = $1 AND channel_id = $2",
      [userId, channelId]
    );
    return result.rows[0]?.count ?? 0;
  }

  async function baseRows(userId: string, channelId: string): Promise<number> {
    const result = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM channel_read_bases WHERE user_id = $1 AND channel_id = $2",
      [userId, channelId]
    );
    return result.rows[0]?.count ?? 0;
  }

  async function storedRetentionDays(): Promise<number | null> {
    const result = await pool.query<{ read_retention_days: number | null }>(
      "SELECT read_retention_days FROM organization WHERE id = 1"
    );
    return result.rows[0]?.read_retention_days ?? null;
  }

  // Запись журнала с временем в прошлом — как будто она попала в журнал давно.
  async function ageJournalRows(userId: string, channelId: string, days: number): Promise<void> {
    await pool.query(
      "UPDATE channel_read_journal SET read_at = now() - make_interval(days => $3::int) WHERE user_id = $1 AND channel_id = $2",
      [userId, channelId, days]
    );
  }

  beforeAll(async () => {
    const database = new URL(process.env.TEST_DATABASE_URL ?? "");
    expect(database.hostname).toBe("db");
    expect(database.pathname).toMatch(/^\/decentracord_test_[a-f0-9]+$/u);
    expect(new URL(baseUrl).hostname).toBe("app");
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4, connectionTimeoutMillis: 3_000 });
    adminSession = await login(adminCredentials);

    const suffix = randomBytes(5).toString("hex");
    const memberRoleId = await createRole(`read_retention_member_${suffix}`, 20, ["VIEW_CHANNEL", "SEND_MESSAGES"]);
    member = await createMember(`read_retention_member_${suffix}`);
    await assignRole(member.id, memberRoleId);
    channel = await createChannel(`read_retention_channel_${suffix}`);
    expect((await setOverrides(channel.id, [
      { subject: "everyone", subjectId: null, permission: "VIEW_CHANNEL", effect: "allow" },
      { subject: "everyone", subjectId: null, permission: "SEND_MESSAGES", effect: "allow" }
    ])).status).toBe(204);
    memberSession = await login(member);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
  });

  it("stores the retention period as a whole number of days and keeps it forever by default", async () => {
    // По умолчанию журнал хранится бессрочно.
    expect(await getReadRetention(adminSession)).toEqual({ keepForever: true, days: null });

    const saved = await patchReadRetention(adminSession, { keepForever: false, days: 90 });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ keepForever: false, days: 90 });
    expect(await getReadRetention(adminSession)).toEqual({ keepForever: false, days: 90 });
    expect(await storedRetentionDays()).toBe(90);
  }, 60_000);

  it("rejects values outside the range and unknown keys", async () => {
    const rejected: unknown[] = [
      { keepForever: false, days: 0 },
      { keepForever: false, days: 3651 },
      { keepForever: false, days: 1.5 },
      { keepForever: false, days: "90" },
      { keepForever: false, days: 90, extra: true },
      { keepForever: "yes" },
      { days: 3651 }
    ];
    for (const body of rejected) {
      await expectError(await patchReadRetention(adminSession, body), 400, "INVALID_REQUEST");
    }
    // Значение в базе после отказов не изменилось.
    expect(await getReadRetention(adminSession)).toEqual({ keepForever: false, days: 90 });
    expect(await storedRetentionDays()).toBe(90);
  }, 60_000);

  it("does not let a member without administrator rights change the period", async () => {
    await expectError(
      await patchReadRetention(memberSession, { keepForever: false, days: 30 }),
      403,
      "FORBIDDEN"
    );
    expect(await storedRetentionDays()).toBe(90);
  }, 60_000);

  it("removes journal entries older than the period and keeps the channel entry table", async () => {
    const message = await sendMessage(memberSession, channel.id, "сообщение для очистки журнала");
    expect((await markRead(memberSession, channel.id, message.seq)).status).toBe(204);
    expect(await journalRows(member.id, channel.id)).toBeGreaterThan(0);
    expect(await baseRows(member.id, channel.id)).toBe(1);

    // Запись журнала старше срока хранения.
    await ageJournalRows(member.id, channel.id, 5);

    const shortened = await patchReadRetention(adminSession, { keepForever: false, days: 1 });
    expect(shortened.status).toBe(200);
    expect(await journalRows(member.id, channel.id)).toBe(0);
    // База входа в канал не очищается: без неё теряется правило о прочтении.
    expect(await baseRows(member.id, channel.id)).toBe(1);
  }, 60_000);

  it("keeps journal entries when the period is unlimited", async () => {
    expect((await patchReadRetention(adminSession, { keepForever: true })).status).toBe(200);
    expect(await getReadRetention(adminSession)).toEqual({ keepForever: true, days: null });

    const message = await sendMessage(memberSession, channel.id, "сообщение при бессрочном хранении");
    expect((await markRead(memberSession, channel.id, message.seq)).status).toBe(204);
    await ageJournalRows(member.id, channel.id, 5);
    const rowsBefore = await journalRows(member.id, channel.id);
    expect(rowsBefore).toBeGreaterThan(0);

    // Смена настройки при бессрочном хранении ничего не удаляет.
    expect((await patchReadRetention(adminSession, { keepForever: true })).status).toBe(200);
    expect(await journalRows(member.id, channel.id)).toBe(rowsBefore);
    expect(await baseRows(member.id, channel.id)).toBe(1);
  }, 60_000);
}
