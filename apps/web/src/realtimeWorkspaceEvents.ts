import type { Socket } from "socket.io-client";
import { isChannel, isChannelCategory, type Channel, type ChannelCategory } from "./api.js";
import { isRecord } from "./api/http.js";
import { CHANNEL_REALTIME, type RealtimeStatus } from "./realtime.js";

export type ChannelSubscriptions = Map<string, "pending" | "confirmed">;

type ChannelEvents = {
  findChannel: (id: string) => Channel | undefined;
  applySync: (channels: Channel[], categories: ChannelCategory[]) => void;
  refresh: () => void;
  revoke: (channelId: string, reason?: string) => void;
};

type SessionEvents = {
  ready: () => void;
  setStatus: (status: RealtimeStatus) => void;
  clearConnection: () => void;
  requeueSending: () => void;
  invalidate: () => void;
};

function hasChannelId(value: unknown): value is { channelId: string; reason?: unknown } {
  return isRecord(value) && typeof value.channelId === "string" && value.channelId.length > 0;
}

function isChannelSync(value: unknown): value is { channels: Channel[]; categories: ChannelCategory[] } {
  return isRecord(value) && Array.isArray(value.channels) && value.channels.every(isChannel) &&
    Array.isArray(value.categories) && value.categories.every(isChannelCategory);
}

export function subscribeToReadableChannels(
  socket: Socket | null,
  subscriptions: ChannelSubscriptions,
  channels: Channel[]
): void {
  if (!socket?.connected) return;
  for (const channel of channels) {
    if (channel.canView && !subscriptions.has(channel.id)) {
      subscriptions.set(channel.id, "pending");
      socket.emit(CHANNEL_REALTIME.subscribe, { channelId: channel.id });
    }
  }
}

export function bindChannelEvents(socket: Socket, subscriptions: ChannelSubscriptions, effects: ChannelEvents): void {
  socket.on(CHANNEL_REALTIME.sync, (value: unknown) => {
    subscriptions.clear();
    if (isChannelSync(value)) effects.applySync(value.channels, value.categories);
    else effects.refresh();
  });

  socket.on(CHANNEL_REALTIME.updated, (value: unknown) => {
    if (!hasChannelId(value) || effects.findChannel(value.channelId)) effects.refresh();
  });

  socket.on(CHANNEL_REALTIME.revoked, (value: unknown) => {
    if (!hasChannelId(value) || ("reason" in value && typeof value.reason !== "string")) {
      effects.refresh();
      return;
    }
    effects.revoke(value.channelId, typeof value.reason === "string" && value.reason.trim() ? value.reason : undefined);
  });

  socket.on(CHANNEL_REALTIME.subscribed, (value: unknown) => {
    if (!hasChannelId(value)) return;
    const { channelId } = value;
    if (effects.findChannel(channelId)?.canView) subscriptions.set(channelId, "confirmed");
    else if (subscriptions.get(channelId) === "pending") subscriptions.delete(channelId);
  });

  socket.on(CHANNEL_REALTIME.subscribeError, (value: unknown) => {
    if (hasChannelId(value)) subscriptions.delete(value.channelId);
    else subscriptions.clear();
    effects.refresh();
  });
}

export function bindSessionEvents(socket: Socket, effects: SessionEvents): void {
  function connectionLost(disconnected: boolean, sessionEnded: boolean): void {
    effects.setStatus("disconnected");
    if (disconnected) effects.clearConnection();
    effects.requeueSending();
    if (sessionEnded) effects.invalidate();
  }

  socket.on("session:ready", effects.ready);
  socket.on("session:revoked", (value: unknown) => {
    if (isRecord(value) && value.code === "SESSION_REVOKED") effects.invalidate();
  });
  socket.on("connect_error", (error) => connectionLost(false, error.message === "UNAUTHORIZED"));
  socket.on("disconnect", (reason) => connectionLost(true, reason === "io server disconnect"));
}
