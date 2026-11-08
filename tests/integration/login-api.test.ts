import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const commandTimeoutMs = 180_000;
const adminLogin = "owner.one";
const adminPassword = "NotOnTheCommandLine-123";
const isContainerRunner = process.env.LOGIN_API_TEST_IN_CONTAINER === "true";

function noStore(response: Response): void {
  expect(response.headers.get("cache-control")).toContain("private");
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("pragma")).toBe("no-cache");
}

function sessionCookie(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie, "response did not set a session cookie");
  return setCookie.split(";", 1)[0] ?? "";
}

function assertSessionCookie(response: Response, secure: boolean): string {
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie, "response did not set a session cookie");
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("SameSite=Lax");
  expect(setCookie).toContain("Path=/");
  expect(setCookie.includes("Secure")).toBe(secure);
  if (secure) expect(setCookie).toMatch(/^__Host-decentracord\.sid=/u);
  expect(setCookie.toLowerCase()).not.toContain("domain=");
  return sessionCookie(response);
}

function apiError(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.ok(value !== null);
  const error = (value as { error?: unknown }).error;
  assert.equal(typeof error, "object");
  assert.ok(error !== null);
  return error as Record<string, unknown>;
}

async function waitForHealth(origin: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL("/healthz", origin), { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
      lastError = new Error(`health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`application did not become healthy: ${String(lastError)}`);
}

if (isContainerRunner) {
  const origin = process.env.LOGIN_API_TEST_ORIGIN ?? "http://app:3000";
  const publicOrigin = process.env.LOGIN_API_TEST_PUBLIC_ORIGIN ?? "https://app:3000";
  const statePath = process.env.LOGIN_API_TEST_STATE ?? "/test-state/session.json";
  const phase = process.env.LOGIN_API_TEST_PHASE ?? "initial";

  function sendApiRequest(
    path: string,
    options: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal } = {}
  ): Promise<Response> {
    return new Promise((resolve, reject) => {
      const request = httpRequest(
        new URL(path, origin),
        {
          method: options.method ?? "GET",
          headers: { ...options.headers, host: new URL(publicOrigin).host, "x-forwarded-proto": "https" },
          signal: options.signal
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
          response.on("error", reject);
          response.on("end", () => {
            const headers = new Headers();
            for (const [name, value] of Object.entries(response.headers)) {
              if (value === undefined) continue;
              for (const part of Array.isArray(value) ? value : [value]) headers.append(name, part);
            }
            resolve(new Response(Buffer.concat(chunks), { status: response.statusCode ?? 500, headers }));
          });
        }
      );
      request.on("error", reject);
      request.end(options.body);
    });
  }

  describe("HTTP login API inside the private Compose network", () => {
    it("protects private data, rotates a persistent cookie, and survives restart", async () => {
      await waitForHealth(origin);

      if (phase === "after-restart") {
        const state = JSON.parse(readFileSync(statePath, "utf8")) as { cookie: string };
        assert.ok(state.cookie.length > 0);

        const meResponse = await sendApiRequest("/api/auth/me", {
          headers: { cookie: state.cookie },
          signal: AbortSignal.timeout(5_000)
        });
        noStore(meResponse);
        expect(meResponse.status).toBe(200);
        expect(await meResponse.json()).toMatchObject({ login: adminLogin });

        const organizationResponse = await sendApiRequest("/api/organization", {
          headers: { cookie: state.cookie },
          signal: AbortSignal.timeout(5_000)
        });
        noStore(organizationResponse);
        expect(organizationResponse.status).toBe(200);
        expect(await organizationResponse.json()).toEqual({ name: "Организация" });
        return;
      }

      const guestShell = await sendApiRequest("/");
      expect(guestShell.status).toBe(200);
      expect(guestShell.headers.get("content-type")).toContain("text/html");
      const guestShellHtml = await guestShell.text();
      expect(guestShellHtml).toContain('id="root"');
      expect(guestShellHtml).not.toContain("Организация");
      expect(guestShellHtml).not.toContain(adminLogin);

      const guestMe = await sendApiRequest("/api/auth/me");
      noStore(guestMe);
      expect(guestMe.status).toBe(401);
      expect(apiError(await guestMe.json()).code).toBe("UNAUTHORIZED");

      const guestOrganization = await sendApiRequest("/api/organization");
      noStore(guestOrganization);
      expect(guestOrganization.status).toBe(401);

      const unknownApi = await sendApiRequest("/api/not-a-route");
      noStore(unknownApi);
      expect(unknownApi.status).toBe(401);
      expect(unknownApi.headers.get("content-type")).toContain("application/json");

      const csrfResponse = await sendApiRequest("/api/auth/csrf");
      noStore(csrfResponse);
      expect(csrfResponse.status).toBe(200);
      const csrfCookie = assertSessionCookie(csrfResponse, true);
      const csrfBody = (await csrfResponse.json()) as { csrfToken: string };
      expect(csrfBody.csrfToken.length).toBeGreaterThan(20);

      const wrongOrigin = await sendApiRequest("/api/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: csrfCookie,
          origin: "http://attacker.invalid",
          "x-csrf-token": csrfBody.csrfToken
        },
        body: JSON.stringify({ login: adminLogin, password: adminPassword })
      });
      noStore(wrongOrigin);
      expect(wrongOrigin.status).toBe(403);
      expect(apiError(await wrongOrigin.json()).code).toBe("CSRF_FAILED");

      const wrongToken = await sendApiRequest("/api/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: csrfCookie,
          origin: publicOrigin,
          "x-csrf-token": "incorrect-token"
        },
        body: JSON.stringify({ login: adminLogin, password: adminPassword })
      });
      noStore(wrongToken);
      expect(wrongToken.status).toBe(403);
      expect(apiError(await wrongToken.json()).code).toBe("CSRF_FAILED");

      const wrongPassword = await sendApiRequest("/api/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: csrfCookie,
          origin: publicOrigin,
          "x-csrf-token": csrfBody.csrfToken
        },
        body: JSON.stringify({ login: adminLogin, password: "IncorrectPassword-123" })
      });
      noStore(wrongPassword);
      expect(wrongPassword.status).toBe(401);
      const wrongPasswordError = await wrongPassword.json();
      expect(apiError(wrongPasswordError).code).toBe("UNAUTHORIZED");

      const unknownLogin = await sendApiRequest("/api/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: csrfCookie,
          origin: publicOrigin,
          "x-csrf-token": csrfBody.csrfToken
        },
        body: JSON.stringify({ login: "missing.user", password: "IncorrectPassword-123" })
      });
      noStore(unknownLogin);
      expect(unknownLogin.status).toBe(401);
      expect(await unknownLogin.json()).toEqual(wrongPasswordError);

      const oversizedBody = await sendApiRequest("/api/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: csrfCookie,
          origin: publicOrigin,
          "x-csrf-token": csrfBody.csrfToken
        },
        body: JSON.stringify({ login: adminLogin, password: "x".repeat(33_000) })
      });
      noStore(oversizedBody);
      expect(oversizedBody.status).toBe(413);

      const loginResponse = await sendApiRequest("/api/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: csrfCookie,
          origin: publicOrigin,
          "x-csrf-token": csrfBody.csrfToken
        },
        body: JSON.stringify({ login: adminLogin, password: adminPassword })
      });
      noStore(loginResponse);
      expect(loginResponse.status).toBe(200);
      const loggedInCookie = assertSessionCookie(loginResponse, true);
      expect(loggedInCookie).not.toBe(csrfCookie);

      const loginBody = (await loginResponse.json()) as { user: Record<string, unknown>; csrfToken: string };
      expect(loginBody.user).toMatchObject({ login: adminLogin });
      expect(Object.keys(loginBody.user).sort()).toEqual(["id", "login"]);
      expect(loginBody.csrfToken.length).toBeGreaterThan(20);
      expect(loginBody.csrfToken).not.toBe(csrfBody.csrfToken);
      expect(JSON.stringify(loginBody)).not.toContain("password_hash");

      const meResponse = await sendApiRequest("/api/auth/me", {
        headers: { cookie: loggedInCookie }
      });
      noStore(meResponse);
      expect(meResponse.status).toBe(200);
      const me = (await meResponse.json()) as Record<string, unknown>;
      expect(me).toMatchObject({ login: adminLogin });
      expect(Object.keys(me).sort()).toEqual(["id", "login"]);
      expect(JSON.stringify(me)).not.toContain("password_hash");

      const organizationResponse = await sendApiRequest("/api/organization", {
        headers: { cookie: loggedInCookie }
      });
      noStore(organizationResponse);
      expect(organizationResponse.status).toBe(200);
      expect(await organizationResponse.json()).toEqual({ name: "Организация" });

      writeFileSync(statePath, JSON.stringify({ cookie: loggedInCookie }), { mode: 0o600 });
      chmodSync(statePath, 0o600);
    });
  });
} else {
  let fixtureDir: string | undefined;
  let projectName = "";
  let databaseName = "";
  let databaseUser = "";
  let envFile = "";
  let fixtureEnv: NodeJS.ProcessEnv = {};

  function compose(args: string[], timeout = commandTimeoutMs) {
    return spawnSync(
      "docker",
      ["compose", "--project-name", projectName, "--env-file", envFile, ...args],
      { cwd: projectRoot, encoding: "utf8", timeout, env: fixtureEnv }
    );
  }

  function assertCommandSucceeded(result: ReturnType<typeof compose>, args: string[]) {
    assert.equal(
      result.status,
      0,
      `docker compose ${args.join(" ")} failed: ${result.error?.message ?? ""}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`
    );
  }

  function runComposeWithInput(args: string[], input: string) {
    return new Promise<{ status: number | null; stdout: string; stderr: string; timedOut: boolean }>((resolve, reject) => {
      const child = spawn("docker", ["compose", "--project-name", projectName, "--env-file", envFile, ...args], {
        cwd: projectRoot,
        env: fixtureEnv,
        stdio: ["pipe", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, commandTimeoutMs);

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
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

  async function bootstrap(login: string, password: string): Promise<void> {
    const result = await runComposeWithInput(
      [
        "run", "--rm", "--no-deps", "-T", "-i", "--entrypoint", "node", "app",
        "apps/server/dist/cli.js", "bootstrap-admin", "--login", login
      ],
      `${password}\n`
    );
    assert.equal(result.timedOut, false, result.stderr);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.ok(!`${result.stdout}\n${result.stderr}`.includes(password), "bootstrap output leaked the password");
  }

  function runContainerPhase(phase: "initial" | "after-restart") {
    const args = [
      "run", "--rm", "--no-deps", "-T",
      "-e", "LOGIN_API_TEST_IN_CONTAINER=true",
      "-e", `LOGIN_API_TEST_PHASE=${phase}`,
      "test-runner"
    ];
    const result = compose(args, commandTimeoutMs);
    assertCommandSucceeded(result, args);
  }

  describe("Compose HTTP login integration", () => {
    beforeAll(() => {
      fixtureDir = mkdtempSync(join(tmpdir(), "decentracord-login-api-"));
      const suffix = randomBytes(6).toString("hex");
      projectName = `decentracord-login-api-${suffix}`;
      databaseName = `decentracord_test_${suffix}`;
      databaseUser = "login_api_test";
      const databasePassword = randomBytes(24).toString("base64url");
      const secretFile = join(fixtureDir, "db_password");
      envFile = join(fixtureDir, "compose.env");
      const composeOverrideFile = join(fixtureDir, "test-services.yaml");
      const buildxConfig = join(fixtureDir, "buildx");
      const stateDir = join(fixtureDir, "test-state");
      mkdirSync(buildxConfig, { mode: 0o700 });
      mkdirSync(stateDir, { mode: 0o700 });
      writeFileSync(secretFile, databasePassword, { mode: 0o600 });
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
      writeFileSync(
        composeOverrideFile,
        [
          "services:",
          "  app:",
          '    entrypoint: ["node", "apps/server/dist/main.js"]',
          "    command: []",
          "    environment:",
          "      APP_HOST: 0.0.0.0",
          "      APP_PORT: 3000",
          "      NODE_ENV: production",
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
          `    image: decentracord-login-api-runner:${suffix}`,
          '    entrypoint: ["npm", "run", "test:integration", "--", "tests/integration/login-api.test.ts"]',
          "    environment:",
          "      LOGIN_API_TEST_ORIGIN: http://app:3000",
          "      LOGIN_API_TEST_PUBLIC_ORIGIN: https://decentracord.example",
          "      LOGIN_API_TEST_STATE: /test-state/session.json",
          "    volumes:",
          "      - type: bind",
          `        source: ${JSON.stringify(stateDir)}`,
          "        target: /test-state",
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
        npm_config_cache: "/tmp/decentracord-npm-cache"
      };

      const buildArgs = ["build", "app", "test-runner"];
      assertCommandSucceeded(compose(buildArgs, 300_000), buildArgs);
      const upDatabaseArgs = ["up", "-d", "--wait", "--wait-timeout", "60", "db"];
      assertCommandSucceeded(compose(upDatabaseArgs), upDatabaseArgs);

      const migrationArgs = ["run", "--rm", "--no-deps", "-T", "--entrypoint", "node", "app", "apps/server/dist/cli.js", "migrate"];
      assertCommandSucceeded(compose(migrationArgs, commandTimeoutMs), migrationArgs);
    }, 360_000);

    afterAll(() => {
      if (!fixtureDir) return;
      const downArgs = ["down", "--volumes", "--remove-orphans"];
      const result = compose(downArgs);
      rmSync(fixtureDir, { recursive: true, force: true });
      assertCommandSucceeded(result, downArgs);
    });

    it("logs in as the CLI-created administrator over HTTP and survives an app restart", async () => {
      await bootstrap(adminLogin, adminPassword);

      const startArgs = ["up", "-d", "--wait", "--wait-timeout", "60", "app"];
      assertCommandSucceeded(compose(startArgs), startArgs);
      runContainerPhase("initial");

      const restartArgs = ["restart", "app"];
      assertCommandSucceeded(compose(restartArgs), restartArgs);
      assertCommandSucceeded(compose(startArgs), startArgs);
      runContainerPhase("after-restart");
    }, 420_000);
  });
}
