import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const composeFile = join(projectRoot, "compose.test.yaml");
const commandTimeoutMs = 600_000;
let activeChild;
let interruptedSignal;
let cleaning = false;

class CommandFailure extends Error {
  constructor(exitCode) {
    super("TLS test command failed");
    this.exitCode = exitCode;
  }
}

function fail(code) {
  throw new Error(code);
}

function parseArguments(args) {
  let project;
  const specs = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--project" && project === undefined) {
      project = args[index + 1];
      index += 1;
    } else if (argument === "--spec") {
      specs.push(args[index + 1]);
      index += 1;
    } else {
      fail("INVALID_ARGUMENTS");
    }
  }

  if (!project || !/^decentracord-tls-[a-z0-9][a-z0-9_-]{0,28}$/u.test(project)) {
    fail("TLS_PROJECT_PREFIX_REQUIRED");
  }
  if (specs.length === 0 || specs.length > 32) fail("TLS_SPEC_REQUIRED");

  const uniqueSpecs = [...new Set(specs)];
  const specRoot = resolve(projectRoot, "tests/e2e");
  for (const spec of uniqueSpecs) {
    const resolvedSpec = typeof spec === "string" ? resolve(projectRoot, spec) : "";
    if (
      typeof spec !== "string" || !/^tests\/e2e(?:\/[A-Za-z0-9._-]+)*$/u.test(spec) ||
      spec.split("/").includes("..") ||
      (resolvedSpec !== specRoot && !resolvedSpec.startsWith(`${specRoot}/`))
    ) {
      fail("TLS_SPEC_INVALID");
    }
  }
  return { project, specs: uniqueSpecs };
}

function assertProjectUnused(project) {
  const result = spawnSync("docker", [
    "ps", "--all", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.ID}}"
  ], {
    cwd: projectRoot,
    encoding: "utf8",
    shell: false,
    timeout: 30_000
  });
  if (result.error || result.status !== 0) fail("DOCKER_UNAVAILABLE");
  if ((result.stdout ?? "").trim()) fail("TLS_PROJECT_ALREADY_IN_USE");
}

function composeArguments(project, envFile, args) {
  return [
    "compose", "--project-name", project, "--env-file", envFile, "--file", composeFile,
    ...args
  ];
}

async function run(command, args, { input = "", timeoutMs = commandTimeoutMs, env = process.env } = {}) {
  if (interruptedSignal && !cleaning) throw new CommandFailure(interruptedSignal === "SIGINT" ? 130 : 143);

  await new Promise((resolvePromise, rejectPromise) => {
    let spawnError;
    let timedOut = false;
    const child = spawn(command, args, {
      cwd: projectRoot,
      env,
      shell: false,
      stdio: ["pipe", "inherit", "inherit"]
    });
    activeChild = child;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.once("error", (error) => { spawnError = error; });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (activeChild === child) activeChild = undefined;
      if (spawnError) {
        rejectPromise(new Error("DOCKER_COMMAND_UNAVAILABLE"));
      } else if (timedOut) {
        rejectPromise(new CommandFailure(124));
      } else if (interruptedSignal && !cleaning) {
        rejectPromise(new CommandFailure(interruptedSignal === "SIGINT" ? 130 : 143));
      } else if (code !== 0) {
        const signalCode = signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1;
        rejectPromise(new CommandFailure(code ?? signalCode));
      } else {
        resolvePromise();
      }
    });

    child.stdin.end(input);
  });
}

function compose(project, envFile, args, options = {}) {
  return run("docker", composeArguments(project, envFile, args), options);
}

function writePrivateFile(path, content) {
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function writeComposeEnvironment(directory, values) {
  const environmentPath = join(directory, "compose.env");
  const content = Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n") + "\n";
  writePrivateFile(environmentPath, content);
  return environmentPath;
}

function verifyNoProjectResources(project) {
  const checks = [
    ["ps", "--all", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.ID}}"],
    ["network", "ls", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.ID}}"],
    ["volume", "ls", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.Name}}"]
  ];

  for (const args of checks) {
    const result = spawnSync("docker", args, {
      cwd: projectRoot,
      encoding: "utf8",
      shell: false,
      timeout: 30_000
    });
    if (result.error || result.status !== 0 || (result.stdout ?? "").trim()) {
      fail("TLS_CLEANUP_VERIFICATION_FAILED");
    }
  }
}

function onSignal(signal) {
  if (cleaning || interruptedSignal) return;
  interruptedSignal = signal;
  activeChild?.kill(signal);
}

async function main() {
  let runDirectory;
  let environmentPath;
  let projectName;
  let exitCode = 0;
  let failure;
  const cleanupErrors = [];

  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    const { project: baseProject, specs } = parseArguments(process.argv.slice(2));
    assertProjectUnused(baseProject);

    const runId = randomBytes(8).toString("hex");
    projectName = `${baseProject}-${runId}`;
    assertProjectUnused(projectName);

    runDirectory = mkdtempSync("/tmp/decentracord-tls-");
    chmodSync(runDirectory, 0o700);
    const buildxDirectory = join(runDirectory, "buildx");
    mkdirSync(buildxDirectory, { mode: 0o700 });
    chmodSync(buildxDirectory, 0o700);

    const databasePassword = randomBytes(32).toString("base64url");
    const adminLogin = `e2e_admin_${runId.slice(0, 12)}`;
    const adminPassword = `TLS-admin-${randomBytes(24).toString("base64url")}`;
    const employeeLogin = `fixture_${runId.slice(0, 12)}`;
    const employeePassword = `TLS-issued-${randomBytes(24).toString("base64url")}`;
    const dbPasswordFile = join(runDirectory, "db_password");
    const dbCredentialsFile = join(runDirectory, "test_db_credentials.json");
    writePrivateFile(dbPasswordFile, databasePassword);
    writePrivateFile(dbCredentialsFile, JSON.stringify({ user: "decentracord", password: databasePassword }));

    process.env.BUILDX_CONFIG = buildxDirectory;
    process.env.npm_config_cache = "/tmp/decentracord-npm-cache";
    process.env.DOCKER_CLI_HINTS = "false";
    process.env.TEST_SPECS_JSON = JSON.stringify(specs);
    process.env.TEST_RUN_DIR = runDirectory;
    process.env.TEST_COMPOSE_PROJECT = projectName;
    process.env.TEST_ORIGIN = "https://proxy:443";
    process.env.E2E_EXTERNAL_STACK = "1";
    process.env.NODE_ENV = "test";

    environmentPath = writeComposeEnvironment(runDirectory, {
      TEST_RUN_DIR: runDirectory,
      TEST_COMPOSE_PROJECT: projectName,
      TEST_ORIGIN: "https://proxy:443",
      E2E_EXTERNAL_STACK: "1",
      NODE_ENV: "test",
      TEST_SPECS_JSON: JSON.stringify(specs),
      TLS_DB_PASSWORD_FILE: dbPasswordFile,
      TLS_DB_CREDENTIALS_FILE: dbCredentialsFile,
      TLS_SERVER_CERT_FILE: join(runDirectory, "server.crt"),
      TLS_SERVER_KEY_FILE: join(runDirectory, "server.key"),
      TLS_CA_CERT_FILE: join(runDirectory, "ca.crt"),
      TLS_UNTRUSTED_CA_CERT_FILE: join(runDirectory, "untrusted-ca.crt"),
      E2E_ADMIN_LOGIN: adminLogin,
      E2E_ADMIN_PASSWORD: adminPassword,
      E2E_EMPLOYEE_LOGIN: employeeLogin,
      E2E_EMPLOYEE_PASSWORD: employeePassword,
      E2E_ORGANIZATION_NAME: "Организация"
    });

    await run(process.execPath, ["scripts/tls-fixture.mjs", "prepare", "--dir", runDirectory], { timeoutMs: 120_000 });
    process.stdout.write(`Building and starting isolated TLS test stack ${projectName}.\n`);
    await compose(projectName, environmentPath, [
      "up", "--detach", "--build", "--wait", "--wait-timeout", "180", "db", "app", "proxy"
    ], { timeoutMs: 900_000 });

    process.stdout.write("Creating the isolated administrator through the production CLI.\n");
    await compose(projectName, environmentPath, [
      "run", "--rm", "--no-deps", "-T", "-i", "--entrypoint", "node", "app",
      "apps/server/dist/cli.js", "bootstrap-admin", "--login", adminLogin
    ], { input: `${adminPassword}\n`, timeoutMs: 180_000 });

    process.stdout.write("Running trusted TLS, cookie, Socket.IO, and revocation checks inside the test runner.\n");
    await compose(projectName, environmentPath, ["run", "--rm", "runner"], { timeoutMs: 900_000 });
  } catch (error) {
    failure = error;
    exitCode = error instanceof CommandFailure ? error.exitCode : 1;
    const message = error instanceof Error && /^[A-Z0-9_]+$/u.test(error.message) ? error.message : "TLS_TEST_FAILED";
    process.stderr.write(`${message}\n`);
  } finally {
    cleaning = true;
    if (projectName && environmentPath) {
      try {
        process.stdout.write("Cleaning only the isolated TLS Compose project.\n");
        await compose(projectName, environmentPath, ["down", "--volumes", "--remove-orphans"], { timeoutMs: 180_000 });
        verifyNoProjectResources(projectName);
      } catch (error) {
        cleanupErrors.push(error);
        process.stderr.write("TLS Compose cleanup failed for the isolated project.\n");
      }
    }
    if (runDirectory) {
      try {
        rmSync(runDirectory, { recursive: true, force: true });
        if (existsSync(runDirectory)) fail("TLS_RUN_DIRECTORY_CLEANUP_FAILED");
      } catch (error) {
        cleanupErrors.push(error);
        process.stderr.write("TLS temporary run-directory cleanup failed.\n");
      }
    }
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }

  if (interruptedSignal) exitCode = interruptedSignal === "SIGINT" ? 130 : 143;
  else if (cleanupErrors.length > 0 && exitCode === 0) exitCode = 1;
  else if (!failure && exitCode === 0) process.stdout.write("TLS project resources and temporary run directory removed.\n");
  process.exitCode = exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write("TLS_TEST_FAILED\n");
    process.exitCode = 1;
  });
}
