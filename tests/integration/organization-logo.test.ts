import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const commandTimeoutMs = 180_000;
const inContainer = process.env.ORGANIZATION_LOGO_TEST_IN_CONTAINER === "true";

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

/** Собирает настоящий PNG: сигнатура, заголовок IHDR, данные IDAT и завершающий IEND. */
function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, "ascii");
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function buildPng(width: number, height: number, solid = false): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(2, 9);
  header.writeUInt8(0, 10);
  header.writeUInt8(0, 11);
  header.writeUInt8(0, 12);
  // solid=true даёт маленькое тело: нули сжимаются, и PNG не упирается в лимит тела до проверки IHDR.
  const pixelBytes = height * (1 + width * 3);
  const raw = solid ? Buffer.alloc(pixelBytes) : randomBytes(pixelBytes);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

if (!inContainer) {
  describe("organization logo integration", () => {
    let fixtureDirectory = "";
    let projectName = "";
    let envFile = "";
    let overrideFile = "";

    function run(args: string[], timeout = commandTimeoutMs) {
      return compose(projectName, envFile, overrideFile, args, timeout);
    }

    beforeAll(() => {
      fixtureDirectory = mkdtempSync(join(tmpdir(), "decentracord-organization-logo-"));
      const suffix = randomBytes(6).toString("hex");
      projectName = `decentracord-organization-logo-${suffix}`;
      const databaseName = `decentracord_test_${suffix}`;
      const databaseUser = `organization_logo_${suffix.slice(0, 10)}`;
      const databasePassword = randomBytes(24).toString("base64url");
      const adminLogin = `organization_logo_admin_${suffix.slice(0, 10)}`;
      const adminPassword = `Organization-logo-admin-${randomBytes(18).toString("base64url")}`;
      const secretFile = join(fixtureDirectory, "db_password");
      envFile = join(fixtureDirectory, "compose.env");
      overrideFile = join(fixtureDirectory, "compose.organization-logo.yaml");
      const buildxConfig = join(fixtureDirectory, "buildx");
      mkdirSync(buildxConfig, { mode: 0o700 });
      writeFileSync(secretFile, databasePassword, { mode: 0o600 });
      chmodSync(secretFile, 0o600);
      writeFileSync(envFile, [
        `DB_PASSWORD_SECRET_FILE=${secretFile}`,
        `DB_PASSWORD=${databasePassword}`,
        `DB_NAME=${databaseName}`,
        `DB_USER=${databaseUser}`,
        `ORGANIZATION_LOGO_TEST_ADMIN_LOGIN=${adminLogin}`,
        `ORGANIZATION_LOGO_TEST_ADMIN_PASSWORD=${adminPassword}`,
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
        "    healthcheck:",
        '      test: ["CMD", "node", "-e", "fetch(\'http://127.0.0.1:3000/healthz\').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]',
        "    networks:",
        "      - backend",
        "  test-runner:",
        "    build:",
        `      context: ${JSON.stringify(projectRoot)}`,
        "      dockerfile: Dockerfile",
        "      target: test-runner",
        `    image: ${JSON.stringify(`decentracord-organization-logo-runner:${suffix}`)}`,
        '    entrypoint: ["npm", "run", "test:integration", "--", "tests/integration/organization-logo.test.ts"]',
        "    environment:",
        "      NODE_ENV: test",
        "      ORGANIZATION_LOGO_TEST_IN_CONTAINER: \"true\"",
        "      ORGANIZATION_LOGO_TEST_BASE_URL: http://app:3000",
        "      ORGANIZATION_LOGO_TEST_ADMIN_LOGIN: ${ORGANIZATION_LOGO_TEST_ADMIN_LOGIN}",
        "      ORGANIZATION_LOGO_TEST_ADMIN_PASSWORD: ${ORGANIZATION_LOGO_TEST_ADMIN_PASSWORD}",
        `      TEST_DATABASE_URL: postgresql://${databaseUser}:${databasePassword}@db:5432/${databaseName}`,
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
      assertComposeSucceeded(bootstrap, bootstrapArgs);
      assert.ok(!`${bootstrap.stdout}\n${bootstrap.stderr}`.includes(adminPassword), "bootstrap output leaked the administrator password");
      const appArgs = ["up", "--detach", "--wait", "--wait-timeout", "90", "app"];
      assertComposeSucceeded(run(appArgs, 180_000), appArgs);
      const runnerArgs = ["run", "--rm", "--no-deps", "-T", "-e", "ORGANIZATION_LOGO_TEST_IN_CONTAINER=true", "test-runner"];
      assertComposeSucceeded(run(runnerArgs, 600_000), runnerArgs);
    }, 900_000);

    afterAll(() => {
      if (!fixtureDirectory) return;
      const downArgs = ["down", "--volumes", "--remove-orphans", "--rmi", "local"];
      const result = run(downArgs, 120_000);
      rmSync(fixtureDirectory, { recursive: true, force: true });
      assertComposeSucceeded(result, downArgs);
    });

    it("runs the isolated PostgreSQL and HTTP organization logo checks", () => {
      expect(projectName).toContain("decentracord-organization-logo-");
    });
  }, 900_000);
} else {
  interface HttpSession {
    cookie?: string;
    csrfToken?: string;
  }

  const baseUrl = process.env.ORGANIZATION_LOGO_TEST_BASE_URL ?? "http://app:3000";
  const appOrigin = new URL(baseUrl).origin;
  const adminCredentials = {
    login: process.env.ORGANIZATION_LOGO_TEST_ADMIN_LOGIN ?? "",
    password: process.env.ORGANIZATION_LOGO_TEST_ADMIN_PASSWORD ?? ""
  };

  let pool: Pool;
  let adminSession: HttpSession;
  let memberSession: HttpSession;

  function sessionHeaders(session: HttpSession, method: string): Record<string, string> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (session.cookie) headers.cookie = session.cookie;
    if (method !== "GET") {
      headers.origin = appOrigin;
      if (session.csrfToken) headers["x-csrf-token"] = session.csrfToken;
    }
    return headers;
  }

  async function request(session: HttpSession, path: string, method = "GET", body?: unknown): Promise<Response> {
    const headers = sessionHeaders(session, method);
    const options: RequestInit = { method, headers, signal: AbortSignal.timeout(45_000) };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      options.body = JSON.stringify(body);
    }
    const response = await fetch(new URL(path, baseUrl), options);
    const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
    if (cookie) session.cookie = cookie;
    return response;
  }

  /** Загрузка логотипа: тело запроса — сырые байты PNG, а не JSON. */
  async function uploadLogo(session: HttpSession, body: Buffer): Promise<Response> {
    const headers = sessionHeaders(session, "PUT");
    headers["content-type"] = "image/png";
    return fetch(new URL("/api/organization/logo", baseUrl), {
      method: "PUT",
      headers,
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(45_000)
    });
  }

  async function downloadLogo(session: HttpSession): Promise<Response> {
    const headers = sessionHeaders(session, "GET");
    headers.accept = "image/png";
    return fetch(new URL("/api/organization/logo", baseUrl), {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(45_000)
    });
  }

  async function deleteLogo(session: HttpSession): Promise<Response> {
    return request(session, "/api/organization/logo", "DELETE");
  }

  async function login(credentials: { login: string; password: string }): Promise<HttpSession> {
    const session: HttpSession = {};
    const csrfResponse = await request(session, "/api/auth/csrf");
    expect(csrfResponse.status).toBe(200);
    const csrfBody = await csrfResponse.json() as { csrfToken?: unknown };
    expect(typeof csrfBody.csrfToken).toBe("string");
    session.csrfToken = csrfBody.csrfToken as string;
    const loginResponse = await request(session, "/api/auth/login", "POST", {
      login: credentials.login,
      password: credentials.password
    });
    if (loginResponse.status !== 200) {
      throw new Error(`Login failed (${loginResponse.status}): ${JSON.stringify(await loginResponse.json())}`);
    }
    const loginBody = await loginResponse.json() as { csrfToken?: unknown };
    expect(typeof loginBody.csrfToken).toBe("string");
    session.csrfToken = loginBody.csrfToken as string;
    return session;
  }

  async function expectError(response: Response, status: number, code: string): Promise<void> {
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code } });
  }

  async function organizationView(): Promise<{ name: string; logoUrl: string | null }> {
    const response = await request(adminSession, "/api/organization");
    expect(response.status).toBe(200);
    return response.json() as Promise<{ name: string; logoUrl: string | null }>;
  }

  async function storedLogo(): Promise<{ logo: Buffer | null; logoUpdatedAt: Date | null }> {
    const result = await pool.query<{ logo: Buffer | null; logo_updated_at: Date | null }>(
      "SELECT logo, logo_updated_at FROM organization WHERE id = 1"
    );
    const row = result.rows[0];
    return { logo: row?.logo ?? null, logoUpdatedAt: row?.logo_updated_at ?? null };
  }

  async function logoColumnType(): Promise<string> {
    const result = await pool.query<{ data_type: string }>(
      "SELECT data_type FROM information_schema.columns WHERE table_name = 'organization' AND column_name = 'logo'"
    );
    return result.rows[0]?.data_type ?? "";
  }

  beforeAll(async () => {
    const database = new URL(process.env.TEST_DATABASE_URL ?? "");
    expect(database.hostname).toBe("db");
    expect(database.pathname).toMatch(/^\/decentracord_test_[a-f0-9]+$/u);
    expect(new URL(baseUrl).hostname).toBe("app");
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4, connectionTimeoutMillis: 3_000 });
    adminSession = await login(adminCredentials);

    // Участник без права администратора: только системная роль @everyone.
    const suffix = randomBytes(5).toString("hex");
    const memberLogin = `organization_logo_member_${suffix}`;
    const memberPassword = `Organization-logo-member-${randomBytes(16).toString("base64url")}`;
    const created = await request(adminSession, "/api/members", "POST", { login: memberLogin, password: memberPassword });
    expect(created.status).toBe(201);
    memberSession = await login({ login: memberLogin, password: memberPassword });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  });

  it("stores the logo in the database and serves the same bytes as image/png", async () => {
    const logo = buildPng(1, 1);
    const upload = await uploadLogo(adminSession, logo);
    expect(upload.status).toBe(204);
    expect(await upload.text()).toBe("");

    const download = await downloadLogo(adminSession);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toMatch(/^image\/png/u);
    const served = Buffer.from(await download.arrayBuffer());
    expect(served.equals(logo)).toBe(true);

    // Клиенту отдаётся относительный путь, а не абсолютный URL.
    expect((await organizationView()).logoUrl).toBe("/api/organization/logo");

    // В базе логотип лежит в bytea и совпадает с загруженными байтами.
    expect(await logoColumnType()).toBe("bytea");
    const stored = await storedLogo();
    expect(stored.logo).not.toBeNull();
    expect(stored.logo?.length).toBe(logo.length);
    expect(stored.logo?.equals(logo)).toBe(true);
    expect(stored.logoUpdatedAt).not.toBeNull();
  }, 60_000);

  it("rejects a body that is not a PNG", async () => {
    await expectError(
      await uploadLogo(adminSession, Buffer.from("это не изображение, а текст")),
      400,
      "INVALID_LOGO"
    );
    await expectError(await uploadLogo(adminSession, Buffer.alloc(0)), 400, "INVALID_LOGO");
  }, 60_000);

  it("rejects a PNG wider or taller than 512 pixels", async () => {
    await expectError(await uploadLogo(adminSession, buildPng(513, 512, true)), 400, "INVALID_LOGO");
    await expectError(await uploadLogo(adminSession, buildPng(512, 513, true)), 400, "INVALID_LOGO");
    // Граничный размер 512×512 принимается.
    expect((await uploadLogo(adminSession, buildPng(512, 512, true))).status).toBe(204);
  }, 60_000);

  it("accepts a logo file of about 100 KB without a payload limit error", async () => {
    const large = buildPng(512, 67);
    expect(large.length).toBeGreaterThan(90 * 1024);
    expect(large.length).toBeLessThan(150 * 1024);
    const upload = await uploadLogo(adminSession, large);
    expect(upload.status).toBe(204);
    const stored = await storedLogo();
    expect(stored.logo?.length).toBe(large.length);
  }, 60_000);

  it("does not let a member without administrator rights upload or delete the logo", async () => {
    await expectError(await uploadLogo(memberSession, buildPng(1, 1)), 403, "FORBIDDEN");
    await expectError(await deleteLogo(memberSession), 403, "FORBIDDEN");
    // Логотип после отказов остался прежним.
    const stored = await storedLogo();
    expect(stored.logo?.length).toBeGreaterThan(0);
  }, 60_000);

  it("does not serve the logo without a session", async () => {
    const anonymous = await downloadLogo({});
    expect(anonymous.status).toBe(401);
  }, 60_000);

  it("deletes the logo and reports it as missing afterwards", async () => {
    const removal = await deleteLogo(adminSession);
    expect(removal.status).toBe(204);
    expect(await removal.text()).toBe("");

    await expectError(await downloadLogo(adminSession), 404, "LOGO_NOT_FOUND");
    expect((await organizationView()).logoUrl).toBeNull();

    const stored = await storedLogo();
    expect(stored.logo).toBeNull();
    expect(stored.logoUpdatedAt).toBeNull();
  }, 60_000);
}
