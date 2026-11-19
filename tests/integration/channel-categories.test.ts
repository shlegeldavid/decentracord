import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PasswordService } from "../../apps/server/src/auth/password.service.js";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const commandTimeoutMs = 180_000;
const inContainer = process.env.CHANNEL_CATEGORIES_TEST_IN_CONTAINER === "true";

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
  describe("channel categories API integration", () => {
    let fixtureDirectory = "";
    let projectName = "";
    let envFile = "";
    let overrideFile = "";

    function run(args: string[], timeout = commandTimeoutMs) {
      return compose(projectName, envFile, overrideFile, args, timeout);
    }

    beforeAll(() => {
      fixtureDirectory = mkdtempSync(join(tmpdir(), "decentracord-channel-categories-"));
      const suffix = randomBytes(6).toString("hex");
      projectName = `decentracord-channel-categories-${suffix}`;
      const databaseName = `decentracord_test_${suffix}`;
      const databaseUser = `category_test_${suffix.slice(0, 10)}`;
      const databasePassword = randomBytes(24).toString("base64url");
      const adminLogin = `category_admin_${suffix.slice(0, 10)}`;
      const adminPassword = `Category-admin-${randomBytes(18).toString("base64url")}`;
      const secretFile = join(fixtureDirectory, "db_password");
      envFile = join(fixtureDirectory, "compose.env");
      overrideFile = join(fixtureDirectory, "compose.channel-categories.yaml");
      const buildxConfig = join(fixtureDirectory, "buildx");
      mkdirSync(buildxConfig, { mode: 0o700 });
      writeFileSync(secretFile, databasePassword, { mode: 0o600 });
      chmodSync(secretFile, 0o600);
      writeFileSync(envFile, [
        `DB_PASSWORD_SECRET_FILE=${secretFile}`,
        `DB_PASSWORD=${databasePassword}`,
        `DB_NAME=${databaseName}`,
        `DB_USER=${databaseUser}`,
        `CHANNEL_CATEGORIES_ADMIN_LOGIN=${adminLogin}`,
        `CHANNEL_CATEGORIES_ADMIN_PASSWORD=${adminPassword}`,
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
        `    image: ${JSON.stringify(`decentracord-channel-categories-runner:${suffix}`)}`,
        '    entrypoint: ["npm", "run", "test:integration", "--", "tests/integration/channel-categories.test.ts"]',
        "    environment:",
        "      CHANNEL_CATEGORIES_TEST_IN_CONTAINER: \"true\"",
        "      CHANNEL_CATEGORIES_TEST_BASE_URL: http://app:3000",
        "      CHANNEL_CATEGORIES_ADMIN_LOGIN: ${CHANNEL_CATEGORIES_ADMIN_LOGIN}",
        "      CHANNEL_CATEGORIES_ADMIN_PASSWORD: ${CHANNEL_CATEGORIES_ADMIN_PASSWORD}",
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

    it("runs isolated PostgreSQL and HTTP category checks", () => {
      expect(projectName).toContain("decentracord-channel-categories-");
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

  interface CategoryDto {
    id: string;
    name: string;
    position: number;
  }

  interface ChannelDto {
    id: string;
    categoryId: string | null;
    name?: string;
    description?: string | null;
    visibility?: "hidden" | "known";
  }

  interface ChannelOrderGroup {
    categoryId: string | null;
    channelIds: string[];
  }

  const baseUrl = process.env.CHANNEL_CATEGORIES_TEST_BASE_URL ?? "http://app:3000";
  const appOrigin = new URL(baseUrl).origin;
  let pool: Pool;
  let managerSession: HttpSession;
  let viewerSession: HttpSession;
  const anonymousSession: HttpSession = {};
  let manager: TestUser;
  let viewer: TestUser;
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

  async function anonymousRequest(path: string, method = "GET", body?: unknown): Promise<Response> {
    if (method !== "GET" && !anonymousSession.csrfToken) await csrf(anonymousSession);
    return request(anonymousSession, path, method, body);
  }

  async function login(credentials: { login: string; password: string }): Promise<HttpSession> {
    const session: HttpSession = {};
    await csrf(session);
    const response = await request(session, "/api/auth/login", "POST", credentials);
    expect(response.status, await response.clone().text()).toBe(200);
    const body = await response.json() as { csrfToken?: unknown };
    expect(typeof body.csrfToken).toBe("string");
    session.csrfToken = body.csrfToken as string;
    return session;
  }

  async function createUser(loginValue: string): Promise<TestUser> {
    const password = `Category-member-${randomBytes(16).toString("base64url")}`;
    const passwordHash = await new PasswordService().hash(password);
    const result = await pool.query<{ id: string }>(
      "INSERT INTO users (login, login_normalized, password_hash) VALUES ($1, $1, $2) RETURNING id::text AS id",
      [loginValue, passwordHash]
    );
    const id = result.rows[0]?.id;
    if (!id) throw new Error("Test user was not created");
    await pool.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)", [id, everyoneRoleId]);
    return { id, login: loginValue, password };
  }

  async function createCategory(name: string): Promise<Response> {
    return request(managerSession, "/api/channels/categories", "POST", { name });
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
    await login({
      login: process.env.CHANNEL_CATEGORIES_ADMIN_LOGIN ?? "",
      password: process.env.CHANNEL_CATEGORIES_ADMIN_PASSWORD ?? ""
    });

    const everyone = await pool.query<{ id: string }>("SELECT id::text AS id FROM roles WHERE system_key = 'everyone'");
    everyoneRoleId = everyone.rows[0]?.id ?? "";
    if (!everyoneRoleId) throw new Error("@everyone role is missing");
    await pool.query("UPDATE roles SET permissions = $1::jsonb WHERE id = $2", [JSON.stringify(["VIEW_CHANNEL", "SEND_MESSAGES"]), everyoneRoleId]);

    const rolePosition = await pool.query<{ max_position: number }>(
      "SELECT COALESCE(MAX(position), 0)::integer AS max_position FROM roles"
    );
    const role = await pool.query<{ id: string }>(
      "INSERT INTO roles (system_key, name, position, permissions) VALUES (NULL, $1, $2, $3::jsonb) RETURNING id::text AS id",
      [`Category Manager ${randomBytes(5).toString("hex")}`, (rolePosition.rows[0]?.max_position ?? 0) + 1, JSON.stringify(["MANAGE_CHANNELS"])]
    );
    managerRoleId = role.rows[0]?.id ?? "";
    if (!managerRoleId) throw new Error("Category manager role was not created");
    manager = await createUser(`category_manager_${randomBytes(5).toString("hex")}`);
    viewer = await createUser(`category_viewer_${randomBytes(5).toString("hex")}`);
    await pool.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)", [manager.id, managerRoleId]);
    managerSession = await login({ login: manager.login, password: manager.password });
    viewerSession = await login({ login: viewer.login, password: viewer.password });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
  });

  it("creates channels with a category, description and strict access overrides", async () => {
    const suffix = randomBytes(5).toString("hex");
    const createdChannelIds: string[] = [];
    const categoryResponse = await createCategory(`Create target ${suffix}`);
    expect(categoryResponse.status).toBe(201);
    const category = await categoryResponse.json() as CategoryDto;

    const channelName = `Create details ${suffix}`;
    const detailsResponse = await request(managerSession, "/api/channels", "POST", {
      name: channelName,
      description: "О закупках",
      categoryId: category.id
    });
    expect(detailsResponse.status, await detailsResponse.clone().text()).toBe(201);
    const detailsChannel = await detailsResponse.json() as ChannelDto;
    createdChannelIds.push(detailsChannel.id);
    const detailsRow = await pool.query<{ description: string | null; category_id: string | null; visibility: string; position: number }>(
      "SELECT description, category_id::text AS category_id, visibility, position FROM channels WHERE id = $1",
      [detailsChannel.id]
    );
    expect(detailsRow.rows[0]).toMatchObject({
      description: "О закупках",
      category_id: category.id,
      visibility: "hidden",
      position: 1
    });

    const secondInCategory = await request(managerSession, "/api/channels", "POST", {
      name: `Create category second ${suffix}`,
      categoryId: category.id
    });
    expect(secondInCategory.status, await secondInCategory.clone().text()).toBe(201);
    const secondChannel = await secondInCategory.json() as ChannelDto;
    createdChannelIds.push(secondChannel.id);
    const categoryPositions = await pool.query<{ position: number }>(
      "SELECT position FROM channels WHERE category_id = $1 ORDER BY position ASC",
      [category.id]
    );
    expect(categoryPositions.rows.map((row) => row.position)).toEqual([1, 2]);

    const uncategorizedResponse = await request(managerSession, "/api/channels", "POST", {
      name: `Create uncategorized ${suffix}`
    });
    expect(uncategorizedResponse.status, await uncategorizedResponse.clone().text()).toBe(201);
    const uncategorizedChannel = await uncategorizedResponse.json() as ChannelDto;
    createdChannelIds.push(uncategorizedChannel.id);
    const uncategorizedRow = await pool.query<{ category_id: string | null; visibility: string }>(
      "SELECT category_id::text AS category_id, visibility FROM channels WHERE id = $1",
      [uncategorizedChannel.id]
    );
    expect(uncategorizedRow.rows[0]).toEqual({ category_id: null, visibility: "hidden" });

    const overridesResponse = await request(managerSession, "/api/channels", "POST", {
      name: `Create overrides ${suffix}`,
      overrides: [
        { subject: "everyone", subjectId: null, permission: "VIEW_CHANNEL", effect: "allow" },
        { subject: "everyone", subjectId: null, permission: "SEND_MESSAGES", effect: "deny" },
        { subject: "role", subjectId: managerRoleId, permission: "MANAGE_MESSAGES", effect: "unset" }
      ]
    });
    expect(overridesResponse.status, await overridesResponse.clone().text()).toBe(201);
    const overridesChannel = await overridesResponse.json() as ChannelDto;
    createdChannelIds.push(overridesChannel.id);
    const storedOverrides = await pool.query<{ role_id: string; permission: string; effect: string }>(
      "SELECT role_id::text AS role_id, permission, effect FROM channel_role_overrides WHERE channel_id = $1 ORDER BY permission ASC",
      [overridesChannel.id]
    );
    expect(storedOverrides.rows).toEqual([
      { role_id: everyoneRoleId, permission: "SEND_MESSAGES", effect: "deny" },
      { role_id: everyoneRoleId, permission: "VIEW_CHANNEL", effect: "allow" }
    ]);

    await expectError(await request(managerSession, "/api/channels", "POST", {
      name: `Invalid category format ${suffix}`,
      categoryId: "not-a-uuid"
    }), 400, "INVALID_REQUEST");
    await expectError(await request(managerSession, "/api/channels", "POST", {
      name: `Missing category ${suffix}`,
      categoryId: randomUUID()
    }), 404, "CATEGORY_NOT_FOUND");
    await expectError(await request(managerSession, "/api/channels", "POST", {
      name: `Long description ${suffix}`,
      description: "x".repeat(1025)
    }), 400, "INVALID_REQUEST");
    await expectError(await request(managerSession, "/api/channels", "POST", {
      name: `Forbidden override ${suffix}`,
      overrides: [{ subject: "everyone", subjectId: null, permission: "MANAGE_CHANNELS", effect: "allow" }]
    }), 400, "INVALID_REQUEST");
    await expectError(await request(managerSession, "/api/channels", "POST", { name: `Unknown field ${suffix}`, extra: true }), 400, "INVALID_REQUEST");
    await expectError(await request(managerSession, "/api/channels", "POST", { name: channelName.toUpperCase() }), 409, "CHANNEL_ALREADY_EXISTS");
    await expectError(await request(viewerSession, "/api/channels", "POST", { name: `Denied create ${suffix}` }), 403, "FORBIDDEN");
    expect((await anonymousRequest("/api/channels", "POST", { name: `Anonymous create ${suffix}` })).status).toBe(401);

    expect(secondChannel.id).not.toBe(detailsChannel.id);
    await pool.query("DELETE FROM channels WHERE id = ANY($1::uuid[])", [createdChannelIds]);
    await pool.query("DELETE FROM channel_categories WHERE id = $1", [category.id]);
  });

  it("creates categories, validates names, and limits visibility to managers and channel readers", async () => {
    const anonymousRoutes: Array<[string, string, unknown?]> = [
      ["GET", "/api/channels/categories"],
      ["POST", "/api/channels/categories", { name: "Anonymous" }]
    ];
    for (const [method, path, body] of anonymousRoutes) {
      expect((await anonymousRequest(path, method, body)).status, `${method} ${path}`).toBe(401);
    }

    await expectError(await request(viewerSession, "/api/channels/categories", "POST", { name: "Denied" }), 403, "FORBIDDEN");
    await expectError(await createCategory("x".repeat(81)), 400, "INVALID_REQUEST");
    await expectError(await request(managerSession, "/api/channels/categories", "POST", { name: "Bad", extra: true }), 400, "INVALID_REQUEST");
    await expectError(await request(managerSession, "/api/channels", "POST", { name: "Bad", extra: true }), 400, "INVALID_REQUEST");

    const firstResponse = await createCategory("Отдел продаж");
    expect(firstResponse.status).toBe(201);
    const first = await firstResponse.json() as CategoryDto;
    expect(first).toMatchObject({ name: "Отдел продаж" });
    expect(first.id).toBeTruthy();
    expect(Number.isInteger(first.position)).toBe(true);
    await expectError(await createCategory("отдел продаж"), 409, "CATEGORY_ALREADY_EXISTS");

    const secondResponse = await createCategory("Бухгалтерия");
    expect(secondResponse.status).toBe(201);
    const second = await secondResponse.json() as CategoryDto;
    const adminList = await request(managerSession, "/api/channels");
    expect(adminList.status).toBe(200);
    const adminListBody = await adminList.json() as { channels: ChannelDto[]; categories: CategoryDto[] };
    expect(adminListBody.categories.map((category) => category.id)).toEqual([first.id, second.id]);
    expect(adminListBody.categories.map((category) => category.position)).toEqual(
      [...adminListBody.categories.map((category) => category.position)].sort((left, right) => left - right)
    );
    expect(adminListBody.categories[0]?.position).toBe(first.position);

    const emptyViewerList = await request(viewerSession, "/api/channels");
    expect(emptyViewerList.status).toBe(200);
    expect((await emptyViewerList.json() as { categories: CategoryDto[] }).categories).toEqual([]);

    const channelResponse = await request(managerSession, "/api/channels", "POST", { name: "Category access channel" });
    expect(channelResponse.status).toBe(201);
    const channel = await channelResponse.json() as ChannelDto;
    expect(channel.categoryId).toBeNull();
    const unassigned = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM channels WHERE category_id IS NOT NULL"
    );
    expect(unassigned.rows[0]?.count).toBe(0);

    await pool.query("UPDATE channels SET category_id = $1 WHERE id = $2", [first.id, channel.id]);
    const viewerList = await request(viewerSession, "/api/channels");
    expect(viewerList.status).toBe(200);
    const viewerListBody = await viewerList.json() as { channels: ChannelDto[]; categories: CategoryDto[] };
    expect(viewerListBody.categories.map((category) => category.id)).toEqual([first.id]);
    expect(viewerListBody.channels.find((entry) => entry.id === channel.id)?.categoryId).toBe(first.id);

    const viewerCategoryRoute = await request(viewerSession, "/api/channels/categories");
    expect(viewerCategoryRoute.status).toBe(200);
    expect((await viewerCategoryRoute.json() as CategoryDto[]).map((category) => category.id)).toEqual([first.id]);

    const categoryPath = `/api/channels/categories/${first.id}`;
    await expectError(await request(managerSession, categoryPath, "PATCH", { name: "Отдел", extra: true }), 400, "INVALID_REQUEST");
    await expectError(await request(managerSession, categoryPath, "PATCH", { name: "бухгалтерия" }), 409, "CATEGORY_ALREADY_EXISTS");
    const renameResponse = await request(managerSession, categoryPath, "PATCH", { name: "Отдел закупок" });
    expect(renameResponse.status).toBe(200);
    expect(await renameResponse.json()).toMatchObject({ id: first.id, name: "Отдел закупок" });

    const viewerAfterRename = await request(viewerSession, "/api/channels");
    expect((await viewerAfterRename.json() as { categories: CategoryDto[] }).categories)
      .toContainEqual(expect.objectContaining({ id: first.id, name: "Отдел закупок" }));
    await expectError(await request(viewerSession, categoryPath, "PATCH", { name: "Запрещено" }), 403, "FORBIDDEN");
    await expectError(await request(managerSession, "/api/channels/categories/00000000-0000-4000-8000-000000000000", "PATCH", { name: "Нет" }), 404, "CATEGORY_NOT_FOUND");

    const anonymousCategoryRoutes: Array<[string, string, unknown?]> = [
      ["PATCH", categoryPath, { name: "Анонимно" }],
      ["DELETE", categoryPath]
    ];
    for (const [method, path, body] of anonymousCategoryRoutes) {
      expect((await anonymousRequest(path, method, body)).status, `${method} ${path}`).toBe(401);
    }
    await expectError(await request(viewerSession, categoryPath, "DELETE"), 403, "FORBIDDEN");
    await expectError(await request(managerSession, "/api/channels/categories/00000000-0000-4000-8000-000000000000", "DELETE"), 404, "CATEGORY_NOT_FOUND");

    const secondChannelResponse = await request(managerSession, "/api/channels", "POST", { name: "Category deletion second channel" });
    expect(secondChannelResponse.status).toBe(201);
    const secondChannel = await secondChannelResponse.json() as ChannelDto;
    await pool.query("UPDATE channels SET category_id = $1 WHERE id = $2", [second.id, secondChannel.id]);
    const unassignedChannelResponse = await request(managerSession, "/api/channels", "POST", { name: "Category deletion unassigned channel" });
    expect(unassignedChannelResponse.status).toBe(201);
    const messageId = randomUUID();
    await pool.query(
      "INSERT INTO messages (channel_id, author_id, seq, updated_seq, content, client_request_id) VALUES ($1, $2, 1, 1, $3, $4)",
      [channel.id, manager.id, "Message survives category deletion", messageId]
    );
    const messagesBeforeDelete = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM messages WHERE channel_id = $1",
      [channel.id]
    );

    const deleteResponse = await request(managerSession, categoryPath, "DELETE");
    expect(deleteResponse.status).toBe(204);
    const channelAfterDelete = await pool.query<{ category_id: string | null }>(
      "SELECT category_id::text AS category_id FROM channels WHERE id = $1",
      [channel.id]
    );
    expect(channelAfterDelete.rows[0]?.category_id).toBeNull();
    const messagesAfterDelete = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM messages WHERE channel_id = $1",
      [channel.id]
    );
    expect(messagesAfterDelete.rows[0]?.count).toBe(messagesBeforeDelete.rows[0]?.count);
    const uncategorizedPositions = await pool.query<{ position: number }>(
      "SELECT position FROM channels WHERE category_id IS NULL ORDER BY position ASC"
    );
    expect(uncategorizedPositions.rows.map((row) => row.position)).toEqual([1, 2]);
  });

  it("moves channels between categories and preserves contiguous order", async () => {
    const suffix = randomBytes(5).toString("hex");
    const sourceResponse = await createCategory(`Move source ${suffix}`);
    const targetResponse = await createCategory(`Move target ${suffix}`);
    expect(sourceResponse.status).toBe(201);
    expect(targetResponse.status).toBe(201);
    const source = await sourceResponse.json() as CategoryDto;
    const target = await targetResponse.json() as CategoryDto;

    async function createChannel(name: string): Promise<ChannelDto> {
      const response = await request(managerSession, "/api/channels", "POST", { name: `${name} ${suffix}` });
      expect(response.status, await response.clone().text()).toBe(201);
      return response.json() as Promise<ChannelDto>;
    }

    const moving = await createChannel("Moving");
    const sourceRemaining = await createChannel("Source remaining");
    const targetExisting = await createChannel("Target existing");
    const uncategorizedOne = await createChannel("Uncategorized one");
    const uncategorizedTwo = await createChannel("Uncategorized two");

    await pool.query("UPDATE channels SET category_id = $1, position = 1 WHERE id = $2", [source.id, moving.id]);
    await pool.query("UPDATE channels SET category_id = $1, position = 2 WHERE id = $2", [source.id, sourceRemaining.id]);
    await pool.query("UPDATE channels SET category_id = $1, position = 1 WHERE id = $2", [target.id, targetExisting.id]);
    await pool.query("UPDATE channels SET category_id = NULL, position = 1 WHERE id = $1", [uncategorizedOne.id]);
    await pool.query("UPDATE channels SET category_id = NULL, position = 2 WHERE id = $1", [uncategorizedTwo.id]);
    const uncategorizedBefore = await pool.query<{ id: string }>(
      "SELECT id::text AS id FROM channels WHERE category_id IS NULL ORDER BY position ASC, lower(name) ASC, id ASC"
    );
    const originalUncategorizedOrder = uncategorizedBefore.rows.map((row) => row.id);

    const moveResponse = await request(managerSession, `/api/channels/${moving.id}`, "PATCH", { categoryId: target.id });
    expect(moveResponse.status, await moveResponse.clone().text()).toBe(200);
    expect(await moveResponse.json()).toMatchObject({ id: moving.id, categoryId: target.id });
    const targetRows = await pool.query<{ id: string; position: number }>(
      "SELECT id::text AS id, position FROM channels WHERE category_id = $1 ORDER BY position ASC",
      [target.id]
    );
    expect(targetRows.rows.map((row) => row.id)).toEqual([targetExisting.id, moving.id]);
    expect(targetRows.rows.map((row) => row.position)).toEqual([1, 2]);
    const sourceRows = await pool.query<{ position: number }>(
      "SELECT position FROM channels WHERE category_id = $1 ORDER BY position ASC",
      [source.id]
    );
    expect(sourceRows.rows.map((row) => row.position)).toEqual([1]);

    const moveFromUncategorized = await request(managerSession, `/api/channels/${uncategorizedOne.id}`, "PATCH", { categoryId: target.id });
    expect(moveFromUncategorized.status).toBe(200);
    const remainingUncategorized = await pool.query<{ id: string; position: number }>(
      "SELECT id::text AS id, position FROM channels WHERE category_id IS NULL ORDER BY position ASC, lower(name) ASC, id ASC"
    );
    expect(remainingUncategorized.rows.map((row) => row.id)).toEqual(originalUncategorizedOrder.filter((id) => id !== uncategorizedOne.id));
    expect(remainingUncategorized.rows.map((row) => row.position)).toEqual(remainingUncategorized.rows.map((_, index) => index + 1));

    const moveToUncategorized = await request(managerSession, `/api/channels/${moving.id}`, "PATCH", { categoryId: null });
    expect(moveToUncategorized.status).toBe(200);
    const uncategorizedAfterMove = await pool.query<{ id: string; position: number }>(
      "SELECT id::text AS id, position FROM channels WHERE category_id IS NULL ORDER BY position ASC, lower(name) ASC, id ASC"
    );
    expect(uncategorizedAfterMove.rows.map((row) => row.id)).toEqual([
      ...originalUncategorizedOrder.filter((id) => id !== uncategorizedOne.id),
      moving.id
    ]);
    expect(uncategorizedAfterMove.rows.map((row) => row.position)).toEqual(uncategorizedAfterMove.rows.map((_, index) => index + 1));

    await expectError(await request(managerSession, `/api/channels/${moving.id}`, "PATCH", { categoryId: "not-a-uuid" }), 400, "INVALID_REQUEST");
    await expectError(await request(managerSession, `/api/channels/${moving.id}`, "PATCH", { categoryId: "00000000-0000-4000-8000-000000000000" }), 404, "CATEGORY_NOT_FOUND");
    await expectError(await request(managerSession, `/api/channels/${randomUUID()}`, "PATCH", { categoryId: target.id }), 404, "CHANNEL_NOT_FOUND");
    await expectError(await request(viewerSession, `/api/channels/${moving.id}`, "PATCH", { categoryId: target.id }), 403, "FORBIDDEN");
    await expectError(await request(managerSession, `/api/channels/${moving.id}`, "PATCH", { name: "Allowed name", extra: true }), 400, "INVALID_REQUEST");
  });

  it("reorders the complete category list and guards the order route", async () => {
    const suffix = randomBytes(5).toString("hex");
    const responses = await Promise.all([
      createCategory(`Order one ${suffix}`),
      createCategory(`Order two ${suffix}`),
      createCategory(`Order three ${suffix}`)
    ]);
    for (const response of responses) expect(response.status).toBe(201);
    const categories = await Promise.all(responses.map((response) => response.json() as Promise<CategoryDto>));
    const currentResponse = await request(managerSession, "/api/channels/categories");
    expect(currentResponse.status).toBe(200);
    const currentCategories = await currentResponse.json() as CategoryDto[];
    const createdIds = new Set(categories.map((category) => category.id));
    const requested = [
      categories[2]!.id,
      categories[0]!.id,
      categories[1]!.id,
      ...currentCategories.map((category) => category.id).filter((id) => !createdIds.has(id))
    ];
    const path = "/api/channels/categories/order";

    const reordered = await request(managerSession, path, "PUT", { categoryIds: requested });
    expect(reordered.status, await reordered.text()).toBe(204);
    const positions = await pool.query<{ id: string; position: number }>(
      "SELECT id::text AS id, position FROM channel_categories WHERE id = ANY($1::uuid[]) ORDER BY position ASC",
      [requested]
    );
    expect(positions.rows.map((row) => row.id)).toEqual(requested);
    expect(positions.rows.map((row) => row.position)).toEqual(positions.rows.map((_, index) => index + 1));

    const repeated = [...requested];
    repeated[1] = repeated[0]!;
    const unknown = [...requested];
    unknown[unknown.length - 1] = "00000000-0000-4000-8000-000000000000";
    await expectError(await request(managerSession, path, "PUT", { categoryIds: repeated }), 400, "INVALID_REQUEST");
    await expectError(await request(managerSession, path, "PUT", { categoryIds: unknown }), 400, "INVALID_REQUEST");
    await expectError(await request(viewerSession, path, "PUT", { categoryIds: requested }), 403, "FORBIDDEN");
    expect((await anonymousRequest(path, "PUT", { categoryIds: requested })).status).toBe(401);
  });

  it("reorders complete channel groups, transfers channels, and keeps contiguous positions", async () => {
    const suffix = randomBytes(5).toString("hex");
    const createdCategoryIds: string[] = [];
    const createdChannelIds: string[] = [];
    const path = "/api/channels/order";

    async function createFixtureCategory(name: string): Promise<string> {
      const response = await createCategory(name);
      expect(response.status, await response.clone().text()).toBe(201);
      const category = await response.json() as CategoryDto;
      createdCategoryIds.push(category.id);
      return category.id;
    }

    async function createFixtureChannel(name: string, categoryId: string | null): Promise<string> {
      const response = await request(managerSession, "/api/channels", "POST", {
        name,
        ...(categoryId === null ? {} : { categoryId })
      });
      expect(response.status, await response.clone().text()).toBe(201);
      const channel = await response.json() as ChannelDto;
      createdChannelIds.push(channel.id);
      return channel.id;
    }

    async function currentGroups(): Promise<ChannelOrderGroup[]> {
      const [categories, channels] = await Promise.all([
        pool.query<{ id: string }>("SELECT id::text AS id FROM channel_categories ORDER BY position ASC, id ASC"),
        pool.query<{ id: string; category_id: string | null }>(
          "SELECT id::text AS id, category_id::text AS category_id FROM channels ORDER BY category_id NULLS FIRST, position ASC, lower(name) ASC, id ASC"
        )
      ]);
      const groupIds: Array<string | null> = [null, ...categories.rows.map((category) => category.id)];
      return groupIds.map((categoryId) => ({
        categoryId,
        channelIds: channels.rows.filter((channel) => channel.category_id === categoryId).map((channel) => channel.id)
      }));
    }

    try {
      const sourceCategoryId = await createFixtureCategory(`Reorder source ${suffix}`);
      const targetCategoryId = await createFixtureCategory(`Reorder target ${suffix}`);
      const uncategorizedFirstId = await createFixtureChannel(`Reorder uncategorized one ${suffix}`, null);
      const uncategorizedSecondId = await createFixtureChannel(`Reorder uncategorized two ${suffix}`, null);
      const sourceFirstId = await createFixtureChannel(`Reorder source one ${suffix}`, sourceCategoryId);
      const sourceSecondId = await createFixtureChannel(`Reorder source two ${suffix}`, sourceCategoryId);
      const targetFirstId = await createFixtureChannel(`Reorder target one ${suffix}`, targetCategoryId);

      const groups = await currentGroups();
      const uncategorizedGroup = groups.find((group) => group.categoryId === null);
      expect(uncategorizedGroup).toBeTruthy();
      if (!uncategorizedGroup) throw new Error("Uncategorized group was missing");
      uncategorizedGroup.channelIds = [
        uncategorizedSecondId,
        uncategorizedFirstId,
        ...uncategorizedGroup.channelIds.filter((id) => id !== uncategorizedFirstId && id !== uncategorizedSecondId)
      ];

      const reordered = await request(managerSession, path, "PUT", { groups });
      expect(reordered.status, await reordered.text()).toBe(204);

      const uncategorizedPositions = await pool.query<{ id: string; position: number }>(
        "SELECT id::text AS id, position FROM channels WHERE id = ANY($1::uuid[]) ORDER BY position ASC",
        [[uncategorizedSecondId, uncategorizedFirstId]]
      );
      expect(uncategorizedPositions.rows).toEqual([
        { id: uncategorizedSecondId, position: 1 },
        { id: uncategorizedFirstId, position: 2 }
      ]);

      const sourcePositions = await pool.query<{ id: string; position: number }>(
        "SELECT id::text AS id, position FROM channels WHERE category_id = $1 AND id = ANY($2::uuid[]) ORDER BY position ASC",
        [sourceCategoryId, [sourceFirstId, sourceSecondId]]
      );
      expect(sourcePositions.rows).toEqual([
        { id: sourceFirstId, position: 1 },
        { id: sourceSecondId, position: 2 }
      ]);
      const targetPositions = await pool.query<{ id: string; position: number }>(
        "SELECT id::text AS id, position FROM channels WHERE category_id = $1 AND id = $2",
        [targetCategoryId, targetFirstId]
      );
      expect(targetPositions.rows).toEqual([{ id: targetFirstId, position: 1 }]);

      const repeated = await request(managerSession, path, "PUT", { groups });
      expect(repeated.status, await repeated.text()).toBe(204);

      const transferGroups = await currentGroups();
      const sourceGroup = transferGroups.find((group) => group.categoryId === sourceCategoryId);
      const targetGroup = transferGroups.find((group) => group.categoryId === targetCategoryId);
      expect(sourceGroup).toBeTruthy();
      expect(targetGroup).toBeTruthy();
      if (!sourceGroup || !targetGroup) throw new Error("Fixture category group was missing");
      sourceGroup.channelIds = sourceGroup.channelIds.filter((id) => id !== sourceSecondId);
      targetGroup.channelIds = [sourceSecondId, ...targetGroup.channelIds];

      const transferred = await request(managerSession, path, "PUT", { groups: transferGroups });
      expect(transferred.status, await transferred.text()).toBe(204);
      const transferredRow = await pool.query<{ category_id: string | null; position: number }>(
        "SELECT category_id::text AS category_id, position FROM channels WHERE id = $1",
        [sourceSecondId]
      );
      expect(transferredRow.rows[0]).toEqual({ category_id: targetCategoryId, position: 1 });
      const sourceAfterTransfer = await pool.query<{ position: number }>(
        "SELECT position FROM channels WHERE category_id = $1 ORDER BY position ASC",
        [sourceCategoryId]
      );
      expect(sourceAfterTransfer.rows.map((row) => row.position)).toEqual(
        sourceAfterTransfer.rows.map((_, index) => index + 1)
      );

      const repeatedWithinGroup = structuredClone(transferGroups);
      const repeatedUncategorized = repeatedWithinGroup.find((group) => group.categoryId === null);
      expect(repeatedUncategorized?.channelIds.length).toBeGreaterThanOrEqual(2);
      if (!repeatedUncategorized || repeatedUncategorized.channelIds.length < 2) {
        throw new Error("Fixture needs two uncategorized channels");
      }
      repeatedUncategorized.channelIds[1] = repeatedUncategorized.channelIds[0]!;
      await expectError(await request(managerSession, path, "PUT", { groups: repeatedWithinGroup }), 400, "INVALID_REQUEST");

      const repeatedAcrossGroups = structuredClone(transferGroups);
      const repeatedSource = repeatedAcrossGroups.find((group) => group.categoryId === sourceCategoryId);
      const repeatedTarget = repeatedAcrossGroups.find((group) => group.categoryId === targetCategoryId);
      expect(repeatedSource?.channelIds.length).toBeGreaterThan(0);
      expect(repeatedTarget?.channelIds.length).toBeGreaterThan(0);
      if (!repeatedSource || !repeatedTarget || repeatedSource.channelIds.length === 0 || repeatedTarget.channelIds.length === 0) {
        throw new Error("Fixture categories need channels");
      }
      repeatedTarget.channelIds[0] = repeatedSource.channelIds[0]!;
      await expectError(await request(managerSession, path, "PUT", { groups: repeatedAcrossGroups }), 400, "INVALID_REQUEST");

      const unknownChannel = structuredClone(transferGroups);
      const unknownUncategorized = unknownChannel.find((group) => group.categoryId === null);
      if (!unknownUncategorized || unknownUncategorized.channelIds.length === 0) {
        throw new Error("Fixture needs an uncategorized channel");
      }
      unknownUncategorized.channelIds[0] = randomUUID();
      await expectError(await request(managerSession, path, "PUT", { groups: unknownChannel }), 400, "INVALID_REQUEST");

      const unknownCategory = structuredClone(transferGroups);
      const unknownCategoryGroup = unknownCategory.find((group) => group.categoryId === sourceCategoryId);
      if (!unknownCategoryGroup) throw new Error("Fixture category group was missing");
      unknownCategoryGroup.categoryId = randomUUID();
      await expectError(await request(managerSession, path, "PUT", { groups: unknownCategory }), 400, "INVALID_REQUEST");

      await expectError(await request(managerSession, path, "PUT", { groups: transferGroups, extra: true }), 400, "INVALID_REQUEST");
      await expectError(await request(viewerSession, path, "PUT", { groups: transferGroups }), 403, "FORBIDDEN");
      expect((await anonymousRequest(path, "PUT", { groups: transferGroups })).status).toBe(401);
    } finally {
      if (createdChannelIds.length > 0) {
        await pool.query("DELETE FROM channels WHERE id = ANY($1::uuid[])", [createdChannelIds]);
      }
      if (createdCategoryIds.length > 0) {
        await pool.query("DELETE FROM channel_categories WHERE id = ANY($1::uuid[])", [createdCategoryIds]);
      }
    }
  });

  it("keeps hidden channels out of the manager payload while preserving them on the server", async () => {
    const suffix = randomBytes(5).toString("hex");
    const createdCategoryIds: string[] = [];
    const createdChannelIds: string[] = [];
    const path = "/api/channels/order";

    try {
      const categoryResponse = await createCategory(`Hidden reorder ${suffix}`);
      expect(categoryResponse.status, await categoryResponse.clone().text()).toBe(201);
      const category = await categoryResponse.json() as CategoryDto;
      createdCategoryIds.push(category.id);

      const hiddenIds: string[] = [];
      for (const number of [1, 2]) {
        const response = await request(managerSession, "/api/channels", "POST", {
          name: `hidden-order-${number}-${suffix}`,
          categoryId: category.id,
          overrides: [{ subject: "everyone", subjectId: null, permission: "VIEW_CHANNEL", effect: "deny" }]
        });
        expect(response.status, await response.clone().text()).toBe(201);
        const channel = await response.json() as ChannelDto;
        hiddenIds.push(channel.id);
        createdChannelIds.push(channel.id);
      }
      const visibleResponse = await request(managerSession, "/api/channels", "POST", {
        name: `visible-order-${suffix}`,
        categoryId: category.id
      });
      expect(visibleResponse.status, await visibleResponse.clone().text()).toBe(201);
      const visible = await visibleResponse.json() as ChannelDto;
      createdChannelIds.push(visible.id);

      const listResponse = await request(managerSession, "/api/channels");
      expect(listResponse.status).toBe(200);
      const listBody = await listResponse.json() as { channels: ChannelDto[]; categories: CategoryDto[] };
      expect(listBody.channels.map((channel) => channel.id)).not.toEqual(expect.arrayContaining(hiddenIds));
      expect(JSON.stringify(listBody)).not.toContain(hiddenIds[0]!);
      expect(JSON.stringify(listBody)).not.toContain(hiddenIds[1]!);
      expect(listBody.categories.map((entry) => entry.id)).toContain(category.id);

      const visibleGroups: ChannelOrderGroup[] = [null, ...listBody.categories.map((entry) => entry.id)].map((categoryId) => ({
        categoryId,
        channelIds: listBody.channels.filter((channel) => channel.categoryId === categoryId).map((channel) => channel.id)
      }));
      const hiddenGroup = visibleGroups.find((group) => group.categoryId === category.id);
      expect(hiddenGroup?.channelIds).toContain(visible.id);
      expect(hiddenGroup?.channelIds).not.toEqual(expect.arrayContaining(hiddenIds));

      const reordered = await request(managerSession, path, "PUT", { groups: visibleGroups });
      expect(reordered.status, await reordered.text()).toBe(204);
      const hiddenRows = await pool.query<{ id: string; category_id: string | null; position: number }>(
        "SELECT id::text AS id, category_id::text AS category_id, position FROM channels WHERE id = ANY($1::uuid[]) ORDER BY position ASC",
        [hiddenIds]
      );
      expect(hiddenRows.rows.map((row) => row.id)).toEqual(hiddenIds);
      expect(hiddenRows.rows.map((row) => row.category_id)).toEqual([category.id, category.id]);
      expect(hiddenRows.rows.map((row) => row.position)).toEqual([2, 3]);
    } finally {
      if (createdChannelIds.length > 0) {
        await pool.query("DELETE FROM channels WHERE id = ANY($1::uuid[])", [createdChannelIds]);
      }
      if (createdCategoryIds.length > 0) {
        await pool.query("DELETE FROM channel_categories WHERE id = ANY($1::uuid[])", [createdCategoryIds]);
      }
    }
  });
}
