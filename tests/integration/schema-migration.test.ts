import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const commandTimeoutMs = 180_000;
const inContainer = process.env.SCHEMA_MIGRATION_TEST_IN_CONTAINER === "true";
const baseUrl = process.env.SCHEMA_MIGRATION_TEST_BASE_URL ?? "http://app:3000";
const appOrigin = new URL(baseUrl).origin;

function compose(projectName: string, envFile: string, overrideFile: string, args: string[], timeout = commandTimeoutMs) {
  return spawnSync(
    "docker",
    [
      "compose",
      "--project-name",
      projectName,
      "--env-file",
      envFile,
      "--file",
      join(projectRoot, "compose.yaml"),
      "--file",
      overrideFile,
      ...args
    ],
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
  const line = output
    .split(/\r?\n/u)
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate.startsWith("{"))
    .at(-1);
  assert.ok(line, `expected a JSON response, received: ${output}`);
  return JSON.parse(line) as Record<string, unknown>;
}

function runBootstrap(
  projectName: string,
  envFile: string,
  overrideFile: string,
  login: string,
  password: string,
  databaseName: string
) {
  return spawnSync(
    "docker",
    [
      "compose",
      "--project-name",
      projectName,
      "--env-file",
      envFile,
      "--file",
      join(projectRoot, "compose.yaml"),
      "--file",
      overrideFile,
      "run",
      "--rm",
      "--no-deps",
      "-T",
      "-i",
      "-e",
      `DB_NAME=${databaseName}`,
      "app",
      "bootstrap-admin",
      "--login",
      login
    ],
    {
      cwd: projectRoot,
      encoding: "utf8",
      input: `${password}\n`,
      timeout: commandTimeoutMs,
      env: process.env,
      maxBuffer: 2 * 1024 * 1024
    }
  );
}

if (!inContainer) {
  describe("schema migration integration", () => {
    let fixtureDirectory = "";
    let projectName = "";
    let databaseName = "";
    let phase1DatabaseName = "";
    let databaseUser = "";
    let databasePassword = "";
    let adminLogin = "";
    let adminPassword = "";
    let envFile = "";
    let overrideFile = "";

    function run(args: string[], timeout = commandTimeoutMs) {
      return compose(projectName, envFile, overrideFile, args, timeout);
    }

    beforeAll(() => {
      fixtureDirectory = mkdtempSync(join(tmpdir(), "decentracord-schema-migration-"));
      const suffix = randomBytes(6).toString("hex");
      projectName = `decentracord-schema-migration-${suffix}`;
      databaseName = `decentracord_test_${suffix}`;
      phase1DatabaseName = `decentracord_test_${suffix}_phase1`;
      databaseUser = `schema_${suffix.slice(0, 10)}`;
      databasePassword = randomBytes(24).toString("base64url");
      adminLogin = `schema_admin_${suffix.slice(0, 10)}`;
      adminPassword = `Schema-admin-${randomBytes(18).toString("base64url")}`;
      const secretFile = join(fixtureDirectory, "db_password");
      envFile = join(fixtureDirectory, "compose.env");
      overrideFile = join(fixtureDirectory, "compose.schema-migration.yaml");
      const phase1MigrationDirectory = join(fixtureDirectory, "phase1-migrations");
      const buildxConfig = join(fixtureDirectory, "buildx");
      mkdirSync(buildxConfig, { mode: 0o700 });
      mkdirSync(phase1MigrationDirectory, { mode: 0o700 });
      copyFileSync(join(projectRoot, "migrations", "001-identity.js"), join(phase1MigrationDirectory, "001-identity.js"));
      copyFileSync(join(projectRoot, "migrations", "002-session-lifecycle.js"), join(phase1MigrationDirectory, "002-session-lifecycle.js"));
      writeFileSync(secretFile, databasePassword, { mode: 0o600 });
      chmodSync(secretFile, 0o600);
      writeFileSync(
        envFile,
        [
          `DB_PASSWORD_SECRET_FILE=${secretFile}`,
          `SCHEMA_DB_PASSWORD=${databasePassword}`,
          `DB_NAME=${databaseName}`,
          `DB_USER=${databaseUser}`,
          `SCHEMA_PHASE1_DATABASE_NAME=${phase1DatabaseName}`,
          `SCHEMA_PHASE1_MIGRATIONS_PATH=${phase1MigrationDirectory}`,
          `SCHEMA_APP_IMAGE=decentracord-schema-app:${suffix}`,
          `SCHEMA_RUNNER_IMAGE=decentracord-schema-runner:${suffix}`,
          `SCHEMA_ADMIN_LOGIN=${adminLogin}`,
          `SCHEMA_ADMIN_PASSWORD=${adminPassword}`,
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
          "    build:",
          `      context: ${JSON.stringify(projectRoot)}`,
          "      dockerfile: Dockerfile",
          "    image: ${SCHEMA_APP_IMAGE}",
          '    entrypoint: ["node", "apps/server/dist/main.js"]',
          "    command: []",
          "    environment:",
          "      APP_HOST: 0.0.0.0",
          "      APP_PORT: 3000",
          "      NODE_ENV: test",
          "  phase1-migrator:",
          "    image: ${SCHEMA_APP_IMAGE}",
          '    entrypoint: ["node", "apps/server/dist/main.js"]',
          '    command: ["migrate"]',
          "    environment:",
          "      DB_HOST: db",
          "      DB_PORT: 5432",
          "      DB_NAME: ${SCHEMA_PHASE1_DATABASE_NAME}",
          "      DB_USER: ${DB_USER}",
          "      DB_PASSWORD_FILE: /run/secrets/db_password",
          "      MIGRATIONS_DIR: /app/phase1-migrations",
          "      DB_CONNECT_TIMEOUT_MS: 2500",
          "    secrets:",
          "      - db_password",
          "    depends_on:",
          "      db:",
          "        condition: service_healthy",
          "    volumes:",
          "      - ${SCHEMA_PHASE1_MIGRATIONS_PATH}:/app/phase1-migrations:ro",
          "    networks:",
          "      - backend",
          "  upgrade-app:",
          "    image: ${SCHEMA_APP_IMAGE}",
          '    entrypoint: ["node", "apps/server/dist/main.js"]',
          "    command: []",
          "    environment:",
          "      APP_HOST: 0.0.0.0",
          "      APP_PORT: 3002",
          "      DB_HOST: db",
          "      DB_PORT: 5432",
          "      DB_NAME: ${SCHEMA_PHASE1_DATABASE_NAME}",
          "      DB_USER: ${DB_USER}",
          "      DB_PASSWORD_FILE: /run/secrets/db_password",
          "      DB_CONNECT_TIMEOUT_MS: 2500",
          "      NODE_ENV: test",
          "    secrets:",
          "      - db_password",
          "    depends_on:",
          "      db:",
          "        condition: service_healthy",
          "    networks:",
          "      - backend",
          "  test-runner:",
          "    build:",
          `      context: ${JSON.stringify(projectRoot)}`,
          "      dockerfile: Dockerfile",
          "      target: test-runner",
          "    image: ${SCHEMA_RUNNER_IMAGE}",
          '    entrypoint: ["npm", "run", "test:integration", "--", "tests/integration/schema-migration.test.ts"]',
          "    environment:",
          "      SCHEMA_MIGRATION_TEST_IN_CONTAINER: \"true\"",
          "      SCHEMA_MIGRATION_TEST_BASE_URL: http://app:3000",
          "      SCHEMA_MIGRATION_ADMIN_LOGIN: ${SCHEMA_ADMIN_LOGIN}",
          "      SCHEMA_MIGRATION_ADMIN_PASSWORD: ${SCHEMA_ADMIN_PASSWORD}",
          "      TEST_DATABASE_URL: postgresql://${DB_USER}:${SCHEMA_DB_PASSWORD}@db:5432/${DB_NAME}",
          "      SCHEMA_PHASE1_TEST_DATABASE_URL: postgresql://${DB_USER}:${SCHEMA_DB_PASSWORD}@db:5432/${SCHEMA_PHASE1_DATABASE_NAME}",
          "    networks:",
          "      - backend",
          "    depends_on:",
          "      app:",
          "        condition: service_healthy",
          "      upgrade-app:",
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

      // The clean database receives every migration when the production server starts.
      const appArgs = ["up", "--detach", "--wait", "--wait-timeout", "90", "app"];
      assertComposeSucceeded(run(appArgs, 180_000), appArgs);
      const bootstrap = runBootstrap(projectName, envFile, overrideFile, adminLogin, adminPassword, databaseName);
      assert.equal(bootstrap.status, 0, `bootstrap failed: ${bootstrap.error?.message ?? ""}\n${bootstrap.stdout ?? ""}\n${bootstrap.stderr ?? ""}`);
      assert.equal(lastJsonLine(bootstrap.stdout ?? "").ok, true);
      assert.ok(!`${bootstrap.stdout}\n${bootstrap.stderr}`.includes(adminPassword), "bootstrap output leaked the administrator password");

      const repeatedBootstrap = runBootstrap(projectName, envFile, overrideFile, adminLogin, adminPassword, databaseName);
      assert.equal(repeatedBootstrap.status, 1, `repeated bootstrap unexpectedly succeeded: ${repeatedBootstrap.stdout ?? ""}\n${repeatedBootstrap.stderr ?? ""}`);
      assert.deepEqual(lastJsonLine(`${repeatedBootstrap.stdout ?? ""}\n${repeatedBootstrap.stderr ?? ""}`), {
        ok: false,
        code: "BOOTSTRAP_ALREADY_COMPLETED"
      });

      const createPhase1DatabaseArgs = ["exec", "-T", "db", "createdb", "--username", databaseUser, "--owner", databaseUser, phase1DatabaseName];
      assertComposeSucceeded(run(createPhase1DatabaseArgs), createPhase1DatabaseArgs);
      const phase1MigrationArgs = ["run", "--rm", "--no-deps", "-T", "phase1-migrator"];
      assertComposeSucceeded(run(phase1MigrationArgs, 180_000), phase1MigrationArgs);

      const phase1SeedSql = [
        "INSERT INTO organization (id, name) VALUES (1, 'Существующая организация')",
        "INSERT INTO roles (system_key, name, position, permissions) VALUES ('everyone', '@everyone', 0, '[]'::jsonb), ('administrator', 'Administrator', 1, '[\"ADMINISTRATOR\"]'::jsonb)",
        "INSERT INTO users (login, login_normalized, password_hash) VALUES ('phase1.admin', 'phase1.admin', 'preserved-password-hash')",
        "INSERT INTO user_roles (user_id, role_id) SELECT users.id, roles.id FROM users CROSS JOIN roles WHERE users.login_normalized = 'phase1.admin' AND roles.system_key IN ('everyone', 'administrator')"
      ].join("; ");
      const seedArgs = [
        "exec",
        "-T",
        "db",
        "psql",
        "--no-psqlrc",
        "--set",
        "ON_ERROR_STOP=1",
        "--username",
        databaseUser,
        "--dbname",
        phase1DatabaseName,
        "--command",
        phase1SeedSql
      ];
      assertComposeSucceeded(run(seedArgs), seedArgs);

      // Starting the current server on the Phase 1 database applies migration 004 in place.
      const upgradeAppArgs = ["up", "--detach", "--wait", "--wait-timeout", "90", "upgrade-app"];
      const upgradeApp = run(upgradeAppArgs, 180_000);
      if (upgradeApp.status !== 0) {
        const logs = run(["logs", "--no-color", "upgrade-app"]);
        upgradeApp.stderr = `${upgradeApp.stderr ?? ""}\n${logs.stdout ?? ""}\n${logs.stderr ?? ""}`;
      }
      assertComposeSucceeded(upgradeApp, upgradeAppArgs);
      const runnerArgs = ["run", "--rm", "--no-deps", "-T", "test-runner"];
      assertComposeSucceeded(run(runnerArgs, 360_000), runnerArgs);
    }, 900_000);

    afterAll(() => {
      if (!fixtureDirectory) return;
      const downArgs = ["down", "--volumes", "--remove-orphans", "--rmi", "local"];
      const result = run(downArgs, 180_000);
      rmSync(fixtureDirectory, { recursive: true, force: true });
      assertComposeSucceeded(result, downArgs);
    });

    it("starts isolated clean and Phase 1 PostgreSQL application stacks", () => {
      expect(projectName).toContain("decentracord-schema-migration-");
    });
  }, 900_000);
} else {
  interface HttpSession {
    cookie?: string;
    csrfToken?: string;
  }

  let pool: Pool;
  let phase1Pool: Pool;
  let adminSession: HttpSession;
  let adminCredentials: { login: string; password: string };

  async function requestJson(session: HttpSession, path: string, method = "GET", body?: unknown): Promise<Response> {
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

  async function expectPgError(action: () => Promise<unknown>, sqlState: string): Promise<void> {
    let caught: unknown;
    try {
      await action();
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: sqlState });
  }

  beforeAll(async () => {
    const database = new URL(process.env.TEST_DATABASE_URL ?? "");
    const phase1Database = new URL(process.env.SCHEMA_PHASE1_TEST_DATABASE_URL ?? "");
    expect(database.hostname).toBe("db");
    expect(database.pathname).toMatch(/^\/decentracord_test_[a-f0-9]+$/u);
    expect(phase1Database.hostname).toBe("db");
    expect(phase1Database.pathname).toMatch(/^\/decentracord_test_[a-f0-9]+_phase1$/u);
    expect(new URL(baseUrl).hostname).toBe("app");
    expect(new URL(baseUrl).port).toBe("3000");
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4, connectionTimeoutMillis: 3_000 });
    phase1Pool = new Pool({ connectionString: process.env.SCHEMA_PHASE1_TEST_DATABASE_URL, max: 4, connectionTimeoutMillis: 3_000 });
    adminSession = {};
    adminCredentials = {
      login: process.env.SCHEMA_MIGRATION_ADMIN_LOGIN ?? "",
      password: process.env.SCHEMA_MIGRATION_ADMIN_PASSWORD ?? ""
    };
    await signIn(adminSession, adminCredentials);
  });

  afterAll(async () => {
    await Promise.all([pool?.end(), phase1Pool?.end()]);
  });

  describe("migration 003 data and constraints", () => {
    it("preserves Phase 1 records and transfers its single administrator as owner", async () => {
      const organization = await phase1Pool.query<{ name: string }>("SELECT name FROM organization WHERE id = 1");
      expect(organization.rows).toEqual([{ name: "Существующая организация" }]);

      const user = await phase1Pool.query<{ login_normalized: string; password_hash: string; is_owner: boolean }>(
        "SELECT login_normalized, password_hash, is_owner FROM users"
      );
      expect(user.rows).toEqual([{ login_normalized: "phase1.admin", password_hash: "preserved-password-hash", is_owner: true }]);

      const rolePositions = await phase1Pool.query<{ system_key: string; position: number }>(
        "SELECT system_key, position FROM roles ORDER BY system_key"
      );
      expect(rolePositions.rows).toEqual([
        { system_key: "administrator", position: 1_000_000 },
        { system_key: "everyone", position: 0 }
      ]);

      const assignments = await phase1Pool.query<{ system_key: string }>(
        "SELECT roles.system_key FROM user_roles JOIN roles ON roles.id = user_roles.role_id JOIN users ON users.id = user_roles.user_id WHERE users.login_normalized = 'phase1.admin' ORDER BY roles.system_key"
      );
      expect(assignments.rows.map((row) => row.system_key)).toEqual(["administrator", "everyone"]);

      const schema = await phase1Pool.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('channels', 'channel_role_overrides', 'channel_member_overrides') ORDER BY table_name"
      );
      expect(schema.rows.map((row) => row.table_name)).toEqual(["channel_member_overrides", "channel_role_overrides", "channels"]);
    });

    it("creates channels case insensitively and enforces valid override effects and cascades", async () => {
      const channel = await pool.query<{ id: string }>("INSERT INTO channels (name) VALUES ($1) RETURNING id", ["Schema General"]);
      await expectPgError(
        () => pool.query("INSERT INTO channels (name) VALUES ($1)", ["sCHEMA gENERAL"]),
        "23505"
      );

      const role = await pool.query<{ id: string }>(
        "INSERT INTO roles (system_key, name, position, permissions) VALUES (NULL, $1, 10, '[]'::jsonb) RETURNING id",
        ["Schema Cascade Role"]
      );
      await expectPgError(
        () => pool.query(
          "INSERT INTO channel_role_overrides (channel_id, role_id, permission, effect) VALUES ($1, $2, $3, $4)",
          [channel.rows[0]!.id, role.rows[0]!.id, "ADMINISTRATOR", "invalid"]
        ),
        "23514"
      );
      await pool.query(
        "INSERT INTO channel_role_overrides (channel_id, role_id, permission, effect) VALUES ($1, $2, $3, 'deny')",
        [channel.rows[0]!.id, role.rows[0]!.id, "ADMINISTRATOR"]
      );
      await pool.query("DELETE FROM roles WHERE id = $1", [role.rows[0]!.id]);
      const roleOverrides = await pool.query("SELECT 1 FROM channel_role_overrides WHERE role_id = $1", [role.rows[0]!.id]);
      expect(roleOverrides.rows).toHaveLength(0);

      const member = await pool.query<{ id: string }>(
        "INSERT INTO users (login, login_normalized, password_hash) VALUES ('schema.cascade', 'schema.cascade', 'unused') RETURNING id"
      );
      await pool.query(
        "INSERT INTO channel_member_overrides (channel_id, user_id, permission, effect) VALUES ($1, $2, $3, 'allow')",
        [channel.rows[0]!.id, member.rows[0]!.id, "ADMINISTRATOR"]
      );
      await pool.query("DELETE FROM users WHERE id = $1", [member.rows[0]!.id]);
      const memberOverrides = await pool.query("SELECT 1 FROM channel_member_overrides WHERE user_id = $1", [member.rows[0]!.id]);
      expect(memberOverrides.rows).toHaveLength(0);
    });

    it("limits the installation to one owner and keeps created API members unprivileged", async () => {
      const bootstrapOwner = await pool.query<{ id: string; is_owner: boolean; system_keys: string[] }>(
        `SELECT users.id, users.is_owner, array_agg(roles.system_key ORDER BY roles.system_key) AS system_keys
         FROM users JOIN user_roles ON user_roles.user_id = users.id JOIN roles ON roles.id = user_roles.role_id
         WHERE users.login_normalized = $1 GROUP BY users.id`,
        [adminCredentials.login]
      );
      expect(bootstrapOwner.rows).toHaveLength(1);
      expect(bootstrapOwner.rows[0]?.is_owner).toBe(true);
      expect(bootstrapOwner.rows[0]?.system_keys).toEqual(["administrator", "everyone"]);

      const ownerCount = await pool.query<{ count: string }>("SELECT count(*) FROM users WHERE is_owner");
      expect(ownerCount.rows[0]?.count).toBe("1");
      const rolePositions = await pool.query<{ system_key: string; position: number }>(
        "SELECT system_key, position FROM roles ORDER BY system_key"
      );
      expect(rolePositions.rows).toEqual([
        { system_key: "administrator", position: 1_000_000 },
        { system_key: "everyone", position: 0 }
      ]);

      const secondUser = await pool.query<{ id: string }>(
        "INSERT INTO users (login, login_normalized, password_hash) VALUES ('schema.ownerconflict', 'schema.ownerconflict', 'unused') RETURNING id"
      );
      await expectPgError(() => pool.query("UPDATE users SET is_owner = true WHERE id = $1", [secondUser.rows[0]!.id]), "23505");
      const secondOwner = await pool.query<{ is_owner: boolean }>("SELECT is_owner FROM users WHERE id = $1", [secondUser.rows[0]!.id]);
      expect(secondOwner.rows).toEqual([{ is_owner: false }]);

      const memberPassword = `Created-member-${randomBytes(12).toString("hex")}`;
      const createResponse = await requestJson(adminSession, "/api/members", "POST", {
        login: "schema.created.member",
        password: memberPassword
      });
      expect(createResponse.status).toBe(201);
      const created = await createResponse.json() as { id: string; login: string };
      expect(created.login).toBe("schema.created.member");
      const createdMember = await pool.query<{ is_owner: boolean }>("SELECT is_owner FROM users WHERE id = $1", [created.id]);
      expect(createdMember.rows).toEqual([{ is_owner: false }]);
    });
  });

  describe("migration 004 data and constraints", () => {
    it("creates message storage and enforces idempotency and content length", async () => {
      const tables = await pool.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1::text[]) ORDER BY table_name",
        [["messages", "message_mentions", "channel_reads"]]
      );
      expect(tables.rows.map((row) => row.table_name)).toEqual(["channel_reads", "message_mentions", "messages"]);

      const lastSeq = await pool.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2",
        ["channels", "last_seq"]
      );
      expect(lastSeq.rows).toEqual([{ column_name: "last_seq" }]);

      const author = await pool.query<{ id: string }>(
        "SELECT id::text AS id FROM users WHERE login_normalized = $1",
        [adminCredentials.login]
      );
      const channel = await pool.query<{ id: string }>(
        "INSERT INTO channels (name) VALUES ($1) RETURNING id::text AS id",
        [`Schema messages ${randomBytes(6).toString("hex")}`]
      );
      const channelId = channel.rows[0]!.id;
      const authorId = author.rows[0]!.id;
      const clientRequestId = randomUUID();

      await pool.query(
        "INSERT INTO messages (channel_id, author_id, seq, updated_seq, content, client_request_id) VALUES ($1, $2, $3, $4, $5, $6)",
        [channelId, authorId, 1, 1, "first message", clientRequestId]
      );
      await expectPgError(
        () => pool.query(
          "INSERT INTO messages (channel_id, author_id, seq, updated_seq, content, client_request_id) VALUES ($1, $2, $3, $4, $5, $6)",
          [channelId, authorId, 2, 2, "retry", clientRequestId]
        ),
        "23505"
      );
      await expectPgError(
        () => pool.query(
          "INSERT INTO messages (channel_id, author_id, seq, updated_seq, content, client_request_id) VALUES ($1, $2, $3, $4, $5, $6)",
          [channelId, authorId, 3, 3, "💬".repeat(2001), randomUUID()]
        ),
        "23514"
      );
    });

    it("cascades message rows when their channel or author is deleted", async () => {
      const channelCascade = await pool.query<{ id: string }>(
        "INSERT INTO channels (name) VALUES ($1) RETURNING id::text AS id",
        [`Schema channel cascade ${randomBytes(6).toString("hex")}`]
      );
      const admin = await pool.query<{ id: string }>(
        "SELECT id::text AS id FROM users WHERE login_normalized = $1",
        [adminCredentials.login]
      );
      const channelMessage = await pool.query<{ id: string }>(
        "INSERT INTO messages (channel_id, author_id, seq, updated_seq, content, client_request_id) VALUES ($1, $2, 1, 1, $3, $4) RETURNING id::text AS id",
        [channelCascade.rows[0]!.id, admin.rows[0]!.id, "removed with channel", randomUUID()]
      );
      await pool.query("DELETE FROM channels WHERE id = $1", [channelCascade.rows[0]!.id]);
      const channelMessages = await pool.query("SELECT 1 FROM messages WHERE id = $1", [channelMessage.rows[0]!.id]);
      expect(channelMessages.rows).toHaveLength(0);

      const suffix = randomBytes(6).toString("hex");
      const author = await pool.query<{ id: string }>(
        "INSERT INTO users (login, login_normalized, password_hash) VALUES ($1, $2, 'unused') RETURNING id::text AS id",
        [`schema.author.${suffix}`, `schema.author.${suffix}`]
      );
      const authorCascadeChannel = await pool.query<{ id: string }>(
        "INSERT INTO channels (name) VALUES ($1) RETURNING id::text AS id",
        [`Schema author cascade ${suffix}`]
      );
      const authorMessage = await pool.query<{ id: string }>(
        "INSERT INTO messages (channel_id, author_id, seq, updated_seq, content, client_request_id) VALUES ($1, $2, 1, 1, $3, $4) RETURNING id::text AS id",
        [authorCascadeChannel.rows[0]!.id, author.rows[0]!.id, "removed with author", randomUUID()]
      );
      await pool.query("DELETE FROM users WHERE id = $1", [author.rows[0]!.id]);
      const authorMessages = await pool.query("SELECT 1 FROM messages WHERE id = $1", [authorMessage.rows[0]!.id]);
      expect(authorMessages.rows).toHaveLength(0);
    });
  });
}
