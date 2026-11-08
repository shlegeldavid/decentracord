import type { IncomingMessage } from "node:http";
import type { AuthenticatedRequest, AuthPrincipal, SessionService } from "./session.service.js";
import type { Socket } from "socket.io";

const maxSocketsPerSession = 10;
const maxHandshakesPerIp = 30;
const handshakeWindowMs = 60_000;
const maxHandshakeRateKeys = 4_096;

interface EngineRequest extends IncomingMessage {
  _query?: Record<string, string | string[] | undefined>;
  session?: AuthenticatedRequest["session"];
  sessionID?: string;
}

interface SocketPrincipalData {
  principal?: AuthPrincipal;
  request?: AuthenticatedRequest;
  reservedSessionId?: string;
}

interface SessionConnection {
  principal: AuthPrincipal;
  request: AuthenticatedRequest;
  socket: Socket;
}

interface SessionConnectionSet {
  userId: string;
  connections: Set<SessionConnection>;
  pendingSockets: Set<Socket>;
}

export interface TransportAdmission {
  allowed: boolean;
  status?: 403 | 429;
}

function isInitialHandshake(request: EngineRequest): boolean {
  if (request._query && Object.hasOwn(request._query, "sid")) return false;
  try {
    return !new URL(request.url ?? "/", "http://local.invalid").searchParams.has("sid");
  } catch {
    return true;
  }
}

function requestIp(request: EngineRequest): string {
  const forwarded = request.headers["x-forwarded-for"];
  // Match Express trust-proxy: 1, which selects the nearest forwarded client address.
  const candidate = typeof forwarded === "string" ? forwarded.split(",").at(-1)?.trim() : undefined;
  return (candidate || request.socket.remoteAddress || "unknown").slice(0, 128);
}

function requestOriginMatches(request: EngineRequest): boolean {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (typeof host !== "string" || !host || host.includes(",")) return false;

  const forwardedProtocol = request.headers["x-forwarded-proto"];
  if (process.env.NODE_ENV === "production" && (typeof forwardedProtocol !== "string" || forwardedProtocol.includes(","))) {
    return false;
  }
  const proxyProtocol = typeof forwardedProtocol === "string" ? forwardedProtocol.split(",", 1)[0]?.trim() : undefined;
  const protocol = proxyProtocol || ((request.socket as typeof request.socket & { encrypted?: boolean }).encrypted ? "https" : "http");
  if (protocol !== "http" && protocol !== "https") return false;
  const requestOrigin = `${protocol}://${host}`;
  const configuredOrigin = process.env.NODE_ENV === "production" ? process.env.APP_ORIGIN : undefined;
  if (process.env.NODE_ENV === "production" && !configuredOrigin) return false;
  const expectedOrigin = configuredOrigin ?? requestOrigin;
  if (requestOrigin !== expectedOrigin) return false;
  if (typeof origin === "string") return origin === expectedOrigin;

  // Same-origin polling GETs omit Origin in Chromium. They cannot open the namespace:
  // Socket.IO's CONNECT packet is a POST, which must carry the exact Origin above.
  let transport: string | null | undefined = request._query?.transport as string | undefined;
  if (!transport) {
    try {
      transport = new URL(request.url ?? "/", "http://local.invalid").searchParams.get("transport");
    } catch {
      return false;
    }
  }
  return request.method === "GET" && transport === "polling";
}

function apiUnauthorized(): Error {
  return new Error("UNAUTHORIZED");
}

/** Coordinates socket delivery and logout around the same in-process user/session locks. */
export class SessionRevocationService {
  private readonly lockTails = new Map<string, Promise<void>>();
  private readonly handshakeAttempts = new Map<string, number[]>();
  private readonly sessions = new Map<string, SessionConnectionSet>();
  private readonly connectionBySocket = new Map<Socket, SessionConnection>();

  constructor(private readonly sessionService: SessionService) {}

  admitTransportRequest(request: IncomingMessage): TransportAdmission {
    const engineRequest = request as EngineRequest;
    if (!requestOriginMatches(engineRequest)) return { allowed: false, status: 403 };
    if (!isInitialHandshake(engineRequest)) return { allowed: true };

    const ip = requestIp(engineRequest);
    const now = Date.now();
    const recent = (this.handshakeAttempts.get(ip) ?? []).filter((timestamp) => now - timestamp < handshakeWindowMs);
    if (recent.length >= maxHandshakesPerIp) return { allowed: false, status: 429 };

    recent.push(now);
    if (!this.handshakeAttempts.has(ip) && this.handshakeAttempts.size >= maxHandshakeRateKeys) {
      const oldestIp = this.handshakeAttempts.keys().next().value as string | undefined;
      if (oldestIp) this.handshakeAttempts.delete(oldestIp);
    }
    this.handshakeAttempts.set(ip, recent);
    return { allowed: true };
  }

  async authorizeHandshake(socket: Socket): Promise<void> {
    const request = socket.request as unknown as AuthenticatedRequest;
    const principal = await this.sessionService.requireActiveSession(request);
    await this.withPrincipalLock(principal, async () => {
      await this.sessionService.requireActiveSession(request);
      const current = this.sessions.get(principal.sessionId) ?? {
        userId: principal.userId,
        connections: new Set<SessionConnection>(),
        pendingSockets: new Set<Socket>()
      };
      if (current.connections.size + current.pendingSockets.size >= maxSocketsPerSession) throw apiUnauthorized();
      current.pendingSockets.add(socket);
      this.sessions.set(principal.sessionId, current);
      const data = socket.data as SocketPrincipalData;
      data.principal = principal;
      data.request = request;
      data.reservedSessionId = principal.sessionId;
    });
  }

  attachSocket(socket: Socket): void {
    const data = socket.data as SocketPrincipalData;
    const principal = data.principal;
    const request = data.request;
    const sessionId = data.reservedSessionId;
    if (!principal || !request || !sessionId) {
      socket.disconnect(true);
      return;
    }

    const current = this.sessions.get(sessionId);
    if (!current || !current.pendingSockets.delete(socket)) {
      socket.disconnect(true);
      return;
    }
    const connection: SessionConnection = { principal, request, socket };
    current.connections.add(connection);
    this.connectionBySocket.set(socket, connection);
  }

  detachSocket(socket: Socket): void {
    const connection = this.connectionBySocket.get(socket);
    if (!connection) {
      const sessionId = (socket.data as SocketPrincipalData).reservedSessionId;
      if (!sessionId) return;
      const pending = this.sessions.get(sessionId);
      pending?.pendingSockets.delete(socket);
      if (pending && pending.pendingSockets.size === 0 && pending.connections.size === 0) {
        this.sessions.delete(sessionId);
      }
      return;
    }
    this.connectionBySocket.delete(socket);
    const current = this.sessions.get(connection.principal.sessionId);
    current?.connections.delete(connection);
    if (current && current.pendingSockets.size === 0 && current.connections.size === 0) {
      this.sessions.delete(connection.principal.sessionId);
    }
  }

  async authorizeCommand(socket: Socket): Promise<void> {
    const connection = this.connectionBySocket.get(socket);
    if (!connection) throw apiUnauthorized();
    await this.withPrincipalLock(connection.principal, async () => {
      try {
        await this.sessionService.requireActiveSession(connection.request);
      } catch {
        this.notifyAndDisconnect(connection.principal.sessionId);
        throw apiUnauthorized();
      }
    });
  }

  async revokeCurrentSession(principal: AuthPrincipal, request: AuthenticatedRequest): Promise<void> {
    await this.withPrincipalLock(principal, async () => {
      const current = await this.sessionService.requireActiveSession(request);
      if (current.userId !== principal.userId || current.sessionId !== principal.sessionId) throw apiUnauthorized();
      await this.sessionService.destroySession(request);
      this.notifyAndDisconnect(principal.sessionId);
      process.stdout.write(`${JSON.stringify({
        event: "auth.session.revoked",
        actorId: principal.userId,
        targetUserId: principal.userId,
        outcome: "revoked"
      })}\n`);
    });
  }

  async revokeAllUserSessions(principal: AuthPrincipal, revoke: () => Promise<void>): Promise<void> {
    await this.revokeAllSessionsForUser(principal.userId, revoke);
  }

  async revokeAllSessionsForUser(userId: string, revoke: () => Promise<void>): Promise<void> {
    await this.withUserLock(userId, async () => {
      await revoke();
      this.notifyAndDisconnectUser(userId);
    });
  }

  /** The only server-side delivery path for protected session events. */
  async sendToAuthorizedSession(sessionId: string, event: string, payload: unknown): Promise<boolean> {
    const current = this.sessions.get(sessionId);
    const representative = current?.connections.values().next().value as SessionConnection | undefined;
    if (!current || !representative) return false;

    return this.withPrincipalLock(representative.principal, async () => {
      const latest = this.sessions.get(sessionId);
      if (!latest || latest.connections.size === 0) return false;
      const connections = [...latest.connections];
      try {
        await this.sessionService.requireActiveSession(connections[0]!.request);
      } catch {
        this.notifyAndDisconnect(sessionId);
        return false;
      }
      for (const connection of connections) connection.socket.emit(event, payload);
      return true;
    });
  }

  private notifyAndDisconnect(sessionId: string): void {
    const current = this.sessions.get(sessionId);
    if (!current) return;
    for (const socket of current.pendingSockets) {
      socket.emit("session:revoked", { code: "SESSION_REVOKED" });
      socket.disconnect(true);
    }
    for (const connection of current.connections) {
      connection.socket.emit("session:revoked", { code: "SESSION_REVOKED" });
      connection.socket.disconnect(true);
    }
    this.sessions.delete(sessionId);
  }

  private notifyAndDisconnectUser(userId: string): void {
    for (const [sessionId, current] of [...this.sessions]) {
      if (current.userId === userId) this.notifyAndDisconnect(sessionId);
    }
  }

  private async withPrincipalLock<T>(principal: AuthPrincipal, run: () => Promise<T>): Promise<T> {
    const keys = [`session:${principal.sessionId}`, `user:${principal.userId}`].sort();
    const acquire = (index: number): Promise<T> => index === keys.length
      ? run()
      : this.withKeyedLock(keys[index]!, () => acquire(index + 1));
    return acquire(0);
  }

  private async withUserLock<T>(userId: string, run: () => Promise<T>): Promise<T> {
    return this.withKeyedLock(`user:${userId}`, run);
  }

  private async withKeyedLock<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = this.lockTails.get(key) ?? Promise.resolve();
    let release: () => void = () => {};
    const next = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => next);
    this.lockTails.set(key, tail);
    await previous;
    try {
      return await run();
    } finally {
      release();
      if (this.lockTails.get(key) === tail) {
        void tail.then(() => {
          if (this.lockTails.get(key) === tail) this.lockTails.delete(key);
        });
      }
    }
  }
}
