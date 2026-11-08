import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const commandTimeoutMs = 60_000;

function compose(projectName: string, envFile: string, buildxConfig: string, args: string[], timeout = commandTimeoutMs) {
  return spawnSync(
    "docker",
    ["compose", "--project-name", projectName, "--env-file", envFile, ...args],
    {
      cwd: projectRoot,
      encoding: "utf8",
      timeout,
      env: { ...process.env, BUILDX_CONFIG: buildxConfig, DOCKER_CLI_HINTS: "false" }
    }
  );
}

function assertCommandSucceeded(result: ReturnType<typeof compose>, args: string[]) {
  assert.equal(
    result.status,
    0,
    `docker compose ${args.join(" ")} failed: ${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr}`
  );
}

function lastJsonLine(output: string) {
  const line = output
    .split(/\r?\n/u)
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate.startsWith("{"))
    .at(-1);

  assert.ok(line, `expected a JSON response, received: ${output}`);
  return JSON.parse(line) as unknown;
}

test(
  "Compose CLI doctor checks a healthy PostgreSQL database and bounds safe failures",
  { timeout: 180_000 },
  async (context) => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "decentracord-installation-doctor-"));
    const projectName = `decentracord-doctor-${randomBytes(8).toString("hex")}`;
    const secret = randomBytes(24).toString("base64url");
    const secretFile = join(fixtureDir, "db_password");
    const envFile = join(fixtureDir, "compose.env");
    const buildxConfig = join(fixtureDir, "buildx");
    mkdirSync(buildxConfig, { mode: 0o700 });
    writeFileSync(secretFile, secret, { mode: 0o600 });
    chmodSync(secretFile, 0o600);
    writeFileSync(
      envFile,
      [
        `DB_PASSWORD_SECRET_FILE=${secretFile}`,
        "DB_NAME=decentracord_test",
        "DB_USER=doctor_test",
        "DB_CONNECT_TIMEOUT_MS=2500",
        ""
      ].join("\n"),
      { mode: 0o600 }
    );

    const run = (args: string[], timeout = commandTimeoutMs) => compose(projectName, envFile, buildxConfig, args, timeout);
    const doctor = ["run", "--rm", "--no-deps", "app", "doctor"];

    try {
      const build = ["build", "app"];
      assertCommandSucceeded(run(build), build);

      const coldStart = ["up", "-d", "--wait", "--wait-timeout", "60", "db"];
      assertCommandSucceeded(run(coldStart), coldStart);

      await context.test("cold start returns the minimal readiness response", () => {
        const result = run(doctor);
        assertCommandSucceeded(result, doctor);
        assert.deepEqual(lastJsonLine(result.stdout), { ok: true });
      });

      const restart = ["restart", "db"];
      assertCommandSucceeded(run(restart), restart);
      assertCommandSucceeded(run(coldStart), coldStart);

      await context.test("restart remains ready", () => {
        const result = run(doctor);
        assertCommandSucceeded(result, doctor);
        assert.deepEqual(lastJsonLine(result.stdout), { ok: true });
      });

      await context.test("unavailable database fails quickly without credentials", () => {
        const startedAt = Date.now();
        const result = run(
          ["run", "--rm", "--no-deps", "-e", "DB_HOST=127.0.0.1", "-e", "DB_PORT=1", "app", "doctor"],
          10_000
        );
        const elapsedMs = Date.now() - startedAt;
        const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;

        assert.equal(result.error, undefined, `doctor exceeded the host timeout: ${result.error?.message ?? ""}`);
        assert.equal(result.status, 1, output);
        assert.ok(elapsedMs < 8_000, `doctor took ${elapsedMs}ms for an unavailable database`);
        assert.deepEqual(lastJsonLine(output), { ok: false, code: "DATABASE_UNAVAILABLE" });
        assert.ok(!output.includes(secret), "doctor output leaked the database password");
        assert.ok(!output.includes("doctor_test"), "doctor output leaked database credentials");
      });
    } finally {
      const down = run(["down", "--volumes", "--remove-orphans"]);
      rmSync(fixtureDir, { recursive: true, force: true });
      assertCommandSucceeded(down, ["down", "--volumes", "--remove-orphans"]);
    }
  }
);
