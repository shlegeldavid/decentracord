import type { Socket } from "socket.io-client";
import { isConversation, isMessage, type Conversation, type MessageView } from "./api.js";
import { CONVERSATION_REALTIME, MESSAGE_REALTIME } from "./realtime.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type MessageDeletion = { scopeId: string; messageId: string; updatedSeq: number };

function messageDeletion(value: unknown, scopeField: "channelId" | "conversationId"): MessageDeletion | null {
  if (!isRecord(value)) return null;
  const scopeId = value[scopeField];
  const { messageId, updatedSeq } = value;
  if (typeof scopeId !== "string" || typeof messageId !== "string" || typeof updatedSeq !== "number") return null;
  return { scopeId, messageId, updatedSeq };
}

function conversationMessage(value: unknown): { conversationId: string; message: MessageView } | null {
  if (!isRecord(value) || typeof value.conversationId !== "string" || !isMessage(value.message)) return null;
  if (value.message.conversationId !== value.conversationId) return null;
  return { conversationId: value.conversationId, message: value.message };
}

type ChannelMessageEffects = {
  canView: (channelId: string) => boolean;
  isSelected: (channelId: string) => boolean;
  apply: (message: MessageView) => boolean;
  remove: (deleted: MessageDeletion) => void;
  markRead: (channelId: string) => void;
  incrementUnread: (channelId: string) => void;
  setPinned: (messageId: string, pinned: boolean) => void;
};

export function bindChannelMessageEvents(socket: Socket, userId: string, effects: ChannelMessageEffects): void {
  const applyChannelMessage = (value: unknown, created: boolean) => {
    if (!isRecord(value) || !isMessage(value.message)) return;
    const { message } = value;
    const { channelId } = message;
    if (channelId === null || !effects.canView(channelId)) return;
    if (effects.isSelected(channelId)) {
      const hasGap = effects.apply(message);
      if (created && !hasGap) effects.markRead(channelId);
    } else if (created && message.authorId !== userId) {
      effects.incrementUnread(channelId);
    }
  };

  const applyPin = (value: unknown, pinned: boolean) => {
    if (!isRecord(value) || typeof value.channelId !== "string" || typeof value.messageId !== "string") return;
    if (effects.canView(value.channelId) && effects.isSelected(value.channelId)) {
      effects.setPinned(value.messageId, pinned);
    }
  };

  socket.on(MESSAGE_REALTIME.created, (value: unknown) => applyChannelMessage(value, true));
  socket.on(MESSAGE_REALTIME.updated, (value: unknown) => applyChannelMessage(value, false));
  socket.on(MESSAGE_REALTIME.deleted, (value: unknown) => {
    const deleted = messageDeletion(value, "channelId");
    if (!deleted || !effects.canView(deleted.scopeId) || !effects.isSelected(deleted.scopeId)) return;
    effects.remove(deleted);
    effects.setPinned(deleted.messageId, false);
  });
  socket.on(MESSAGE_REALTIME.pinned, (value: unknown) => applyPin(value, true));
  socket.on(MESSAGE_REALTIME.unpinned, (value: unknown) => applyPin(value, false));
}

type ConversationMessageEffects = {
  apply: (message: MessageView) => boolean;
  isSelected: (conversationId: string) => boolean;
  onCreated: (conversationId: string, message: MessageView) => void;
  remove: (deleted: MessageDeletion) => void;
  replaceConversations: (conversations: Conversation[]) => void;
  refreshConversations: () => void;
  clearUnread: (conversationId: string) => void;
  recordTyping: (conversationId: string, userId: string, login: string) => void;
};

export function bindConversationMessageEvents(
  socket: Socket,
  userId: string,
  effects: ConversationMessageEffects
): void {
  socket.on(CONVERSATION_REALTIME.created, (value: unknown) => {
    const event = conversationMessage(value);
    if (!event) return;
    effects.apply(event.message);
    effects.onCreated(event.conversationId, event.message);
  });
  socket.on(CONVERSATION_REALTIME.updated, (value: unknown) => {
    const event = conversationMessage(value);
    if (event) effects.apply(event.message);
  });
  socket.on(CONVERSATION_REALTIME.deleted, (value: unknown) => {
    const deleted = messageDeletion(value, "conversationId");
    if (deleted && effects.isSelected(deleted.scopeId)) effects.remove(deleted);
  });
  socket.on(CONVERSATION_REALTIME.sync, (value: unknown) => {
    if (!isRecord(value)) return;
    if (value.conversations === null) {
      effects.refreshConversations();
      return;
    }
    if (Array.isArray(value.conversations) && value.conversations.every(isConversation)) {
      effects.replaceConversations(value.conversations);
    }
  });
  socket.on(CONVERSATION_REALTIME.read, (value: unknown) => {
    if (isRecord(value) && typeof value.conversationId === "string") effects.clearUnread(value.conversationId);
  });
  socket.on(CONVERSATION_REALTIME.typing, (value: unknown) => {
    if (!isRecord(value)) return;
    const { conversationId, userId: typingUserId, login } = value;
    if (typeof conversationId !== "string" || conversationId.length === 0) return;
    if (typeof typingUserId !== "string" || typingUserId === userId) return;
    if (typeof login !== "string" || login.length === 0 || login.length > 64) return;
    effects.recordTyping(conversationId, typingUserId, login);
  });
}
