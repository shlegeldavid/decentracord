import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { SessionRevocationService } from "./session-revocation.service.js";
import { SessionService, type AuthenticatedRequest } from "./session.service.js";

function applyMethodDecorator(
  decorator: MethodDecorator,
  target: object,
  property: string
): void {
  const descriptor = Object.getOwnPropertyDescriptor(target, property);
  if (!descriptor) throw new Error("Route handler is missing");
  decorator(target, property, descriptor);
}

function applyParameterDecorator(
  decorator: ParameterDecorator,
  constructor: { prototype: object },
  property: string,
  index: number
): void {
  decorator(constructor.prototype, property, index);
}

export class AuthController {
  constructor(private readonly sessions: SessionService, private readonly revocations: SessionRevocationService) {}

  issueCsrf(request: Request): Promise<{ csrfToken: string }> {
    return this.sessions.issueCsrfToken(request);
  }

  login(request: Request, body: unknown): Promise<{ user: { id: string; login: string }; csrfToken: string }> {
    return this.sessions.login(request, body);
  }

  me(request: AuthenticatedRequest): Promise<{ id: string; login: string }> {
    if (!request.authPrincipal) {
      throw new Error("Authenticated principal missing");
    }
    return this.sessions.currentUser(request.authPrincipal);
  }

  async logout(request: AuthenticatedRequest, response: Response): Promise<void> {
    const principal = request.authPrincipal;
    if (!principal) throw new Error("Authenticated principal missing");
    await this.revocations.revokeCurrentSession(principal, request);
    this.sessions.clearSessionCookie(response);
  }

  async changePassword(request: AuthenticatedRequest, value: unknown, response: Response): Promise<void> {
    const principal = request.authPrincipal;
    if (!principal) throw new Error("Authenticated principal missing");
    await this.revocations.revokeAllUserSessions(principal, async () => {
      await this.sessions.changePassword(principal, request, value);
      this.sessions.clearSessionCookie(response);
    });
  }
}

Controller("api/auth")(AuthController);
Inject(SessionService)(AuthController, undefined, 0);
Inject(SessionRevocationService)(AuthController, undefined, 1);
applyMethodDecorator(Get("csrf"), AuthController.prototype, "issueCsrf");
applyParameterDecorator(Req(), AuthController, "issueCsrf", 0);
applyMethodDecorator(Post("login"), AuthController.prototype, "login");
applyMethodDecorator(HttpCode(200), AuthController.prototype, "login");
applyParameterDecorator(Req(), AuthController, "login", 0);
applyParameterDecorator(Body(), AuthController, "login", 1);
applyMethodDecorator(Get("me"), AuthController.prototype, "me");
applyParameterDecorator(Req(), AuthController, "me", 0);
applyMethodDecorator(Post("logout"), AuthController.prototype, "logout");
applyMethodDecorator(HttpCode(204), AuthController.prototype, "logout");
applyParameterDecorator(Req(), AuthController, "logout", 0);
applyParameterDecorator(Res({ passthrough: true }), AuthController, "logout", 1);
applyMethodDecorator(Post("password"), AuthController.prototype, "changePassword");
applyMethodDecorator(HttpCode(204), AuthController.prototype, "changePassword");
applyParameterDecorator(Req(), AuthController, "changePassword", 0);
applyParameterDecorator(Body(), AuthController, "changePassword", 1);
applyParameterDecorator(Res({ passthrough: true }), AuthController, "changePassword", 2);
