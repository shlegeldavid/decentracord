import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const commandTimeoutMs = 180_000;
const inContainer = process.env.MEMBER_ROLES_TEST_IN_CONTAINER === "true";
const baseUrl = process.env.MEMBER_ROLES_TEST_BASE_URL ?? "http://app:3000";
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
  describe("member role assignment integration", () => {
    let fixtureDirectory = "";
    let projectName = "";
    let envFile = "";
    let overrideFile = "";

    function run(args: string[], timeout = commandTimeoutMs) {
      return compose(projectName, envFile, overrideFile, args, timeout);
    }

    beforeAll(() => {
      fixtureDirectory = mkdtempSync(join(tmpdir(), "decentracord-member-roles-"));
      const suffix = randomBytes(6).toString("hex");
      projectName = `decentracord-member-roles-${suffix}`;
      const databaseName = `decentracord_test_${suffix}`;
      const databaseUser = `member_roles_${suffix.slice(0, 10)}`;
      const databasePassword = randomBytes(24).toString("base64url");
      const adminLogin = `roles_admin_${suffix.slice(0, 10)}`;
      const adminPassword = `Roles-admin-${randomBytes(18).toString("base64url")}`;
      const secretFile = join(fixtureDirectory, "db_password");
      envFile = join(fixtureDirectory, "compose.env");
      overrideFile = join(fixtureDirectory, "compose.member-roles.yaml");
      const buildxConfig = join(fixtureDirectory, "buildx");
      mkdirSync(buildxConfig, { mode: 0o700 });
      writeFileSync(secretFile, databasePassword, { mode: 0o600 });
      chmodSync(secretFile, 0o600);
      writeFileSync(envFile, [
        `DB_PASSWORD_SECRET_FILE=${secretFile}`,
        `DB_PASSWORD=${databasePassword}`,
        `DB_NAME=${databaseName}`,
        `DB_USER=${databaseUser}`,
        `MEMBER_ROLES_ADMIN_LOGIN=${adminLogin}`,
        `MEMBER_ROLES_ADMIN_PASSWORD=${adminPassword}`,
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
        `    image: ${JSON.stringify(`decentracord-member-roles-runner:${suffix}`)}`,
        '    entrypoint: ["npm", "run", "test:integration", "--", "tests/integration/member-roles.test.ts"]',
        "    environment:",
        "      NODE_ENV: test",
        "      MEMBER_ROLES_TEST_IN_CONTAINER: \"true\"",
        "      MEMBER_ROLES_TEST_BASE_URL: http://app:3000",
        "      MEMBER_ROLES_ADMIN_LOGIN: ${MEMBER_ROLES_ADMIN_LOGIN}",
        "      MEMBER_ROLES_ADMIN_PASSWORD: ${MEMBER_ROLES_ADMIN_PASSWORD}",
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

    it("runs member role checks against an isolated PostgreSQL database", () => {
      const args = ["run", "--rm", "--no-deps", "-T", "-e", "MEMBER_ROLES_TEST_IN_CONTAINER=true", "test-runner"];
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
    session: HttpSession;
  }

  interface RoleIdentity {
    id: string;
    name: string;
    position: number;
  }

  const ownerCredentials = {
    login: process.env.MEMBER_ROLES_ADMIN_LOGIN ?? "",
    password: process.env.MEMBER_ROLES_ADMIN_PASSWORD ?? ""
  };
  let pool: Pool;
  let ownerSession: HttpSession;
  let ownerId = "";
  let everyoneRoleId = "";
  let managerRole: RoleIdentity;
  let lowerRole: RoleIdentity;
  let equalRole: RoleIdentity;
  let higherRole: RoleIdentity;
  let wideRole: RoleIdentity;
  let administratorRole: RoleIdentity;

  async function request(
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
    const options: RequestInit = { method, headers, signal: AbortSignal.timeout(15_000) };
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
    const loginResponse = await request(session, "/api/auth/login", "POST", credentials);
    expect(loginResponse.status).toBe(200);
    const loginBody = await loginResponse.json() as { csrfToken?: unknown };
    expect(typeof loginBody.csrfToken).toBe("string");
    session.csrfToken = loginBody.csrfToken as string;
    return session;
  }

  async function createMember(session: HttpSession, loginValue: string, roleIds?: string[]): Promise<{ response: Response; member?: MemberIdentity; responseKeys?: string[] }> {
    const password = `Issued-member-${randomBytes(16).toString("base64url")}`;
    const body: { login: string; password: string; roleIds?: string[] } = { login: loginValue, password };
    if (roleIds !== undefined) body.roleIds = roleIds;
    const response = await request(session, "/api/members", "POST", body);
    if (response.status !== 201) return { response };
    const created = await response.json() as { id: string; login: string };
    return {
      response,
      member: { id: created.id, login: created.login, password, session: {} },
      responseKeys: Object.keys(created).sort()
    };
  }

  async function createRole(
    suffix: string,
    key: string,
    position: number,
    permissions: string[]
  ): Promise<RoleIdentity> {
    const name = `${key}-${suffix}`;
    const result = await pool.query<{ id: string }>(
      "INSERT INTO roles (name, position, permissions) VALUES ($1, $2, $3::jsonb) RETURNING id",
      [name, position, JSON.stringify(permissions)]
    );
    const id = result.rows[0]?.id;
    if (!id) throw new Error("Test role was not created");
    return { id, name, position };
  }

  async function expectError(response: Response, status: number, code: string): Promise<void> {
    expect(response.status).toBe(status);
    expect(await response.text()).toContain(code);
  }

  async function roleAssignments(userId: string): Promise<Array<{ system_key: string | null; id: string; name: string; position: number }>> {
    const result = await pool.query<{ system_key: string | null; id: string; name: string; position: number }>(
      `SELECT role.system_key, role.id, role.name, role.position
       FROM user_roles AS assignment JOIN roles AS role ON role.id = assignment.role_id
       WHERE assignment.user_id = $1 ORDER BY role.position, role.id`,
      [userId]
    );
    return result.rows;
  }

  beforeAll(async () => {
    const database = new URL(process.env.TEST_DATABASE_URL ?? "");
    expect(database.hostname).toBe("db");
    expect(database.pathname).toMatch(/^\/decentracord_test/u);
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4, connectionTimeoutMillis: 3_000 });
    ownerSession = await login(ownerCredentials);
    const owner = await pool.query<{ id: string }>(
      "SELECT id FROM users WHERE login_normalized = $1 AND is_owner = true",
      [ownerCredentials.login]
    );
    ownerId = owner.rows[0]?.id ?? "";
    expect(ownerId).not.toBe("");
    const everyone = await pool.query<{ id: string }>("SELECT id FROM roles WHERE system_key = 'everyone'");
    everyoneRoleId = everyone.rows[0]?.id ?? "";
    expect(everyoneRoleId).not.toBe("");

    const suffix = randomBytes(5).toString("hex");
    managerRole = await createRole(suffix, "manager", 20, ["MANAGE_ROLES", "VIEW_CHANNEL"]);
    lowerRole = await createRole(suffix, "lower", 10, ["VIEW_CHANNEL"]);
    equalRole = await createRole(suffix, "equal", 20, ["VIEW_CHANNEL"]);
    higherRole = await createRole(suffix, "higher", 30, ["VIEW_CHANNEL"]);
    wideRole = await createRole(suffix, "wide", 5, ["MANAGE_ROLES", "MANAGE_CHANNELS"]);
    administratorRole = await createRole(suffix, "administrator", 5, ["ADMINISTRATOR"]);
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
  });

  it("creates members with roles and enforces hierarchy, owner, and last-administrator rules", async () => {
    const suffix = randomBytes(5).toString("hex");
    const direct = await createMember(ownerSession, `direct_${suffix}`, [everyoneRoleId, lowerRole.id]);
    expect(direct.response.status).toBe(201);
    const directMember = direct.member;
    if (!directMember) throw new Error("Member was not returned");
    expect(direct.responseKeys).toEqual(["active", "id", "login"]);
    const directAssignments = await roleAssignments(directMember.id);
    expect(directAssignments.map((role) => role.system_key)).toEqual(["everyone", null]);

    await expectError(await request(ownerSession, "/api/members", "POST", {
      login: `bad_role_${suffix}`,
      password: `Issued-member-${randomBytes(16).toString("base64url")}`,
      roleIds: ["not-a-uuid"]
    }), 400, "INVALID_REQUEST");
    await expectError(await request(ownerSession, "/api/members", "POST", {
      login: `missing_role_${suffix}`,
      password: `Issued-member-${randomBytes(16).toString("base64url")}`,
      roleIds: ["00000000-0000-4000-8000-000000000001"]
    }), 404, "ROLE_NOT_FOUND");

    const managerResult = await createMember(ownerSession, `manager_${suffix}`, [managerRole.id]);
    expect(managerResult.response.status).toBe(201);
    const manager = managerResult.member;
    if (!manager) throw new Error("Manager member was not returned");
    manager.session = await login({ login: manager.login, password: manager.password });

    const lowerTargetResult = await createMember(ownerSession, `lower_target_${suffix}`, [lowerRole.id]);
    const equalTargetResult = await createMember(ownerSession, `equal_target_${suffix}`, [equalRole.id]);
    const higherTargetResult = await createMember(ownerSession, `higher_target_${suffix}`, [higherRole.id]);
    for (const result of [lowerTargetResult, equalTargetResult, higherTargetResult]) {
      expect(result.response.status).toBe(201);
    }
    const lowerTarget = lowerTargetResult.member;
    const equalTarget = equalTargetResult.member;
    const higherTarget = higherTargetResult.member;
    if (!lowerTarget || !equalTarget || !higherTarget) throw new Error("Target members were not returned");

    const managerCreate = await createMember(manager.session, `created_by_manager_${suffix}`, [lowerRole.id]);
    expect(managerCreate.response.status).toBe(201);
    await expectError((await createMember(manager.session, `wide_by_manager_${suffix}`, [wideRole.id])).response, 403, "MISSING_PERMISSION");
    await expectError((await createMember(manager.session, `admin_by_manager_${suffix}`, [administratorRole.id])).response, 403, "FORBIDDEN");

    const listResponse = await request(manager.session, "/api/members");
    expect(listResponse.status).toBe(200);
    const list = await listResponse.json() as { members: Array<{ id: string; login: string; active: boolean; roleIds: string[]; roleNames: string[] }> };
    const listedLower = list.members.find((member) => member.id === lowerTarget.id);
    expect(listedLower).toEqual({
      id: lowerTarget.id,
      login: lowerTarget.login,
      active: true,
      roleIds: [lowerRole.id],
      roleNames: [lowerRole.name]
    });
    directMember.session = await login({ login: directMember.login, password: directMember.password });
    expect((await request(directMember.session, "/api/members")).status).toBe(403);

    const replaceWithEveryoneAndLower = await request(manager.session, `/api/members/${lowerTarget.id}/roles`, "PATCH", {
      roleIds: [everyoneRoleId, lowerRole.id]
    });
    expect(replaceWithEveryoneAndLower.status).toBe(204);
    expect((await roleAssignments(lowerTarget.id)).map((role) => role.system_key)).toEqual(["everyone", null]);
    expect((await request(manager.session, `/api/members/${lowerTarget.id}/roles`, "PATCH", { roleIds: [] })).status).toBe(204);
    expect((await roleAssignments(lowerTarget.id)).map((role) => role.system_key)).toEqual(["everyone"]);
    await expectError(await request(manager.session, `/api/members/${lowerTarget.id}/roles`, "PATCH", { roleIds: [equalRole.id] }), 403, "HIERARCHY");
    await expectError(await request(manager.session, `/api/members/${lowerTarget.id}/roles`, "PATCH", { roleIds: [higherRole.id] }), 403, "HIERARCHY");
    await expectError(await request(manager.session, `/api/members/${lowerTarget.id}/roles`, "PATCH", { roleIds: [wideRole.id] }), 403, "MISSING_PERMISSION");
    await expectError(await request(manager.session, `/api/members/${lowerTarget.id}/roles`, "PATCH", { roleIds: [administratorRole.id] }), 403, "FORBIDDEN");
    await expectError(await request(manager.session, `/api/members/${equalTarget.id}/roles`, "PATCH", { roleIds: [] }), 403, "HIERARCHY");
    await expectError(await request(manager.session, `/api/members/${higherTarget.id}/roles`, "PATCH", { roleIds: [] }), 403, "HIERARCHY");
    await expectError(await request(manager.session, `/api/members/${manager.id}/roles`, "PATCH", { roleIds: [] }), 403, "HIERARCHY");
    await expectError(await request(manager.session, "/api/members/not-a-uuid/roles", "PATCH", { roleIds: [] }), 400, "INVALID_REQUEST");
    await expectError(await request(manager.session, "/api/members/00000000-0000-4000-8000-000000000002/roles", "PATCH", { roleIds: [] }), 404, "MEMBER_NOT_FOUND");
    await expectError(await request(manager.session, `/api/members/${lowerTarget.id}/roles`, "PATCH", { roleIds: ["bad-id"] }), 400, "INVALID_REQUEST");

    const delegatedAdminResult = await createMember(ownerSession, `delegated_admin_${suffix}`, [administratorRole.id]);
    expect(delegatedAdminResult.response.status).toBe(201);
    const delegatedAdmin = delegatedAdminResult.member;
    if (!delegatedAdmin) throw new Error("Administrator member was not returned");
    delegatedAdmin.session = await login({ login: delegatedAdmin.login, password: delegatedAdmin.password });
    await expectError(await request(delegatedAdmin.session, `/api/members/${ownerId}/roles`, "PATCH", { roleIds: [] }), 403, "FORBIDDEN");
    await expectError(await request(delegatedAdmin.session, `/api/members/${ownerId}/disable`, "POST"), 403, "FORBIDDEN");

    const lastAdminResult = await createMember(ownerSession, `last_admin_${suffix}`, [administratorRole.id]);
    expect(lastAdminResult.response.status).toBe(201);
    const lastAdmin = lastAdminResult.member;
    if (!lastAdmin) throw new Error("Last administrator member was not returned");
    expect((await request(ownerSession, `/api/members/${delegatedAdmin.id}/roles`, "PATCH", { roleIds: [] })).status).toBe(204);

    await pool.query("UPDATE users SET is_owner = false WHERE id = $1", [ownerId]);
    await pool.query(
      "DELETE FROM user_roles WHERE user_id = $1 AND role_id = (SELECT id FROM roles WHERE system_key = 'administrator')",
      [ownerId]
    );
    await expectError(await request(manager.session, `/api/members/${lastAdmin.id}/roles`, "PATCH", { roleIds: [] }), 409, "LAST_ADMINISTRATOR");
  }, 90_000);
}
