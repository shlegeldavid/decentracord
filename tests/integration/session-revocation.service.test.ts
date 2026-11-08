import type { IncomingMessage } from "node:http";
import type { AuthenticatedRequest, AuthPrincipal, SessionService } from "../../apps/server/src/auth/session.service.js";
import { SessionRevocationService } from "../../apps/server/src/auth/session-revocation.service.js";
import type { Socket } from "socket.io";
import { describe, expect, it, vi } from "vitest";

const principal: AuthPrincipal = {
  userId: "00000000-0000-4000-8000-000000000001",
  sessionId: "session-test-id",
  authVersion: 1
};

function setup() {
  const request = { sessionID: principal.sessionId, session: {} } as AuthenticatedRequest;
  const sessionService = {
    requireActiveSession: vi.fn(async () => principal),
    destroySession: vi.fn(async () => undefined)
  } as unknown as SessionService;
  const revocation = new SessionRevocationService(sessionService);
  const emitted: Array<[string, unknown]> = [];
  const sockets: Array<{ socket: Socket; disconnected: () => boolean }> = [];

  function addSocket(): Socket {
    let isDisconnected = false;
    const socket = {
      request,
      data: {},
      emit(event: string, payload: unknown) {
        emitted.push([event, payload]);
        return this;
      },
      disconnect() {
        isDisconnected = true;
        return this;
      }
    } as unknown as Socket;
    sockets.push({ socket, disconnected: () => isDisconnected });
    return socket;
  }

  return { emitted, request, revocation, sessionService, sockets, addSocket };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("SessionRevocationService delivery ordering", () => {
  it("holds the shared user/session lock through delivery and revocation", async () => {
    const context = setup();
    const socket = context.addSocket();
    await context.revocation.authorizeHandshake(socket);
    context.revocation.attachSocket(socket);

    const deliveryGate = deferred();
    const deliveryCheckStarted = deferred();
    let activeChecks = 0;
    context.sessionService.requireActiveSession = vi.fn(async () => {
      activeChecks += 1;
      if (activeChecks === 1) {
        deliveryCheckStarted.resolve();
        await deliveryGate.promise;
      }
      return principal;
    }) as unknown as SessionService["requireActiveSession"];

    const delivery = context.revocation.sendToAuthorizedSession(principal.sessionId, "protected:sentinel", { id: "event-1" });
    await deliveryCheckStarted.promise;
    let revocationFinished = false;
    const revoke = context.revocation.revokeCurrentSession(principal, context.request)
      .then(() => { revocationFinished = true; });
    await Promise.resolve();
    expect(revocationFinished).toBe(false);

    deliveryGate.resolve();
    await expect(delivery).resolves.toBe(true);
    await revoke;

    expect(context.emitted).toEqual([
      ["protected:sentinel", { id: "event-1" }],
      ["session:revoked", { code: "SESSION_REVOKED" }]
    ]);
    expect(context.sockets[0]?.disconnected()).toBe(true);
    await expect(context.revocation.sendToAuthorizedSession(principal.sessionId, "protected:late", {})).resolves.toBe(false);
    expect(context.sessionService.destroySession).toHaveBeenCalledTimes(1);
  });

  it("limits a session to ten active and reserved sockets", async () => {
    const context = setup();
    for (let index = 0; index < 10; index += 1) {
      const socket = context.addSocket();
      await context.revocation.authorizeHandshake(socket);
      context.revocation.attachSocket(socket);
    }

    const eleventh = context.addSocket();
    await expect(context.revocation.authorizeHandshake(eleventh)).rejects.toThrow("UNAUTHORIZED");
  });

  it("rejects a late protected delivery after logout has committed", async () => {
    const context = setup();
    const socket = context.addSocket();
    await context.revocation.authorizeHandshake(socket);
    context.revocation.attachSocket(socket);
    await context.revocation.revokeCurrentSession(principal, context.request);

    await expect(context.revocation.sendToAuthorizedSession(principal.sessionId, "protected:late", {})).resolves.toBe(false);
    expect(context.emitted.some(([event]) => event === "protected:late")).toBe(false);
  });
});

describe("SessionRevocationService audit output", () => {
  it("does not write a revoked session cookie identifier to logs", async () => {
    const context = setup();
    const output: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    });

    try {
      await context.revocation.revokeCurrentSession(principal, context.request);
    } finally {
      write.mockRestore();
    }

    expect(output.join("")).not.toContain(principal.sessionId);
  });
});

describe("Engine.IO origin admission", () => {
  it("requires the exact origin matching the transport host", () => {
    const context = setup();
    const request = {
      url: "/socket.io/?EIO=4&transport=polling",
      headers: { origin: "https://app.example", host: "app.example" },
      socket: { remoteAddress: "127.0.0.1" }
    } as unknown as IncomingMessage;
    expect(context.revocation.admitTransportRequest(request)).toEqual({ allowed: false, status: 403 });
    const valid = {
      ...request,
      headers: { origin: "http://app.example", host: "app.example" }
    } as IncomingMessage;
    expect(context.revocation.admitTransportRequest(valid)).toEqual({ allowed: true });
    const sameOriginPolling = {
      method: "GET",
      ...request,
      headers: { host: "app.example" }
    } as unknown as IncomingMessage;
    expect(context.revocation.admitTransportRequest(sameOriginPolling)).toEqual({ allowed: true });
    const crossSiteWithoutOrigin = {
      method: "POST",
      ...request,
      headers: { host: "app.example" }
    } as unknown as IncomingMessage;
    expect(context.revocation.admitTransportRequest(crossSiteWithoutOrigin)).toEqual({ allowed: false, status: 403 });
    const websocketWithoutOrigin = {
      method: "GET",
      url: "/socket.io/?EIO=4&transport=websocket",
      headers: { host: "app.example" },
      socket: { remoteAddress: "127.0.0.1" }
    } as unknown as IncomingMessage;
    expect(context.revocation.admitTransportRequest(websocketWithoutOrigin)).toEqual({ allowed: false, status: 403 });
    const crossOriginConnect = {
      method: "POST",
      url: "/socket.io/?EIO=4&transport=polling&sid=engine-session",
      headers: { origin: "http://attacker.invalid", host: "app.example" },
      socket: { remoteAddress: "127.0.0.1" }
    } as unknown as IncomingMessage;
    expect(context.revocation.admitTransportRequest(crossOriginConnect)).toEqual({ allowed: false, status: 403 });
    const crossOriginUpgrade = {
      method: "GET",
      url: "/socket.io/?EIO=4&transport=websocket&sid=engine-session",
      headers: { origin: "http://attacker.invalid", host: "app.example" },
      socket: { remoteAddress: "127.0.0.1" }
    } as unknown as IncomingMessage;
    expect(context.revocation.admitTransportRequest(crossOriginUpgrade)).toEqual({ allowed: false, status: 403 });
  });

  it("counts new handshakes against the nearest forwarded client address", () => {
    const context = setup();
    const request = (spoofed: string) => ({
      url: "/socket.io/?EIO=4&transport=polling",
      headers: {
        origin: "http://app.example",
        host: "app.example",
        "x-forwarded-for": `${spoofed}, 203.0.113.10`
      },
      socket: { remoteAddress: "192.0.2.20" }
    }) as unknown as IncomingMessage;

    for (let index = 0; index < 30; index += 1) {
      expect(context.revocation.admitTransportRequest(request(`spoof-${index}`))).toEqual({ allowed: true });
    }
    expect(context.revocation.admitTransportRequest(request("fresh-spoof"))).toEqual({ allowed: false, status: 429 });
  });
});
