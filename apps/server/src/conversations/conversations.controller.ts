import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Req } from "@nestjs/common";
import type { AuthenticatedRequest } from "../auth/session.service.js";
import { ConversationsService } from "./conversations.service.js";

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

export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  async listConversations(request: AuthenticatedRequest) {
    return this.conversations.list(principal(request));
  }

  async createConversation(request: AuthenticatedRequest, body: unknown) {
    return this.conversations.create(principal(request), body);
  }

  async getConversation(request: AuthenticatedRequest, conversationId: string) {
    return this.conversations.get(principal(request), conversationId);
  }

  // Тело ответа не возвращается (204): клиент уже знает отправленный `seq`, а
  // 204 не создаёт иллюзию контракта.
  async markConversationRead(request: AuthenticatedRequest, conversationId: string, body: unknown) {
    return this.conversations.markRead(principal(request), conversationId, body);
  }

  async closeConversation(request: AuthenticatedRequest, conversationId: string) {
    return this.conversations.close(principal(request), conversationId);
  }

  // Состав группы. Ответ 204: клиент уже знает, кого добавил, а
  // обновлённый состав приходит событием `conversations:sync`.
  async addConversationParticipant(request: AuthenticatedRequest, conversationId: string, body: unknown) {
    return this.conversations.addParticipant(principal(request), conversationId, body);
  }

  async updateConversationParticipant(
    request: AuthenticatedRequest,
    conversationId: string,
    participantId: string,
    body: unknown
  ) {
    return this.conversations.setParticipantRight(principal(request), conversationId, participantId, body);
  }

  async removeConversationParticipant(request: AuthenticatedRequest, conversationId: string, participantId: string) {
    return this.conversations.removeParticipant(principal(request), conversationId, participantId);
  }
}

Controller("api/conversations")(ConversationsController);
Inject(ConversationsService)(ConversationsController, undefined, 0);
applyMethodDecorator(Get(), ConversationsController.prototype, "listConversations");
applyParameterDecorator(Req(), ConversationsController, "listConversations", 0);
applyMethodDecorator(Post(), ConversationsController.prototype, "createConversation");
applyMethodDecorator(HttpCode(201), ConversationsController.prototype, "createConversation");
applyParameterDecorator(Req(), ConversationsController, "createConversation", 0);
applyParameterDecorator(Body(), ConversationsController, "createConversation", 1);
applyMethodDecorator(Get(":conversationId"), ConversationsController.prototype, "getConversation");
applyParameterDecorator(Req(), ConversationsController, "getConversation", 0);
applyParameterDecorator(Param("conversationId"), ConversationsController, "getConversation", 1);
applyMethodDecorator(Post(":conversationId/read"), ConversationsController.prototype, "markConversationRead");
applyMethodDecorator(HttpCode(204), ConversationsController.prototype, "markConversationRead");
applyParameterDecorator(Req(), ConversationsController, "markConversationRead", 0);
applyParameterDecorator(Param("conversationId"), ConversationsController, "markConversationRead", 1);
applyParameterDecorator(Body(), ConversationsController, "markConversationRead", 2);
applyMethodDecorator(Post(":conversationId/close"), ConversationsController.prototype, "closeConversation");
applyMethodDecorator(HttpCode(204), ConversationsController.prototype, "closeConversation");
applyParameterDecorator(Req(), ConversationsController, "closeConversation", 0);
applyParameterDecorator(Param("conversationId"), ConversationsController, "closeConversation", 1);
applyMethodDecorator(Post(":conversationId/participants"), ConversationsController.prototype, "addConversationParticipant");
applyMethodDecorator(HttpCode(204), ConversationsController.prototype, "addConversationParticipant");
applyParameterDecorator(Req(), ConversationsController, "addConversationParticipant", 0);
applyParameterDecorator(Param("conversationId"), ConversationsController, "addConversationParticipant", 1);
applyParameterDecorator(Body(), ConversationsController, "addConversationParticipant", 2);
applyMethodDecorator(Patch(":conversationId/participants/:userId"), ConversationsController.prototype, "updateConversationParticipant");
applyMethodDecorator(HttpCode(204), ConversationsController.prototype, "updateConversationParticipant");
applyParameterDecorator(Req(), ConversationsController, "updateConversationParticipant", 0);
applyParameterDecorator(Param("conversationId"), ConversationsController, "updateConversationParticipant", 1);
applyParameterDecorator(Param("userId"), ConversationsController, "updateConversationParticipant", 2);
applyParameterDecorator(Body(), ConversationsController, "updateConversationParticipant", 3);
applyMethodDecorator(Delete(":conversationId/participants/:userId"), ConversationsController.prototype, "removeConversationParticipant");
applyMethodDecorator(HttpCode(204), ConversationsController.prototype, "removeConversationParticipant");
applyParameterDecorator(Req(), ConversationsController, "removeConversationParticipant", 0);
applyParameterDecorator(Param("conversationId"), ConversationsController, "removeConversationParticipant", 1);
applyParameterDecorator(Param("userId"), ConversationsController, "removeConversationParticipant", 2);
