import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query, Req } from "@nestjs/common";
import type { AuthenticatedRequest } from "../auth/session.service.js";
import { MessagesService } from "./messages.service.js";

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

export class MessagesController {
  constructor(private readonly messages: MessagesService) {}

  async sendMessage(request: AuthenticatedRequest, channelId: string, body: unknown) {
    return this.messages.send(principal(request), channelId, body);
  }

  async listMessages(request: AuthenticatedRequest, channelId: string, query: unknown) {
    return this.messages.listMessages(principal(request), channelId, query);
  }

  async forwardMessage(request: AuthenticatedRequest, channelId: string, messageId: string, body: unknown) {
    return this.messages.forwardMessage(principal(request), channelId, messageId, body);
  }

  async editMessage(request: AuthenticatedRequest, channelId: string, messageId: string, body: unknown) {
    return this.messages.edit(principal(request), channelId, messageId, body);
  }

  async deleteMessage(request: AuthenticatedRequest, channelId: string, messageId: string): Promise<void> {
    await this.messages.remove(principal(request), channelId, messageId);
  }

  async markChannelRead(request: AuthenticatedRequest, channelId: string, body: unknown): Promise<void> {
    await this.messages.markRead(principal(request), channelId, body);
  }

  async listChannelMembers(request: AuthenticatedRequest, channelId: string) {
    return this.messages.listMembers(principal(request), channelId);
  }

  async listMessageReaders(request: AuthenticatedRequest, channelId: string, messageId: string) {
    const readers = await this.messages.listReaders(principal(request), channelId, messageId);
    return { readers };
  }

  async listChannelPins(request: AuthenticatedRequest, channelId: string) {
    const pins = await this.messages.listPins(principal(request), channelId);
    return { pins };
  }

  async pinChannelMessage(request: AuthenticatedRequest, channelId: string, body: unknown): Promise<void> {
    await this.messages.pinMessage(principal(request), channelId, body);
  }

  async unpinChannelMessage(request: AuthenticatedRequest, channelId: string, messageId: string): Promise<void> {
    await this.messages.unpinMessage(principal(request), channelId, messageId);
  }
}

Controller("api/channels")(MessagesController);
Inject(MessagesService)(MessagesController, undefined, 0);
applyMethodDecorator(Post(":channelId/messages"), MessagesController.prototype, "sendMessage");
applyMethodDecorator(HttpCode(201), MessagesController.prototype, "sendMessage");
applyParameterDecorator(Req(), MessagesController, "sendMessage", 0);
applyParameterDecorator(Param("channelId"), MessagesController, "sendMessage", 1);
applyParameterDecorator(Body(), MessagesController, "sendMessage", 2);
applyMethodDecorator(Get(":channelId/messages"), MessagesController.prototype, "listMessages");
applyParameterDecorator(Req(), MessagesController, "listMessages", 0);
applyParameterDecorator(Param("channelId"), MessagesController, "listMessages", 1);
applyParameterDecorator(Query(), MessagesController, "listMessages", 2);
applyMethodDecorator(Post(":channelId/messages/:messageId/forward"), MessagesController.prototype, "forwardMessage");
applyMethodDecorator(HttpCode(201), MessagesController.prototype, "forwardMessage");
applyParameterDecorator(Req(), MessagesController, "forwardMessage", 0);
applyParameterDecorator(Param("channelId"), MessagesController, "forwardMessage", 1);
applyParameterDecorator(Param("messageId"), MessagesController, "forwardMessage", 2);
applyParameterDecorator(Body(), MessagesController, "forwardMessage", 3);
applyMethodDecorator(Patch(":channelId/messages/:messageId"), MessagesController.prototype, "editMessage");
applyParameterDecorator(Req(), MessagesController, "editMessage", 0);
applyParameterDecorator(Param("channelId"), MessagesController, "editMessage", 1);
applyParameterDecorator(Param("messageId"), MessagesController, "editMessage", 2);
applyParameterDecorator(Body(), MessagesController, "editMessage", 3);
applyMethodDecorator(Delete(":channelId/messages/:messageId"), MessagesController.prototype, "deleteMessage");
applyMethodDecorator(HttpCode(204), MessagesController.prototype, "deleteMessage");
applyParameterDecorator(Req(), MessagesController, "deleteMessage", 0);
applyParameterDecorator(Param("channelId"), MessagesController, "deleteMessage", 1);
applyParameterDecorator(Param("messageId"), MessagesController, "deleteMessage", 2);
applyMethodDecorator(Get(":channelId/messages/:messageId/readers"), MessagesController.prototype, "listMessageReaders");
applyParameterDecorator(Req(), MessagesController, "listMessageReaders", 0);
applyParameterDecorator(Param("channelId"), MessagesController, "listMessageReaders", 1);
applyParameterDecorator(Param("messageId"), MessagesController, "listMessageReaders", 2);
applyMethodDecorator(Post(":channelId/read"), MessagesController.prototype, "markChannelRead");
applyMethodDecorator(HttpCode(204), MessagesController.prototype, "markChannelRead");
applyParameterDecorator(Req(), MessagesController, "markChannelRead", 0);
applyParameterDecorator(Param("channelId"), MessagesController, "markChannelRead", 1);
applyParameterDecorator(Body(), MessagesController, "markChannelRead", 2);
applyMethodDecorator(Get(":channelId/members"), MessagesController.prototype, "listChannelMembers");
applyParameterDecorator(Req(), MessagesController, "listChannelMembers", 0);
applyParameterDecorator(Param("channelId"), MessagesController, "listChannelMembers", 1);
applyMethodDecorator(Get(":channelId/pins"), MessagesController.prototype, "listChannelPins");
applyParameterDecorator(Req(), MessagesController, "listChannelPins", 0);
applyParameterDecorator(Param("channelId"), MessagesController, "listChannelPins", 1);
applyMethodDecorator(Post(":channelId/pins"), MessagesController.prototype, "pinChannelMessage");
applyMethodDecorator(HttpCode(204), MessagesController.prototype, "pinChannelMessage");
applyParameterDecorator(Req(), MessagesController, "pinChannelMessage", 0);
applyParameterDecorator(Param("channelId"), MessagesController, "pinChannelMessage", 1);
applyParameterDecorator(Body(), MessagesController, "pinChannelMessage", 2);
applyMethodDecorator(Delete(":channelId/pins/:messageId"), MessagesController.prototype, "unpinChannelMessage");
applyMethodDecorator(HttpCode(204), MessagesController.prototype, "unpinChannelMessage");
applyParameterDecorator(Req(), MessagesController, "unpinChannelMessage", 0);
applyParameterDecorator(Param("channelId"), MessagesController, "unpinChannelMessage", 1);
applyParameterDecorator(Param("messageId"), MessagesController, "unpinChannelMessage", 2);
