import { Pool } from "pg";
import { PasswordService } from "../../apps/server/src/auth/password.service.js";

const fixtureLoginPrefix = "fixture_";

function fail(code: string, exitCode = 1): void {
  process.stderr.write(`${JSON.stringify({ ok: false, code })}\n`);
  process.exitCode = exitCode;
}

function testDatabaseUrl(): string | null {
  if (process.env.NODE_ENV !== "test") return null;
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString || connectionString.length > 4_096) return null;

  try {
    const databaseUrl = new URL(connectionString);
    const databaseName = decodeURIComponent(databaseUrl.pathname.slice(1));
    const markerTail = databaseName.slice("decentracord_test".length);
    const isTestDatabase = databaseName.startsWith("decentracord_test") &&
      (markerTail === "" || /^_[a-z0-9_-]+$/u.test(markerTail));
    const isAllowedTestHost = ["127.0.0.1", "localhost", "[::1]", "db"].includes(databaseUrl.hostname);

    if (
      !["postgres:", "postgresql:"].includes(databaseUrl.protocol) ||
      !isTestDatabase ||
      !isAllowedTestHost ||
      databaseUrl.password.length === 0
    ) {
      return null;
    }

    return connectionString;
  } catch {
    return null;
  }
}

function normalizeFixtureLogin(input: string): string | null {
  const login = input.trim().toLowerCase();
  if (!login.startsWith(fixtureLoginPrefix) || !/^[a-z0-9_.-]{3,64}$/u.test(login)) return null;
  return login;
}

async function readPasswordFromStdin(): Promise<string> {
  const input = process.stdin;
  const terminal = Boolean(input.isTTY && typeof input.setRawMode === "function");
  let password = "";
  let characters = 0;

  process.stderr.write("Password (12-128 Unicode characters): ");
  if (terminal) input.setRawMode(true);
  input.setEncoding("utf8");
  input.resume();

  return await new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("error", onError);
      if (terminal) input.setRawMode(false);
      input.pause();
      process.stderr.write("\n");
      if (error) reject(error);
      else resolve(password);
    };

    const onData = (chunk: string | Buffer) => {
      const value = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const character of value) {
        if (character === "\n" || character === "\r") {
          finish();
          return;
        }
        if (character === "\u0003") {
          finish(new Error("Password input cancelled"));
          return;
        }
        if (character === "\u007f" || character === "\b") {
          if (characters > 0) {
            const codePoints = Array.from(password);
            codePoints.pop();
            password = codePoints.join("");
            characters -= 1;
          }
          continue;
        }
        if (characters >= 128) {
          finish(new Error("Password input is too long"));
          return;
        }
        password += character;
        characters += 1;
      }
    };
    const onEnd = () => finish();
    const onError = (error: Error) => finish(error);

    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);
  });
}

async function createUser(args: string[]): Promise<void> {
  let loginInput: string | undefined;
  let administrator = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--login" && loginInput === undefined) {
      loginInput = args[index + 1];
      index += 1;
    } else if (argument === "--admin" && !administrator) {
      administrator = true;
    } else {
      fail("INVALID_ARGUMENTS", 2);
      return;
    }
  }

  const login = normalizeFixtureLogin(loginInput ?? "");
  if (!login) {
    fail("INVALID_LOGIN", 2);
    return;
  }

  let password: string;
  try {
    password = await readPasswordFromStdin();
  } catch {
    fail("PASSWORD_INPUT_FAILED", 2);
    return;
  }

  const passwordService = new PasswordService();
  let passwordHash: string;
  try {
    passwordHash = await passwordService.hash(password);
  } catch {
    fail("INVALID_PASSWORD", 2);
    return;
  }

  const connectionString = testDatabaseUrl();
  if (!connectionString) {
    fail("TEST_DATABASE_REQUIRED", 2);
    return;
  }

  const pool = new Pool({
    connectionString,
    connectionTimeoutMillis: 3_000,
    max: 1,
    query_timeout: 10_000
  });
  let client;

  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const everyone = await client.query<{ id: string }>(
      "SELECT id FROM roles WHERE system_key = 'everyone'"
    );
    const everyoneRoleId = everyone.rows[0]?.id;
    if (!everyoneRoleId) throw new Error("Required test role is missing");

    const user = await client.query<{ id: string; login: string; active: boolean }>(
      "INSERT INTO users (login, login_normalized, password_hash) VALUES ($1, $1, $2) RETURNING id, login, active",
      [login, passwordHash]
    );
    const userId = user.rows[0]?.id;
    if (!userId) throw new Error("Test user was not created");
    await client.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)", [userId, everyoneRoleId]);

    if (administrator) {
      const adminRole = await client.query<{ id: string }>(
        "SELECT id FROM roles WHERE system_key = 'administrator'"
      );
      const administratorRoleId = adminRole.rows[0]?.id;
      if (!administratorRoleId) throw new Error("Administrator test role is missing");
      await client.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)", [userId, administratorRoleId]);
    }

    await client.query("COMMIT");
    process.stdout.write(`${JSON.stringify({ id: userId, login, active: user.rows[0]?.active })}\n`);
  } catch {
    await client?.query("ROLLBACK").catch(() => undefined);
    fail("FIXTURE_CREATE_FAILED");
  } finally {
    client?.release();
    await pool.end().catch(() => {
      process.exitCode = 1;
    });
  }
}

async function clearFixture(): Promise<void> {
  const connectionString = testDatabaseUrl();
  if (!connectionString) {
    fail("TEST_DATABASE_REQUIRED", 2);
    return;
  }

  const pool = new Pool({
    connectionString,
    connectionTimeoutMillis: 3_000,
    max: 1,
    query_timeout: 10_000
  });
  try {
    const result = await pool.query<{ id: string }>(
      "DELETE FROM users WHERE left(login_normalized, length($1)) = $1 RETURNING id",
      [fixtureLoginPrefix]
    );
    process.stdout.write(`${JSON.stringify({ ok: true, deleted: result.rowCount ?? 0 })}\n`);
  } catch {
    fail("FIXTURE_CLEAR_FAILED");
  } finally {
    await pool.end().catch(() => {
      process.exitCode = 1;
    });
  }
}

async function main(): Promise<void> {
  const connectionString = testDatabaseUrl();
  if (!connectionString) {
    fail("TEST_DATABASE_REQUIRED", 2);
    return;
  }

  const [command, ...args] = process.argv.slice(2);
  if (command === "create-user") {
    await createUser(args);
  } else if (command === "clear-fixture" && args.length === 0) {
    await clearFixture();
  } else {
    fail("INVALID_COMMAND", 2);
  }
}

await main();
