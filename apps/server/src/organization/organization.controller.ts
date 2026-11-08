import { Body, Controller, Get, HttpCode, HttpException, Inject, Patch, Req } from "@nestjs/common";
import type { Pool } from "pg";
import { AuthorizationService } from "../auth/authorization.service.js";
import { parseOrganizationName } from "../auth/contracts.js";
import { DATABASE_POOL, type AuthPrincipal, type AuthenticatedRequest } from "../auth/session.service.js";

function auditOrganizationChange(actorUserId: string, outcome: string): void {
  try {
    process.stdout.write(`${JSON.stringify({
      event: "audit.organization.name.update",
      actorUserId,
      target: { type: "organization", id: "1" },
      outcome
    })}\n`);
  } catch {
    // An audit output failure must not change the authorization or write result.
  }
}

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

export class OrganizationController {
  constructor(
    private readonly pool: Pool,
    private readonly authorization: AuthorizationService
  ) {}

  async getOrganization(request: AuthenticatedRequest): Promise<{ name: string }> {
    if (!request.authPrincipal) {
      throw new HttpException({ code: "UNAUTHORIZED", message: "Требуется вход" }, 401);
    }

    const result = await this.pool.query<{ name: string }>(
      "SELECT name FROM organization WHERE id = 1"
    );
    const organization = result.rows[0];
    if (!organization) {
      throw new Error("Organization is not initialized");
    }
    return { name: organization.name };
  }

  async updateOrganization(
    request: AuthenticatedRequest,
    body: unknown
  ): Promise<{ name: string }> {
    if (!request.authPrincipal) {
      throw new HttpException({ code: "UNAUTHORIZED", message: "Требуется вход" }, 401);
    }

    const principal: AuthPrincipal = request.authPrincipal;
    try {
      await this.authorization.requireAdministrator(principal);
    } catch (error) {
      auditOrganizationChange(principal.userId, "forbidden");
      throw error;
    }
    const name = parseOrganizationName(body);
    if (!name) {
      auditOrganizationChange(principal.userId, "invalid_request");
      throw new HttpException({ code: "INVALID_REQUEST", message: "Некорректное название" }, 400);
    }

    try {
      const result = await this.pool.query<{ name: string }>(
        "UPDATE organization SET name = $1, updated_at = now() WHERE id = 1 RETURNING name",
        [name]
      );
      const organization = result.rows[0];
      if (!organization) {
        throw new Error("Organization is not initialized");
      }
      auditOrganizationChange(principal.userId, "updated");
      return { name: organization.name };
    } catch (error) {
      auditOrganizationChange(principal.userId, "failed");
      throw error;
    }
  }
}

Controller("api/organization")(OrganizationController);
Inject(DATABASE_POOL)(OrganizationController, undefined, 0);
Inject(AuthorizationService)(OrganizationController, undefined, 1);
applyMethodDecorator(Get(), OrganizationController.prototype, "getOrganization");
applyParameterDecorator(Req(), OrganizationController, "getOrganization", 0);
applyMethodDecorator(Patch(), OrganizationController.prototype, "updateOrganization");
applyMethodDecorator(HttpCode(200), OrganizationController.prototype, "updateOrganization");
applyParameterDecorator(Req(), OrganizationController, "updateOrganization", 0);
applyParameterDecorator(Body(), OrganizationController, "updateOrganization", 1);
