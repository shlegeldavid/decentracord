import { io, type Socket } from "socket.io-client";
import { describe, expect, it, vi } from "vitest";
import type { Channel } from "../../apps/web/src/api.js";
import { CHANNEL_REALTIME } from "../../apps/web/src/realtime.js";
import {
  bindChannelEvents,
  bindSessionEvents,
  subscribeToReadableChannels,
  type ChannelSubscriptions
} from "../../apps/web/src/realtimeWorkspaceEvents.js";

function deliver(socket: Socket, event: string, payload?: unknown): void {
  for (const listener of socket.listeners(event)) listener(payload);
}

function channel(id: string, canView: boolean): Channel {
  return {
    id,
    name: id,
    categoryId: null,
    description: null,
    visibility: "known",
    canView,
    canSend: canView,
    canManageMessages: false,
    ownerEditable: false
  };
}

describe("realtime workspace events", () => {
  it("subscribes once per readable channel and preserves confirmation until invalidation", () => {
    const socket = io({ autoConnect: false });
    const emit = vi.spyOn(socket, "emit").mockReturnValue(socket);
    const subscriptions: ChannelSubscriptions = new Map();
    const rooms = [channel("confirmed", true), channel("pending", true), channel("closed", false)];
    const refresh = vi.fn();
    const applySync = vi.fn();
    const revoke = vi.fn();
    bindChannelEvents(socket, subscriptions, {
      findChannel: (id) => rooms.find((room) => room.id === id),
      applySync,
      refresh,
      revoke
    });

    subscribeToReadableChannels(socket, subscriptions, rooms);
    expect(emit).not.toHaveBeenCalled();
    socket.connected = true;
    subscribeToReadableChannels(socket, subscriptions, rooms);
    subscribeToReadableChannels(socket, subscriptions, rooms);
    expect(emit.mock.calls).toEqual([
      [CHANNEL_REALTIME.subscribe, { channelId: "confirmed" }],
      [CHANNEL_REALTIME.subscribe, { channelId: "pending" }]
    ]);

    deliver(socket, CHANNEL_REALTIME.subscribed, { channelId: "confirmed" });
    rooms.forEach((room) => { room.canView = false; });
    deliver(socket, CHANNEL_REALTIME.subscribed, { channelId: "confirmed" });
    deliver(socket, CHANNEL_REALTIME.subscribed, { channelId: "pending" });
    expect([...subscriptions]).toEqual([["confirmed", "confirmed"]]);

    deliver(socket, CHANNEL_REALTIME.subscribeError, { channelId: "confirmed" });
    expect(subscriptions.size).toBe(0);
    expect(refresh).toHaveBeenCalledOnce();

    subscriptions.set("confirmed", "confirmed");
    deliver(socket, CHANNEL_REALTIME.sync, { channels: rooms, categories: [] });
    expect(subscriptions.size).toBe(0);
    expect(applySync).toHaveBeenCalledExactlyOnceWith(rooms, []);
    deliver(socket, CHANNEL_REALTIME.sync, { channels: [null], categories: [] });
    expect(applySync).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledTimes(2);

    deliver(socket, CHANNEL_REALTIME.revoked, { channelId: "confirmed", reason: 10 });
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(revoke).not.toHaveBeenCalled();
    deliver(socket, CHANNEL_REALTIME.revoked, { channelId: "confirmed", reason: "  " });
    deliver(socket, CHANNEL_REALTIME.revoked, { channelId: "confirmed", reason: " Доступ отозван " });
    expect(revoke.mock.calls).toEqual([
      ["confirmed", undefined],
      ["confirmed", " Доступ отозван "]
    ]);
  });

  it("clears connection state on disconnect and expires only for server revocation", () => {
    const socket = io({ autoConnect: false });
    const events: string[] = [];
    bindSessionEvents(socket, {
      ready: () => { events.push("ready"); },
      setStatus: (status) => { events.push(status); },
      clearConnection: () => { events.push("clear"); },
      requeueSending: () => { events.push("requeue"); },
      invalidate: () => { events.push("invalidate"); }
    });

    deliver(socket, "session:ready");
    deliver(socket, "connect_error", new Error("transport error"));
    deliver(socket, "disconnect", "transport close");
    expect(events).toEqual(["ready", "disconnected", "requeue", "disconnected", "clear", "requeue"]);

    events.length = 0;
    deliver(socket, "connect_error", new Error("UNAUTHORIZED"));
    deliver(socket, "session:revoked", { code: "unknown" });
    deliver(socket, "session:revoked", { code: "SESSION_REVOKED" });
    deliver(socket, "disconnect", "io server disconnect");
    expect(events).toEqual([
      "disconnected", "requeue", "invalidate",
      "invalidate",
      "disconnected", "clear", "requeue", "invalidate"
    ]);
  });
});
