import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
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
const inContainer = process.env.CHANNEL_ACCESS_TEST_IN_CONTAINER === "true";

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
  describe("channel access API integration", () => {
    let fixtureDirectory = "";
    let projectName = "";
    let envFile = "";
    let overrideFile = "";

    function run(args: string[], timeout = commandTimeoutMs) {
      return compose(projectName, envFile, overrideFile, args, timeout);
    }

    beforeAll(() => {
      fixtureDirectory = mkdtempSync(join(tmpdir(), "decentracord-channel-access-"));
      const suffix = randomBytes(6).toString("hex");
      projectName = `decentracord-channel-access-${suffix}`;
      const databaseName = `decentracord_test_${suffix}`;
      const databaseUser = `channel_test_${suffix.slice(0, 10)}`;
      const databasePassword = randomBytes(24).toString("base64url");
      const adminLogin = `channel_admin_${suffix.slice(0, 10)}`;
      const adminPassword = `Channel-admin-${randomBytes(18).toString("base64url")}`;
      const secretFile = join(fixtureDirectory, "db_password");
      envFile = join(fixtureDirectory, "compose.env");
      overrideFile = join(fixtureDirectory, "compose.channel-access.yaml");
      const buildxConfig = join(fixtureDirectory, "buildx");
      mkdirSync(buildxConfig, { mode: 0o700 });
      writeFileSync(secretFile, databasePassword, { mode: 0o600 });
      chmodSync(secretFile, 0o600);
      writeFileSync(envFile, [
        `DB_PASSWORD_SECRET_FILE=${secretFile}`,
        `DB_PASSWORD=${databasePassword}`,
        `DB_NAME=${databaseName}`,
        `DB_USER=${databaseUser}`,
        `CHANNEL_ACCESS_ADMIN_LOGIN=${adminLogin}`,
        `CHANNEL_ACCESS_ADMIN_PASSWORD=${adminPassword}`,
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
        `    image: ${JSON.stringify(`decentracord-channel-access-runner:${suffix}`)}`,
        '    entrypoint: ["npm", "run", "test:integration", "--", "tests/integration/channel-access.test.ts"]',
        "    environment:",
        "      CHANNEL_ACCESS_TEST_IN_CONTAINER: \"true\"",
        "      CHANNEL_ACCESS_TEST_BASE_URL: http://app:3000",
        "      CHANNEL_ACCESS_ADMIN_LOGIN: ${CHANNEL_ACCESS_ADMIN_LOGIN}",
        "      CHANNEL_ACCESS_ADMIN_PASSWORD: ${CHANNEL_ACCESS_ADMIN_PASSWORD}",
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

    it("runs isolated PostgreSQL and HTTP channel permission checks", () => {
      expect(projectName).toContain("decentracord-channel-access-");
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
    canView: boolean;
    canSend: boolean;
    canManageMessages: boolean;
    ownerEditable: boolean;
  }

  interface OverrideDto {
    subject: "everyone" | "role" | "member";
    subjectId: string | null;
    permission: string;
    effect: "allow" | "deny";
  }

  const baseUrl = process.env.CHANNEL_ACCESS_TEST_BASE_URL ?? "http://app:3000";
  const appOrigin = new URL(baseUrl).origin;
  let pool: Pool;
  let adminSession: HttpSession;
  let managerSession: HttpSession;
  let viewerSession: HttpSession;
  let roleViewerSession: HttpSession;
  const anonymousSession: HttpSession = {};
  let viewer: TestUser;
  let roleViewer: TestUser;
  let manager: TestUser;
  let managerRoleId: string;
  let managerRoleName: string;
  let readerRoleId: string;
  let readerRoleName: string;
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

  async function anonymousRequest(path: string, method = "GET", body?: unknown): Promise<Response> {
    if (method !== "GET" && !anonymousSession.csrfToken) await csrf(anonymousSession);
    return request(anonymousSession, path, method, body);
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
    expect(response.status).toBe(200);
    const body = await response.json() as { csrfToken?: unknown };
    expect(typeof body.csrfToken).toBe("string");
    session.csrfToken = body.csrfToken as string;
    return session;
  }

  async function createUser(loginValue: string, everyoneRoleId: string): Promise<TestUser> {
    const password = `Channel-member-${randomBytes(16).toString("base64url")}`;
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

  async function createRole(name: string, position: number, permissions: string[]): Promise<string> {
    const result = await pool.query<{ id: string }>(
      "INSERT INTO roles (system_key, name, position, permissions) VALUES (NULL, $1, $2, $3::jsonb) RETURNING id::text AS id",
      [name, position, JSON.stringify(permissions)]
    );
    const id = result.rows[0]?.id;
    if (!id) throw new Error("Test role was not created");
    return id;
  }

  async function expectError(response: Response, status: number, code: string): Promise<void> {
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code } });
  }

  async function setOverrides(session: HttpSession, channelId: string, overrides: unknown[]): Promise<Response> {
    return request(session, `/api/channels/${channelId}/overrides`, "PUT", { overrides });
  }

  beforeAll(async () => {
    const database = new URL(process.env.TEST_DATABASE_URL ?? "");
    expect(database.hostname).toBe("db");
    expect(database.pathname).toMatch(/^\/decentracord_test_[a-f0-9]+$/u);
    expect(new URL(baseUrl).hostname).toBe("app");
    expect(new URL(baseUrl).port).toBe("3000");
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 6, connectionTimeoutMillis: 3_000 });
    adminSession = await login({
      login: process.env.CHANNEL_ACCESS_ADMIN_LOGIN ?? "",
      password: process.env.CHANNEL_ACCESS_ADMIN_PASSWORD ?? ""
    });

    const everyone = await pool.query<{ id: string }>("SELECT id::text AS id FROM roles WHERE system_key = 'everyone'");
    everyoneRoleId = everyone.rows[0]?.id ?? "";
    if (!everyoneRoleId) throw new Error("@everyone role is missing");
    await pool.query("UPDATE roles SET permissions = $1::jsonb WHERE id = $2", [JSON.stringify(["VIEW_CHANNEL", "SEND_MESSAGES"]), everyoneRoleId]);

    const suffix = randomBytes(5).toString("hex");
    viewer = await createUser(`channel_viewer_${suffix}`, everyoneRoleId);
    roleViewer = await createUser(`channel_role_viewer_${suffix}`, everyoneRoleId);
    managerRoleName = `Channel Manager ${suffix}`;
    readerRoleName = `Channel Reader ${suffix}`;
    managerRoleId = await createRole(managerRoleName, 1, ["MANAGE_CHANNELS"]);
    readerRoleId = await createRole(readerRoleName, 2, []);
    await pool.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)", [roleViewer.id, readerRoleId]);
    manager = await createUser(`channel_manager_${suffix}`, everyoneRoleId);
    await pool.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)", [manager.id, managerRoleId]);
    viewerSession = await login(viewer);
    roleViewerSession = await login(roleViewer);
    managerSession = await login(manager);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
  });

  it("returns a minimal override-subject catalog to channel managers", async () => {
    await expectError(await request(viewerSession, "/api/channels/subjects"), 403, "FORBIDDEN");

    const inactive = await createUser(`inactive_${randomBytes(5).toString("hex")}`, everyoneRoleId);
    await pool.query("UPDATE users SET active = false WHERE id = $1", [inactive.id]);

    const response = await request(managerSession, "/api/channels/subjects");
    expect(response.status).toBe(200);
    const catalog = await response.json() as {
      roles: Array<{ id: string; name: string }>;
      members: Array<{ id: string; login: string }>;
    };
    expect(Object.keys(catalog).sort()).toEqual(["members", "roles"]);
    expect(catalog.roles).toEqual(expect.arrayContaining([
      { id: managerRoleId, name: managerRoleName },
      { id: readerRoleId, name: readerRoleName }
    ]));
    expect(catalog.roles.some((role) => role.id === everyoneRoleId)).toBe(false);
    expect(catalog.roles.every((role) => Object.keys(role).sort().join(",") === "id,name")).toBe(true);
    expect(catalog.members).toEqual(expect.arrayContaining([
      { id: viewer.id, login: viewer.login },
      { id: roleViewer.id, login: roleViewer.login },
      { id: manager.id, login: manager.login }
    ]));
    expect(catalog.members.some((member) => member.id === inactive.id)).toBe(false);
    expect(catalog.members.every((member) => Object.keys(member).sort().join(",") === "id,login")).toBe(true);

    const adminCatalog = await request(adminSession, "/api/channels/subjects");
    expect(adminCatalog.status).toBe(200);
  });

  it("enforces private routes, visibility, override precedence, and role-order independence", async () => {
    const channelPathId = "00000000-0000-4000-8000-000000000001";
    const anonymousRoutes: Array<[string, string, unknown?]> = [
      ["GET", "/api/channels"],
      ["GET", "/api/channels/subjects"],
      ["GET", `/api/channels/${channelPathId}`],
      ["POST", "/api/channels", { name: "Anonymous" }],
      ["PATCH", `/api/channels/${channelPathId}`, { name: "Anonymous" }],
      ["PUT", `/api/channels/${channelPathId}/overrides`, { overrides: [] }],
      ["POST", `/api/channels/${channelPathId}/messages`, { message: "must not be processed" }]
    ];
    for (const [method, path, body] of anonymousRoutes) {
      expect((await anonymousRequest(path, method, body)).status, `${method} ${path}`).toBe(401);
    }

    await expectError(await request(viewerSession, "/api/channels", "POST", { name: "Unauthorized" }), 403, "FORBIDDEN");
    await expectError(await request(managerSession, "/api/channels", "POST", { name: "Bad", extra: true }), 400, "INVALID_REQUEST");

    const createGeneral = await request(managerSession, "/api/channels", "POST", { name: " General " });
    expect(createGeneral.status).toBe(201);
    const general = await createGeneral.json() as ChannelDto;
    expect(general).toMatchObject({ name: "General", canView: true, canSend: true, ownerEditable: true });
    await expectError(await request(managerSession, "/api/channels", "POST", { name: "gEnErAl" }), 409, "CHANNEL_ALREADY_EXISTS");

    const createAnnouncements = await request(managerSession, "/api/channels", "POST", { name: "Announcements" });
    expect(createAnnouncements.status).toBe(201);
    const announcements = await createAnnouncements.json() as ChannelDto;
    expect(announcements.name).toBe("Announcements");
    const rename = await request(managerSession, `/api/channels/${general.id}`, "PATCH", { name: "General Chat" });
    expect(rename.status).toBe(200);
    expect(await rename.json()).toMatchObject({ id: general.id, name: "General Chat" });
    await expectError(await request(managerSession, `/api/channels/${general.id}`, "PATCH", { name: "announcements" }), 409, "CHANNEL_ALREADY_EXISTS");

    const detailForViewer = await request(viewerSession, `/api/channels/${general.id}`);
    expect(detailForViewer.status).toBe(200);
    expect(await detailForViewer.json()).toEqual({
      channel: { id: general.id, name: "General Chat", categoryId: null, description: null, visibility: "hidden", canView: true, canSend: true, canManageMessages: false, ownerEditable: false, unreadCount: 0, lastReadSeq: 0 },
      overrides: []
    });
    const detailForManager = await request(managerSession, `/api/channels/${general.id}`);
    expect(detailForManager.status).toBe(200);
    expect(await detailForManager.json()).toMatchObject({ channel: { id: general.id, ownerEditable: true }, overrides: [] });

    const denyEveryoneView = await setOverrides(managerSession, general.id, [
      { subject: "role", subjectId: managerRoleId, permission: "VIEW_CHANNEL", effect: "allow" },
      { subject: "everyone", subjectId: null, permission: "VIEW_CHANNEL", effect: "deny" }
    ]);
    expect(denyEveryoneView.status).toBe(204);
    const viewerListHidden = await request(viewerSession, "/api/channels");
    const hiddenList = await viewerListHidden.json() as { channels: ChannelDto[] };
    expect(hiddenList.channels.map((channel) => channel.id)).not.toContain(general.id);
    expect(hiddenList.channels.map((channel) => channel.id)).toContain(announcements.id);
    await expectError(await request(viewerSession, `/api/channels/${general.id}`), 404, "CHANNEL_NOT_FOUND");
    expect((await request(managerSession, `/api/channels/${general.id}`)).status).toBe(200);
    expect((await request(adminSession, `/api/channels/${general.id}`)).status).toBe(200);

    const roleAllow = await setOverrides(managerSession, general.id, [
      { subject: "role", subjectId: readerRoleId, permission: "VIEW_CHANNEL", effect: "allow" }
    ]);
    expect(roleAllow.status).toBe(204);
    expect((await request(roleViewerSession, `/api/channels/${general.id}`)).status).toBe(200);

    const roleUnset = await setOverrides(managerSession, general.id, [
      { subject: "role", subjectId: readerRoleId, permission: "VIEW_CHANNEL", effect: "unset" }
    ]);
    expect(roleUnset.status).toBe(204);
    await expectError(await request(roleViewerSession, `/api/channels/${general.id}`), 404, "CHANNEL_NOT_FOUND");

    const roleAllowAgain = await setOverrides(managerSession, general.id, [
      { subject: "role", subjectId: readerRoleId, permission: "VIEW_CHANNEL", effect: "allow" }
    ]);
    expect(roleAllowAgain.status).toBe(204);
    const memberDeny = await setOverrides(managerSession, general.id, [
      { subject: "member", subjectId: roleViewer.id, permission: "VIEW_CHANNEL", effect: "deny" }
    ]);
    expect(memberDeny.status).toBe(204);
    await expectError(await request(roleViewerSession, `/api/channels/${general.id}`), 404, "CHANNEL_NOT_FOUND");

    const roleDenyMemberAllow = await setOverrides(managerSession, general.id, [
      { subject: "role", subjectId: readerRoleId, permission: "VIEW_CHANNEL", effect: "deny" },
      { subject: "member", subjectId: roleViewer.id, permission: "VIEW_CHANNEL", effect: "allow" }
    ]);
    expect(roleDenyMemberAllow.status).toBe(204);
    expect((await request(roleViewerSession, `/api/channels/${general.id}`)).status).toBe(200);
    const overridesForManager = await request(managerSession, `/api/channels/${general.id}`);
    const overrideList = (await overridesForManager.json() as { overrides: OverrideDto[] }).overrides;
    expect(overrideList).toEqual(expect.arrayContaining([
      expect.objectContaining({ subject: "everyone", subjectId: null, permission: "VIEW_CHANNEL", effect: "deny" }),
      expect.objectContaining({ subject: "role", subjectId: readerRoleId, permission: "VIEW_CHANNEL", effect: "deny" }),
      expect.objectContaining({ subject: "member", subjectId: roleViewer.id, permission: "VIEW_CHANNEL", effect: "allow" })
    ]));
    expect((await request(adminSession, `/api/channels/${general.id}`)).status).toBe(200);
    const overrideListForViewer = await request(roleViewerSession, `/api/channels/${general.id}`);
    expect((await overrideListForViewer.json() as { overrides: OverrideDto[] }).overrides).toEqual([]);

    const unsetInheritance = await setOverrides(managerSession, general.id, [
      { subject: "everyone", subjectId: null, permission: "VIEW_CHANNEL", effect: "unset" },
      { subject: "role", subjectId: managerRoleId, permission: "VIEW_CHANNEL", effect: "unset" },
      { subject: "role", subjectId: readerRoleId, permission: "VIEW_CHANNEL", effect: "unset" },
      { subject: "member", subjectId: roleViewer.id, permission: "VIEW_CHANNEL", effect: "unset" }
    ]);
    expect(unsetInheritance.status).toBe(204);
    expect((await request(viewerSession, `/api/channels/${general.id}`)).status).toBe(200);
    expect((await request(roleViewerSession, `/api/channels/${general.id}`)).status).toBe(200);
    const rowsAfterUnset = await pool.query<{ count: number }>(
      "SELECT ((SELECT count(*) FROM channel_role_overrides WHERE channel_id = $1) + (SELECT count(*) FROM channel_member_overrides WHERE channel_id = $1))::int AS count",
      [general.id]
    );
    expect(rowsAfterUnset.rows[0]?.count).toBe(0);

    const sendDeny = await setOverrides(managerSession, announcements.id, [
      { subject: "everyone", subjectId: null, permission: "SEND_MESSAGES", effect: "deny" }
    ]);
    expect(sendDeny.status).toBe(204);
    const readOnlyDetail = await request(viewerSession, `/api/channels/${announcements.id}`);
    expect(await readOnlyDetail.json()).toMatchObject({ channel: { canView: true, canSend: false } });
    await expectError(await request(viewerSession, `/api/channels/${announcements.id}/messages`, "POST", { message: "blocked" }), 403, "SEND_NOT_ALLOWED");
    await expectError(await request(viewerSession, `/api/channels/${announcements.id}/messages`, "POST", {
      content: "read only",
      clientRequestId: "00000000-0000-4000-8000-000000000001"
    }), 403, "SEND_NOT_ALLOWED");
    const adminReadOnlyDetail = await request(adminSession, `/api/channels/${announcements.id}`);
    expect(adminReadOnlyDetail.status).toBe(200);
    expect(await adminReadOnlyDetail.json()).toMatchObject({ channel: { canView: true, canSend: true } });
    const sendUnset = await setOverrides(managerSession, announcements.id, [
      { subject: "everyone", subjectId: null, permission: "SEND_MESSAGES", effect: "unset" }
    ]);
    expect(sendUnset.status).toBe(204);
    // Unknown request keys are rejected by the strict message input contract.
    await expectError(await request(viewerSession, `/api/channels/${announcements.id}/messages`, "POST", { message: "phase three" }), 400, "INVALID_REQUEST");

    await expectError(await setOverrides(managerSession, announcements.id, [
      { subject: "everyone", subjectId: null, permission: "UNKNOWN", effect: "allow" }
    ]), 400, "INVALID_REQUEST");
    await expectError(await setOverrides(managerSession, announcements.id, [
      { subject: "everyone", subjectId: null, permission: "ADMINISTRATOR", effect: "allow" }
    ]), 403, "FORBIDDEN");

    const beforeReorderResponse = await request(roleViewerSession, "/api/channels");
    expect(beforeReorderResponse.status).toBe(200);
    const beforeReorder = await beforeReorderResponse.json() as { channels: ChannelDto[] };
    const customRoles = await pool.query<{ id: string }>("SELECT id::text AS id FROM roles WHERE system_key IS NULL ORDER BY position ASC, id ASC");
    const roleIds = customRoles.rows.map((row) => row.id).reverse();
    const reordered = await request(adminSession, "/api/roles/order", "PUT", { roleIds });
    expect(reordered.status).toBe(204);
    expect(await reordered.text()).toBe("");
    const afterReorderResponse = await request(roleViewerSession, "/api/channels");
    expect(afterReorderResponse.status).toBe(200);
    const afterReorder = await afterReorderResponse.json() as { channels: ChannelDto[] };
    expect(afterReorder.channels).toEqual(beforeReorder.channels);
  }, 60_000);
}
