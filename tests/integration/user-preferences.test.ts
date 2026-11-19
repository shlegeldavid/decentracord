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
const inContainer = process.env.USER_PREFERENCES_TEST_IN_CONTAINER === "true";

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
    "docker compose " + args.join(" ") + " failed: " + (result.error?.message ?? "") +
      "\n" + (result.stdout ?? "") + "\n" + (result.stderr ?? "")
  );
}

function lastJsonLine(output: string): Record<string, unknown> {
  const line = output.split(/\r?\n/u).map((candidate) => candidate.trim()).filter((candidate) => candidate.startsWith("{")).at(-1);
  assert.ok(line, "expected a JSON response, received: " + output);
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
    { cwd: projectRoot, encoding: "utf8", input: password + "\n", timeout: commandTimeoutMs, env: process.env, maxBuffer: 2 * 1024 * 1024 }
  );
}

if (!inContainer) {
  describe("user preferences and role color API integration", () => {
    let fixtureDirectory = "";
    let projectName = "";
    let envFile = "";
    let overrideFile = "";

    function run(args: string[], timeout = commandTimeoutMs) {
      return compose(projectName, envFile, overrideFile, args, timeout);
    }

    beforeAll(() => {
      fixtureDirectory = mkdtempSync(join(tmpdir(), "decentracord-user-preferences-"));
      const suffix = randomBytes(6).toString("hex");
      projectName = "decentracord-user-preferences-" + suffix;
      const databaseName = "decentracord_test_" + suffix;
      const databaseUser = "preferences_" + suffix.slice(0, 10);
      const databasePassword = randomBytes(24).toString("base64url");
      const adminLogin = "preferences_admin_" + suffix.slice(0, 10);
      const adminPassword = "Preferences-admin-" + randomBytes(18).toString("base64url");
      const secretFile = join(fixtureDirectory, "db_password");
      envFile = join(fixtureDirectory, "compose.env");
      overrideFile = join(fixtureDirectory, "compose.user-preferences.yaml");
      const buildxConfig = join(fixtureDirectory, "buildx");
      mkdirSync(buildxConfig, { mode: 0o700 });
      writeFileSync(secretFile, databasePassword, { mode: 0o600 });
      chmodSync(secretFile, 0o600);
      writeFileSync(envFile, [
        "DB_PASSWORD_SECRET_FILE=" + secretFile,
        "DB_PASSWORD=" + databasePassword,
        "DB_NAME=" + databaseName,
        "DB_USER=" + databaseUser,
        "USER_PREFERENCES_ADMIN_LOGIN=" + adminLogin,
        "USER_PREFERENCES_ADMIN_PASSWORD=" + adminPassword,
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
        "      context: " + JSON.stringify(projectRoot),
        "      dockerfile: Dockerfile",
        "      target: test-runner",
        "    image: " + JSON.stringify("decentracord-user-preferences-runner:" + suffix),
        '    entrypoint: ["npm", "run", "test:integration", "--", "tests/integration/user-preferences.test.ts"]',
        "    environment:",
        '      USER_PREFERENCES_TEST_IN_CONTAINER: "true"',
        "      USER_PREFERENCES_TEST_BASE_URL: http://app:3000",
        "      USER_PREFERENCES_ADMIN_LOGIN: " + "$" + "{USER_PREFERENCES_ADMIN_LOGIN}",
        "      USER_PREFERENCES_ADMIN_PASSWORD: " + "$" + "{USER_PREFERENCES_ADMIN_PASSWORD}",
        "      TEST_DATABASE_URL: postgresql://" + databaseUser + ":" + databasePassword + "@db:5432/" + databaseName,
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
      assert.equal(bootstrap.status, 0, "bootstrap failed: " + (bootstrap.error?.message ?? "") +
        "\n" + (bootstrap.stdout ?? "") + "\n" + (bootstrap.stderr ?? ""));
      assert.equal(lastJsonLine((bootstrap.stdout ?? "") + "\n" + (bootstrap.stderr ?? "")).ok, true);
      assert.ok(!((bootstrap.stdout ?? "") + "\n" + (bootstrap.stderr ?? "")).includes(adminPassword), "bootstrap output leaked the administrator password");

      const runnerArgs = ["run", "--rm", "--no-deps", "-T", "test-runner"];
      const runner = run(runnerArgs, 600_000);
      if (runner.status !== 0) {
        const logs = run(["logs", "--no-color", "app"]);
        runner.stderr = (runner.stderr ?? "") + "\nApp logs:\n" + (logs.stdout ?? "") + (logs.stderr ?? "");
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

    it("runs preference and role metadata checks against PostgreSQL", () => {
      expect(projectName).toContain("decentracord-user-preferences-");
    });
  }, 900_000);
} else {
  interface HttpSession {
    cookie?: string;
    csrfToken?: string;
  }

  interface UserRoleDto {
    id: string;
    name: string;
    color: string | null;
    position: number;
  }

  interface CurrentUserDto {
    id: string;
    login: string;
    theme: "dark" | "light";
    timezone: string | null;
    roles: UserRoleDto[];
  }

  interface RoleDto {
    id: string;
    name: string;
    position: number;
    permissions: string[];
    systemKey: string | null;
    ownerEditable: boolean;
    color: string | null;
    editable: boolean;
  }

  const baseUrl = process.env.USER_PREFERENCES_TEST_BASE_URL ?? "http://app:3000";
  const appOrigin = new URL(baseUrl).origin;
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
    const response = await request(session, "/api/auth/login", "POST", credentials);
    expect(response.status).toBe(200);
    const body = await response.json() as { csrfToken?: unknown };
    expect(typeof body.csrfToken).toBe("string");
    session.csrfToken = body.csrfToken as string;
    return session;
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
      login: process.env.USER_PREFERENCES_ADMIN_LOGIN ?? "",
      password: process.env.USER_PREFERENCES_ADMIN_PASSWORD ?? ""
    });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
  });

  it("persists validated theme and timezone preferences and requires CSRF", async () => {
    const initialResponse = await request(adminSession, "/api/auth/me");
    expect(initialResponse.status).toBe(200);
    const initial = await initialResponse.json() as CurrentUserDto;
    expect(initial.theme).toBe("dark");
    expect(initial.timezone).toBeNull();
    expect(Array.isArray(initial.roles)).toBe(true);
    expect(initial.roles.every((role) => typeof role.id === "string" &&
      typeof role.name === "string" && (role.color === null || typeof role.color === "string") &&
      Number.isSafeInteger(role.position))).toBe(true);

    const themeUpdate = await request(adminSession, "/api/auth/preferences", "PATCH", { theme: "light" });
    expect(themeUpdate.status).toBe(200);
    expect((await themeUpdate.json() as CurrentUserDto).theme).toBe("light");

    const timezoneUpdate = await request(adminSession, "/api/auth/preferences", "PATCH", { timezone: "Europe/Moscow" });
    expect(timezoneUpdate.status).toBe(200);
    const withTimezone = await request(adminSession, "/api/auth/me");
    expect((await withTimezone.json() as CurrentUserDto)).toMatchObject({ theme: "light", timezone: "Europe/Moscow" });

    const darkUpdate = await request(adminSession, "/api/auth/preferences", "PATCH", { theme: "dark" });
    expect(darkUpdate.status).toBe(200);
    const clearedTimezone = await request(adminSession, "/api/auth/preferences", "PATCH", { timezone: null });
    expect(clearedTimezone.status).toBe(200);
    const reset = await request(adminSession, "/api/auth/me");
    expect((await reset.json() as CurrentUserDto)).toMatchObject({ theme: "dark", timezone: null });

    await expectError(await request(adminSession, "/api/auth/preferences", "PATCH", { theme: "sepia" }), 400, "INVALID_REQUEST");
    await expectError(await request(adminSession, "/api/auth/preferences", "PATCH", { roleIds: [] }), 400, "INVALID_REQUEST");
    await expectError(await request(adminSession, "/api/auth/preferences", "PATCH", { timezone: "Mars/Olympus" }), 400, "INVALID_REQUEST");

    const csrfMissing: HttpSession = adminSession.cookie ? { cookie: adminSession.cookie } : {};
    await expectError(await request(csrfMissing, "/api/auth/preferences", "PATCH", { theme: "light" }), 403, "CSRF_FAILED");

    const foreignOriginHeaders: Record<string, string> = {
      accept: "application/json",
      origin: "https://attacker.example",
      "content-type": "application/json"
    };
    if (adminSession.cookie) foreignOriginHeaders.cookie = adminSession.cookie;
    if (adminSession.csrfToken) foreignOriginHeaders["x-csrf-token"] = adminSession.csrfToken;
    const foreignOrigin = await fetch(new URL("/api/auth/preferences", baseUrl), {
      method: "PATCH",
      headers: foreignOriginHeaders,
      body: JSON.stringify({ theme: "light" }),
      signal: AbortSignal.timeout(15_000)
    });
    await expectError(foreignOrigin, 403, "CSRF_FAILED");
  });

  it("validates role colors and returns hierarchy-aware editability", async () => {
    const name = "Preference Color " + randomBytes(5).toString("hex");
    const create = await request(adminSession, "/api/roles", "POST", {
      name,
      permissions: [],
      color: "#4a7fd0"
    });
    expect(create.status).toBe(201);
    const created = await create.json() as RoleDto;
    expect(created).toMatchObject({ name, color: "#4a7fd0", editable: true, ownerEditable: false });

    const update = await request(adminSession, "/api/roles/" + created.id, "PATCH", { color: "#b45309" });
    expect(update.status).toBe(200);
    expect((await update.json() as RoleDto).color).toBe("#b45309");

    await expectError(await request(adminSession, "/api/roles/" + created.id, "PATCH", { color: "red" }), 400, "INVALID_REQUEST");
    const resetColor = await request(adminSession, "/api/roles/" + created.id, "PATCH", { color: null });
    expect(resetColor.status).toBe(200);
    expect((await resetColor.json() as RoleDto).color).toBeNull();

    const higherRole = await pool.query<{ id: string }>(
      "INSERT INTO roles (system_key, name, position, permissions) VALUES (NULL, $1, 1000001, '[]'::jsonb) RETURNING id::text AS id",
      ["Above owner " + randomBytes(5).toString("hex")]
    );
    const higherRoleId = higherRole.rows[0]?.id;
    if (!higherRoleId) throw new Error("Higher role was not created");

    const list = await request(adminSession, "/api/roles");
    expect(list.status).toBe(200);
    const roles = (await list.json() as { roles: RoleDto[] }).roles;
    expect(roles.length).toBeGreaterThan(0);
    expect(roles.every((role) => Object.hasOwn(role, "color") && typeof role.editable === "boolean")).toBe(true);
    expect(roles.find((role) => role.systemKey === "everyone")).toMatchObject({
      ownerEditable: true, editable: false, color: null
    });
    expect(roles.find((role) => role.id === created.id)).toMatchObject({ editable: true, color: null });
    expect(roles.find((role) => role.id === higherRoleId)).toMatchObject({ editable: false, position: 1_000_001 });
  });
}
