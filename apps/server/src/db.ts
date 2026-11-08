import { readFileSync, statSync } from "node:fs";
import { Pool } from "pg";

const defaultConnectTimeoutMs = 3_000;
const maxConnectTimeoutMs = 10_000;
const maxSecretBytes = 4_096;

function readBoundedInteger(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;

  if (!/^\d{1,5}$/u.test(raw)) {
    throw new Error("Invalid database configuration");
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error("Invalid database configuration");
  }

  return value;
}

function readDatabasePassword(): string {
  const passwordFile = process.env.DB_PASSWORD_FILE ?? "/run/secrets/db_password";
  if (passwordFile.length > 4_096) throw new Error("Invalid database configuration");

  const secretStats = statSync(passwordFile);
  if (!secretStats.isFile() || secretStats.size === 0 || secretStats.size > maxSecretBytes) {
    throw new Error("Invalid database configuration");
  }

  const password = readFileSync(passwordFile, "utf8");
  if (password.length === 0 || Buffer.byteLength(password, "utf8") > maxSecretBytes) {
    throw new Error("Invalid database configuration");
  }

  return password;
}

export function createDatabasePool(): Pool {
  const host = process.env.DB_HOST ?? "db";
  const database = process.env.DB_NAME ?? "decentracord";
  const user = process.env.DB_USER ?? "decentracord";

  if (!/^[a-zA-Z0-9.-]{1,253}$/u.test(host)) {
    throw new Error("Invalid database configuration");
  }
  if (!/^[a-zA-Z_][a-zA-Z0-9_$-]{0,62}$/u.test(database)) {
    throw new Error("Invalid database configuration");
  }
  if (!/^[a-zA-Z_][a-zA-Z0-9_$-]{0,62}$/u.test(user)) {
    throw new Error("Invalid database configuration");
  }

  const port = readBoundedInteger("DB_PORT", 5432, 1, 65_535);
  const connectTimeoutMs = readBoundedInteger(
    "DB_CONNECT_TIMEOUT_MS",
    defaultConnectTimeoutMs,
    100,
    maxConnectTimeoutMs
  );

  return new Pool({
    application_name: "decentracord-cli",
    connectionTimeoutMillis: connectTimeoutMs,
    database,
    host,
    max: 1,
    password: readDatabasePassword(),
    port,
    query_timeout: maxConnectTimeoutMs,
    user
  });
}
