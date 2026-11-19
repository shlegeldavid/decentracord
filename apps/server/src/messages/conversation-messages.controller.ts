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

/**
 * Сообщения переписки. Отдельный контроллер: у `MessagesController`
 * база `api/channels`, а две базы в одном классе невозможны.
 */
export class ConversationMessagesController {
  constructor(private readonly messages: MessagesService) {}

  async listConversationMessages(request: AuthenticatedRequest, conversationId: string, query: unknown) {
    return this.messages.listConversationMessages(principal(request), conversationId, query);
  }

  async sendConversationMessage(request: AuthenticatedRequest, conversationId: string, body: unknown) {
    return this.messages.sendToConversation(principal(request), conversationId, body);
  }

  async editConversationMessage(
    request: AuthenticatedRequest,
    conversationId: string,
    messageId: string,
    body: unknown
  ) {
    return this.messages.editInConversation(principal(request), conversationId, messageId, body);
  }

  async deleteConversationMessage(
    request: AuthenticatedRequest,
    conversationId: string,
    messageId: string
  ): Promise<void> {
    await this.messages.removeInConversation(principal(request), conversationId, messageId);
  }

  async forwardFromConversationMessage(
    request: AuthenticatedRequest,
    conversationId: string,
    messageId: string,
    body: unknown
  ) {
    return this.messages.forwardFromConversation(principal(request), conversationId, messageId, body);
  }
}

Controller("api/conversations")(ConversationMessagesController);
Inject(MessagesService)(ConversationMessagesController, undefined, 0);
applyMethodDecorator(Get(":conversationId/messages"), ConversationMessagesController.prototype, "listConversationMessages");
applyParameterDecorator(Req(), ConversationMessagesController, "listConversationMessages", 0);
applyParameterDecorator(Param("conversationId"), ConversationMessagesController, "listConversationMessages", 1);
applyParameterDecorator(Query(), ConversationMessagesController, "listConversationMessages", 2);
applyMethodDecorator(Post(":conversationId/messages"), ConversationMessagesController.prototype, "sendConversationMessage");
applyMethodDecorator(HttpCode(201), ConversationMessagesController.prototype, "sendConversationMessage");
applyParameterDecorator(Req(), ConversationMessagesController, "sendConversationMessage", 0);
applyParameterDecorator(Param("conversationId"), ConversationMessagesController, "sendConversationMessage", 1);
applyParameterDecorator(Body(), ConversationMessagesController, "sendConversationMessage", 2);
applyMethodDecorator(Patch(":conversationId/messages/:messageId"), ConversationMessagesController.prototype, "editConversationMessage");
applyParameterDecorator(Req(), ConversationMessagesController, "editConversationMessage", 0);
applyParameterDecorator(Param("conversationId"), ConversationMessagesController, "editConversationMessage", 1);
applyParameterDecorator(Param("messageId"), ConversationMessagesController, "editConversationMessage", 2);
applyParameterDecorator(Body(), ConversationMessagesController, "editConversationMessage", 3);
applyMethodDecorator(Delete(":conversationId/messages/:messageId"), ConversationMessagesController.prototype, "deleteConversationMessage");
applyMethodDecorator(HttpCode(204), ConversationMessagesController.prototype, "deleteConversationMessage");
applyParameterDecorator(Req(), ConversationMessagesController, "deleteConversationMessage", 0);
applyParameterDecorator(Param("conversationId"), ConversationMessagesController, "deleteConversationMessage", 1);
applyParameterDecorator(Param("messageId"), ConversationMessagesController, "deleteConversationMessage", 2);
applyMethodDecorator(Post(":conversationId/messages/:messageId/forward"), ConversationMessagesController.prototype, "forwardFromConversationMessage");
applyMethodDecorator(HttpCode(201), ConversationMessagesController.prototype, "forwardFromConversationMessage");
applyParameterDecorator(Req(), ConversationMessagesController, "forwardFromConversationMessage", 0);
applyParameterDecorator(Param("conversationId"), ConversationMessagesController, "forwardFromConversationMessage", 1);
applyParameterDecorator(Param("messageId"), ConversationMessagesController, "forwardFromConversationMessage", 2);
applyParameterDecorator(Body(), ConversationMessagesController, "forwardFromConversationMessage", 3);
