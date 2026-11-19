import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Put, Req } from "@nestjs/common";
import type { RoleSummary } from "../auth/contracts.js";
import type { AuthenticatedRequest } from "../auth/session.service.js";
import { RolesService } from "./roles.service.js";

function applyMethodDecorator(decorator: MethodDecorator, target: object, property: string): void {
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

function principal(request: AuthenticatedRequest) {
  if (!request.authPrincipal) throw new Error("Authenticated principal missing");
  return request.authPrincipal;
}

export class RolesController {
  constructor(private readonly roles: RolesService) {}

  async getRoles(request: AuthenticatedRequest): Promise<{ roles: RoleSummary[] }> {
    return { roles: await this.roles.list(principal(request)) };
  }

  async createRole(request: AuthenticatedRequest, body: unknown): Promise<RoleSummary> {
    return this.roles.create(principal(request), body);
  }

  async updateRole(request: AuthenticatedRequest, roleId: string, body: unknown): Promise<RoleSummary> {
    return this.roles.update(principal(request), roleId, body);
  }

  async reorderRoles(request: AuthenticatedRequest, body: unknown): Promise<void> {
    await this.roles.reorder(principal(request), body);
  }
}

Controller("api/roles")(RolesController);
Inject(RolesService)(RolesController, undefined, 0);
applyMethodDecorator(Get(), RolesController.prototype, "getRoles");
applyParameterDecorator(Req(), RolesController, "getRoles", 0);
applyMethodDecorator(Post(), RolesController.prototype, "createRole");
applyMethodDecorator(HttpCode(201), RolesController.prototype, "createRole");
applyParameterDecorator(Req(), RolesController, "createRole", 0);
applyParameterDecorator(Body(), RolesController, "createRole", 1);
applyMethodDecorator(Patch(":roleId"), RolesController.prototype, "updateRole");
applyParameterDecorator(Req(), RolesController, "updateRole", 0);
applyParameterDecorator(Param("roleId"), RolesController, "updateRole", 1);
applyParameterDecorator(Body(), RolesController, "updateRole", 2);
applyMethodDecorator(Put("order"), RolesController.prototype, "reorderRoles");
applyMethodDecorator(HttpCode(204), RolesController.prototype, "reorderRoles");
applyParameterDecorator(Req(), RolesController, "reorderRoles", 0);
applyParameterDecorator(Body(), RolesController, "reorderRoles", 1);
