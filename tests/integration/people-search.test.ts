import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const commandTimeoutMs = 180_000;
const inContainer = process.env.PEOPLE_SEARCH_TEST_IN_CONTAINER === "true";
const baseUrl = process.env.PEOPLE_SEARCH_TEST_BASE_URL ?? "http://app:3000";
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
  describe("people search API integration", () => {
    let fixtureDirectory = "";
    let projectName = "";
    let envFile = "";
    let overrideFile = "";

    function run(args: string[], timeout = commandTimeoutMs) {
      return compose(projectName, envFile, overrideFile, args, timeout);
    }

    beforeAll(() => {
      fixtureDirectory = mkdtempSync(join(tmpdir(), "decentracord-people-search-"));
      const suffix = randomBytes(6).toString("hex");
      projectName = `decentracord-people-search-${suffix}`;
      const databaseName = `decentracord_test_${suffix}`;
      const databaseUser = `people_search_${suffix.slice(0, 10)}`;
      const databasePassword = randomBytes(24).toString("base64url");
      const adminLogin = `people_admin_${suffix.slice(0, 10)}`;
      const adminPassword = `People-admin-${randomBytes(18).toString("base64url")}`;
      const secretFile = join(fixtureDirectory, "db_password");
      envFile = join(fixtureDirectory, "compose.env");
      overrideFile = join(fixtureDirectory, "compose.people-search.yaml");
      const buildxConfig = join(fixtureDirectory, "buildx");
      mkdirSync(buildxConfig, { mode: 0o700 });
      writeFileSync(secretFile, databasePassword, { mode: 0o600 });
      chmodSync(secretFile, 0o600);
      writeFileSync(envFile, [
        `DB_PASSWORD_SECRET_FILE=${secretFile}`,
        `DB_PASSWORD=${databasePassword}`,
        `DB_NAME=${databaseName}`,
        `DB_USER=${databaseUser}`,
        `PEOPLE_SEARCH_ADMIN_LOGIN=${adminLogin}`,
        `PEOPLE_SEARCH_ADMIN_PASSWORD=${adminPassword}`,
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
        "      interval: 2s",
        "      timeout: 2s",
        "      retries: 30",
        "      start_period: 3s",
        "  test-runner:",
        "    build:",
        `      context: ${JSON.stringify(projectRoot)}`,
        "      dockerfile: Dockerfile",
        "      target: test-runner",
        `    image: ${JSON.stringify(`decentracord-people-search-runner:${suffix}`)}`,
        '    entrypoint: ["npm", "run", "test:integration", "--", "tests/integration/people-search.test.ts"]',
        "    environment:",
        "      NODE_ENV: test",
        '      PEOPLE_SEARCH_TEST_IN_CONTAINER: "true"',
        "      PEOPLE_SEARCH_TEST_BASE_URL: http://app:3000",
        "      PEOPLE_SEARCH_ADMIN_LOGIN: ${PEOPLE_SEARCH_ADMIN_LOGIN}",
        "      PEOPLE_SEARCH_ADMIN_PASSWORD: ${PEOPLE_SEARCH_ADMIN_PASSWORD}",
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
      assert.equal(bootstrap.status, 0, `Administrator bootstrap failed: ${bootstrap.error?.message ?? ""}\n${bootstrap.stdout ?? ""}\n${bootstrap.stderr ?? ""}`);
      assert.ok(!`${bootstrap.stdout}\n${bootstrap.stderr}`.includes(adminPassword), "bootstrap output leaked the administrator password");
      const appArgs = ["up", "--detach", "--wait", "--wait-timeout", "90", "app"];
      assertComposeSucceeded(run(appArgs, 180_000), appArgs);
      const runnerArgs = ["run", "--rm", "--no-deps", "-T", "-e", "PEOPLE_SEARCH_TEST_IN_CONTAINER=true", "test-runner"];
      assertComposeSucceeded(run(runnerArgs, 600_000), runnerArgs);
    }, 900_000);

    afterAll(() => {
      if (!fixtureDirectory) return;
      const downArgs = ["down", "--volumes", "--remove-orphans", "--rmi", "local"];
      const result = run(downArgs, 120_000);
      rmSync(fixtureDirectory, { recursive: true, force: true });
      assertComposeSucceeded(result, downArgs);
    });

    it("runs the isolated people search checks against PostgreSQL and the API", () => {
      expect(projectName).toContain("decentracord-people-search-");
    });
  }, 900_000);
} else {
  interface HttpSession {
    cookie?: string;
    csrfToken?: string;
  }

  interface MemberIdentity {
    id: string;
    login: string;
    password: string;
    session: HttpSession;
  }

  interface RoleIdentity {
    id: string;
    name: string;
    color: string | null;
  }

  interface SearchRole {
    id: string;
    name: string;
    color: string | null;
  }

  interface SearchChannel {
    id: string;
    name: string;
  }

  interface SearchResult {
    id: string;
    login: string;
    roles: SearchRole[];
    commonChannels: SearchChannel[];
    presence: "online" | "offline";
  }

  interface SearchPayload {
    results: SearchResult[];
    truncated: boolean;
  }

  const ownerCredentials = {
    login: process.env.PEOPLE_SEARCH_ADMIN_LOGIN ?? "",
    password: process.env.PEOPLE_SEARCH_ADMIN_PASSWORD ?? ""
  };

  let pool: Pool;
  let adminSession: HttpSession;
  let searcher: MemberIdentity;
  let ivanova: MemberIdentity;
  let outsider: MemberIdentity;
  let sharedChannel: { id: string; name: string };
  let targetRole: RoleIdentity;
  let extraRole: RoleIdentity;

  async function request(
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
    const options: RequestInit = { method, headers, signal: AbortSignal.timeout(15_000) };
    if (body !== undefined) options.body = JSON.stringify(body);
    const response = await fetch(new URL(path, baseUrl), options);
    const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
    if (cookie) session.cookie = cookie;
    return response;
  }

  async function login(credentials: { login: string; password: string }): Promise<HttpSession> {
    const session: HttpSession = {};
    const csrfResponse = await request(session, "/api/auth/csrf");
    expect(csrfResponse.status).toBe(200);
    const csrfBody = await csrfResponse.json() as { csrfToken?: unknown };
    expect(typeof csrfBody.csrfToken).toBe("string");
    session.csrfToken = csrfBody.csrfToken as string;
    const loginResponse = await request(session, "/api/auth/login", "POST", credentials);
    const loginText = await loginResponse.text();
    expect(loginResponse.status, loginText).toBe(200);
    const loginBody = JSON.parse(loginText) as { csrfToken?: unknown };
    expect(typeof loginBody.csrfToken).toBe("string");
    session.csrfToken = loginBody.csrfToken as string;
    return session;
  }

  async function createRole(
    name: string,
    position: number,
    permissions: string[],
    color: string | null
  ): Promise<RoleIdentity> {
    const result = await pool.query<{ id: string }>(
      "INSERT INTO roles (name, position, permissions, color) VALUES ($1, $2, $3::jsonb, $4) RETURNING id::text AS id",
      [name, position, JSON.stringify(permissions), color]
    );
    const id = result.rows[0]?.id;
    if (!id) throw new Error("Test role was not created");
    return { id, name, color };
  }

  async function createChannel(name: string): Promise<{ id: string; name: string }> {
    const position = await pool.query<{ max_position: number }>(
      "SELECT COALESCE(MAX(position), 0)::integer AS max_position FROM channels"
    );
    const result = await pool.query<{ id: string }>(
      "INSERT INTO channels (name, position) VALUES ($1, $2) RETURNING id::text AS id",
      [name, (position.rows[0]?.max_position ?? 0) + 1]
    );
    const id = result.rows[0]?.id;
    if (!id) throw new Error("Test channel was not created");
    return { id, name };
  }

  async function createMember(loginValue: string, roleIds: string[]): Promise<MemberIdentity> {
    const password = `Issued-member-${randomBytes(16).toString("base64url")}`;
    const response = await request(adminSession, "/api/members", "POST", {
      login: loginValue,
      password,
      roleIds
    });
    const text = await response.text();
    expect(response.status, text).toBe(201);
    const created = JSON.parse(text) as { id: string; login: string };
    return { id: created.id, login: created.login, password, session: {} };
  }

  async function search(session: HttpSession, query: string): Promise<SearchPayload> {
    const response = await request(session, `/api/members/search?q=${encodeURIComponent(query)}`);
    const text = await response.text();
    expect(response.status, text).toBe(200);
    const payload = JSON.parse(text) as SearchPayload;
    expect(Array.isArray(payload.results)).toBe(true);
    expect(typeof payload.truncated).toBe("boolean");
    return payload;
  }

  function logins(payload: SearchPayload): string[] {
    return payload.results.map((result) => result.login);
  }

  beforeAll(async () => {
    const database = new URL(process.env.TEST_DATABASE_URL ?? "");
    expect(database.hostname).toBe("db");
    expect(database.pathname).toMatch(/^\/decentracord_test/u);
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4, connectionTimeoutMillis: 3_000 });
    adminSession = await login(ownerCredentials);

    const suffix = randomBytes(5).toString("hex");
    // The searcher sees the shared channel but holds no member management right.
    const searcherRole = await createRole(`ps-searcher-${suffix}`, 10, ["VIEW_CHANNEL", "SEND_MESSAGES"], null);
    targetRole = await createRole(`ps-target-${suffix}`, 20, ["VIEW_CHANNEL"], "#e55353");
    extraRole = await createRole(`ps-extra-${suffix}`, 30, ["VIEW_CHANNEL"], null);
    const outsiderRole = await createRole(`ps-outsider-${suffix}`, 40, [], null);
    sharedChannel = await createChannel(`ps-shared-${suffix}`);

    searcher = await createMember("ps_root", [searcherRole.id]);
    searcher.session = await login({ login: searcher.login, password: searcher.password });
    ivanova = await createMember("ivanova", [targetRole.id, extraRole.id]);
    await createMember("ivanova-2", [targetRole.id]);
    await createMember("a_b", [targetRole.id]);
    await createMember("axb", [targetRole.id]);
    outsider = await createMember("ps_outsider", [outsiderRole.id]);
    const disabled = await createMember("ivanova-off", [targetRole.id]);
    const disableResponse = await request(adminSession, `/api/members/${disabled.id}/disable`, "POST");
    expect(disableResponse.status, await disableResponse.text()).toBe(204);
    for (let index = 1; index <= 30; index += 1) {
      await createMember(`zebra-${index.toString().padStart(2, "0")}`, [targetRole.id]);
    }
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
  });

  it("finds members by the login prefix regardless of case and applies the result limit", async () => {
    const uppercase = await search(searcher.session, "IVA");
    expect(logins(uppercase).sort()).toEqual(["ivanova", "ivanova-2"]);
    expect(uppercase.truncated).toBe(false);

    const lowercase = await search(searcher.session, "iva");
    expect(logins(lowercase).sort()).toEqual(["ivanova", "ivanova-2"]);

    // `_` is a literal character in `starts_with`, so `a_b` must not match `axb`.
    const underscore = await search(searcher.session, "a_b");
    expect(logins(underscore)).toContain("a_b");
    expect(logins(underscore)).not.toContain("axb");

    const limited = await search(searcher.session, "zebra");
    expect(limited.results).toHaveLength(25);
    expect(limited.truncated).toBe(true);
    expect(logins(limited).every((login) => login.startsWith("zebra"))).toBe(true);

    const exact = await search(searcher.session, "ivanova");
    expect(exact.results[0]?.login).toBe("ivanova");
    expect(logins(exact)).toEqual(["ivanova", "ivanova-2"]);
  }, 60_000);

  it("keeps the searcher and disabled members out of the results", async () => {
    const samePrefix = await search(searcher.session, "ps_");
    expect(logins(samePrefix)).toEqual([outsider.login]);
    expect(logins(samePrefix)).not.toContain(searcher.login);

    const disabledPrefix = await search(searcher.session, "ivanova");
    expect(logins(disabledPrefix)).not.toContain("ivanova-off");
  }, 60_000);

  it("serves the search to a member without the member management right", async () => {
    const membersResponse = await request(searcher.session, "/api/members");
    expect(membersResponse.status).toBe(403);

    const response = await request(searcher.session, "/api/members/search?q=ivanova");
    expect(response.status, await response.text()).toBe(200);

    const guestResponse = await request({}, "/api/members/search?q=ivanova");
    expect(guestResponse.status).toBe(401);
  }, 60_000);

  it("returns every role, the common channels and the presence of each result", async () => {
    const payload = await search(searcher.session, "ivanova");
    const found = payload.results.find((result) => result.login === "ivanova");
    if (!found) throw new Error("Searched member was not returned");
    expect(found.id).toBe(ivanova.id);

    // Every assigned role is listed, not only the senior one.
    expect(found.roles).toHaveLength(2);
    expect(found.roles.map((role) => role.name).sort()).toEqual([extraRole.name, targetRole.name].sort());
    for (const role of found.roles) {
      expect(Object.keys(role).sort()).toEqual(["color", "id", "name"]);
      expect(role.name).not.toBe("@everyone");
    }
    expect(found.roles.find((role) => role.id === targetRole.id)?.color).toBe("#e55353");

    expect(found.commonChannels.map((channel) => channel.id)).toContain(sharedChannel.id);
    expect(found.commonChannels.find((channel) => channel.id === sharedChannel.id)?.name).toBe(sharedChannel.name);
    // A common channel is always a channel the searcher can see as well.
    const visibleChannels = await request(searcher.session, "/api/channels");
    const visiblePayload = await visibleChannels.json() as { channels?: Array<{ id: string }> };
    const visibleChannelIds = (visiblePayload.channels ?? []).map((channel) => channel.id);
    for (const channel of found.commonChannels) {
      expect(visibleChannelIds).toContain(channel.id);
    }
    expect(["online", "offline"]).toContain(found.presence);

    const outsiderPayload = await search(searcher.session, "ps_outsider");
    const outsiderResult = outsiderPayload.results.find((result) => result.login === outsider.login);
    if (!outsiderResult) throw new Error("Outsider was not returned");
    expect(outsiderResult.commonChannels).toEqual([]);
    expect(outsiderResult.roles).toHaveLength(1);
    expect(outsiderResult.roles[0]?.name).not.toBe("@everyone");
    expect(["online", "offline"]).toContain(outsiderResult.presence);
  }, 60_000);

  it("rejects malformed search requests", async () => {
    const empty = await request(searcher.session, "/api/members/search?q=");
    const emptyText = await empty.text();
    expect(empty.status, emptyText).toBe(200);
    const emptyPayload = JSON.parse(emptyText) as SearchPayload;
    expect(emptyPayload.results).toEqual([]);
    expect(emptyPayload.truncated).toBe(false);

    const tooLong = await request(searcher.session, `/api/members/search?q=${"a".repeat(65)}`);
    expect(tooLong.status).toBe(400);
    expect(await tooLong.text()).toContain("INVALID_REQUEST");

    const missing = await request(searcher.session, "/api/members/search");
    expect(missing.status).toBe(400);
    expect(await missing.text()).toContain("INVALID_REQUEST");
  }, 60_000);

  it("explains the prefix query plan on the test database", async () => {
    const plan = await pool.query<{ "QUERY PLAN": string }>(
      `EXPLAIN (FORMAT TEXT)
       SELECT u.id::text AS id, u.login, u.login_normalized
       FROM users AS u
       WHERE u.active = true
         AND u.id <> $2
         AND starts_with(u.login_normalized, $1)
       ORDER BY (u.login_normalized = $3) DESC, u.login_normalized ASC
       LIMIT 25`,
      ["ivanova", searcher.id, "ivanova"]
    );
    const planText = plan.rows.map((row) => row["QUERY PLAN"]).join("\n");
    expect(planText.length).toBeGreaterThan(0);
    expect(planText).toContain("starts_with");
    expect(planText).toContain("users");
  }, 60_000);
}
