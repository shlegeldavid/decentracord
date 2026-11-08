import { createDatabasePool } from "./db.js";
import { PasswordService } from "./auth/password.service.js";
import { runner } from "node-pg-migrate";
import { join } from "node:path";

const bootstrapLockNamespace = 68_477;
const bootstrapLockKey = 1;

type CliResult = { ok: true; id?: string; login?: string } | { ok: false; code: string };

function printResult(result: CliResult): void {
  const output = JSON.stringify(result);
  (result.ok ? process.stdout : process.stderr).write(`${output}\n`);
}

function normalizeLogin(input: string): string | null {
  const login = input.trim().toLowerCase();
  return /^[a-z0-9_.-]{3,64}$/u.test(login) ? login : null;
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

async function migrate(): Promise<void> {
  const pool = createDatabasePool();
  let client;

  try {
    client = await pool.connect();
    await runner({
      dbClient: client,
      dir: process.env.MIGRATIONS_DIR ?? join(process.cwd(), "migrations"),
      direction: "up",
      migrationsTable: "decentracord_migrations",
      verbose: false
    });
    process.stdout.write('{"ok":true}\n');
  } catch {
    process.stderr.write('{"ok":false,"code":"MIGRATION_FAILED"}\n');
    process.exitCode = 1;
  } finally {
    client?.release();
    await pool.end().catch(() => {
      process.exitCode = 1;
    });
  }
}

async function bootstrapAdmin(args: string[]): Promise<void> {
  if (args.length !== 2 || args[0] !== "--login") {
    printResult({ ok: false, code: "INVALID_ARGUMENTS" });
    process.exitCode = 2;
    return;
  }

  const login = normalizeLogin(args[1] ?? "");
  if (!login) {
    printResult({ ok: false, code: "INVALID_LOGIN" });
    process.exitCode = 2;
    return;
  }

  let password: string;
  try {
    password = await readPasswordFromStdin();
  } catch {
    printResult({ ok: false, code: "PASSWORD_INPUT_FAILED" });
    process.exitCode = 2;
    return;
  }

  const passwordService = new PasswordService();
  let passwordHash: string;
  try {
    passwordHash = await passwordService.hash(password);
  } catch {
    printResult({ ok: false, code: "INVALID_PASSWORD" });
    process.exitCode = 2;
    return;
  }

  const pool = createDatabasePool();
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1, $2)", [bootstrapLockNamespace, bootstrapLockKey]);

    const initialized = await client.query<{ initialized: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM organization WHERE id = 1) AS initialized"
    );
    if (initialized.rows[0]?.initialized) {
      await client.query("ROLLBACK");
      printResult({ ok: false, code: "BOOTSTRAP_ALREADY_COMPLETED" });
      process.exitCode = 1;
      return;
    }

    await client.query("INSERT INTO organization (id, name) VALUES (1, $1)", ["Организация"]);
    const roles = await client.query<{ id: string; system_key: string }>(
      "INSERT INTO roles (system_key, name, position, permissions) VALUES ('everyone', '@everyone', 0, '[]'::jsonb), ('administrator', 'Administrator', 1, '[\"ADMINISTRATOR\"]'::jsonb) RETURNING id, system_key"
    );
    const everyoneRole = roles.rows.find((role) => role.system_key === "everyone");
    const administratorRole = roles.rows.find((role) => role.system_key === "administrator");
    if (!everyoneRole || !administratorRole) throw new Error("Required roles were not created");

    const user = await client.query<{ id: string; login: string }>(
      "INSERT INTO users (login, login_normalized, password_hash) VALUES ($1, $1, $2) RETURNING id, login",
      [login, passwordHash]
    );
    const userId = user.rows[0]?.id;
    if (!userId) throw new Error("Administrator was not created");
    await client.query(
      "INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2), ($1, $3)",
      [userId, everyoneRole.id, administratorRole.id]
    );
    await client.query("COMMIT");
    printResult({ ok: true, id: userId, login });
  } catch {
    await client?.query("ROLLBACK").catch(() => undefined);
    printResult({ ok: false, code: "BOOTSTRAP_FAILED" });
    process.exitCode = 1;
  } finally {
    client?.release();
    await pool.end().catch(() => {
      process.exitCode = 1;
    });
  }
}

async function doctor(): Promise<void> {
  let pool;

  try {
    pool = createDatabasePool();
    await pool.query("SELECT 1");
    process.stdout.write('{"ok":true}\n');
  } catch {
    process.stderr.write('{"ok":false,"code":"DATABASE_UNAVAILABLE"}\n');
    process.exitCode = 1;
  } finally {
    if (pool) {
      await pool.end().catch(() => {
        process.exitCode = 1;
      });
    }
  }
}

const command = process.argv[2];

if (command === "doctor") {
  await doctor();
} else if (command === "migrate") {
  await migrate();
} else if (command === "bootstrap-admin") {
  await bootstrapAdmin(process.argv.slice(3));
} else {
  process.stderr.write('{"ok":false,"code":"INVALID_COMMAND"}\n');
  process.exitCode = 2;
}
