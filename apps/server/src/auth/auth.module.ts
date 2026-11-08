import { Module, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import type { Response } from "express";
import type { Pool } from "pg";
import { createDatabasePool } from "../db.js";
import { AuthorizationService } from "./authorization.service.js";
import { AuthController } from "./auth.controller.js";
import { PasswordService } from "./password.service.js";
import { DATABASE_POOL, SessionService, type AuthenticatedRequest } from "./session.service.js";
import { SessionRevocationService } from "./session-revocation.service.js";

const publicRoutes = new Set([
  "GET /api/auth/csrf",
  "POST /api/auth/login"
]);

class SessionGuard implements CanActivate {
  constructor(private readonly sessions: SessionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const route = `${request.method.toUpperCase()} ${request.path}`;
    if (publicRoutes.has(route)) return true;

    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method.toUpperCase())) {
      this.sessions.assertCsrf(request);
    }

    try {
      request.authPrincipal = await this.sessions.requireActiveSession(request);
    } catch (error) {
      // Preserve the anonymous CSRF session established for the login form.
      if (request.session?.auth) {
        this.sessions.clearSessionCookie(context.switchToHttp().getResponse<Response>());
      }
      throw error;
    }
    return true;
  }
}

class DatabasePoolLifecycle {
  constructor(private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

const providers = [
  { provide: DATABASE_POOL, useFactory: createDatabasePool },
  { provide: PasswordService, useFactory: () => new PasswordService() },
  {
    provide: SessionService,
    useFactory: (pool: Pool, passwordService: PasswordService) => new SessionService(pool, passwordService),
    inject: [DATABASE_POOL, PasswordService]
  },
  {
    provide: SessionRevocationService,
    useFactory: (sessions: SessionService) => new SessionRevocationService(sessions),
    inject: [SessionService]
  },
  {
    provide: AuthorizationService,
    useFactory: (pool: Pool) => new AuthorizationService(pool),
    inject: [DATABASE_POOL]
  },
  {
    provide: APP_GUARD,
    useFactory: (sessions: SessionService) => new SessionGuard(sessions),
    inject: [SessionService]
  },
  {
    provide: DatabasePoolLifecycle,
    useFactory: (pool: Pool) => new DatabasePoolLifecycle(pool),
    inject: [DATABASE_POOL]
  }
];

export class AuthModule {}

Module({
  controllers: [AuthController],
  exports: [DATABASE_POOL, SessionService, SessionRevocationService, AuthorizationService],
  providers
})(AuthModule);
