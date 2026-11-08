import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import { SessionRevocationService } from "../../apps/server/src/auth/session-revocation.service.js";
import type { SessionService } from "../../apps/server/src/auth/session.service.js";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const commandTimeoutMs = 180_000;
const inContainer = process.env.DEPLOYMENT_CONFIG_TEST_IN_CONTAINER === "true";
const baseUrl = process.env.DEPLOYMENT_CONFIG_TEST_BASE_URL ?? "http://app:3000";

interface ComposeService {
  ports?: Array<{ target: number; published: string; protocol?: string }>;
  networks?: Record<string, unknown>;
  secrets?: Array<string | { source: string }>;
  profiles?: string[];
  environment?: Record<string, string | boolean>;
}

interface ComposeConfig {
  services: Record<string, ComposeService>;
  networks: Record<string, { internal?: boolean }>;
  secrets: Record<string, { file: string }>;
}

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

function assertComposeSucceeded(
  result: ReturnType<typeof compose>,
  args: string[],
  secretValue: string
): void {
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.replaceAll(secretValue, "[redacted]");
  assert.equal(result.status, 0, `docker compose ${args.join(" ")} failed: ${result.error?.message ?? ""}\n${output}`);
  assert.equal(output.includes(secretValue), false, "Compose output must not include the database secret");
}

function secretSources(service: ComposeService | undefined): string[] {
  return (service?.secrets ?? []).map((secret) => (typeof secret === "string" ? secret : secret.source));
}

if (!inContainer) {
  describe("production deployment configuration", () => {
    let fixtureDirectory = "";
    let projectName = "";
    let envFile = "";
    let overrideFile = "";
    let buildxConfig = "";
    let secretValue = "";

    function run(args: string[], timeout = commandTimeoutMs) {
      return compose(projectName, envFile, overrideFile, args, timeout);
    }

    beforeAll(() => {
      fixtureDirectory = mkdtempSync(join(tmpdir(), "decentracord-deployment-config-"));
      const suffix = randomBytes(6).toString("hex");
      projectName = `decentracord-deployment-config-${suffix}`;
      const databaseName = `decentracord_test_${suffix}`;
      const databaseUser = `deploy_test_${suffix.slice(0, 10)}`;
      secretValue = randomBytes(32).toString("base64url");
      const secretFile = join(fixtureDirectory, "db_password");
      envFile = join(fixtureDirectory, "compose.env");
      overrideFile = join(fixtureDirectory, "compose.deployment-test.yaml");
      buildxConfig = join(fixtureDirectory, "buildx");
      mkdirSync(buildxConfig, { mode: 0o700 });
      writeFileSync(secretFile, secretValue, { mode: 0o600 });
      chmodSync(secretFile, 0o600);
      writeFileSync(
        envFile,
        [
          `DB_PASSWORD_SECRET_FILE=${secretFile}`,
          `DB_NAME=${databaseName}`,
          `DB_USER=${databaseUser}`,
          "DB_CONNECT_TIMEOUT_MS=2500",
          "PUBLIC_HOST=decentracord.example",
          "APP_ORIGIN=https://decentracord.example",
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
          "    environment:",
          "      NODE_ENV: production",
          "  test-runner:",
          "    build:",
          `      context: ${JSON.stringify(projectRoot)}`,
          "      dockerfile: Dockerfile",
          "      target: test-runner",
          `    image: ${JSON.stringify(`decentracord-deployment-test-runner:${suffix}`)}`,
          '    entrypoint: ["npm", "run", "test:integration", "--", "tests/integration/deployment-config.test.ts"]',
          "    environment:",
          "      DEPLOYMENT_CONFIG_TEST_BASE_URL: http://app:3000",
          "      DEPLOYMENT_CONFIG_TEST_IN_CONTAINER: \"true\"",
          "    networks:",
          "      - backend",
          "    depends_on:",
          "      app:",
          "        condition: service_healthy",
          ""
        ].join("\n"),
        { mode: 0o600 }
      );
      chmodSync(overrideFile, 0o600);
      process.env.BUILDX_CONFIG = buildxConfig;
      process.env.npm_config_cache = "/tmp/decentracord-npm-cache";
      process.env.DOCKER_CLI_HINTS = "false";
    }, 30_000);

    afterAll(() => {
      if (!fixtureDirectory) return;
      const downArgs = ["down", "--volumes", "--remove-orphans", "--rmi", "local"];
      const result = projectName && envFile && overrideFile ? run(downArgs, 120_000) : undefined;
      rmSync(fixtureDirectory, { recursive: true, force: true });
      if (result) assertComposeSucceeded(result, downArgs, secretValue);
    });

    it("keeps only the HTTPS proxy public and validates its deployment config", () => {
      expect(statSync(join(fixtureDirectory, "db_password")).mode & 0o777).toBe(0o600);

      const configArgs = ["config", "--format", "json"];
      const configResult = run(configArgs);
      assertComposeSucceeded(configResult, configArgs, secretValue);
      const config = JSON.parse(configResult.stdout) as ComposeConfig;
      const app = config.services.app;
      const db = config.services.db;
      const proxy = config.services.proxy;
      const dockerIgnore = readFileSync(join(projectRoot, ".dockerignore"), "utf8").split(/\r?\n/u);
      const envExample = readFileSync(join(projectRoot, ".env.example"), "utf8");

      expect(proxy).toBeDefined();
      expect(proxy?.profiles).toBeUndefined();
      expect(proxy?.environment?.PUBLIC_HOST).toBe("decentracord.example");
      expect(app?.environment?.PUBLIC_HOST).toBe("decentracord.example");
      expect(app?.environment?.APP_ORIGIN).toBe("https://decentracord.example");
      expect(app?.ports).toBeUndefined();
      expect(db?.ports).toBeUndefined();
      expect(config.networks.backend?.internal).toBe(true);
      expect(Object.keys(proxy?.networks ?? {}).sort()).toEqual(["backend", "edge"]);
      expect(Object.keys(app?.networks ?? {})).toEqual(["backend"]);
      expect(Object.keys(db?.networks ?? {})).toEqual(["backend"]);
      expect(secretSources(app)).toContain("db_password");
      expect(secretSources(db)).toContain("db_password");
      expect(secretSources(proxy)).not.toContain("db_password");
      const databaseSecret = config.secrets.db_password;
      assert.ok(databaseSecret, "Compose must define the database secret source");
      expect(databaseSecret.file).toBe(join(fixtureDirectory, "db_password"));
      expect(
        (proxy?.ports ?? []).map((port) => `${port.target}/${port.protocol ?? "tcp"}`).sort()
      ).toEqual(["443/tcp", "443/udp", "80/tcp"]);
      expect(app?.ports).toBeUndefined();
      expect(db?.ports).toBeUndefined();
      expect(JSON.stringify(config)).not.toContain(secretValue);
      expect(dockerIgnore).toContain(".env");
      expect(dockerIgnore).toContain(".env.*");
      expect(dockerIgnore).toContain("secrets");
      expect(envExample).not.toMatch(/^DB_PASSWORD=/mu);
      expect(envExample).not.toMatch(/^SESSION_SECRET=/mu);

      const caddyArgs = [
        "run",
        "--rm",
        "--no-deps",
        "-T",
        "proxy",
        "caddy",
        "validate",
        "--config",
        "/etc/caddy/Caddyfile",
        "--adapter",
        "caddyfile"
      ];
      const caddyResult = run(caddyArgs, 120_000);
      assertComposeSucceeded(caddyResult, caddyArgs, secretValue);

      const buildArgs = ["build", "app", "test-runner"];
      assertComposeSucceeded(run(buildArgs, 600_000), buildArgs, secretValue);
      const dbArgs = ["up", "--detach", "--wait", "--wait-timeout", "90", "db"];
      assertComposeSucceeded(run(dbArgs, 180_000), dbArgs, secretValue);
      const appArgs = ["up", "--detach", "--wait", "--wait-timeout", "90", "app"];
      assertComposeSucceeded(run(appArgs, 180_000), appArgs, secretValue);
      const runnerArgs = ["run", "--rm", "--no-deps", "-T", "test-runner"];
      assertComposeSucceeded(run(runnerArgs, 180_000), runnerArgs, secretValue);
    }, 900_000);
  }, 900_000);
} else {
  describe("production HTTP security headers", () => {
    it("sets privacy headers, bounds API errors, and keeps secure pre-auth cookies", async () => {
      const response = await fetch(new URL("/healthz", baseUrl), {
        headers: { "x-forwarded-proto": "https" }
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("x-powered-by")).toBeNull();
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("strict-transport-security")).toContain("max-age=");
      expect(response.headers.get("content-security-policy")).toContain("connect-src 'self'");
      expect(response.headers.get("content-security-policy")).toContain("wss://decentracord.example");

      const csrf = await fetch(new URL("/api/auth/csrf", baseUrl), {
        headers: { "x-forwarded-proto": "https" }
      });
      expect(csrf.status).toBe(200);
      const csrfBody = (await csrf.json()) as { csrfToken?: unknown };
      expect(typeof csrfBody.csrfToken).toBe("string");
      const cookie = csrf.headers.get("set-cookie") ?? "";
      expect(cookie).toMatch(/^__Host-decentracord\.sid=/u);
      expect(cookie).toMatch(/; Path=\//iu);
      expect(cookie).toMatch(/; HttpOnly(?:;|$)/iu);
      expect(cookie).toMatch(/; Secure(?:;|$)/iu);
      expect(cookie).toMatch(/; SameSite=Lax(?:;|$)/iu);
      expect(cookie).not.toMatch(/; Domain=/iu);

      const oversizedBody = JSON.stringify({ login: "BOUNDARY-MARKER".repeat(3_000), password: "unused" });
      const oversized = await fetch(new URL("/api/auth/login", baseUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-proto": "https"
        },
        body: oversizedBody
      });
      expect(oversized.status).toBe(413);
      expect(oversized.headers.get("cache-control")).toContain("no-store");
      const errorBody = await oversized.text();
      expect(errorBody.length).toBeLessThan(512);
      expect(errorBody).not.toContain("BOUNDARY-MARKER");
      expect(errorBody).toContain("PAYLOAD_TOO_LARGE");
    });

    it("rejects Socket.IO requests whose Host and Origin disagree with APP_ORIGIN", () => {
      const previousNodeEnv = process.env.NODE_ENV;
      const previousAppOrigin = process.env.APP_ORIGIN;
      process.env.NODE_ENV = "production";
      process.env.APP_ORIGIN = "https://decentracord.example";
      try {
        const revocations = new SessionRevocationService({} as SessionService);
        const request = {
          method: "GET",
          url: "/socket.io/?EIO=4&transport=polling",
          headers: {
            host: "decentracord.example",
            origin: "https://decentracord.example",
            "x-forwarded-proto": "https"
          },
          socket: { remoteAddress: "127.0.0.1" }
        } as unknown as IncomingMessage;
        const spoofedHost = {
          method: "GET",
          url: "/socket.io/?EIO=4&transport=polling",
          headers: {
            host: "attacker.example",
            origin: "https://attacker.example",
            "x-forwarded-proto": "https"
          },
          socket: { remoteAddress: "127.0.0.1" }
        } as unknown as IncomingMessage;

        expect(revocations.admitTransportRequest(request).allowed).toBe(true);
        expect(revocations.admitTransportRequest(spoofedHost)).toEqual({ allowed: false, status: 403 });
      } finally {
        if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = previousNodeEnv;
        if (previousAppOrigin === undefined) delete process.env.APP_ORIGIN;
        else process.env.APP_ORIGIN = previousAppOrigin;
      }
    });
  });
}
