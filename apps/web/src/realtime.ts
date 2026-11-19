import { io, type Socket } from "socket.io-client";

export type RealtimeStatus = "connecting" | "connected" | "disconnected";

export const CHANNEL_REALTIME = {
  sync: "channels:sync",
  updated: "channel:updated",
  revoked: "channel:revoked",
  subscribe: "channel:subscribe",
  subscribed: "channel:subscribed",
  subscribeError: "channel:subscribe:error"
} as const;

export const MESSAGE_REALTIME = {
  created: "message:created",
  updated: "message:updated",
  deleted: "message:deleted",
  pinned: "message:pinned",
  unpinned: "message:unpinned"
} as const;

export const CONVERSATION_REALTIME = {
  created: "conversation:message:created",
  updated: "conversation:message:updated",
  deleted: "conversation:message:deleted",
  sync: "conversations:sync",
  read: "conversation:read",
  typing: "conversation:typing"
} as const;

/** Opens only the authenticated same-origin namespace; identity comes from the HttpOnly cookie. */
export function connectRealtime(): Socket {
  return io("/realtime", {
    autoConnect: false,
    withCredentials: true,
    transports: ["polling", "websocket"]
  });
}
