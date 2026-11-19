import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { test as base } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const commandTimeoutMs = 180_000;
const restartTag = "@session-after-restart";
export const applicationOrigin = new URL(process.env.TEST_ORIGIN ?? process.env.E2E_BASE_URL ?? "http://decentracord.test:3000").origin;

export interface TestIdentity {
  admin: { login: string; password: string };
  employee?: { login: string; password: string };
  organizationName: string;
}

export interface ChannelAccessSeed {
  channelId: string;
  channelName: string;
  lowerRoleId: string;
  lowerRoleName: string;
}

export interface MessagingSeed {
  channelId: string;
  channelName: string;
  manager: { login: string; password: string };
  member: { login: string; password: string };
}

interface TestFixtures {
  channelAccessSeed: ChannelAccessSeed;
  messagingSeed: MessagingSeed;
}

interface E2EFixtures {
  identity: TestIdentity;
}

function runLocalCommand(command: string, args: string[], input = "", env: NodeJS.ProcessEnv = process.env): string {
  try {
    return execFileSync(command, args, {
      cwd: projectRoot,
      env,
      input,
      maxBuffer: 2 * 1024 * 1024,
      stdio: ["pipe", "inherit", "inherit"],
      timeout: commandTimeoutMs
    })?.toString("utf8") ?? "";
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { status?: number | null; stdout?: string; stderr?: string };
    const output = `${failure.stdout ?? ""}\n${failure.stderr ?? ""}`;
    throw new Error(`${command} ${args.join(" ")} failed with status ${failure.status ?? "unknown"}: ${output || failure.message || "command failed"}`);
  }
}

export function createFixtureUser(input: { login: string; password: string; roleName: string }): void {
  runLocalCommand(
    process.execPath,
    ["--import", "tsx", "tests/helpers/identity-cli.ts", "create-user", "--login", input.login, "--role", input.roleName],
    `${input.password}\n`,
    process.env
  );
}

export function normalizedNetworkOrigin(rawUrl: string): string | undefined {
  try {
    const url = new URL(rawUrl);
    if (url.protocol === "ws:") return `http://${url.host}`;
    if (url.protocol === "wss:") return `https://${url.host}`;
    if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
    return undefined;
  } catch {
    return undefined;
  }
}

export function captureExternalRequests(context: BrowserContext): string[] {
  const unexpected: string[] = [];
  const record = (url: string, method: string, type: string): void => {
    const origin = normalizedNetworkOrigin(url);
    if (origin && origin !== applicationOrigin) {
      // Keep only safe request metadata; never retain URL queries, headers, or bodies.
      unexpected.push(`${method} ${origin} (${type})`);
    }
  };

  // BrowserContext request events include page navigation, assets, and requests made by workers.
  context.on("request", (request) => record(request.url(), request.method(), request.resourceType()));
  const observeWebSockets = (page: Page): void => {
    page.on("websocket", (websocket) => record(websocket.url(), "GET", "websocket"));
  };
  context.pages().forEach(observeWebSockets);
  context.on("page", observeWebSockets);
  return unexpected;
}

export async function openSettingsSection(page: Page, sectionName: string): Promise<void> {
  const navigation = page.getByRole("navigation", { name: "Разделы" });
  if (!(await navigation.isVisible())) {
    await page.locator(".app-header").getByRole("button", { name: "Настройки", exact: true }).click();
  }
  await navigation.getByRole("button", { name: sectionName, exact: true }).click();
  await page.getByRole("dialog", { name: "Настройки" })
    .getByRole("heading", { name: sectionName, exact: true })
    .waitFor({ state: "visible" });
}

export async function seedMessageHistory(channelId: string, authorLogin: string, contents: string[]): Promise<void> {
  if (contents.length === 0 || contents.length > 500 || contents.some((content) => content.length > 2_000)) {
    throw new Error("Messaging history seed is invalid");
  }
  const databaseUrl = new URL(requiredEnvironment("TEST_DATABASE_URL"));
  const databaseName = decodeURIComponent(databaseUrl.pathname.slice(1));
  if (
    process.env.NODE_ENV !== "test" ||
    !["db", "localhost", "127.0.0.1", "[::1]"].includes(databaseUrl.hostname) ||
    !/^decentracord_test(?:_[a-z0-9_-]+)?$/u.test(databaseName) ||
    !databaseUrl.password
  ) {
    throw new Error("Messaging history seeds require the isolated test database");
  }

  const pool = new Pool({ connectionString: databaseUrl.toString(), max: 1, connectionTimeoutMillis: 3_000 });
  let client: Awaited<ReturnType<typeof pool.connect>> | undefined;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(21471, 901)");
    const author = await client.query<{ id: string }>(
      "SELECT id::text AS id FROM users WHERE login_normalized = $1 AND active = true",
      [authorLogin]
    );
    const authorId = author.rows[0]?.id;
    if (!authorId) throw new Error("Messaging history author was not found");
    const channel = await client.query<{ first_seq: number }>(
      `UPDATE channels
       SET last_seq = last_seq + $2, updated_at = now()
       WHERE id = $1
       RETURNING (last_seq - $2 + 1)::integer AS first_seq`,
      [channelId, contents.length]
    );
    const firstSeq = channel.rows[0]?.first_seq;
    if (firstSeq === undefined) throw new Error("Messaging history channel was not found");

    const values: unknown[] = [];
    const rows = contents.map((content, index) => {
      const offset = index * 5;
      values.push(channelId, authorId, firstSeq + index, content, randomUUID());
      return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 3}, $${offset + 4}, $${offset + 5})`;
    });
    await client.query(
      `INSERT INTO messages (channel_id, author_id, seq, updated_seq, content, client_request_id)
       VALUES ${rows.join(", ")}`,
      values
    );
    await client.query("COMMIT");
  } catch (error) {
    await client?.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client?.release();
    await pool.end();
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Required e2e environment value is missing: ${name}`);
  return value;
}

async function setFixtureOrganizationName(name: string): Promise<void> {
  const databaseUrl = new URL(requiredEnvironment("TEST_DATABASE_URL"));
  const databaseName = decodeURIComponent(databaseUrl.pathname.slice(1));
  if (
    process.env.NODE_ENV !== "test" ||
    !["db", "localhost", "127.0.0.1", "[::1]"].includes(databaseUrl.hostname) ||
    !/^decentracord_test(?:_[a-z0-9_-]+)?$/u.test(databaseName) ||
    !databaseUrl.password
  ) {
    throw new Error("Organization fixture updates require the isolated test database");
  }

  const pool = new Pool({ connectionString: databaseUrl.toString(), max: 1, connectionTimeoutMillis: 3_000 });
  try {
    const result = await pool.query("UPDATE organization SET name = $1 WHERE id = 1", [name]);
    if (result.rowCount !== 1) throw new Error("Test organization was not initialized");
  } finally {
    await pool.end();
  }
}

function installRunnerTrust(): void {
  const caFile = requiredEnvironment("TEST_CA_FILE");
  const caStats = statSync(caFile);
  if (!caStats.isFile() || caStats.size === 0 || caStats.size > 64 * 1024) {
    throw new Error("TLS test CA is invalid");
  }

  const systemCertificate = "/usr/local/share/ca-certificates/decentracord-test-ca.crt";
  copyFileSync(caFile, systemCertificate);
  chmodSync(systemCertificate, 0o644);
  runLocalCommand("update-ca-certificates", []);

  const nssDatabase = "/root/.pki/nssdb";
  mkdirSync(nssDatabase, { recursive: true, mode: 0o700 });
  runLocalCommand("certutil", ["-N", "-d", `sql:${nssDatabase}`, "--empty-password"]);
  runLocalCommand("certutil", [
    "-A", "-d", `sql:${nssDatabase}`, "-n", "Decentracord isolated TLS test CA",
    "-t", "C,,", "-i", caFile
  ]);
}

function setRunnerTestDatabaseUrl(): void {
  const databaseName = requiredEnvironment("TEST_DATABASE_NAME");
  const databaseHost = requiredEnvironment("TEST_DATABASE_HOST");
  const databasePort = requiredEnvironment("TEST_DATABASE_PORT");
  const secretFile = requiredEnvironment("TEST_DATABASE_SECRET_FILE");
  if (databaseName !== "decentracord_test" || databaseHost !== "db" || databasePort !== "5432") {
    throw new Error("TLS test database boundary is invalid");
  }

  const secretStats = statSync(secretFile);
  if (!secretStats.isFile() || secretStats.size === 0 || secretStats.size > 4_096) {
    throw new Error("TLS test database credentials are invalid");
  }
  const credentials = JSON.parse(readFileSync(secretFile, "utf8")) as unknown;
  if (
    typeof credentials !== "object" || credentials === null || Array.isArray(credentials) ||
    Object.keys(credentials).sort().join(",") !== "password,user" ||
    typeof (credentials as { user?: unknown }).user !== "string" ||
    typeof (credentials as { password?: unknown }).password !== "string" ||
    !(credentials as { user: string }).user || !(credentials as { password: string }).password
  ) {
    throw new Error("TLS test database credentials are invalid");
  }

  const databaseUrl = new URL(`postgresql://${databaseHost}:${databasePort}/${databaseName}`);
  databaseUrl.username = (credentials as { user: string }).user;
  databaseUrl.password = (credentials as { password: string }).password;
  process.env.TEST_DATABASE_URL = databaseUrl.toString();
}

function runnerSpecs(): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(requiredEnvironment("TEST_SPECS_JSON"));
  } catch {
    throw new Error("TLS test specs are invalid");
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 32) {
    throw new Error("TLS test specs are invalid");
  }
  return parsed.map((value) => {
    if (
      typeof value !== "string" || value.length > 512 || value.includes("\u0000") ||
      (!value.startsWith("tests/e2e/") && value !== "tests/e2e") || value.split("/").includes("..")
    ) {
      throw new Error("TLS test specs are invalid");
    }
    return value;
  });
}

export const test = base.extend<TestFixtures, E2EFixtures>({
  identity: [async ({}, use) => {
    const admin = {
      login: requiredEnvironment("E2E_ADMIN_LOGIN"),
      password: requiredEnvironment("E2E_ADMIN_PASSWORD")
    };
    const employee = {
      login: requiredEnvironment("E2E_EMPLOYEE_LOGIN"),
      password: requiredEnvironment("E2E_EMPLOYEE_PASSWORD")
    };
    const organizationName = requiredEnvironment("E2E_ORGANIZATION_NAME");
    const isRestartPhase = process.env.E2E_STAGE === "after-restart";

    if (!isRestartPhase) {
      await setFixtureOrganizationName(organizationName);
      runLocalCommand(process.execPath, ["--import", "tsx", "tests/helpers/identity-cli.ts", "clear-fixture"]);
      runLocalCommand(
        process.execPath,
        ["--import", "tsx", "tests/helpers/identity-cli.ts", "create-user", "--login", employee.login],
        `${employee.password}\n`
      );

      try {
        await use({ admin, employee, organizationName });
      } finally {
        runLocalCommand(process.execPath, ["--import", "tsx", "tests/helpers/identity-cli.ts", "clear-fixture"]);
      }
      return;
    }

    await use({ admin, organizationName });
  }, { scope: "worker" }],
  channelAccessSeed: async ({}, use) => {
    const suffix = randomBytes(6).toString("hex");
    const lowerRoleName = `e2e-lower-${suffix}`;
    const channelName = `e2e-access-${suffix}`;
    const databaseUrl = new URL(requiredEnvironment("TEST_DATABASE_URL"));
    const databaseName = decodeURIComponent(databaseUrl.pathname.slice(1));
    if (
      process.env.NODE_ENV !== "test" ||
      !["db", "localhost", "127.0.0.1", "[::1]"].includes(databaseUrl.hostname) ||
      !/^decentracord_test(?:_[a-z0-9_-]+)?$/u.test(databaseName) ||
      !databaseUrl.password
    ) {
      throw new Error("Channel access fixtures require the isolated test database");
    }

    const pool = new Pool({ connectionString: databaseUrl.toString(), max: 1, connectionTimeoutMillis: 3_000 });
    let client: Awaited<ReturnType<typeof pool.connect>> | undefined;
    try {
      client = await pool.connect();
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(21471, 901)");
      const rolePosition = await client.query<{ max_position: number }>(
        "SELECT COALESCE(MAX(position), 0)::integer AS max_position FROM roles WHERE system_key IS NULL"
      );
      const role = await client.query<{ id: string }>(
        "INSERT INTO roles (system_key, name, position, permissions) VALUES (NULL, $1, $2, '[]'::jsonb) RETURNING id::text AS id",
        [lowerRoleName, (rolePosition.rows[0]?.max_position ?? 0) + 1]
      );
      const channelPosition = await client.query<{ max_position: number }>(
        "SELECT COALESCE(MAX(position), 0)::integer AS max_position FROM channels"
      );
      const channel = await client.query<{ id: string }>(
        "INSERT INTO channels (name, position) VALUES ($1, $2) RETURNING id::text AS id",
        [channelName, (channelPosition.rows[0]?.max_position ?? 0) + 1]
      );
      const lowerRoleId = role.rows[0]?.id;
      const channelId = channel.rows[0]?.id;
      if (!lowerRoleId || !channelId) throw new Error("E2E channel access fixture could not be created");
      await client.query("COMMIT");
      await use({ channelId, channelName, lowerRoleId, lowerRoleName });
    } catch (error) {
      await client?.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client?.release();
      await pool.end();
    }
  },
  messagingSeed: async ({}, use) => {
    const suffix = randomBytes(6).toString("hex");
    const channelName = `e2e-messaging-${suffix}`;
    const managerRoleName = `e2e-messaging-manager-${suffix}`;
    const memberRoleName = `e2e-messaging-member-${suffix}`;
    const manager = {
      login: `fixture_e2e_msg_manager_${suffix}`,
      password: `E2E-manager-${randomBytes(18).toString("base64url")}`
    };
    const member = {
      login: `fixture_e2e_msg_member_${suffix}`,
      password: `E2E-member-${randomBytes(18).toString("base64url")}`
    };
    const databaseUrl = new URL(requiredEnvironment("TEST_DATABASE_URL"));
    const databaseName = decodeURIComponent(databaseUrl.pathname.slice(1));
    if (
      process.env.NODE_ENV !== "test" ||
      !["db", "localhost", "127.0.0.1", "[::1]"].includes(databaseUrl.hostname) ||
      !/^decentracord_test(?:_[a-z0-9_-]+)?$/u.test(databaseName) ||
      !databaseUrl.password
    ) {
      throw new Error("Messaging fixtures require the isolated test database");
    }

    const pool = new Pool({ connectionString: databaseUrl.toString(), max: 1, connectionTimeoutMillis: 3_000 });
    let client: Awaited<ReturnType<typeof pool.connect>> | undefined;
    let channelId: string | undefined;
    try {
      client = await pool.connect();
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(21471, 901)");
      const everyoneRole = await client.query<{ id: string }>(
        "SELECT id::text AS id FROM roles WHERE system_key = 'everyone'"
      );
      const everyoneRoleId = everyoneRole.rows[0]?.id;
      if (!everyoneRoleId) throw new Error("Messaging fixture could not find the everyone role");

      const positionResult = await client.query<{ max_position: number }>(
        "SELECT COALESCE(MAX(position), 0)::integer AS max_position FROM roles WHERE system_key IS NULL"
      );
      const firstRolePosition = (positionResult.rows[0]?.max_position ?? 0) + 1;
      const managerRoleResult = await client.query<{ id: string }>(
        "INSERT INTO roles (system_key, name, position, permissions) VALUES (NULL, $1, $2, $3::jsonb) RETURNING id::text AS id",
        [managerRoleName, firstRolePosition, JSON.stringify(["VIEW_CHANNEL", "SEND_MESSAGES", "MANAGE_MESSAGES"])]
      );
      const memberRoleResult = await client.query<{ id: string }>(
        "INSERT INTO roles (system_key, name, position, permissions) VALUES (NULL, $1, $2, $3::jsonb) RETURNING id::text AS id",
        [memberRoleName, firstRolePosition + 1, JSON.stringify(["VIEW_CHANNEL", "SEND_MESSAGES"])]
      );
      const managerRoleId = managerRoleResult.rows[0]?.id;
      const memberRoleId = memberRoleResult.rows[0]?.id;
      if (!managerRoleId || !memberRoleId) throw new Error("Messaging fixture roles could not be created");

      const channelPositionResult = await client.query<{ max_position: number }>(
        "SELECT COALESCE(MAX(position), 0)::integer AS max_position FROM channels"
      );
      const channelResult = await client.query<{ id: string }>(
        "INSERT INTO channels (name, position) VALUES ($1, $2) RETURNING id::text AS id",
        [channelName, (channelPositionResult.rows[0]?.max_position ?? 0) + 1]
      );
      channelId = channelResult.rows[0]?.id;
      if (!channelId) throw new Error("Messaging fixture channel could not be created");

      await client.query(
        `INSERT INTO channel_role_overrides (channel_id, role_id, permission, effect)
         VALUES
           ($1, $2, 'VIEW_CHANNEL', 'deny'),
           ($1, $2, 'SEND_MESSAGES', 'deny'),
           ($1, $3, 'VIEW_CHANNEL', 'allow'),
           ($1, $3, 'SEND_MESSAGES', 'allow'),
           ($1, $4, 'VIEW_CHANNEL', 'allow'),
           ($1, $4, 'SEND_MESSAGES', 'allow')`,
        [channelId, everyoneRoleId, managerRoleId, memberRoleId]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client?.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client?.release();
      await pool.end();
    }

    if (!channelId) throw new Error("Messaging fixture channel was not returned");
    createFixtureUser({ login: manager.login, password: manager.password, roleName: managerRoleName });
    createFixtureUser({ login: member.login, password: member.password, roleName: memberRoleName });
    await use({ channelId, channelName, manager, member });
  }
});

export { expect } from "@playwright/test";

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function writeComposeOverride(path: string, stateDirectory: string, imageTag: string): void {
  const lines = [
    "services:",
    "  app:",
    "    environment:",
    "      NODE_ENV: test",
    // Все браузерные контексты теста идут с одного адреса стека: поднимаем предел рукопожатий,
    // иначе поздние контексты группы получают 429 и остаются без сокета.
    '      DECENTRACORD_MAX_SOCKET_HANDSHAKES_PER_IP: "1000"',
    "    networks:",
    "      backend:",
    "        aliases:",
    "          - decentracord.test",
    "  e2e-runner:",
    "    build:",
    `      context: ${yamlString(projectRoot)}`,
    "      dockerfile: Dockerfile",
    "      target: e2e-runner",
    `    image: ${yamlString(imageTag)}`,
    "    environment:",
    "      NODE_ENV: test",
    "      E2E_BASE_URL: http://decentracord.test:3000",
    "      E2E_STAGE: before-restart",
    "      E2E_ORGANIZATION_NAME: ${E2E_ORGANIZATION_NAME}",
    "      E2E_ADMIN_LOGIN: ${E2E_ADMIN_LOGIN}",
    "      E2E_ADMIN_PASSWORD: ${E2E_ADMIN_PASSWORD}",
    "      E2E_EMPLOYEE_LOGIN: ${E2E_EMPLOYEE_LOGIN}",
    "      E2E_EMPLOYEE_PASSWORD: ${E2E_EMPLOYEE_PASSWORD}",
    "      E2E_STORAGE_STATE_PATH: /e2e-state/session.json",
    "      E2E_BOOTSTRAP_STORAGE_STATE_PATH: /e2e-state/bootstrap-session.json",
    "      DB_HOST: db",
    "      DB_PORT: \"5432\"",
    "      DB_NAME: ${DB_NAME}",
    "      DB_USER: ${DB_USER}",
    "      DB_PASSWORD_FILE: /run/secrets/db_password",
    "      TEST_DATABASE_URL: postgresql://${DB_USER}:${DB_PASSWORD}@db:5432/${DB_NAME}",
    "    secrets:",
    "      - db_password",
    "    volumes:",
    `      - ${yamlString(`${stateDirectory}:/e2e-state`)}`,
    "    depends_on:",
    "      app:",
    "        condition: service_healthy",
    "    networks:",
    "      - backend",
    ""
  ];
  writeFileSync(path, lines.join("\n"), { mode: 0o600 });
  chmodSync(path, 0o600);
}

function compose(projectName: string, envFile: string, overrideFile: string, args: string[], timeout = commandTimeoutMs) {
  return spawnSync(
    "docker",
    [
      "compose",
      "--project-name", projectName,
      "--env-file", envFile,
      "--file", join(projectRoot, "compose.yaml"),
      "--file", overrideFile,
      ...args
    ],
    {
      cwd: projectRoot,
      encoding: "utf8",
      env: process.env,
      maxBuffer: 4 * 1024 * 1024,
      timeout
    }
  );
}

function assertComposeSucceeded(
  result: ReturnType<typeof compose>,
  args: string[],
  allowFailure = false
): void {
  if (!allowFailure && (result.error || result.status !== 0)) {
    throw new Error(
      `docker compose ${args.join(" ")} failed with status ${result.status ?? "unknown"}: ${result.error?.message ?? ""}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`
    );
  }
}

function runCompose(projectName: string, envFile: string, overrideFile: string, args: string[], timeout = commandTimeoutMs): void {
  assertComposeSucceeded(compose(projectName, envFile, overrideFile, args, timeout), args);
}

function orchestrate(args: string[]): void {
  const fixtureDirectory = mkdtempSync(join(tmpdir(), "decentracord-e2e-"));
  const suffix = randomBytes(8).toString("hex");
  const projectName = `decentracord-e2e-${suffix}`;
  const imageTag = `decentracord-e2e-runner:${suffix}`;
  const databaseName = `decentracord_test_${suffix}`;
  const databaseUser = `e2e_${suffix.slice(0, 12)}`;
  const databasePassword = randomBytes(32).toString("base64url");
  const adminLogin = `e2e_admin_${suffix.slice(0, 12)}`;
  const adminPassword = `E2E-password-${randomBytes(18).toString("base64url")}`;
  const employeeLogin = `fixture_${suffix.slice(0, 12)}`;
  const employeePassword = `Issued-password-${randomBytes(18).toString("base64url")}`;
  const secretFile = join(fixtureDirectory, "db_password");
  const envFile = join(fixtureDirectory, "compose.env");
  const overrideFile = join(fixtureDirectory, "compose.e2e.yaml");
  const buildxConfig = join(fixtureDirectory, "buildx");
  const stateDirectory = join(fixtureDirectory, "state");
  mkdirSync(buildxConfig, { mode: 0o700 });
  mkdirSync(stateDirectory, { mode: 0o700 });
  writeFileSync(secretFile, databasePassword, { mode: 0o600 });
  chmodSync(secretFile, 0o600);
  writeFileSync(
    envFile,
    [
      `DB_PASSWORD_SECRET_FILE=${secretFile}`,
      `DB_PASSWORD=${databasePassword}`,
      `DB_NAME=${databaseName}`,
      `DB_USER=${databaseUser}`,
      `E2E_ADMIN_LOGIN=${adminLogin}`,
      `E2E_ADMIN_PASSWORD=${adminPassword}`,
      `E2E_EMPLOYEE_LOGIN=${employeeLogin}`,
      `E2E_EMPLOYEE_PASSWORD=${employeePassword}`,
      `E2E_ORGANIZATION_NAME=E2E-private-organization-${suffix}`,
      `E2E_STATE_DIRECTORY=${stateDirectory}`,
      "DB_CONNECT_TIMEOUT_MS=2500",
      ""
    ].join("\n"),
    { mode: 0o600 }
  );
  chmodSync(envFile, 0o600);
  writeComposeOverride(overrideFile, stateDirectory, imageTag);
  process.env.BUILDX_CONFIG = buildxConfig;
  process.env.npm_config_cache = "/tmp/decentracord-npm-cache";
  process.env.DOCKER_CLI_HINTS = "false";

  try {
    process.stdout.write("Building isolated app and browser test images.\n");
    const buildArgs = ["build", "app", "e2e-runner"];
    runCompose(projectName, envFile, overrideFile, buildArgs, 600_000);

    process.stdout.write("Starting isolated PostgreSQL and app containers.\n");
    const upArgs = ["up", "--detach", "--wait", "--wait-timeout", "120", "db", "app"];
    runCompose(projectName, envFile, overrideFile, upArgs, 240_000);

    process.stdout.write("Creating the administrator with the production CLI.\n");
    const bootstrapStdin = spawnSync(
      "docker",
      [
        "compose",
        "--project-name", projectName,
        "--env-file", envFile,
        "--file", join(projectRoot, "compose.yaml"),
        "--file", overrideFile,
        "run", "--rm", "--no-deps", "-T", "-i",
        "-e", `DB_NAME=${databaseName}`,
        "app", "bootstrap-admin", "--login", adminLogin
      ],
      {
        cwd: projectRoot,
        encoding: "utf8",
        env: process.env,
        input: `${adminPassword}\n`,
        maxBuffer: 2 * 1024 * 1024,
        timeout: commandTimeoutMs
      }
    );
    if (bootstrapStdin.error || bootstrapStdin.status !== 0) {
      throw new Error(
        `CLI bootstrap failed with status ${bootstrapStdin.status ?? "unknown"}: ${bootstrapStdin.error?.message ?? ""}\n${bootstrapStdin.stdout ?? ""}\n${bootstrapStdin.stderr ?? ""}`
      );
    }

    const specArgs = args.length > 0 ? args : ["tests/e2e"];
    const beforeRestartArgs = [
      "run", "--rm", "--no-deps", "e2e-runner",
      ...specArgs,
      "--grep-invert", restartTag
    ];
    process.stdout.write("Running browser login, employee, guest, and privacy checks.\n");
    try {
      runCompose(projectName, envFile, overrideFile, beforeRestartArgs, 300_000);
    } catch (error) {
      const appLogsArgs = ["logs", "--no-color", "app"];
      const appLogs = compose(projectName, envFile, overrideFile, appLogsArgs, 30_000);
      process.stderr.write(`App container logs:\n${appLogs.stdout ?? ""}${appLogs.stderr ?? ""}\n`);
      const probeArgs = [
        "run", "--rm", "--no-deps", "--entrypoint", "node", "e2e-runner", "-e",
        "fetch('http://app:3000/healthz').then(r => process.stdout.write(JSON.stringify({status:r.status, contentType:r.headers.get('content-type')}))).catch(e => { process.stderr.write(e.message); process.exitCode=1; })"
      ];
      const probe = compose(projectName, envFile, overrideFile, probeArgs, 30_000);
      process.stderr.write(`Test-container HTTP probe: ${probe.stdout ?? ""}${probe.stderr ?? ""}\n`);
      throw error;
    }

    const restartDatabaseArgs = ["restart", "db"];
    runCompose(projectName, envFile, overrideFile, restartDatabaseArgs, 120_000);
    const waitDatabaseArgs = ["up", "--detach", "--wait", "--wait-timeout", "120", "db"];
    runCompose(projectName, envFile, overrideFile, waitDatabaseArgs, 180_000);

    const restartAppArgs = ["restart", "app"];
    runCompose(projectName, envFile, overrideFile, restartAppArgs, 120_000);
    const waitAppArgs = ["up", "--detach", "--wait", "--wait-timeout", "120", "app"];
    runCompose(projectName, envFile, overrideFile, waitAppArgs, 180_000);

    const afterRestartArgs = [
      "run", "--rm", "--no-deps", "--env", "E2E_STAGE=after-restart", "e2e-runner",
      ...specArgs,
      "--grep", restartTag
    ];
    process.stdout.write("Checking the authenticated browser session after app and database restart.\n");
    runCompose(projectName, envFile, overrideFile, afterRestartArgs, 180_000);
  } finally {
    const downArgs = ["down", "--volumes", "--remove-orphans", "--rmi", "local"];
    const cleanup = compose(projectName, envFile, overrideFile, downArgs, 120_000);
    if (cleanup.error || cleanup.status !== 0) {
      process.stderr.write(`docker compose ${downArgs.join(" ")} cleanup failed: ${cleanup.error?.message ?? cleanup.stderr ?? "unknown error"}\n`);
    }
    rmSync(fixtureDirectory, { recursive: true, force: true });
  }
}

function runExternalStack(args: string[]): void {
  if (args.length !== 0) throw new Error("External TLS runner receives specs through TEST_SPECS_JSON");
  const testOrigin = requiredEnvironment("TEST_ORIGIN");
  const runDirectory = requiredEnvironment("TEST_RUN_DIR");
  const projectName = requiredEnvironment("TEST_COMPOSE_PROJECT");
  if (
    process.env.NODE_ENV !== "test" || testOrigin !== "https://proxy:443" ||
    !/^\/tmp\/decentracord-tls-[A-Za-z0-9]+$/u.test(runDirectory) ||
    !/^decentracord-tls-[a-z0-9][a-z0-9_-]{0,28}-[a-f0-9]{16}$/u.test(projectName) ||
    requiredEnvironment("E2E_EXTERNAL_STACK") !== "1" ||
    requiredEnvironment("NODE_EXTRA_CA_CERTS") !== requiredEnvironment("TEST_CA_FILE") ||
    requiredEnvironment("TEST_CA_FILE") !== "/test-ca/ca.crt" ||
    requiredEnvironment("TEST_UNTRUSTED_CA_FILE") !== "/test-ca/untrusted-ca.crt"
  ) {
    throw new Error("TLS test origin or CA configuration is invalid");
  }

  process.env.E2E_BASE_URL = testOrigin;
  setRunnerTestDatabaseUrl();
  installRunnerTrust();
  runLocalCommand(process.execPath, ["scripts/verify-install.mjs"]);
  runLocalCommand("npm", ["run", "test:e2e:playwright", "--", ...runnerSpecs()]);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    if (process.env.E2E_EXTERNAL_STACK === "1") runExternalStack(process.argv.slice(2));
    else orchestrate(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : "e2e orchestration failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
