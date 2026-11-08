import { randomBytes } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test as base } from "@playwright/test";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const commandTimeoutMs = 180_000;
const restartTag = "@session-after-restart";

export interface TestIdentity {
  admin: { login: string; password: string };
  employee?: { login: string; password: string };
  organizationName: string;
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

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Required e2e environment value is missing: ${name}`);
  return value;
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

export const test = base.extend<object, E2EFixtures>({
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
  }, { scope: "worker" }]
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
      "E2E_ORGANIZATION_NAME=Организация",
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
