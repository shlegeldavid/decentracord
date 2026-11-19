import { WebSocketGateway } from "@nestjs/websockets";
import { HttpException } from "@nestjs/common";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Request, Response } from "express";
import type { Namespace, Socket } from "socket.io";
import { AccessService, type UserChannelAccessChange } from "../access/access.service.js";
import { SessionRevocationService, type SocketPrincipalData } from "../auth/session-revocation.service.js";
import { SessionService } from "../auth/session.service.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function errorCode(error: unknown): string {
  if (!(error instanceof HttpException)) return "FORBIDDEN";
  const response = error.getResponse();
  return isRecord(response) && typeof response.code === "string" ? response.code : "FORBIDDEN";
}

function denyTransportRequest(response: ServerResponse, sessions: SessionService, status: number, clearCookie = false): void {
  if (response.headersSent || response.writableEnded || response.destroyed) return;
  if (clearCookie) sessions.clearSessionCookie(response as unknown as Response);
  response.statusCode = status;
  response.end();
}

// Порог пересылки набора: чаще одного события в секунду на переписку сокет
// молчать не может. Это ограничитель частоты, а не состояние набора.
const TYPING_FORWARD_THROTTLE_MS = 1_000;

export class RealtimeGateway {
  private namespace: Namespace | null = null;

  // Обработчик набора приходит из `ConversationsService`: гейтвей не знает о
  // переписках, иначе граф модулей замкнулся бы (`ConversationsModule` уже
  // импортирует `RealtimeModule`).
  private conversationTypingHandler: ((socket: Socket, payload: unknown) => Promise<void>) | null = null;

  // `socketId → (conversationId → время последней пересылки)`.
  private readonly typingThrottle = new Map<string, Map<string, number>>();

  constructor(
    private readonly sessions: SessionService,
    private readonly revocations: SessionRevocationService,
    private readonly access: AccessService
  ) {}

  afterInit(namespace: Namespace): void {
    this.namespace = namespace;
    const sessionMiddleware = this.sessions.createMiddleware();
    namespace.server.engine.use((request: IncomingMessage, response: ServerResponse, next: () => void) => {
      const admission = this.revocations.admitTransportRequest(request);
      if (!admission.allowed) {
        denyTransportRequest(response, this.sessions, admission.status ?? 403);
        return;
      }

      sessionMiddleware(request as unknown as Request, response as unknown as Response, (error) => {
        if (error) {
          denyTransportRequest(response, this.sessions, 401, true);
          return;
        }
        void this.sessions.requireActiveSession(request as unknown as Request).then(
          () => next(),
          () => {
            denyTransportRequest(response, this.sessions, 401, true);
          }
        );
      });
    });

    namespace.use((socket, next) => {
      void this.revocations.authorizeHandshake(socket as Socket).then(() => {
        socket.use((_packet, commandNext) => {
          void this.revocations.authorizeCommand(socket as Socket).then(
            () => commandNext(),
            () => commandNext(new Error("UNAUTHORIZED"))
          );
        });
        next();
      }, () => next(new Error("UNAUTHORIZED")));
    });
  }

  handleConnection(socket: Socket): void {
    // Комната пользователя — единственное место, где сокет уже авторизован и ещё
    // ни на что не подписан. Вступает только сервер: клиент в чужую комнату
    // попасть не может (в `channel:<id>` join инициирует клиент).
    const principal = (socket.data as SocketPrincipalData | undefined)?.principal;
    if (principal) void socket.join(`user:${principal.userId}`);
    socket.on("channel:subscribe", (payload: unknown) => {
      void this.handleChannelSubscribe(socket, payload);
    });
    socket.on("conversation:typing", (payload: unknown) => {
      void this.handleConversationTyping(socket, payload);
    });
    this.revocations.attachSocket(socket);
    if (socket.connected) socket.emit("session:ready", { connected: true });
  }

  handleDisconnect(socket: Socket): void {
    this.typingThrottle.delete(socket.id);
    this.revocations.detachSocket(socket);
  }

  // Единственная точка подключения проверки участия: гейтвей пересылает набор,
  // не зная ни о таблицах переписок, ни о правах.
  registerConversationTypingHandler(handler: (socket: Socket, payload: unknown) => Promise<void>): void {
    this.conversationTypingHandler = handler;
  }

  onlineUserIds(): Set<string> {
    return this.revocations.onlineUserIds();
  }

  async emitChannelEvent(channelId: string, event: string, payload: unknown): Promise<void> {
    const namespace = this.namespace;
    if (!namespace) return;
    const room = `channel:${channelId}`;
    const sockets = await namespace.in(room).fetchSockets();
    for (const socket of sockets) {
      const principal = (socket.data as SocketPrincipalData | undefined)?.principal;
      if (!principal) continue;
      if (!(await this.access.canReceiveChannelEvent(principal.userId, channelId, event))) {
        await socket.leave(room);
        continue;
      }
      socket.emit(event, payload);
    }
  }

  // Событие переписки: получатели вычислены сервером из состава переписки, права
  // на каждого не перепроверяются — клиент не может вступить в чужую комнату.
  async emitConversationEvent(participantIds: string[], event: string, payload: unknown): Promise<void> {
    const namespace = this.namespace;
    if (!namespace) return;
    for (const userId of participantIds) namespace.to(`user:${userId}`).emit(event, payload);
  }

  // Адресное событие в комнату пользователя: отметки прочтения и сигналы
  // переписок не привязаны к каналу, а право получателя уже проверено сервисом.
  async emitUserEvent(userId: string, event: string, payload: unknown): Promise<void> {
    const namespace = this.namespace;
    if (!namespace) return;
    namespace.to(`user:${userId}`).emit(event, payload);
  }

  // Сигнал «перечитай список переписок». Запросов в БД нет: полный список
  // собирает `ConversationsService.notifyConversationsChanged`, поэтому
  // `conversations: null` клиент отличает проверкой `Array.isArray`.
  notifyUsersConversationsChanged(userIds: string[]): void {
    const namespace = this.namespace;
    if (!namespace) return;
    for (const userId of userIds) namespace.to(`user:${userId}`).emit("conversations:sync", { conversations: null });
  }

  async notifyChannelAccessChanged(userIds: string[], channelId: string, revoked: boolean): Promise<void> {
    await this.notifyUsersChannelsChanged(userIds.map((userId) => ({
      userId,
      revokedChannelIds: revoked ? [channelId] : []
    })));
  }

  async notifyUsersChannelsChanged(changes: UserChannelAccessChange[]): Promise<void> {
    const changesByUser = new Map<string, Map<string, string>>();
    for (const change of changes) {
      const revokedChannels = changesByUser.get(change.userId) ?? new Map<string, string>();
      const reason = change.reason?.trim() || "Доступ к каналу отозван";
      for (const channelId of change.revokedChannelIds) revokedChannels.set(channelId, reason);
      changesByUser.set(change.userId, revokedChannels);
    }

    const userIds = [...changesByUser.keys()];
    const [channelsByUser, categoriesByUser] = await Promise.all([
      this.access.listVisibleChannelsForUsers(userIds),
      this.access.listVisibleCategoriesForUsers(userIds)
    ]);

    for (const [userId, revokedChannels] of changesByUser) {
      const channels = channelsByUser.get(userId) ?? [];
      const categories = categoriesByUser.get(userId) ?? [];
      await this.revocations.forEachUserConnection(userId, async (socket) => {
        for (const channelId of revokedChannels.keys()) await socket.leave(`channel:${channelId}`);
        socket.emit("channels:sync", { channels, categories });
        for (const [channelId, reason] of revokedChannels) socket.emit("channel:revoked", { channelId, reason });
      });
    }
  }

  // Набор — эфемерное действие: ни ошибки, ни подтверждения клиенту не уходят,
  // иначе событие стало бы оракулом существования переписки.
  private async handleConversationTyping(socket: Socket, payload: unknown): Promise<void> {
    if (
      !isRecord(payload) ||
      Object.keys(payload).length !== 1 ||
      typeof payload.conversationId !== "string" ||
      !isUuid(payload.conversationId)
    ) {
      return;
    }
    const conversationId = payload.conversationId;

    const now = Date.now();
    const perSocket = this.typingThrottle.get(socket.id) ?? new Map<string, number>();
    if (now - (perSocket.get(conversationId) ?? 0) < TYPING_FORWARD_THROTTLE_MS) return;
    perSocket.set(conversationId, now);
    this.typingThrottle.set(socket.id, perSocket);

    const handler = this.conversationTypingHandler;
    if (!handler) return;
    await handler(socket, payload).catch(() => undefined);
  }

  private async handleChannelSubscribe(socket: Socket, payload: unknown): Promise<void> {
    const channelId = isRecord(payload) && typeof payload.channelId === "string" ? payload.channelId : null;
    if (
      !isRecord(payload) ||
      Object.keys(payload).length !== 1 ||
      channelId === null ||
      typeof payload.channelId !== "string" ||
      !isUuid(payload.channelId)
    ) {
      socket.emit("channel:subscribe:error", { channelId, code: "INVALID_REQUEST" });
      return;
    }

    const principal = (socket.data as SocketPrincipalData | undefined)?.principal;
    if (!principal) {
      socket.emit("channel:subscribe:error", { channelId, code: "FORBIDDEN" });
      return;
    }

    const room = `channel:${channelId}`;
    try {
      await this.access.requireChannelPermission(principal, channelId, "VIEW_CHANNEL");
      await socket.join(room);
      socket.emit("channel:subscribed", { channelId });
    } catch (error) {
      await socket.leave(room);
      socket.emit("channel:subscribe:error", { channelId, code: errorCode(error) });
    }
  }
}

WebSocketGateway({
  namespace: "/realtime",
  serveClient: false,
  transports: ["polling", "websocket"],
  maxHttpBufferSize: 32 * 1024,
  perMessageDeflate: false
  // Connection-state recovery is deliberately disabled: replayed packets bypass recipient ACL checks, its session state is process-local, and message catch-up uses the durable database cursor.
})(RealtimeGateway);
