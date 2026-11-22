import { io, type Socket } from "socket.io-client";
import { describe, expect, it, vi } from "vitest";
import type { MessageView } from "../../apps/web/src/api.js";
import { CONVERSATION_REALTIME, MESSAGE_REALTIME } from "../../apps/web/src/realtime.js";
import { bindChannelMessageEvents, bindConversationMessageEvents } from "../../apps/web/src/realtimeMessageEvents.js";

const channelMessage: MessageView = {
  id: "message",
  channelId: "selected",
  conversationId: null,
  authorId: "peer",
  authorLogin: "peer",
  seq: 1,
  updatedSeq: 2,
  content: "Привет!",
  mentions: [],
  editedAt: null,
  deleted: false,
  clientRequestId: "request",
  createdAt: "2026-11-22T00:00:00Z",
  authorRoles: [],
  forwardedFrom: null
};

function deliver(socket: Socket, event: string, payload: unknown) {
  for (const listener of socket.listeners(event)) listener(payload);
}

describe("realtime message events", () => {
  it("keeps read, unread and pin updates scoped to readable channels", () => {
    const socket = io({ autoConnect: false });
    const apply = vi.fn(() => true);
    const remove = vi.fn();
    const markRead = vi.fn();
    const incrementUnread = vi.fn();
    const setPinned = vi.fn();
    bindChannelMessageEvents(socket, "self", {
      canView: (id) => id !== "revoked",
      isSelected: (id) => id === "selected",
      apply,
      remove,
      markRead,
      incrementUnread,
      setPinned
    });

    deliver(socket, MESSAGE_REALTIME.created, { message: { ...channelMessage, channelId: "revoked" } });
    deliver(socket, MESSAGE_REALTIME.created, { message: { ...channelMessage, channelId: "other" } });
    deliver(socket, MESSAGE_REALTIME.updated, { message: { ...channelMessage, channelId: "other" } });
    deliver(socket, MESSAGE_REALTIME.created, { message: channelMessage });
    expect(apply).toHaveBeenCalledExactlyOnceWith(channelMessage);
    expect(incrementUnread).toHaveBeenCalledExactlyOnceWith("other");
    expect(markRead).not.toHaveBeenCalled();

    apply.mockReturnValue(false);
    deliver(socket, MESSAGE_REALTIME.updated, { message: channelMessage });
    expect(markRead).not.toHaveBeenCalled();
    deliver(socket, MESSAGE_REALTIME.created, { message: channelMessage });
    expect(markRead).toHaveBeenCalledExactlyOnceWith("selected");

    deliver(socket, MESSAGE_REALTIME.pinned, { channelId: "revoked", messageId: "message" });
    deliver(socket, MESSAGE_REALTIME.pinned, { channelId: "selected", messageId: "message" });
    deliver(socket, MESSAGE_REALTIME.deleted, { channelId: "selected", messageId: "message", updatedSeq: 3 });
    expect(remove).toHaveBeenCalledExactlyOnceWith({ scopeId: "selected", messageId: "message", updatedSeq: 3 });
    expect(setPinned.mock.calls).toEqual([["message", true], ["message", false]]);
  });

  it("requires conversation messages to agree with the event scope", () => {
    const socket = io({ autoConnect: false });
    const apply = vi.fn(() => false);
    const onCreated = vi.fn();
    const remove = vi.fn();
    const message = { ...channelMessage, channelId: null, conversationId: "selected" };
    bindConversationMessageEvents(socket, "self", {
      apply,
      isSelected: (id) => id === "selected",
      onCreated,
      remove,
      replaceConversations: vi.fn(),
      refreshConversations: vi.fn(),
      clearUnread: vi.fn(),
      recordTyping: vi.fn()
    });

    deliver(socket, CONVERSATION_REALTIME.created, { conversationId: "other", message });
    deliver(socket, CONVERSATION_REALTIME.updated, { conversationId: "other", message });
    deliver(socket, CONVERSATION_REALTIME.deleted, { conversationId: "other", messageId: "message", updatedSeq: 3 });
    deliver(socket, CONVERSATION_REALTIME.deleted, { conversationId: "selected", messageId: "message", updatedSeq: "3" });
    expect(apply).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();

    deliver(socket, CONVERSATION_REALTIME.created, { conversationId: "selected", message });
    deliver(socket, CONVERSATION_REALTIME.deleted, { conversationId: "selected", messageId: "message", updatedSeq: 3 });
    expect(apply).toHaveBeenCalledExactlyOnceWith(message);
    expect(onCreated).toHaveBeenCalledExactlyOnceWith("selected", message);
    expect(remove).toHaveBeenCalledExactlyOnceWith({ scopeId: "selected", messageId: "message", updatedSeq: 3 });
  });
});
