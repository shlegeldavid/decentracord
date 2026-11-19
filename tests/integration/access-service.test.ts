import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HttpException } from "@nestjs/common";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AccessService, findUserChannelAccessChanges } from "../../apps/server/src/access/access.service.js";
import { assertCanEditRolePermissions } from "../../apps/server/src/access/hierarchy.service.js";
import { PERMISSIONS, type Permission } from "../../apps/server/src/access/permissions.js";
import type { AuthPrincipal } from "../../apps/server/src/auth/session.service.js";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const commandTimeoutMs = 180_000;
const inContainer = process.env.ACCESS_SERVICE_TEST_IN_CONTAINER === "true";
const baseUrl = process.env.ACCESS_SERVICE_TEST_BASE_URL ?? "http://app:3000";
const appOrigin = new URL(baseUrl).origin;

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
  describe("AccessService isolated PostgreSQL integration", () => {
    let fixtureDirectory = "";
    let projectName = "";
    let envFile = "";
    let overrideFile = "";

    function run(args: string[], timeout = commandTimeoutMs) {
      return compose(projectName, envFile, overrideFile, args, timeout);
    }

    beforeAll(() => {
      fixtureDirectory = mkdtempSync(join(tmpdir(), "decentracord-access-service-"));
      const suffix = randomBytes(6).toString("hex");
      projectName = `decentracord-access-service-${suffix}`;
      const databaseName = `decentracord_test_${suffix}`;
      const databaseUser = `access_service_${suffix.slice(0, 10)}`;
      const databasePassword = randomBytes(24).toString("base64url");
      const adminLogin = `access_admin_${suffix.slice(0, 10)}`;
      const adminPassword = `Access-admin-${randomBytes(18).toString("base64url")}`;
      const secretFile = join(fixtureDirectory, "db_password");
      envFile = join(fixtureDirectory, "compose.env");
      overrideFile = join(fixtureDirectory, "compose.access-service.yaml");
      const buildxConfig = join(fixtureDirectory, "buildx");
      mkdirSync(buildxConfig, { mode: 0o700 });
      writeFileSync(secretFile, databasePassword, { mode: 0o600 });
      chmodSync(secretFile, 0o600);
      writeFileSync(
        envFile,
        [
          `DB_PASSWORD_SECRET_FILE=${secretFile}`,
          `DB_NAME=${databaseName}`,
          `DB_USER=${databaseUser}`,
          `ACCESS_SERVICE_ADMIN_LOGIN=${adminLogin}`,
          `ACCESS_SERVICE_ADMIN_PASSWORD=${adminPassword}`,
          "DB_CONNECT_TIMEOUT_MS=2500",
          ""
        ].join("\n"),
        { mode: 0o600 }
      );
      chmodSync(envFile, 0o600);
      writeFileSync(
        overrideFile,
        [
          "services:",
          "  app:",
          '    entrypoint: ["node", "apps/server/dist/main.js"]',
          "    command: []",
          "    environment:",
          "      APP_HOST: 0.0.0.0",
          "      APP_PORT: 3000",
          "      NODE_ENV: test",
          "    healthcheck:",
          '      test: ["CMD", "node", "-e", "fetch(\'http://127.0.0.1:3000/healthz\').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]',
          "      interval: 2s",
          "      timeout: 2s",
          "      retries: 30",
          "      start_period: 3s",
          "  test-runner:",
          "    build:",
          `      context: ${JSON.stringify(projectRoot)}`,
          "      dockerfile: Dockerfile",
          "      target: test-runner",
          `    image: ${JSON.stringify(`decentracord-access-service-runner:${suffix}`)}`,
          '    entrypoint: ["npm", "run", "test:integration", "--", "tests/integration/access-service.test.ts"]',
          "    environment:",
          "      ACCESS_SERVICE_TEST_IN_CONTAINER: \"true\"",
          "      ACCESS_SERVICE_TEST_BASE_URL: http://app:3000",
          "      ACCESS_SERVICE_ADMIN_LOGIN: ${ACCESS_SERVICE_ADMIN_LOGIN}",
          "      ACCESS_SERVICE_ADMIN_PASSWORD: ${ACCESS_SERVICE_ADMIN_PASSWORD}",
          `      TEST_DATABASE_URL: postgresql://${databaseUser}:${databasePassword}@db:5432/${databaseName}`,
          "    networks:",
          "      - backend",
          "    depends_on:",
          "      app:",
          "        condition: service_healthy",
          ""
        ].join("\n"),
        { mode: 0o600 }
      );
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
      const runnerArgs = ["run", "--rm", "--no-deps", "-T", "-e", "ACCESS_SERVICE_TEST_IN_CONTAINER=true", "test-runner"];
      assertComposeSucceeded(run(runnerArgs, 360_000), runnerArgs);
    }, 660_000);

    afterAll(() => {
      if (!fixtureDirectory) return;
      const downArgs = ["down", "--volumes", "--remove-orphans", "--rmi", "local"];
      const result = run(downArgs, 120_000);
      rmSync(fixtureDirectory, { recursive: true, force: true });
      assertComposeSucceeded(result, downArgs);
    });

    it("runs the isolated PostgreSQL access checks", () => {
      expect(projectName).toContain("decentracord-access-service-");
    });
  }, 660_000);
} else {
  interface HttpSession {
    cookie?: string;
    csrfToken?: string;
  }

  interface TestUser {
    id: string;
    login: string;
    password: string;
    session: HttpSession;
  }

  interface ChannelRow {
    id: string;
  }

  let pool: Pool;
  let access: AccessService;
  let ownerSession: HttpSession;
  let ownerId: string;
  let delegatedAdmin: TestUser;
  let roleManager: TestUser;
  let employee: TestUser;
  let hiddenChannelId: string;
  let visibleChannelId: string;

  async function requestJson(
    session: HttpSession,
    path: string,
    method = "GET",
    body?: unknown
  ): Promise<Response> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (session.cookie) headers.cookie = session.cookie;
    if (method !== "GET") {
      headers.origin = appOrigin;
      if (session.csrfToken) headers["x-csrf-token"] = session.csrfToken;
    }
    if (body !== undefined) headers["content-type"] = "application/json";
    const requestOptions: RequestInit = { method, headers, signal: AbortSignal.timeout(10_000) };
    if (body !== undefined) requestOptions.body = JSON.stringify(body);
    const response = await fetch(new URL(path, baseUrl), requestOptions);
    const cookieHeader = response.headers.get("set-cookie");
    const sessionCookie = cookieHeader?.split(";", 1)[0];
    if (sessionCookie) session.cookie = sessionCookie;
    return response;
  }

  async function signIn(session: HttpSession, credentials: { login: string; password: string }): Promise<void> {
    const csrfResponse = await requestJson(session, "/api/auth/csrf");
    expect(csrfResponse.status).toBe(200);
    const csrfBody = await csrfResponse.json() as { csrfToken?: unknown };
    expect(typeof csrfBody.csrfToken).toBe("string");
    session.csrfToken = csrfBody.csrfToken as string;
    const loginResponse = await requestJson(session, "/api/auth/login", "POST", credentials);
    expect(loginResponse.status).toBe(200);
    const loginBody = await loginResponse.json() as { csrfToken?: unknown };
    expect(typeof loginBody.csrfToken).toBe("string");
    session.csrfToken = loginBody.csrfToken as string;
  }

  async function createMember(session: HttpSession, login: string, password: string): Promise<TestUser> {
    const response = await requestJson(session, "/api/members", "POST", { login, password });
    expect(response.status).toBe(201);
    const body = await response.json() as { id?: unknown; login?: unknown };
    expect(typeof body.id).toBe("string");
    expect(body.login).toBe(login);
    return { id: body.id as string, login, password, session: {} };
  }

  function principal(userId: string): AuthPrincipal {
    return { userId, sessionId: "access-service-test", authVersion: 0 };
  }

  async function expectHttpError(action: () => unknown | Promise<unknown>, status: number, code: string): Promise<void> {
    let thrown: unknown;
    try {
      await action();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HttpException);
    if (!(thrown instanceof HttpException)) return;
    expect(thrown.getStatus()).toBe(status);
    expect(thrown.getResponse()).toMatchObject({ code });
  }

  beforeAll(async () => {
    const database = new URL(process.env.TEST_DATABASE_URL ?? "");
    expect(database.hostname).toBe("db");
    expect(database.pathname).toMatch(/^\/decentracord_test/u);
    expect(new URL(baseUrl).hostname).toBe("app");
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4, connectionTimeoutMillis: 3_000 });
    access = new AccessService(pool);
    ownerSession = {};
    await signIn(ownerSession, {
      login: process.env.ACCESS_SERVICE_ADMIN_LOGIN ?? "",
      password: process.env.ACCESS_SERVICE_ADMIN_PASSWORD ?? ""
    });
    const owner = await pool.query<{ id: string }>(
      "SELECT id FROM users WHERE login_normalized = $1 AND is_owner = true",
      [process.env.ACCESS_SERVICE_ADMIN_LOGIN]
    );
    ownerId = owner.rows[0]?.id ?? "";
    expect(ownerId).not.toBe("");

    const suffix = randomBytes(5).toString("hex");
    const roleAdmin = await pool.query<{ id: string }>(
      "INSERT INTO roles (name, position, permissions) VALUES ($1, $2, $3::jsonb) RETURNING id",
      [`delegated-admin-${suffix}`, 30, JSON.stringify(["ADMINISTRATOR"])]
    );
    const roleManage = await pool.query<{ id: string }>(
      "INSERT INTO roles (name, position, permissions) VALUES ($1, $2, $3::jsonb) RETURNING id",
      [`role-manager-${suffix}`, 20, JSON.stringify(["MANAGE_ROLES"])]
    );
    const adminPassword = `Access-delegate-${randomBytes(16).toString("base64url")}`;
    const managerPassword = `Role-manager-${randomBytes(16).toString("base64url")}`;
    const employeePassword = `Regular-member-${randomBytes(16).toString("base64url")}`;
    delegatedAdmin = await createMember(ownerSession, `delegated_${suffix}`, adminPassword);
    roleManager = await createMember(ownerSession, `manager_${suffix}`, managerPassword);
    employee = await createMember(ownerSession, `employee_${suffix}`, employeePassword);
    await pool.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2), ($3, $4)", [
      delegatedAdmin.id,
      roleAdmin.rows[0]?.id,
      roleManager.id,
      roleManage.rows[0]?.id
    ]);

    const administrator = await pool.query<{ id: string }>("SELECT id FROM roles WHERE system_key = 'administrator'");
    await pool.query("DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2", [ownerId, administrator.rows[0]?.id]);

    await signIn(delegatedAdmin.session, { login: delegatedAdmin.login, password: delegatedAdmin.password });
    await signIn(roleManager.session, { login: roleManager.login, password: roleManager.password });
    await signIn(employee.session, { login: employee.login, password: employee.password });

    const everyone = await pool.query<{ id: string }>("SELECT id FROM roles WHERE system_key = 'everyone'");
    const hidden = await pool.query<ChannelRow>("INSERT INTO channels (name) VALUES ($1) RETURNING id", [`hidden-${suffix}`]);
    const visible = await pool.query<ChannelRow>("INSERT INTO channels (name) VALUES ($1) RETURNING id", [`visible-${suffix}`]);
    hiddenChannelId = hidden.rows[0]?.id ?? "";
    visibleChannelId = visible.rows[0]?.id ?? "";
    await pool.query(
      "INSERT INTO channel_role_overrides (channel_id, role_id, permission, effect) VALUES ($1, $2, 'VIEW_CHANNEL', 'deny'), ($3, $2, 'VIEW_CHANNEL', 'allow')",
      [hiddenChannelId, everyone.rows[0]?.id, visibleChannelId]
    );
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
  });

  it("uses effective permissions for administrators and installation owners", async () => {
    const ownerPermissions = await access.effectivePermissions(ownerId);
    expect(ownerPermissions).toEqual(new Set<Permission>(PERMISSIONS));
    await expect(access.requireOwner(principal(ownerId))).resolves.toBeUndefined();
    await expect(access.requirePermission(principal(ownerId), "MANAGE_ROLES")).resolves.toBeUndefined();
    expect((await access.currentUserAccess(ownerId))?.isOwner).toBe(true);

    const delegatedPermissions = await access.effectivePermissions(delegatedAdmin.id);
    expect(delegatedPermissions).toEqual(new Set<Permission>(PERMISSIONS));
    await expect(access.requirePermission(principal(delegatedAdmin.id), "MANAGE_ROLES")).resolves.toBeUndefined();
    expect((await access.currentUserAccess(delegatedAdmin.id))?.isOwner).toBe(false);
    expect((await requestJson(delegatedAdmin.session, "/api/members")).status).toBe(200);

    await expectHttpError(
      () => access.requirePermission(principal(employee.id), "ADMINISTRATOR"),
      403,
      "FORBIDDEN"
    );
    await expectHttpError(() => access.requireOwner(principal(delegatedAdmin.id)), 403, "FORBIDDEN");
    expect((await requestJson(employee.session, "/api/members")).status).toBe(403);
  });

  it("uses the highest assigned role and rejects equal or higher targets", async () => {
    const actorHighest = await access.highestRoleOf(roleManager.id);
    expect(actorHighest).toBe(20);
    const managerPermissions = await access.effectivePermissions(roleManager.id);
    for (const targetPosition of [20, 21]) {
      await expectHttpError(() => assertCanEditRolePermissions({
        actorPermissions: managerPermissions,
        actorHighest,
        targetPosition,
        requested: ["MANAGE_ROLES"]
      }), 403, "HIERARCHY");
    }
  });

  it("hides channels without VIEW_CHANNEL and preserves 403 for visible missing permissions", async () => {
    await expectHttpError(
      () => access.requireChannelPermission(principal(employee.id), hiddenChannelId, "VIEW_CHANNEL"),
      404,
      "CHANNEL_NOT_FOUND"
    );
    await expectHttpError(
      () => access.requireChannelPermission(principal(employee.id), "00000000-0000-4000-8000-000000000000", "VIEW_CHANNEL"),
      404,
      "CHANNEL_NOT_FOUND"
    );
    await expectHttpError(
      () => access.requireChannelPermission(principal(roleManager.id), visibleChannelId, "SEND_MESSAGES"),
      403,
      "FORBIDDEN"
    );
    await expect(access.canReceiveChannelEvent(employee.id, hiddenChannelId, "message:new")).resolves.toBe(false);
    await expect(access.canReceiveChannelEvent(delegatedAdmin.id, hiddenChannelId, "message:new")).resolves.toBe(true);
    await expect(access.canReceiveChannelEvent(ownerId, hiddenChannelId, "message:new")).resolves.toBe(true);
  });

  it("reports message management in channel permissions and visible channel rows", async () => {
    await expect(access.hasChannelPermission(principal(delegatedAdmin.id), visibleChannelId, "MANAGE_MESSAGES")).resolves.toBe(true);
    await expect(access.hasChannelPermission(principal(employee.id), visibleChannelId, "MANAGE_MESSAGES")).resolves.toBe(false);
    await expect(access.hasChannelPermission(principal(employee.id), hiddenChannelId, "MANAGE_MESSAGES")).resolves.toBe(false);

    const adminChannel = (await access.listVisibleChannels(principal(delegatedAdmin.id)))
      .find((channel) => channel.id === visibleChannelId);
    const employeeChannel = (await access.listVisibleChannels(principal(employee.id)))
      .find((channel) => channel.id === visibleChannelId);
    expect(adminChannel?.canManageMessages).toBe(true);
    expect(employeeChannel?.canManageMessages).toBe(false);
  });

  it("lists active channel members with VIEW_CHANNEL and hides other users", async () => {
    const inactiveLogin = `inactive_${randomBytes(5).toString("hex")}`;
    const inactive = await pool.query<{ id: string }>(
      "INSERT INTO users (login, login_normalized, password_hash, active) VALUES ($1, $2, 'unused', false) RETURNING id::text AS id",
      [inactiveLogin, inactiveLogin]
    );

    const visibleMembers = await access.listChannelMembers(visibleChannelId);
    const visibleMemberIds = new Set(visibleMembers.map((member) => member.id));
    expect(visibleMemberIds.has(employee.id)).toBe(true);
    expect(visibleMemberIds.has(inactive.rows[0]!.id)).toBe(false);
    expect(visibleMembers.every((member) => typeof member.id === "string")).toBe(true);

    const hiddenMembers = await access.listChannelMembers(hiddenChannelId);
    const hiddenMemberIds = new Set(hiddenMembers.map((member) => member.id));
    expect(hiddenMemberIds.has(ownerId)).toBe(true);
    expect(hiddenMemberIds.has(delegatedAdmin.id)).toBe(true);
    expect(hiddenMemberIds.has(employee.id)).toBe(false);
    expect(hiddenMembers.some((member) => member.login === employee.login)).toBe(false);
  });

  it("detects channel management permission changes for channel sync", async () => {
    const before = await access.listVisibleChannels(principal(roleManager.id));
    const role = await pool.query<{ id: string }>(
      `SELECT role.id::text AS id
       FROM user_roles AS assignment
       JOIN roles AS role ON role.id = assignment.role_id
       WHERE assignment.user_id = $1 AND role.system_key IS DISTINCT FROM 'everyone'
       ORDER BY role.id
       LIMIT 1`,
      [roleManager.id]
    );
    await pool.query("UPDATE roles SET permissions = $2::jsonb WHERE id = $1", [
      role.rows[0]!.id,
      JSON.stringify(["MANAGE_ROLES", "MANAGE_MESSAGES"])
    ]);
    const after = await access.listVisibleChannels(principal(roleManager.id));

    expect(before.find((channel) => channel.id === visibleChannelId)?.canManageMessages).toBe(false);
    expect(after.find((channel) => channel.id === visibleChannelId)?.canManageMessages).toBe(true);
    expect(findUserChannelAccessChanges(
      new Map([[roleManager.id, before]]),
      new Map([[roleManager.id, after]])
    )).toEqual([{ userId: roleManager.id, revokedChannelIds: [] }]);
  });
}
