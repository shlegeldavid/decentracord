import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const commandTimeoutMs = 120_000;
const bootstrapPassword = "NotOnTheCommandLine-123";
const concurrencyPassword = "RacePassword-123456";

let fixtureDir: string;
let projectName: string;
let databaseName: string;
let databaseUser: string;
let databasePassword: string;
let envFile: string;
let composeOverrideFile: string;
let secretFile: string;
let buildxConfig: string;
let fixtureEnv: NodeJS.ProcessEnv;

function compose(args: string[], timeout = commandTimeoutMs) {
  return spawnSync(
    "docker",
    ["compose", "--project-name", projectName, "--env-file", envFile, ...args],
    {
      cwd: projectRoot,
      encoding: "utf8",
      timeout,
      env: fixtureEnv
    }
  );
}

function assertCommandSucceeded(result: ReturnType<typeof compose>, args: string[]) {
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

function runComposeWithInput(args: string[], input: string, timeout = commandTimeoutMs) {
  return new Promise<{ status: number | null; stdout: string; stderr: string; timedOut: boolean }>((resolve, reject) => {
    const child = spawn(
      "docker",
      ["compose", "--project-name", projectName, "--env-file", envFile, ...args],
      { cwd: projectRoot, env: fixtureEnv, stdio: ["pipe", "pipe", "pipe"] }
    );
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeout);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr, timedOut });
    });
    child.stdin.end(input);
  });
}

function runBootstrap(login: string, password: string, targetDatabase = databaseName) {
  return runComposeWithInput(
    [
      "run",
      "--rm",
      "--no-deps",
      "-T",
      "-i",
      "-e",
      `DB_NAME=${targetDatabase}`,
      "app",
      "bootstrap-admin",
      "--login",
      login
    ],
    `${password}\n`
  );
}

function queryDatabase(sql: string, targetDatabase = databaseName) {
  const args = [
    "exec",
    "-T",
    "db",
    "psql",
    "--no-psqlrc",
    "--tuples-only",
    "--no-align",
    "--set",
    "ON_ERROR_STOP=1",
    "--username",
    databaseUser,
    "--dbname",
    targetDatabase,
    "--command",
    sql
  ];
  const result = compose(args);
  assertCommandSucceeded(result, args);
  return (result.stdout ?? "").trim();
}

function migrateDatabase(targetDatabase: string) {
  const args = ["run", "--rm", "--no-deps", "-e", `DB_NAME=${targetDatabase}`, "app", "migrate"];
  const result = compose(args, 180_000);
  assertCommandSucceeded(result, args);
}

function helperDatabaseUrl(targetDatabase = databaseName) {
  return `postgresql://${encodeURIComponent(databaseUser)}:${encodeURIComponent(databasePassword)}@db:5432/${targetDatabase}`;
}

function runIdentityHelper(
  args: string[],
  input = "",
  environment: NodeJS.ProcessEnv = {}
) {
  return spawnSync(
    "docker",
    [
      "compose",
      "--project-name",
      projectName,
      "--env-file",
      envFile,
      "run",
      "--rm",
      "--no-deps",
      "-T",
      "-i",
      "-e",
      `NODE_ENV=${environment.NODE_ENV ?? "test"}`,
      "-e",
      `TEST_DATABASE_URL=${environment.TEST_DATABASE_URL ?? helperDatabaseUrl()}`,
      "test-helper",
      ...args
    ],
    {
      cwd: projectRoot,
      encoding: "utf8",
      input,
      timeout: commandTimeoutMs,
      env: {
        ...fixtureEnv,
        NODE_ENV: "test",
        TEST_DATABASE_URL: helperDatabaseUrl(),
        ...environment
      }
    }
  );
}

describe("production CLI administrator bootstrap", () => {
  beforeAll(() => {
    fixtureDir = mkdtempSync(join(tmpdir(), "decentracord-bootstrap-"));
    const suffix = randomBytes(6).toString("hex");
    projectName = `decentracord-bootstrap-${suffix}`;
    databaseName = `decentracord_test_${suffix}`;
    databaseUser = "bootstrap_test";
    databasePassword = randomBytes(24).toString("base64url");
    secretFile = join(fixtureDir, "db_password");
    envFile = join(fixtureDir, "compose.env");
    composeOverrideFile = join(fixtureDir, "test-port.yaml");
    buildxConfig = join(fixtureDir, "buildx");
    mkdirSync(buildxConfig, { mode: 0o700 });
    writeFileSync(secretFile, databasePassword, { mode: 0o600 });
    chmodSync(secretFile, 0o600);
    writeFileSync(
      envFile,
      [
        `DB_PASSWORD_SECRET_FILE=${secretFile}`,
        `DB_NAME=${databaseName}`,
        `DB_USER=${databaseUser}`,
        "DB_CONNECT_TIMEOUT_MS=2500",
        ""
      ].join("\n"),
      { mode: 0o600 }
    );
    writeFileSync(
      composeOverrideFile,
      [
        "services:",
        "  test-helper:",
        "    build:",
        `      context: ${JSON.stringify(projectRoot)}`,
        "      dockerfile: Dockerfile",
        "      target: test-helper",
        `    image: decentracord-test-helper:${suffix}`,
        '    entrypoint: ["node", "--import", "tsx", "tests/helpers/identity-cli.ts"]',
        "    environment:",
        "      NODE_ENV: ${NODE_ENV:-test}",
        "      TEST_DATABASE_URL: ${TEST_DATABASE_URL}",
        "    depends_on:",
        "      db:",
        "        condition: service_healthy",
        "    networks:",
        "      - backend",
        ""
      ].join("\n"),
      { mode: 0o600 }
    );
    fixtureEnv = {
      ...process.env,
      BUILDX_CONFIG: buildxConfig,
      COMPOSE_FILE: `${join(projectRoot, "compose.yaml")}:${composeOverrideFile}`,
      COMPOSE_PROJECT_NAME: projectName,
      DB_CONNECT_TIMEOUT_MS: "2500",
      DB_NAME: databaseName,
      DB_PASSWORD_SECRET_FILE: secretFile,
      DB_USER: databaseUser,
      DOCKER_CLI_HINTS: "false",
      NODE_ENV: "test",
      TEST_DATABASE_URL: helperDatabaseUrl(),
      npm_config_cache: "/tmp/decentracord-npm-cache"
    };

    const buildArgs = ["build", "app", "test-helper"];
    assertCommandSucceeded(compose(buildArgs, 240_000), buildArgs);
    const upArgs = ["up", "-d", "--wait", "--wait-timeout", "60", "db"];
    assertCommandSucceeded(compose(upArgs), upArgs);

    const migration = spawnSync("npm", ["run", "db:migrate"], {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: 180_000,
      env: fixtureEnv
    });
    assert.equal(
      migration.status,
      0,
      `npm run db:migrate failed: ${migration.error?.message ?? ""}\n${migration.stdout ?? ""}\n${migration.stderr ?? ""}`
    );
  }, 300_000);

  afterAll(() => {
    if (fixtureDir === undefined) return;

    const downArgs = ["down", "--volumes", "--remove-orphans"];
    const result = compose(downArgs);
    rmSync(fixtureDir, { recursive: true, force: true });
    assertCommandSucceeded(result, downArgs);
  });

  it(
    "creates one administrator when two production CLI bootstraps race",
    async () => {
      const raceDatabase = `${databaseName}_race`;
      const createDatabaseArgs = ["exec", "-T", "db", "createdb", "--username", databaseUser, raceDatabase];
      assertCommandSucceeded(compose(createDatabaseArgs), createDatabaseArgs);
      migrateDatabase(raceDatabase);

      const results = await Promise.all([
        runBootstrap("race.first", concurrencyPassword, raceDatabase),
        runBootstrap("race.second", `${concurrencyPassword}different`, raceDatabase)
      ]);
      expect(results.every((result) => !result.timedOut)).toBe(true);
      expect(results.filter((result) => result.status === 0)).toHaveLength(1);
      expect(results.filter((result) => result.status !== 0)).toHaveLength(1);
      expect(results.map((result) => lastJsonLine(`${result.stdout}\n${result.stderr}`).code)).toContain(
        "BOOTSTRAP_ALREADY_COMPLETED"
      );
      expect(queryDatabase("SELECT COUNT(*) FROM users", raceDatabase)).toBe("1");
      expect(queryDatabase("SELECT COUNT(*) FROM organization", raceDatabase)).toBe("1");
    },
    300_000
  );

  it("creates the administrator, system roles, and Argon2id hash through the production CLI", async () => {
    const result = await runBootstrap("Owner.One", bootstrapPassword);
    expect(result.timedOut).toBe(false);
    expect(result.status).toBe(0);
    const response = lastJsonLine(`${result.stdout}\n${result.stderr}`);
    expect(response).toMatchObject({ ok: true, login: "owner.one" });
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(bootstrapPassword);

    const identity = JSON.parse(
      queryDatabase(
        "SELECT json_build_object('id', u.id, 'login', u.login, 'login_normalized', u.login_normalized, 'active', u.active, 'auth_version', u.auth_version, 'roles', json_agg(json_build_object('system_key', r.system_key, 'permissions', r.permissions)))::text FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id GROUP BY u.id"
      )
    ) as {
      id: string;
      login: string;
      login_normalized: string;
      active: boolean;
      auth_version: number;
      roles: Array<{ system_key: string | null; permissions: string[] }>;
    };
    expect(identity.login).toBe("owner.one");
    expect(identity.login_normalized).toBe("owner.one");
    expect(identity.active).toBe(true);
    expect(identity.auth_version).toBe(0);
    expect(identity.roles.map((role) => role.system_key).sort()).toEqual(["administrator", "everyone"]);
    expect(identity.roles.find((role) => role.system_key === "administrator")?.permissions).toContain(
      "ADMINISTRATOR"
    );

    const passwordHash = queryDatabase("SELECT password_hash FROM users WHERE login_normalized = 'owner.one'");
    expect(passwordHash).not.toBe(bootstrapPassword);
    expect(passwordHash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/u);
  });

  it("rejects a repeat bootstrap without adding another administrator", async () => {
    const secondPassword = "AnotherPassword-1234";
    const result = await runBootstrap("second.admin", secondPassword);
    expect(result.status).not.toBe(0);
    expect(lastJsonLine(`${result.stdout}\n${result.stderr}`)).toMatchObject({
      ok: false,
      code: "BOOTSTRAP_ALREADY_COMPLETED"
    });
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(secondPassword);
    expect(queryDatabase("SELECT COUNT(*) FROM users")).toBe("1");
  });

  it("rolls back user creation when the role foreign key fails", () => {
    const rollbackId = "77777777-7777-4777-8777-777777777777";
    const sql = [
      "BEGIN",
      `INSERT INTO users (id, login, login_normalized, password_hash) VALUES ('${rollbackId}', 'rollback.test', 'rollback.test', 'not-a-real-hash')`,
      `INSERT INTO user_roles (user_id, role_id) VALUES ('${rollbackId}', 'ffffffff-ffff-4fff-8fff-ffffffffffff')`,
      "COMMIT"
    ].join("; ");
    const args = [
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
      databaseName,
      "--command",
      sql
    ];
    const result = compose(args);
    expect(result.status).not.toBe(0);
    expect(queryDatabase(`SELECT COUNT(*) FROM users WHERE id = '${rollbackId}'`)).toBe("0");
  });

  it("keeps the helper out of the production image and ships migrations", () => {
    const args = [
      "run",
      "--rm",
      "--no-deps",
      "-T",
      "--entrypoint",
      "sh",
      "app",
      "-c",
      "test ! -e /app/tests/helpers/identity-cli.ts && test -f /app/migrations/001-identity.js"
    ];
    assertCommandSucceeded(compose(args), args);
  });

  it("creates and clears only test-helper fixtures with the shared password service", () => {
    const employeePassword = "FixtureEmployee-1234";
    const employee = runIdentityHelper(
      ["create-user", "--login", "fixture_employee"],
      `${employeePassword}\n`
    );
    expect(employee.status, `${employee.stdout ?? ""}\n${employee.stderr ?? ""}`).toBe(0);
    const employeeResponse = lastJsonLine(`${employee.stdout ?? ""}\n${employee.stderr ?? ""}`);
    expect(Object.keys(employeeResponse).sort()).toEqual(["active", "id", "login"]);
    expect(employeeResponse).toMatchObject({ active: true, login: "fixture_employee" });
    expect(`${employee.stdout ?? ""}\n${employee.stderr ?? ""}`).not.toContain(employeePassword);
    expect(
      queryDatabase(
        "SELECT json_agg(r.system_key ORDER BY r.system_key)::text FROM user_roles ur JOIN roles r ON r.id = ur.role_id JOIN users u ON u.id = ur.user_id WHERE u.login_normalized = 'fixture_employee'"
      )
    ).toBe('["everyone"]');
    expect(
      queryDatabase("SELECT password_hash FROM users WHERE login_normalized = 'fixture_employee'")
    ).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/u);

    const administrator = runIdentityHelper(
      ["create-user", "--login", "fixture_admin", "--admin"],
      "FixtureAdministrator-1234\n"
    );
    expect(administrator.status).toBe(0);
    expect(lastJsonLine(`${administrator.stdout ?? ""}\n${administrator.stderr ?? ""}`)).toMatchObject({
      active: true,
      login: "fixture_admin"
    });
    expect(
      queryDatabase(
        "SELECT json_agg(r.system_key ORDER BY r.system_key)::text FROM user_roles ur JOIN roles r ON r.id = ur.role_id JOIN users u ON u.id = ur.user_id WHERE u.login_normalized = 'fixture_admin'"
      )
    ).toBe('["administrator", "everyone"]');

    const deniedProduction = runIdentityHelper(
      ["create-user", "--login", "fixture_forbidden"],
      "ForbiddenPassword-1234\n",
      { NODE_ENV: "production" }
    );
    expect(deniedProduction.status).toBe(2);
    expect(lastJsonLine(`${deniedProduction.stdout ?? ""}\n${deniedProduction.stderr ?? ""}`)).toMatchObject({
      ok: false,
      code: "TEST_DATABASE_REQUIRED"
    });

    const deniedDatabase = runIdentityHelper(
      ["create-user", "--login", "fixture_forbidden"],
      "ForbiddenPassword-1234\n",
      { TEST_DATABASE_URL: "postgresql://test:password@127.0.0.1/decentracord" }
    );
    expect(deniedDatabase.status).toBe(2);
    expect(lastJsonLine(`${deniedDatabase.stdout ?? ""}\n${deniedDatabase.stderr ?? ""}`)).toMatchObject({
      ok: false,
      code: "TEST_DATABASE_REQUIRED"
    });
    expect(queryDatabase("SELECT COUNT(*) FROM users WHERE login_normalized = 'fixture_forbidden'")).toBe("0");

    const cleared = runIdentityHelper(["clear-fixture"]);
    expect(cleared.status).toBe(0);
    expect(lastJsonLine(`${cleared.stdout ?? ""}\n${cleared.stderr ?? ""}`)).toMatchObject({ ok: true, deleted: 2 });
    expect(queryDatabase("SELECT COUNT(*) FROM users WHERE login_normalized LIKE 'fixture_%'")).toBe("0");
    expect(queryDatabase("SELECT COUNT(*) FROM users WHERE login_normalized = 'owner.one'")).toBe("1");
  });

  it("rolls back a test-only admin when its required role is missing", () => {
    const rollbackDatabase = `${databaseName}_helper_rollback`;
    const createDatabaseArgs = ["exec", "-T", "db", "createdb", "--username", databaseUser, rollbackDatabase];
    assertCommandSucceeded(compose(createDatabaseArgs), createDatabaseArgs);
    migrateDatabase(rollbackDatabase);
    const seedRoleArgs = [
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
      rollbackDatabase,
      "--command",
      "INSERT INTO roles (id, system_key, name) VALUES ('88888888-8888-4888-8888-888888888888', 'everyone', '@everyone')"
    ];
    assertCommandSucceeded(compose(seedRoleArgs), seedRoleArgs);

    const result = runIdentityHelper(
      ["create-user", "--login", "fixture_rollback", "--admin"],
      "FixtureRollback-12345\n",
      { TEST_DATABASE_URL: helperDatabaseUrl(rollbackDatabase) }
    );
    expect(result.status).not.toBe(0);
    expect(lastJsonLine(`${result.stdout ?? ""}\n${result.stderr ?? ""}`)).toMatchObject({
      ok: false,
      code: "FIXTURE_CREATE_FAILED"
    });
    expect(queryDatabase("SELECT COUNT(*) FROM users WHERE login_normalized = 'fixture_rollback'", rollbackDatabase)).toBe("0");
    expect(queryDatabase("SELECT COUNT(*) FROM user_roles", rollbackDatabase)).toBe("0");
  });
});
