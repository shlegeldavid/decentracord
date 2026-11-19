import { Module, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import type { Response } from "express";
import type { Pool } from "pg";
import { AccessModule } from "../access/access.module.js";
import { AccessService } from "../access/access.service.js";
import { DbModule } from "../db.module.js";
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

const providers = [
  { provide: PasswordService, useFactory: () => new PasswordService() },
  {
    provide: SessionService,
    useFactory: (pool: Pool, passwordService: PasswordService, access: AccessService) =>
      new SessionService(pool, passwordService, Date.now, access),
    inject: [DATABASE_POOL, PasswordService, AccessService]
  },
  {
    provide: SessionRevocationService,
    useFactory: (sessions: SessionService) => new SessionRevocationService(sessions),
    inject: [SessionService]
  },
  {
    provide: AuthorizationService,
    useFactory: (access: AccessService) => new AuthorizationService(access),
    inject: [AccessService]
  },
  {
    provide: APP_GUARD,
    useFactory: (sessions: SessionService) => new SessionGuard(sessions),
    inject: [SessionService]
  },
];

export class AuthModule {}

Module({
  controllers: [AuthController],
  imports: [DbModule, AccessModule],
  exports: [DbModule, AccessModule, SessionService, SessionRevocationService, AuthorizationService],
  providers
})(AuthModule);
