import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AccessService } from "../../apps/server/src/access/access.service.js";
import { PasswordService } from "../../apps/server/src/auth/password.service.js";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const commandTimeoutMs = 180_000;
const inContainer = process.env.ROLE_MANAGEMENT_TEST_IN_CONTAINER === "true";

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
  describe("role management API integration", () => {
    let fixtureDirectory = "";
    let projectName = "";
    let envFile = "";
    let overrideFile = "";

    function run(args: string[], timeout = commandTimeoutMs) {
      return compose(projectName, envFile, overrideFile, args, timeout);
    }

    beforeAll(() => {
      fixtureDirectory = mkdtempSync(join(tmpdir(), "decentracord-role-management-"));
      const suffix = randomBytes(6).toString("hex");
      projectName = `decentracord-role-management-${suffix}`;
      const databaseName = `decentracord_test_${suffix}`;
      const databaseUser = `role_test_${suffix.slice(0, 10)}`;
      const databasePassword = randomBytes(24).toString("base64url");
      const adminLogin = `role_admin_${suffix.slice(0, 10)}`;
      const adminPassword = `Role-admin-${randomBytes(18).toString("base64url")}`;
      const secretFile = join(fixtureDirectory, "db_password");
      envFile = join(fixtureDirectory, "compose.env");
      overrideFile = join(fixtureDirectory, "compose.role-management.yaml");
      const buildxConfig = join(fixtureDirectory, "buildx");
      mkdirSync(buildxConfig, { mode: 0o700 });
      writeFileSync(secretFile, databasePassword, { mode: 0o600 });
      chmodSync(secretFile, 0o600);
      writeFileSync(envFile, [
        `DB_PASSWORD_SECRET_FILE=${secretFile}`,
        `DB_PASSWORD=${databasePassword}`,
        `DB_NAME=${databaseName}`,
        `DB_USER=${databaseUser}`,
        `ROLE_MANAGEMENT_ADMIN_LOGIN=${adminLogin}`,
        `ROLE_MANAGEMENT_ADMIN_PASSWORD=${adminPassword}`,
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
        `    image: ${JSON.stringify(`decentracord-role-management-runner:${suffix}`)}`,
        '    entrypoint: ["npm", "run", "test:integration", "--", "tests/integration/role-management.test.ts"]',
        "    environment:",
        "      ROLE_MANAGEMENT_TEST_IN_CONTAINER: \"true\"",
        "      ROLE_MANAGEMENT_TEST_BASE_URL: http://app:3000",
        "      ROLE_MANAGEMENT_ADMIN_LOGIN: ${ROLE_MANAGEMENT_ADMIN_LOGIN}",
        "      ROLE_MANAGEMENT_ADMIN_PASSWORD: ${ROLE_MANAGEMENT_ADMIN_PASSWORD}",
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

    it("runs role authorization and hierarchy checks against PostgreSQL", () => {
      expect(projectName).toContain("decentracord-role-management-");
    });
  }, 900_000);
} else {
  interface HttpSession {
    cookie?: string;
    csrfToken?: string;
  }

  interface RoleDto {
    id: string;
    name: string;
    position: number;
    permissions: string[];
    systemKey: string | null;
    ownerEditable: boolean;
    color?: string | null;
    editable?: boolean;
  }

  interface TestUser {
    id: string;
    login: string;
    password: string;
  }

  const baseUrl = process.env.ROLE_MANAGEMENT_TEST_BASE_URL ?? "http://app:3000";
  const appOrigin = new URL(baseUrl).origin;
  let pool: Pool;
  let adminSession: HttpSession;
  let managerSession: HttpSession;
  let viewerSession: HttpSession;
  let ownerId = "";
  let manager: TestUser;
  let viewer: TestUser;
  let candidateAdmin: TestUser;
  let lowerRole: RoleDto;
  let candidateAdminRole: RoleDto;
  let managerRole: RoleDto;
  let higherRole: RoleDto;
  let createdRole: RoleDto;

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
    expect(response.status).toBe(200);
    const body = await response.json() as { csrfToken?: unknown };
    expect(typeof body.csrfToken).toBe("string");
    session.csrfToken = body.csrfToken as string;
    return session;
  }

  async function createUser(loginValue: string, everyoneRoleId: string): Promise<TestUser> {
    const password = `Role-member-${randomBytes(16).toString("base64url")}`;
    const passwordHash = await new PasswordService().hash(password);
    const result = await pool.query<{ id: string }>(
      "INSERT INTO users (login, login_normalized, password_hash) VALUES ($1, $1, $2) RETURNING id",
      [loginValue, passwordHash]
    );
    const id = result.rows[0]?.id;
    if (!id) throw new Error("Test user was not created");
    await pool.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)", [id, everyoneRoleId]);
    return { id, login: loginValue, password };
  }

  async function createStoredRole(name: string, position: number, permissions: string[]): Promise<RoleDto> {
    const result = await pool.query<{ id: string; name: string; position: number; permissions: string[]; system_key: null }>(
      "INSERT INTO roles (system_key, name, position, permissions) VALUES (NULL, $1, $2, $3::jsonb) RETURNING id, name, position, permissions, system_key",
      [name, position, JSON.stringify(permissions)]
    );
    const row = result.rows[0];
    if (!row) throw new Error("Test role was not created");
    return { id: row.id, name: row.name, position: row.position, permissions: row.permissions, systemKey: null, ownerEditable: false };
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
      login: process.env.ROLE_MANAGEMENT_ADMIN_LOGIN ?? "",
      password: process.env.ROLE_MANAGEMENT_ADMIN_PASSWORD ?? ""
    });
    const owner = await request(adminSession, "/api/auth/me");
    expect(owner.status).toBe(200);
    ownerId = ((await owner.json()) as { id: string }).id;

    const systemRoles = await pool.query<{ id: string }>("SELECT id FROM roles WHERE system_key = 'everyone'");
    const everyoneRoleId = systemRoles.rows[0]?.id;
    if (!everyoneRoleId) throw new Error("@everyone role is missing");
    const suffix = randomBytes(5).toString("hex");
    manager = await createUser(`role_manager_${suffix}`, everyoneRoleId);
    viewer = await createUser(`role_viewer_${suffix}`, everyoneRoleId);
    candidateAdmin = await createUser(`role_admin_${suffix}`, everyoneRoleId);

    lowerRole = await createStoredRole(`Role Lower ${suffix}`, 1, ["VIEW_CHANNEL"]);
    candidateAdminRole = await createStoredRole(`Role Admin Candidate ${suffix}`, 2, ["ADMINISTRATOR"]);
    managerRole = await createStoredRole(`Role Manager ${suffix}`, 3, ["MANAGE_ROLES", "VIEW_CHANNEL"]);
    higherRole = await createStoredRole(`Role Higher ${suffix}`, 4, ["SEND_MESSAGES"]);
    await pool.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2), ($3, $4)", [
      manager.id,
      managerRole.id,
      candidateAdmin.id,
      candidateAdminRole.id
    ]);
    managerSession = await login(manager);
    viewerSession = await login(viewer);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
  });

  it("lists roles only for managers and returns the canonical ownerEditable shape", async () => {
    const response = await request(adminSession, "/api/roles");
    expect(response.status).toBe(200);
    const body = await response.json() as { roles: RoleDto[] };
    expect(Array.isArray(body.roles)).toBe(true);
    expect(body.roles.length).toBeGreaterThanOrEqual(4);
    for (const role of body.roles) {
      expect(Object.keys(role).sort()).toEqual([
        "color", "editable", "id", "name", "ownerEditable", "permissions", "position", "systemKey"
      ]);
    }
    expect(body.roles.find((role) => role.systemKey === "everyone")).toMatchObject({
      ownerEditable: true, editable: false, color: null, position: 0
    });
    expect(body.roles.find((role) => role.systemKey === "administrator")).toMatchObject({
      ownerEditable: true, editable: false, color: null, position: 1_000_000
    });
    expect(body.roles.find((role) => role.id === lowerRole.id)).toMatchObject({
      ownerEditable: false, editable: true, color: null, systemKey: null
    });

    const managerResponse = await request(managerSession, "/api/roles");
    expect(managerResponse.status).toBe(200);
    const managerRoles = (await managerResponse.json() as { roles: RoleDto[] }).roles;
    expect(managerRoles.find((role) => role.id === lowerRole.id)?.editable).toBe(true);
    expect(managerRoles.find((role) => role.id === higherRole.id)?.editable).toBe(false);
    await expectError(await request(viewerSession, "/api/roles"), 403, "FORBIDDEN");
  });

  it("creates arbitrary roles, rejects case-insensitive duplicates, and updates the role", async () => {
    const response = await request(adminSession, "/api/roles", "POST", {
      name: "  Arbitrary Coordinator  ",
      permissions: ["SEND_MESSAGES"]
    });
    expect(response.status, await response.clone().text()).toBe(201);
    createdRole = await response.json() as RoleDto;
    expect(createdRole).toMatchObject({ name: "Arbitrary Coordinator", systemKey: null, ownerEditable: false, permissions: ["SEND_MESSAGES"] });

    await expectError(await request(adminSession, "/api/roles", "POST", {
      name: "arbitrary coordinator",
      permissions: []
    }), 409, "ROLE_ALREADY_EXISTS");
    await expectError(await request(adminSession, "/api/roles", "POST", {
      name: "Invalid Permission",
      permissions: ["NOT_A_PERMISSION"]
    }), 400, "INVALID_REQUEST");

    const update = await request(adminSession, `/api/roles/${createdRole.id}`, "PATCH", {
      name: "Coordinator Renamed",
      permissions: ["VIEW_CHANNEL", "SEND_MESSAGES"]
    });
    expect(update.status).toBe(200);
    const updated = await update.json() as RoleDto;
    expect(updated).toMatchObject({ id: createdRole.id, name: "Coordinator Renamed", permissions: ["VIEW_CHANNEL", "SEND_MESSAGES"] });
    createdRole = updated;
  });

  it("enforces delegated permission subsets, hierarchy, and owner-only administrator rights", async () => {
    const delegatedUpdate = await request(managerSession, `/api/roles/${lowerRole.id}`, "PATCH", {
      name: "Delegated Lower Role",
      permissions: ["VIEW_CHANNEL"]
    });
    expect(delegatedUpdate.status).toBe(200);

    await expectError(await request(managerSession, `/api/roles/${lowerRole.id}`, "PATCH", {
      permissions: ["SEND_MESSAGES"]
    }), 403, "MISSING_PERMISSION");
    await expectError(await request(managerSession, `/api/roles/${higherRole.id}`, "PATCH", {
      permissions: ["VIEW_CHANNEL"]
    }), 403, "HIERARCHY");
    await expectError(await request(managerSession, "/api/roles", "POST", {
      name: "Delegate Cannot Escalate",
      permissions: ["SEND_MESSAGES"]
    }), 403, "MISSING_PERMISSION");
    await expectError(await request(managerSession, "/api/roles", "POST", {
      name: "Delegate Cannot Create Administrator",
      permissions: ["ADMINISTRATOR"]
    }), 403, "FORBIDDEN");
    await expectError(await request(managerSession, `/api/roles/${lowerRole.id}`, "PATCH", {
      permissions: ["ADMINISTRATOR"]
    }), 403, "FORBIDDEN");

    const everyone = await pool.query<{ id: string }>("SELECT id FROM roles WHERE system_key = 'everyone'");
    const administrator = await pool.query<{ id: string }>("SELECT id FROM roles WHERE system_key = 'administrator'");
    await expectError(await request(managerSession, `/api/roles/${everyone.rows[0]!.id}`, "PATCH", {
      permissions: ["VIEW_CHANNEL"]
    }), 403, "FORBIDDEN");
    await expectError(await request(managerSession, `/api/roles/${administrator.rows[0]!.id}`, "PATCH", {
      permissions: ["ADMINISTRATOR"]
    }), 403, "FORBIDDEN");
  });

  it("allows the owner to change system role permissions and restricts administrator delegation", async () => {
    const everyone = await pool.query<{ id: string }>("SELECT id FROM roles WHERE system_key = 'everyone'");
    const administrator = await pool.query<{ id: string }>("SELECT id FROM roles WHERE system_key = 'administrator'");
    const everyoneUpdate = await request(adminSession, `/api/roles/${everyone.rows[0]!.id}`, "PATCH", {
      permissions: ["VIEW_CHANNEL"]
    });
    expect(everyoneUpdate.status).toBe(200);
    const adminUpdate = await request(adminSession, `/api/roles/${administrator.rows[0]!.id}`, "PATCH", {
      permissions: ["ADMINISTRATOR", "MANAGE_ROLES"]
    });
    expect(adminUpdate.status).toBe(200);
  });

  it("reorders only user roles and leaves role and effective permission sets unchanged", async () => {
    const createFirst = await request(adminSession, "/api/roles", "POST", { name: "Order First", permissions: ["VIEW_CHANNEL"] });
    const createSecond = await request(adminSession, "/api/roles", "POST", { name: "Order Second", permissions: ["SEND_MESSAGES"] });
    expect(createFirst.status).toBe(201);
    expect(createSecond.status).toBe(201);
    const first = await createFirst.json() as RoleDto;
    const second = await createSecond.json() as RoleDto;
    await pool.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2), ($1, $3)", [manager.id, first.id, second.id]);
    const access = new AccessService(pool);
    const before = [...await access.effectivePermissions(manager.id)].sort();

    const reordered = await request(adminSession, "/api/roles/order", "PUT", { roleIds: [second.id, first.id] });
    expect(reordered.status).toBe(204);
    expect(await reordered.text()).toBe("");

    const after = [...await access.effectivePermissions(manager.id)].sort();
    expect(after).toEqual(before);
    const list = await request(adminSession, "/api/roles");
    const roles = (await list.json() as { roles: RoleDto[] }).roles;
    expect(roles.find((role) => role.id === second.id)!.position).toBeLessThan(roles.find((role) => role.id === first.id)!.position);
    expect(roles.find((role) => role.systemKey === "everyone")?.position).toBe(0);
    expect(roles.find((role) => role.systemKey === "administrator")?.position).toBe(1_000_000);
  });

  it("protects the last active administrator when removing the role permission", async () => {
    await pool.query("UPDATE users SET active = false WHERE id = $1", [ownerId]);
    const response = await request(managerSession, `/api/roles/${candidateAdminRole.id}`, "PATCH", {
      permissions: ["VIEW_CHANNEL"]
    });
    await expectError(response, 409, "LAST_ADMINISTRATOR");
    const persisted = await pool.query<{ permissions: string[] }>("SELECT permissions FROM roles WHERE id = $1", [candidateAdminRole.id]);
    expect(persisted.rows[0]?.permissions).toContain("ADMINISTRATOR");
  });
}
