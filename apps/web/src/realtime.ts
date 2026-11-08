import { io, type Socket } from "socket.io-client";

export type RealtimeStatus = "connecting" | "connected" | "disconnected";

/** Opens only the authenticated same-origin namespace; identity comes from the HttpOnly cookie. */
export function connectRealtime(): Socket {
  return io("/realtime", {
    autoConnect: false,
    withCredentials: true,
    transports: ["polling", "websocket"]
  });
}
