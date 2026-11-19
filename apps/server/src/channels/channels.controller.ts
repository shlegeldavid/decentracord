import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Req } from "@nestjs/common";
import type { AuthenticatedRequest } from "../auth/session.service.js";
import { ChannelsService } from "./channels.service.js";

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
  if (!request.authPrincipal) throw new Error("Authenticated principal missing");
  return request.authPrincipal;
}

export class ChannelsController {
  constructor(private readonly channels: ChannelsService) {}

  async getChannels(request: AuthenticatedRequest) {
    return this.channels.list(principal(request));
  }

  async getSubjects(request: AuthenticatedRequest) {
    return this.channels.listSubjects(principal(request));
  }

  async getCategories(request: AuthenticatedRequest) {
    return this.channels.listCategories(principal(request));
  }

  async createCategory(request: AuthenticatedRequest, body: unknown) {
    return this.channels.createCategory(principal(request), body);
  }

  async renameCategory(request: AuthenticatedRequest, categoryId: string, body: unknown) {
    return this.channels.renameCategory(principal(request), categoryId, body);
  }

  async deleteCategory(request: AuthenticatedRequest, categoryId: string): Promise<void> {
    await this.channels.deleteCategory(principal(request), categoryId);
  }

  async reorderCategories(request: AuthenticatedRequest, body: unknown): Promise<void> {
    await this.channels.reorderCategories(principal(request), body);
  }

  async reorderChannels(request: AuthenticatedRequest, body: unknown): Promise<void> {
    await this.channels.reorderChannels(principal(request), body);
  }

  async getChannel(request: AuthenticatedRequest, channelId: string) {
    return this.channels.get(principal(request), channelId);
  }

  async createChannel(request: AuthenticatedRequest, body: unknown) {
    return this.channels.create(principal(request), body);
  }

  async renameChannel(request: AuthenticatedRequest, channelId: string, body: unknown) {
    return this.channels.update(principal(request), channelId, body);
  }

  async setChannelOverrides(request: AuthenticatedRequest, channelId: string, body: unknown): Promise<void> {
    await this.channels.setOverrides(principal(request), channelId, body);
  }

}

Controller("api/channels")(ChannelsController);
Inject(ChannelsService)(ChannelsController, undefined, 0);
applyMethodDecorator(Get(), ChannelsController.prototype, "getChannels");
applyParameterDecorator(Req(), ChannelsController, "getChannels", 0);
applyMethodDecorator(Get("subjects"), ChannelsController.prototype, "getSubjects");
applyParameterDecorator(Req(), ChannelsController, "getSubjects", 0);
applyMethodDecorator(Get("categories"), ChannelsController.prototype, "getCategories");
applyParameterDecorator(Req(), ChannelsController, "getCategories", 0);
applyMethodDecorator(Post("categories"), ChannelsController.prototype, "createCategory");
applyMethodDecorator(HttpCode(201), ChannelsController.prototype, "createCategory");
applyParameterDecorator(Req(), ChannelsController, "createCategory", 0);
applyParameterDecorator(Body(), ChannelsController, "createCategory", 1);
applyMethodDecorator(Patch("categories/:categoryId"), ChannelsController.prototype, "renameCategory");
applyParameterDecorator(Req(), ChannelsController, "renameCategory", 0);
applyParameterDecorator(Param("categoryId"), ChannelsController, "renameCategory", 1);
applyParameterDecorator(Body(), ChannelsController, "renameCategory", 2);
applyMethodDecorator(Delete("categories/:categoryId"), ChannelsController.prototype, "deleteCategory");
applyMethodDecorator(HttpCode(204), ChannelsController.prototype, "deleteCategory");
applyParameterDecorator(Req(), ChannelsController, "deleteCategory", 0);
applyParameterDecorator(Param("categoryId"), ChannelsController, "deleteCategory", 1);
applyMethodDecorator(Put("categories/order"), ChannelsController.prototype, "reorderCategories");
applyMethodDecorator(HttpCode(204), ChannelsController.prototype, "reorderCategories");
applyParameterDecorator(Req(), ChannelsController, "reorderCategories", 0);
applyParameterDecorator(Body(), ChannelsController, "reorderCategories", 1);
applyMethodDecorator(Put("order"), ChannelsController.prototype, "reorderChannels");
applyMethodDecorator(HttpCode(204), ChannelsController.prototype, "reorderChannels");
applyParameterDecorator(Req(), ChannelsController, "reorderChannels", 0);
applyParameterDecorator(Body(), ChannelsController, "reorderChannels", 1);
applyMethodDecorator(Get(":channelId"), ChannelsController.prototype, "getChannel");
applyParameterDecorator(Req(), ChannelsController, "getChannel", 0);
applyParameterDecorator(Param("channelId"), ChannelsController, "getChannel", 1);
applyMethodDecorator(Post(), ChannelsController.prototype, "createChannel");
applyMethodDecorator(HttpCode(201), ChannelsController.prototype, "createChannel");
applyParameterDecorator(Req(), ChannelsController, "createChannel", 0);
applyParameterDecorator(Body(), ChannelsController, "createChannel", 1);
applyMethodDecorator(Patch(":channelId"), ChannelsController.prototype, "renameChannel");
applyParameterDecorator(Req(), ChannelsController, "renameChannel", 0);
applyParameterDecorator(Param("channelId"), ChannelsController, "renameChannel", 1);
applyParameterDecorator(Body(), ChannelsController, "renameChannel", 2);
applyMethodDecorator(Put(":channelId/overrides"), ChannelsController.prototype, "setChannelOverrides");
applyMethodDecorator(HttpCode(204), ChannelsController.prototype, "setChannelOverrides");
applyParameterDecorator(Req(), ChannelsController, "setChannelOverrides", 0);
applyParameterDecorator(Param("channelId"), ChannelsController, "setChannelOverrides", 1);
applyParameterDecorator(Body(), ChannelsController, "setChannelOverrides", 2);
