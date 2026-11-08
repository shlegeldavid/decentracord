import "reflect-metadata";
import { existsSync, statSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import type { ErrorRequestHandler, Express, Request, Response } from "express";
import express from "express";
import { Catch, HttpException } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { runner } from "node-pg-migrate";
import { AppModule } from "./app.module.js";
import { SessionService } from "./auth/session.service.js";
import { createDatabasePool } from "./db.js";

const privateApiRoutes = new Set([
  "GET /api/auth/csrf",
  "POST /api/auth/login",
  "POST /api/auth/logout",
  "POST /api/auth/password",
  "GET /api/auth/me",
  "GET /api/organization",
  "PATCH /api/organization",
  "GET /api/members",
  "POST /api/members"
]);
const memberAccessRoute = /^\/api\/members\/[^/]+\/(?:reset-password|disable)$/u;

const genericShell = "<!doctype html><html lang=\"ru\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>Decentracord</title></head><body><main><h1>Decentracord</h1><p>Войдите, чтобы продолжить.</p></main></body></html>";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isApiPath(request: Request): boolean {
  let pathname = request.path;
  try {
    pathname = decodeURIComponent(new URL(request.originalUrl, "http://local.invalid").pathname);
  } catch {
    pathname = request.path;
  }
  return pathname === "/api" || pathname.startsWith("/api/");
}

function noStoreApiResponse(request: Request, response: Response, next: (error?: unknown) => void): void {
  if (isApiPath(request)) {
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("Pragma", "no-cache");
  }
  next();
}

function safeApiError(status: number, code?: string, message?: string) {
  const defaultErrors: Record<number, { code: string; message: string }> = {
    400: { code: "INVALID_REQUEST", message: "Некорректный запрос" },
    401: { code: "UNAUTHORIZED", message: "Требуется вход" },
    403: { code: "FORBIDDEN", message: "Недостаточно прав" },
    404: { code: "NOT_FOUND", message: "Не найдено" },
    413: { code: "PAYLOAD_TOO_LARGE", message: "Запрос слишком большой" },
    429: { code: "TOO_MANY_REQUESTS", message: "Слишком много запросов" },
    500: { code: "INTERNAL_SERVER_ERROR", message: "Внутренняя ошибка" }
  };
  const fallback = defaultErrors[status] ?? defaultErrors[500]!;
  return {
    error: {
      code: code && /^[A-Z][A-Z0-9_]{1,63}$/u.test(code) ? code : fallback.code,
      message: message && message.length <= 160 ? message : fallback.message
    }
  };
}

export class ApiExceptionFilter {
  catch(exception: unknown, host: { switchToHttp(): { getResponse<T>(): T } }): void {
    const response = host.switchToHttp().getResponse<Response>();
    let status = 500;
    let code: string | undefined;
    let message: string | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const payload = exception.getResponse();
      if (isRecord(payload)) {
        if (typeof payload.code === "string") code = payload.code;
        if (typeof payload.message === "string") message = payload.message;
      }
    }

    response.status(status).json(safeApiError(status, code, message));
  }
}

Catch()(ApiExceptionFilter);

function expressErrorHandler(): ErrorRequestHandler {
  return (error: unknown, request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }
    if (!isApiPath(request)) {
      next(error);
      return;
    }

    const errorRecord = isRecord(error) ? error : {};
    const candidate = errorRecord.status ?? errorRecord.statusCode;
    const status = typeof candidate === "number" && candidate >= 400 && candidate <= 599 ? candidate : 500;
    response.status(status).json(safeApiError(status));
  };
}

function installPublicStaticFiles(expressApp: Express): string | undefined {
  const publicDirectory = "/app/public";
  if (!existsSync(publicDirectory)) return undefined;
  try {
    if (!statSync(publicDirectory).isDirectory()) return undefined;
  } catch {
    return undefined;
  }

  const indexFile = join(publicDirectory, "index.html");
  let publicIndex: string | undefined;
  try {
    if (statSync(indexFile).isFile()) publicIndex = indexFile;
  } catch {
    // Keep serving any available assets and use the generic shell when the SPA entry is absent.
  }

  const staticFiles = express.static(publicDirectory, {
    dotfiles: "deny",
    fallthrough: true,
    index: false,
    maxAge: "1h"
  });
  expressApp.use((request, response, next) => {
    if (isApiPath(request)) {
      next();
      return;
    }
    staticFiles(request, response, next);
  });
  return publicIndex;
}

function sendPublicShell(
  response: Response,
  publicIndex: string | undefined,
  next: (error?: unknown) => void
): void {
  if (!publicIndex) {
    response.status(200).type("html").send(genericShell);
    return;
  }

  response.sendFile(publicIndex, (error) => {
    if (!error) return;
    if (response.headersSent) {
      next(error);
      return;
    }
    response.status(200).type("html").send(genericShell);
  });
}

function installPublicShellFallback(expressApp: Express, publicIndex: string | undefined): void {
  expressApp.use((request, response, next) => {
    if (isApiPath(request) || (request.method !== "GET" && request.method !== "HEAD")) {
      next();
      return;
    }
    sendPublicShell(response, publicIndex, next);
  });
}

async function migrateBeforeListen(): Promise<void> {
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
  } finally {
    client?.release();
    await pool.end();
  }
}

function readPort(): number {
  const raw = process.env.APP_PORT ?? "3000";
  if (!/^\d{1,5}$/u.test(raw)) throw new Error("Invalid HTTP configuration");
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Invalid HTTP configuration");
  return port;
}

function readHost(): string {
  const host = process.env.APP_HOST ?? "0.0.0.0";
  if (!["0.0.0.0", "127.0.0.1", "::"].includes(host)) throw new Error("Invalid HTTP configuration");
  return host;
}

function readPublicOrigin(): string | undefined {
  if (process.env.NODE_ENV !== "production") return undefined;

  const configuredOrigin = process.env.APP_ORIGIN;
  const publicHost = process.env.PUBLIC_HOST;
  if (!configuredOrigin || !publicHost || configuredOrigin.length > 512 || publicHost.length > 253) {
    throw new Error("Invalid HTTP configuration");
  }

  let parsed: URL;
  try {
    parsed = new URL(configuredOrigin);
  } catch {
    throw new Error("Invalid HTTP configuration");
  }

  const hostname = parsed.hostname.toLowerCase();
  const labels = hostname.split(".");
  const validDnsName = labels.length >= 2 && labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label));
  // The isolated TLS runner uses one internal service name; production hosts remain public DNS names.
  const isolatedTestProxy = process.env.DECENTRACORD_TEST_TLS === "1" &&
    process.env.DB_NAME === "decentracord_test" &&
    configuredOrigin === "https://proxy" &&
    publicHost === "proxy";
  if (
    parsed.protocol !== "https:" ||
    parsed.origin !== configuredOrigin ||
    parsed.port !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    publicHost !== parsed.hostname ||
    (!validDnsName && !isolatedTestProxy) ||
    isIP(hostname) !== 0
  ) {
    throw new Error("Invalid HTTP configuration");
  }

  return parsed.origin;
}

function securityHeaders(publicOrigin: string | undefined) {
  const connectSources = publicOrigin
    ? `'self' ${publicOrigin} ${publicOrigin.replace(/^https:/u, "wss:")}`
    : "'self' ws:";
  const contentSecurityPolicy = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    `connect-src ${connectSources}`
  ].join("; ");

  return (request: Request, response: Response, next: (error?: unknown) => void): void => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Content-Security-Policy", contentSecurityPolicy);
    if (process.env.NODE_ENV === "production" && request.secure) {
      response.setHeader("Strict-Transport-Security", "max-age=31536000");
    }
    next();
  };
}

async function start(): Promise<void> {
  const publicOrigin = readPublicOrigin();
  await migrateBeforeListen();
  const app = await NestFactory.create(AppModule, { bodyParser: false, logger: false });
  const expressApp = app.getHttpAdapter().getInstance() as Express;
  expressApp.set("trust proxy", 1);
  expressApp.disable("x-powered-by");
  app.use(securityHeaders(publicOrigin));
  app.use(noStoreApiResponse);
  app.use(express.json({ limit: "32kb", strict: true }));
  const sessions = app.get(SessionService);
  app.use(sessions.createMiddleware());
  app.use((request: Request, response: Response, next: (error?: unknown) => void) => {
    if (!isApiPath(request)) {
      next();
      return;
    }
    const route = `${request.method.toUpperCase()} ${request.path}`;
    if (privateApiRoutes.has(route) || (request.method.toUpperCase() === "POST" && memberAccessRoute.test(request.path))) {
      next();
      return;
    }
    response.status(401).json(safeApiError(401));
  });
  expressApp.get("/healthz", (_request, response) => response.status(200).json({ status: "ok" }));
  const publicIndex = installPublicStaticFiles(expressApp);
  installPublicShellFallback(expressApp, publicIndex);
  app.useGlobalFilters(new ApiExceptionFilter());
  app.enableShutdownHooks();

  await sessions.prepare();
  await app.init();
  expressApp.use(expressErrorHandler());

  await app.listen(readPort(), readHost());
}

const command = process.argv[2];
if (command && command !== "server") {
  await import("./cli.js");
} else {
  try {
    await start();
  } catch {
    process.stderr.write('{"ok":false,"code":"APPLICATION_START_FAILED"}\n');
    process.exitCode = 1;
  }
}
