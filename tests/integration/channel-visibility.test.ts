import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findUserChannelAccessChanges } from "../../apps/server/src/access/access.service.js";
import type { VisibleChannelRow } from "../../apps/server/src/access/access.service.js";
import { PasswordService } from "../../apps/server/src/auth/password.service.js";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const commandTimeoutMs = 180_000;
const inContainer = process.env.CHANNEL_VISIBILITY_TEST_IN_CONTAINER === "true";

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

function lastJsonLine(output: string): Record<string, unknown> {
  const line = output.split(/\r?\n/u).map((candidate) => candidate.trim()).filter((candidate) => candidate.startsWith("{")).at(-1);
  assert.ok(line, `expected a JSON response, received: ${output}`);
  return JSON.parse(line) as Record<string, unknown>;
}

function runBootstrap(projectName: string, envFile: string, overrideFile: string, login: string, password: string) {
  return spawnSync(
    "docker",
    [
      "compose", "--project-name", projectName, "--env-file", envFile,
      "--file", join(projectRoot, "compose.yaml"), "--file", overrideFile,
      "run", "--rm", "--no-deps", "-T", "-i", "app", "bootstrap-admin", "--login", login
    ],
    { cwd: projectRoot, encoding: "utf8", input: `${password}\n`, timeout: commandTimeoutMs, env: process.env, maxBuffer: 2 * 1024 * 1024 }
  );
}

if (!inContainer) {
  describe("channel visibility API integration", () => {
    let fixtureDirectory = "";
    let projectName = "";
    let envFile = "";
    let overrideFile = "";

    function run(args: string[], timeout = commandTimeoutMs) {
      return compose(projectName, envFile, overrideFile, args, timeout);
    }

    beforeAll(() => {
      fixtureDirectory = mkdtempSync(join(tmpdir(), "decentracord-channel-visibility-"));
      const suffix = randomBytes(6).toString("hex");
      projectName = `decentracord-channel-visibility-${suffix}`;
      const databaseName = `decentracord_test_${suffix}`;
      const databaseUser = `channel_test_${suffix.slice(0, 10)}`;
      const databasePassword = randomBytes(24).toString("base64url");
      const adminLogin = `visibility_admin_${suffix.slice(0, 10)}`;
      const adminPassword = `Visibility-admin-${randomBytes(18).toString("base64url")}`;
      const secretFile = join(fixtureDirectory, "db_password");
      envFile = join(fixtureDirectory, "compose.env");
      overrideFile = join(fixtureDirectory, "compose.channel-visibility.yaml");
      const buildxConfig = join(fixtureDirectory, "buildx");
      mkdirSync(buildxConfig, { mode: 0o700 });
      writeFileSync(secretFile, databasePassword, { mode: 0o600 });
      chmodSync(secretFile, 0o600);
      writeFileSync(envFile, [
        `DB_PASSWORD_SECRET_FILE=${secretFile}`,
        `DB_PASSWORD=${databasePassword}`,
        `DB_NAME=${databaseName}`,
        `DB_USER=${databaseUser}`,
        `CHANNEL_VISIBILITY_ADMIN_LOGIN=${adminLogin}`,
        `CHANNEL_VISIBILITY_ADMIN_PASSWORD=${adminPassword}`,
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
        "    networks:",
        "      - backend",
        "  test-runner:",
        "    build:",
        `      context: ${JSON.stringify(projectRoot)}`,
        "      dockerfile: Dockerfile",
        "      target: test-runner",
        `    image: ${JSON.stringify(`decentracord-channel-visibility-runner:${suffix}`)}`,
        '    entrypoint: ["npm", "run", "test:integration", "--", "tests/integration/channel-visibility.test.ts"]',
        "    environment:",
        "      CHANNEL_VISIBILITY_TEST_IN_CONTAINER: \"true\"",
        "      CHANNEL_VISIBILITY_TEST_BASE_URL: http://app:3000",
        "      CHANNEL_VISIBILITY_ADMIN_LOGIN: ${CHANNEL_VISIBILITY_ADMIN_LOGIN}",
        "      CHANNEL_VISIBILITY_ADMIN_PASSWORD: ${CHANNEL_VISIBILITY_ADMIN_PASSWORD}",
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
      const appArgs = ["up", "--detach", "--wait", "--wait-timeout", "90", "app"];
      assertComposeSucceeded(run(appArgs, 180_000), appArgs);

      const bootstrap = runBootstrap(projectName, envFile, overrideFile, adminLogin, adminPassword);
      assert.equal(bootstrap.status, 0, `bootstrap failed: ${bootstrap.error?.message ?? ""}\n${bootstrap.stdout ?? ""}\n${bootstrap.stderr ?? ""}`);
      assert.equal(lastJsonLine(`${bootstrap.stdout ?? ""}\n${bootstrap.stderr ?? ""}`).ok, true);
      assert.ok(!`${bootstrap.stdout}\n${bootstrap.stderr}`.includes(adminPassword), "bootstrap output leaked the administrator password");

      const runnerArgs = ["run", "--rm", "--no-deps", "-T", "test-runner"];
      const runner = run(runnerArgs, 600_000);
      if (runner.status !== 0) {
        const logs = run(["logs", "--no-color", "app"]);
        runner.stderr = `${runner.stderr ?? ""}\nApp logs:\n${logs.stdout ?? ""}${logs.stderr ?? ""}`;
      }
      assertComposeSucceeded(runner, runnerArgs);
    }, 900_000);

    afterAll(() => {
      if (!fixtureDirectory) return;
      const downArgs = ["down", "--volumes", "--remove-orphans", "--rmi", "local"];
      const result = run(downArgs, 180_000);
      rmSync(fixtureDirectory, { recursive: true, force: true });
      assertComposeSucceeded(result, downArgs);
    });

    it("runs isolated PostgreSQL and HTTP channel visibility checks", () => {
      expect(projectName).toContain("decentracord-channel-visibility-");
    });
  }, 900_000);
} else {
  interface HttpSession {
    cookie?: string;
    csrfToken?: string;
  }

  interface TestUser {
    id: string;
    login: string;
    password: string;
  }

  interface ChannelDto {
    id: string;
    name: string;
    description: string | null;
    visibility: "hidden" | "known";
    canView: boolean;
    canSend: boolean;
    canManageMessages: boolean;
    ownerEditable: boolean;
    unreadCount: number;
  }

  const baseUrl = process.env.CHANNEL_VISIBILITY_TEST_BASE_URL ?? "http://app:3000";
  const appOrigin = new URL(baseUrl).origin;
  let pool: Pool;
  let adminSession: HttpSession;
  let viewerSession: HttpSession;
  let deniedSession: HttpSession;
  let managerSession: HttpSession;
  let viewer: TestUser;
  let denied: TestUser;
  let manager: TestUser;
  let viewerRoleId = "";
  let managerRoleId = "";
  let everyoneRoleId = "";

  async function request(session: HttpSession, path: string, method = "GET", body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (session.cookie) headers.cookie = session.cookie;
    if (method !== "GET") {
      headers.origin = appOrigin;
      if (session.csrfToken) headers["x-csrf-token"] = session.csrfToken;
    }
    if (body !== undefined) headers["content-type"] = "application/json";
    const options: RequestInit = { method, headers, signal: AbortSignal.timeout(15_000) };
    if (body !== undefined) options.body = JSON.stringify(body);
    const response = await fetch(new URL(path, baseUrl), options);
    const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
    if (cookie) session.cookie = cookie;
    return response;
  }

  async function csrf(session: HttpSession): Promise<void> {
    const response = await request(session, "/api/auth/csrf");
    expect(response.status).toBe(200);
    const body = await response.json() as { csrfToken?: unknown };
    expect(typeof body.csrfToken).toBe("string");
    session.csrfToken = body.csrfToken as string;
  }

  async function login(credentials: { login: string; password: string }): Promise<HttpSession> {
    const session: HttpSession = {};
    await csrf(session);
    const response = await request(session, "/api/auth/login", "POST", {
      login: credentials.login,
      password: credentials.password
    });
    const responseBody = await response.text();
    expect(response.status, responseBody).toBe(200);
    const body = JSON.parse(responseBody) as { csrfToken?: unknown };
    expect(typeof body.csrfToken).toBe("string");
    session.csrfToken = body.csrfToken as string;
    return session;
  }

  async function createUser(loginValue: string, roleIds: string[]): Promise<TestUser> {
    const password = `Visibility-member-${randomBytes(16).toString("base64url")}`;
    const passwordHash = await new PasswordService().hash(password);
    const result = await pool.query<{ id: string }>(
      "INSERT INTO users (login, login_normalized, password_hash) VALUES ($1, $1, $2) RETURNING id::text AS id",
      [loginValue, passwordHash]
    );
    const id = result.rows[0]?.id;
    if (!id) throw new Error("Test user was not created");
    for (const roleId of roleIds) await pool.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)", [id, roleId]);
    return { id, login: loginValue, password };
  }

  async function createRole(name: string, permissions: string[]): Promise<string> {
    const result = await pool.query<{ id: string }>(
      "INSERT INTO roles (system_key, name, position, permissions) VALUES (NULL, $1, $2, $3::jsonb) RETURNING id::text AS id",
      [name, 1, JSON.stringify(permissions)]
    );
    const id = result.rows[0]?.id;
    if (!id) throw new Error("Test role was not created");
    return id;
  }

  async function expectError(response: Response, status: number, code: string): Promise<void> {
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code } });
  }

  beforeAll(async () => {
    const database = new URL(process.env.TEST_DATABASE_URL ?? "");
    expect(database.hostname).toBe("db");
    expect(database.pathname).toMatch(/^\/decentracord_test_[a-f0-9]+$/u);
    expect(new URL(baseUrl).hostname).toBe("app");
    expect(new URL(baseUrl).port).toBe("3000");
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 6, connectionTimeoutMillis: 3_000 });
    adminSession = await login({
      login: process.env.CHANNEL_VISIBILITY_ADMIN_LOGIN ?? "",
      password: process.env.CHANNEL_VISIBILITY_ADMIN_PASSWORD ?? ""
    });

    const everyone = await pool.query<{ id: string }>("SELECT id::text AS id FROM roles WHERE system_key = 'everyone'");
    everyoneRoleId = everyone.rows[0]?.id ?? "";
    if (!everyoneRoleId) throw new Error("@everyone role is missing");
    await pool.query("UPDATE roles SET permissions = $1::jsonb WHERE id = $2", [JSON.stringify(["SEND_MESSAGES"]), everyoneRoleId]);

    const suffix = randomBytes(5).toString("hex");
    viewerRoleId = await createRole(`Visibility Reader ${suffix}`, ["VIEW_CHANNEL", "SEND_MESSAGES"]);
    managerRoleId = await createRole(`Visibility Manager ${suffix}`, ["MANAGE_CHANNELS"]);
    viewer = await createUser(`visibility_reader_${suffix}`, [everyoneRoleId, viewerRoleId]);
    denied = await createUser(`visibility_denied_${suffix}`, [everyoneRoleId]);
    manager = await createUser(`visibility_manager_${suffix}`, [everyoneRoleId, managerRoleId]);
    viewerSession = await login(viewer);
    deniedSession = await login(denied);
    managerSession = await login(manager);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
  });

  it("keeps closed channel details and unread counts private and conceals updates without read access", async () => {
    const suffix = randomBytes(5).toString("hex");
    const createResponse = await request(adminSession, "/api/channels", "POST", { name: `Visibility ${suffix}` });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json() as ChannelDto;
    expect(created).toMatchObject({ visibility: "hidden", description: null });

    const hiddenListResponse = await request(deniedSession, "/api/channels");
    const hiddenList = await hiddenListResponse.json() as { channels: ChannelDto[] };
    expect(hiddenList.channels.some((channel) => channel.id === created.id)).toBe(false);
    await expectError(await request(managerSession, `/api/channels/${created.id}`, "PATCH", { visibility: "known" }), 404, "CHANNEL_NOT_FOUND");

    const description = "Проектные заметки для читателей";
    const setDescription = await request(adminSession, `/api/channels/${created.id}`, "PATCH", { description });
    expect(setDescription.status).toBe(200);
    await expectError(await request(adminSession, `/api/channels/${created.id}`, "PATCH", { description: "x".repeat(1025) }), 400, "INVALID_REQUEST");
    await expectError(await request(adminSession, `/api/channels/${created.id}`, "PATCH", { visibility: "public" }), 400, "INVALID_REQUEST");
    await expectError(await request(adminSession, `/api/channels/${created.id}`, "PATCH", { description, extra: true }), 400, "INVALID_REQUEST");
    await expectError(await request(viewerSession, `/api/channels/${created.id}`, "PATCH", { description: "Изменение без управления" }), 403, "FORBIDDEN");

    const sent = await request(viewerSession, `/api/channels/${created.id}/messages`, "POST", {
      content: "сообщение для проверки unread",
      clientRequestId: "00000000-0000-4000-8000-000000000051"
    });
    expect(sent.status).toBe(201);

    const makeKnown = await request(adminSession, `/api/channels/${created.id}`, "PATCH", { visibility: "known" });
    expect(makeKnown.status).toBe(200);
    expect(await makeKnown.json()).toMatchObject({ description, visibility: "known" });

    const deniedListResponse = await request(deniedSession, "/api/channels");
    expect(deniedListResponse.status).toBe(200);
    const deniedListBody = await deniedListResponse.json() as { channels: ChannelDto[] };
    const knownChannel = deniedListBody.channels.find((channel) => channel.id === created.id);
    expect(knownChannel).toMatchObject({
      id: created.id,
      name: created.name,
      canView: false,
      description: null,
      unreadCount: 0,
      ownerEditable: false
    });

    const managerListResponse = await request(managerSession, "/api/channels");
    const managerList = await managerListResponse.json() as { channels: ChannelDto[] };
    expect(managerList.channels.find((channel) => channel.id === created.id)).toMatchObject({
      canView: false,
      description: null,
      unreadCount: 0,
      ownerEditable: false
    });
    await expectError(await request(managerSession, `/api/channels/${created.id}`, "PATCH", { description: "leak attempt" }), 404, "CHANNEL_NOT_FOUND");
    await expectError(await request(managerSession, `/api/channels/${created.id}`, "PATCH", { visibility: "hidden" }), 404, "CHANNEL_NOT_FOUND");
    const unchanged = await pool.query<{ description: string | null; visibility: string }>(
      "SELECT description, visibility FROM channels WHERE id = $1",
      [created.id]
    );
    expect(unchanged.rows[0]).toEqual({ description, visibility: "known" });

    const readerListResponse = await request(viewerSession, "/api/channels");
    const readerList = await readerListResponse.json() as { channels: ChannelDto[] };
    expect(readerList.channels.find((channel) => channel.id === created.id)).toMatchObject({
      canView: true,
      description,
      visibility: "known"
    });
  }, 60_000);

  it("reports canView changes without treating a known channel as revoked", () => {
    const readable: VisibleChannelRow = {
      id: "00000000-0000-4000-8000-000000000001",
      name: "Known channel",
      categoryId: null,
      description: "Visible only to readers",
      visibility: "known",
      canView: true,
      canSend: true,
      canManageMessages: false,
      ownerEditable: false
    };
    const closed = { ...readable, description: null, canView: false, canSend: false };
    const changes = findUserChannelAccessChanges(
      new Map([["user-1", [readable]]]),
      new Map([["user-1", [closed]]])
    );
    expect(changes).toEqual([{ userId: "user-1", revokedChannelIds: [] }]);
  });
}
