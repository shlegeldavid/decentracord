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
const inContainer = process.env.MEMBER_CREATION_TEST_IN_CONTAINER === "true";
const baseUrl = process.env.MEMBER_CREATION_TEST_BASE_URL ?? "http://app:3000";
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
  describe("member creation API integration", () => {
    let fixtureDirectory = "";
    let projectName = "";
    let envFile = "";
    let overrideFile = "";

    function run(args: string[], timeout = commandTimeoutMs) {
      return compose(projectName, envFile, overrideFile, args, timeout);
    }

    beforeAll(() => {
      fixtureDirectory = mkdtempSync(join(tmpdir(), "decentracord-member-creation-"));
      const suffix = randomBytes(6).toString("hex");
      projectName = `decentracord-member-creation-${suffix}`;
      const databaseName = `decentracord_test_${suffix}`;
      const databaseUser = `member_create_${suffix.slice(0, 10)}`;
      const databasePassword = randomBytes(24).toString("base64url");
      const adminLogin = `member_admin_${suffix.slice(0, 10)}`;
      const adminPassword = `Member-admin-${randomBytes(18).toString("base64url")}`;
      const secretFile = join(fixtureDirectory, "db_password");
      envFile = join(fixtureDirectory, "compose.env");
      overrideFile = join(fixtureDirectory, "compose.member-creation.yaml");
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
          `MEMBER_CREATION_ADMIN_LOGIN=${adminLogin}`,
          `MEMBER_CREATION_ADMIN_PASSWORD=${adminPassword}`,
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
          `    image: ${JSON.stringify(`decentracord-member-creation-runner:${suffix}`)}`,
          '    entrypoint: ["npm", "run", "test:integration", "--", "tests/integration/member-creation.test.ts"]',
          "    environment:",
          "      MEMBER_CREATION_TEST_BASE_URL: http://app:3000",
          "      MEMBER_CREATION_ADMIN_LOGIN: ${MEMBER_CREATION_ADMIN_LOGIN}",
          "      MEMBER_CREATION_ADMIN_PASSWORD: ${MEMBER_CREATION_ADMIN_PASSWORD}",
          `      TEST_DATABASE_URL: postgresql://${databaseUser}:${databasePassword}@db:5432/${databaseName}`,
          "    networks:",
          "      - backend",
          "    depends_on:",
          "      app:",
          "        condition: service_healthy",
          "",
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
      assert.equal(bootstrap.status, 0, `Administrator bootstrap failed: ${bootstrap.error?.message ?? ""}\n${bootstrap.stdout ?? ""}\n${bootstrap.stderr ?? ""}`);
      assert.ok(!`${bootstrap.stdout}\n${bootstrap.stderr}`.includes(adminPassword), "bootstrap output leaked the administrator password");

      const appArgs = ["up", "--detach", "--wait", "--wait-timeout", "90", "app"];
      assertComposeSucceeded(run(appArgs, 180_000), appArgs);
      const runnerArgs = ["run", "--rm", "--no-deps", "-T", "-e", "MEMBER_CREATION_TEST_IN_CONTAINER=true", "test-runner"];
      assertComposeSucceeded(run(runnerArgs, 360_000), runnerArgs);
    }, 660_000);

    afterAll(() => {
      if (!fixtureDirectory) return;
      const downArgs = ["down", "--volumes", "--remove-orphans", "--rmi", "local"];
      const result = run(downArgs, 120_000);
      rmSync(fixtureDirectory, { recursive: true, force: true });
      assertComposeSucceeded(result, downArgs);
    });

    it("runs the isolated PostgreSQL and HTTP member creation checks", () => {
      expect(projectName).toContain("decentracord-member-creation-");
    });
  }, 660_000);
} else {
  interface HttpSession {
    cookie?: string;
    csrfToken?: string;
  }

  let pool: Pool;
  let adminSession: HttpSession;
  let adminCredentials: { login: string; password: string };

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

    const requestOptions: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(10_000)
    };
    if (body !== undefined) requestOptions.body = JSON.stringify(body);
    const response = await fetch(new URL(path, baseUrl), requestOptions);
    const cookieHeader = response.headers.get("set-cookie");
    const sessionCookie = cookieHeader?.split(";", 1)[0];
    if (sessionCookie) session.cookie = sessionCookie;
    return response;
  }

  async function acquireCsrf(session: HttpSession): Promise<string> {
    const response = await requestJson(session, "/api/auth/csrf");
    expect(response.status).toBe(200);
    const result = await response.json() as { csrfToken?: unknown };
    expect(typeof result.csrfToken).toBe("string");
    session.csrfToken = result.csrfToken as string;
    return session.csrfToken;
  }

  async function signIn(session: HttpSession, credentials: { login: string; password: string }): Promise<void> {
    await acquireCsrf(session);
    const response = await requestJson(session, "/api/auth/login", "POST", credentials);
    expect(response.status).toBe(200);
    const result = await response.json() as { csrfToken?: unknown };
    expect(typeof result.csrfToken).toBe("string");
    session.csrfToken = result.csrfToken as string;
  }

  function safePayload(response: Response): Promise<Record<string, unknown>> {
    return response.json() as Promise<Record<string, unknown>>;
  }

  beforeAll(async () => {
    const database = new URL(process.env.TEST_DATABASE_URL ?? "");
    expect(database.hostname).toBe("db");
    expect(database.pathname).toMatch(/^\/decentracord_test/u);
    const application = new URL(baseUrl);
    expect(application.hostname).toBe("app");
    expect(application.port).toBe("3000");
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4, connectionTimeoutMillis: 3_000 });
    adminSession = {};
    adminCredentials = {
      login: process.env.MEMBER_CREATION_ADMIN_LOGIN ?? "",
      password: process.env.MEMBER_CREATION_ADMIN_PASSWORD ?? ""
    };
    await signIn(adminSession, adminCredentials);
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe("administrator and employee member boundaries", () => {
    it("creates a transactional @everyone member, allows immediate login, and rejects unauthorized account operations", async () => {
      const listResponse = await requestJson(adminSession, "/api/members");
      expect(listResponse.status).toBe(200);
      const list = await safePayload(listResponse);
      expect(Array.isArray(list.members)).toBe(true);
      const rows = list.members as Array<Record<string, unknown>>;
      expect(rows.some((row) => row.login === adminCredentials.login)).toBe(true);
      expect(JSON.stringify(list)).not.toMatch(/password_hash|passwordHash|password/iu);

      const memberPassword = "Issued-member-password-2026";
      const createResponse = await requestJson(adminSession, "/api/members", "POST", {
        login: "  Created.Member  ",
        password: memberPassword
      });
      expect(createResponse.status).toBe(201);
      const created = await safePayload(createResponse);
      expect(created.login).toBe("created.member");
      expect(created.active).toBe(true);
      expect(Object.keys(created).sort()).toEqual(["active", "id", "login"]);
      expect(JSON.stringify(created)).not.toContain(memberPassword);
      expect(JSON.stringify(created)).not.toMatch(/password_hash|passwordHash/iu);

      const databaseMember = await pool.query<{ password_hash: string }>(
        "SELECT password_hash FROM users WHERE id = $1",
        [created.id]
      );
      expect(databaseMember.rows).toHaveLength(1);
      expect(databaseMember.rows[0]?.password_hash).toMatch(/^\$argon2id\$/u);
      await expect(new PasswordService().verify(memberPassword, databaseMember.rows[0]!.password_hash)).resolves.toBe(true);

      const assignments = await pool.query<{ system_key: string | null }>(
        "SELECT role.system_key FROM user_roles AS user_role JOIN roles AS role ON role.id = user_role.role_id WHERE user_role.user_id = $1 ORDER BY role.system_key",
        [created.id]
      );
      expect(assignments.rows.map((row) => row.system_key)).toEqual(["everyone"]);

      const employeeSession: HttpSession = {};
      await signIn(employeeSession, { login: "created.member", password: memberPassword });
      const employeeIdentity = await requestJson(employeeSession, "/api/auth/me");
      expect(employeeIdentity.status).toBe(200);
      expect(await employeeIdentity.json()).toMatchObject({ login: "created.member" });
      expect((await requestJson(employeeSession, "/api/organization")).status).toBe(200);
      expect((await requestJson(employeeSession, "/api/members")).status).toBe(403);
      const employeeCreate = await requestJson(employeeSession, "/api/members", "POST", {
        login: "employee.created",
        password: memberPassword
      });
      expect(employeeCreate.status).toBe(403);

      const guestSession: HttpSession = {};
      await acquireCsrf(guestSession);
      expect((await requestJson(guestSession, "/api/members")).status).toBe(401);
      const guestCreate = await requestJson(guestSession, "/api/members", "POST", {
        login: "guest.created",
        password: memberPassword
      });
      expect(guestCreate.status).toBe(401);

      const duplicate = await requestJson(adminSession, "/api/members", "POST", {
        login: "CREATED.MEMBER",
        password: memberPassword
      });
      expect(duplicate.status).toBe(409);
      const duplicateText = await duplicate.text();
      expect(duplicateText).not.toContain(memberPassword);
      expect(duplicateText).not.toMatch(/password_hash|passwordHash/iu);

      for (const payload of [
        { login: "ab", password: memberPassword },
        { login: "invalid.member", password: "short" },
        { login: "invalid.member", password: memberPassword, admin: true },
        { login: "invalid.member", password: memberPassword, permissions: ["ADMINISTRATOR"] },
        { login: "invalid.member", password: memberPassword, roleIds: ["admin"] }
      ]) {
        expect((await requestJson(adminSession, "/api/members", "POST", payload)).status).toBe(400);
      }

      await pool.query(`
        CREATE FUNCTION fail_test_member_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF (SELECT login_normalized FROM users WHERE id = NEW.user_id) = 'rollback.member' THEN
            RAISE EXCEPTION 'test role assignment failure';
          END IF;
          RETURN NEW;
        END;
        $$
      `);
      await pool.query(`CREATE TRIGGER fail_test_member_assignment_trigger BEFORE INSERT ON user_roles FOR EACH ROW EXECUTE FUNCTION fail_test_member_assignment()`);
      try {
        const failedCreate = await requestJson(adminSession, "/api/members", "POST", {
          login: "rollback.member",
          password: memberPassword
        });
        expect(failedCreate.status).toBe(500);
        const persistedAfterFailure = await pool.query(
          "SELECT id FROM users WHERE login_normalized = $1",
          ["rollback.member"]
        );
        expect(persistedAfterFailure.rows).toHaveLength(0);
      } finally {
        await pool.query("DROP TRIGGER fail_test_member_assignment_trigger ON user_roles");
        await pool.query("DROP FUNCTION fail_test_member_assignment()");
      }
    });
  });
}
