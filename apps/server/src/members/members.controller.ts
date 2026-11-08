import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req } from "@nestjs/common";
import type { MemberSummary } from "../auth/contracts.js";
import type { AuthenticatedRequest } from "../auth/session.service.js";
import { MembersService } from "./members.service.js";

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

function principal(request: AuthenticatedRequest) {
  if (!request.authPrincipal) {
    throw new Error("Authenticated principal missing");
  }
  return request.authPrincipal;
}

export class MembersController {
  constructor(private readonly members: MembersService) {}

  async getMembers(request: AuthenticatedRequest): Promise<{ members: MemberSummary[] }> {
    return { members: await this.members.list(principal(request)) };
  }

  async createMember(request: AuthenticatedRequest, body: unknown): Promise<MemberSummary> {
    return this.members.create(principal(request), body);
  }

  async resetMemberPassword(request: AuthenticatedRequest, memberId: string, body: unknown): Promise<void> {
    await this.members.resetPassword(principal(request), memberId, body);
  }

  async disableMember(request: AuthenticatedRequest, memberId: string): Promise<void> {
    await this.members.disable(principal(request), memberId);
  }
}

Controller("api/members")(MembersController);
Inject(MembersService)(MembersController, undefined, 0);
applyMethodDecorator(Get(), MembersController.prototype, "getMembers");
applyParameterDecorator(Req(), MembersController, "getMembers", 0);
applyMethodDecorator(Post(), MembersController.prototype, "createMember");
applyMethodDecorator(HttpCode(201), MembersController.prototype, "createMember");
applyParameterDecorator(Req(), MembersController, "createMember", 0);
applyParameterDecorator(Body(), MembersController, "createMember", 1);
applyMethodDecorator(Post(":memberId/reset-password"), MembersController.prototype, "resetMemberPassword");
applyMethodDecorator(HttpCode(204), MembersController.prototype, "resetMemberPassword");
applyParameterDecorator(Req(), MembersController, "resetMemberPassword", 0);
applyParameterDecorator(Param("memberId"), MembersController, "resetMemberPassword", 1);
applyParameterDecorator(Body(), MembersController, "resetMemberPassword", 2);
applyMethodDecorator(Post(":memberId/disable"), MembersController.prototype, "disableMember");
applyMethodDecorator(HttpCode(204), MembersController.prototype, "disableMember");
applyParameterDecorator(Req(), MembersController, "disableMember", 0);
applyParameterDecorator(Param("memberId"), MembersController, "disableMember", 1);
