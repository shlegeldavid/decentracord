import { WebSocketGateway } from "@nestjs/websockets";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Request, Response } from "express";
import type { Namespace, Socket } from "socket.io";
import { SessionRevocationService } from "../auth/session-revocation.service.js";
import { SessionService } from "../auth/session.service.js";

function denyTransportRequest(response: ServerResponse, sessions: SessionService, status: number, clearCookie = false): void {
  if (response.headersSent || response.writableEnded || response.destroyed) return;
  if (clearCookie) sessions.clearSessionCookie(response as unknown as Response);
  response.statusCode = status;
  response.end();
}

export class RealtimeGateway {
  constructor(
    private readonly sessions: SessionService,
    private readonly revocations: SessionRevocationService
  ) {}

  afterInit(namespace: Namespace): void {
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
    this.revocations.attachSocket(socket);
    if (socket.connected) socket.emit("session:ready", { connected: true });
  }

  handleDisconnect(socket: Socket): void {
    this.revocations.detachSocket(socket);
  }
}

WebSocketGateway({
  namespace: "/realtime",
  serveClient: false,
  transports: ["polling", "websocket"],
  maxHttpBufferSize: 32 * 1024,
  perMessageDeflate: false
  // Connection-state recovery is deliberately disabled so no recovered socket skips authentication.
})(RealtimeGateway);
