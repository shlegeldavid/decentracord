import { useCallback, useRef, useState } from "react";
import type { RefObject } from "react";
import {
  ApiError,
  deleteConversationMessage,
  deleteMessage,
  editConversationMessage,
  editMessage,
  sendConversationMessage,
  sendMessage,
  type Channel,
  type MessageView
} from "../api.js";
import type { PendingMessage } from "../components/PendingMessageList";
import {
  channelIdFromScope,
  messageScopeKey,
  scopeKeyOf,
  type MessageScope
} from "../lib/messageHistory.js";
import type { RealtimeStatus } from "../realtime.js";
import type { ApplyMessageOptions } from "./useMessageHistory";

type PendingEntry = PendingMessage & { attempt?: symbol };
type MessageChange =
  | { type: "edit"; messageId: string; content: string }
  | { type: "delete"; messageId: string };

const requests = {
  channel: {
    send: (id: string, entry: PendingMessage, token: string) => sendMessage(id, entry.content, entry.clientRequestId, token),
    edit: editMessage,
    remove: deleteMessage
  },
  conversation: {
    send: (id: string, { content, clientRequestId }: PendingMessage, token: string) =>
      sendConversationMessage(id, { content, clientRequestId }, token),
    edit: editConversationMessage,
    remove: deleteConversationMessage
  }
};

function createClientRequestId(): string {
  if (typeof globalThis.crypto.randomUUID === "function") return globalThis.crypto.randomUUID();
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function rejectionReason(error: ApiError | null, kind: MessageScope): string {
  if (kind === "channel" && error?.code === "SEND_NOT_ALLOWED") return "В этом канале запрещена отправка сообщений.";
  return error?.message || "Отправка отклонена.";
}

function changeError(error: ApiError | null, kind: MessageScope, change: MessageChange): string {
  if (change.type === "edit") return error?.message ?? "Не удалось изменить сообщение.";
  if (kind === "conversation") return "Не удалось удалить сообщение. Попробуйте ещё раз.";
  if (error?.status === 403) return "Недостаточно прав для удаления этого сообщения";
  return error?.message ?? "Не удалось удалить сообщение.";
}

export function useMessageQueue() {
  const entries = useRef(new Map<string, PendingEntry>());
  const [pendingMessages, setPendingMessages] = useState<PendingMessage[]>([]);
  const publish = useCallback(() => { setPendingMessages([...entries.current.values()]); }, []);
  const resetQueue = useCallback(() => {
    entries.current = new Map();
    publish();
  }, [publish]);
  return { entries, pendingMessages, publish, resetQueue };
}

type MessageDeliveryOptions = {
  queue: ReturnType<typeof useMessageQueue>;
  currentUserId: string | undefined;
  csrfToken: string | null;
  realtimeStatus: RealtimeStatus;
  isSocketConnected: () => boolean;
  channelIdRef: RefObject<string | null>;
  conversationIdRef: RefObject<string | null>;
  channelsRef: RefObject<Channel[]>;
  applyHistoryMessage: (message: MessageView, options?: ApplyMessageOptions) => boolean;
  markHistoryMessageDeleted: (messageId: string) => void;
  clearComposer: () => void;
  onError: (message: string | null) => void;
  onSessionExpired: () => void;
};

export function useMessageDelivery({
  queue,
  currentUserId,
  csrfToken,
  realtimeStatus,
  isSocketConnected,
  channelIdRef,
  conversationIdRef,
  channelsRef,
  applyHistoryMessage,
  markHistoryMessageDeleted,
  clearComposer,
  onError,
  onSessionExpired
}: MessageDeliveryOptions) {
  const { entries, publish } = queue;
  const selectedId = useCallback((kind: MessageScope) =>
    (kind === "channel" ? channelIdRef : conversationIdRef).current,
  [channelIdRef, conversationIdRef]);

  const applyMessage = useCallback((message: MessageView, options?: ApplyMessageOptions) => {
    const hasGap = applyHistoryMessage(message, options);
    const pending = entries.current.get(message.clientRequestId);
    if (message.authorId === currentUserId && pending?.scopeKey === scopeKeyOf(message)) {
      entries.current.delete(message.clientRequestId);
      publish();
    }
    return hasGap;
  }, [applyHistoryMessage, currentUserId, entries, publish]);

  const send = useCallback(async (kind: MessageScope, id: string, entry: PendingMessage, token: string) => {
    const session = entries.current;
    const { clientRequestId, scopeKey, content } = entry;
    const attempt = Symbol();
    session.set(clientRequestId, { clientRequestId, scopeKey, content, state: "sending", attempt });
    publish();
    if (selectedId(kind) === id) onError(null);

    try {
      const message = await requests[kind].send(id, entry, token);
      if (entries.current === session && session.has(clientRequestId)) applyMessage(message);
    } catch (error) {
      if (entries.current !== session) return;
      const apiError = error instanceof ApiError ? error : null;
      if (apiError?.status === 401) {
        onSessionExpired();
        return;
      }

      const rejected = apiError?.status === 403 || apiError?.status === 404;
      const current = session.get(clientRequestId);
      if (current?.attempt !== attempt || current.state === "rejected") return;
      // Переотправка канала уже запланирована. Сохраняем лишь явный отказ сервера.
      if (kind === "channel" && current.state === "queued" && !rejected) return;
      const state = rejected ? "rejected" : isSocketConnected() ? "failed" : "queued";
      const reason = rejectionReason(apiError, kind);
      session.set(clientRequestId, { ...current, state, ...(rejected ? { reason } : {}) });
      publish();
      if (state === "failed" && selectedId(kind) === id) {
        const denied = kind === "channel" && apiError?.code === "SEND_NOT_ALLOWED";
        onError(denied ? reason : apiError?.message ?? "Не удалось отправить сообщение. Попробуйте ещё раз.");
      }
    }
  }, [applyMessage, entries, isSocketConnected, onError, onSessionExpired, publish, selectedId]);

  const submit = useCallback((kind: MessageScope, content: string, token: string) => {
    const id = selectedId(kind);
    if (!id) return;
    clearComposer();
    const clientRequestId = createClientRequestId();
    const entry: PendingMessage = { clientRequestId, scopeKey: messageScopeKey(kind, id), content, state: "queued" };
    if (realtimeStatus === "connected" && isSocketConnected()) {
      void send(kind, id, entry, token);
    } else {
      entries.current.set(clientRequestId, entry);
      publish();
    }
  }, [clearComposer, entries, isSocketConnected, publish, realtimeStatus, selectedId, send]);

  const retry = useCallback((kind: MessageScope, clientRequestId: string) => {
    const entry = entries.current.get(clientRequestId);
    const prefix = messageScopeKey(kind, "");
    if (!entry?.scopeKey.startsWith(prefix) || !csrfToken) return;
    const id = entry.scopeKey.slice(prefix.length);
    if (!id) return;
    if (realtimeStatus === "connected" && isSocketConnected()) {
      void send(kind, id, entry, csrfToken);
    } else {
      entries.current.set(clientRequestId, { ...entry, state: "queued" });
      publish();
    }
  }, [csrfToken, entries, isSocketConnected, publish, realtimeStatus, send]);

  const requeueSending = useCallback(() => {
    for (const [id, entry] of entries.current) {
      if (entry.state === "sending") entries.current.set(id, { ...entry, state: "queued" });
    }
    publish();
  }, [entries, publish]);

  const dropUnreadableChannels = useCallback((readableIds: ReadonlySet<string>) => {
    for (const [id, entry] of entries.current) {
      const channelId = channelIdFromScope(entry.scopeKey);
      if (channelId !== null && !readableIds.has(channelId)) entries.current.delete(id);
    }
    publish();
  }, [entries, publish]);

  const rejectChannel = useCallback((channelId: string, error: unknown) => {
    const scopeKey = messageScopeKey("channel", channelId);
    const reason = rejectionReason(error instanceof ApiError ? error : null, "channel");
    for (const [id, entry] of entries.current) {
      if (entry.scopeKey === scopeKey && (entry.state === "queued" || entry.state === "sending")) {
        entries.current.set(id, { ...entry, state: "rejected", reason });
      }
    }
    publish();
  }, [entries, publish]);

  const replayChannels = useCallback(async (canReplay: () => boolean) => {
    if (!csrfToken) return;
    const session = entries.current;
    for (const entry of [...session.values()]) {
      if (entries.current !== session || !canReplay()) break;
      if (entry.state !== "queued" || session.get(entry.clientRequestId) !== entry) continue;
      const id = channelIdFromScope(entry.scopeKey);
      if (!id || !channelsRef.current.some((channel) => channel.id === id && channel.canView)) continue;
      await send("channel", id, entry, csrfToken);
    }
  }, [channelsRef, csrfToken, entries, send]);

  const changeMessage = useCallback(async (kind: MessageScope, change: MessageChange): Promise<boolean> => {
    const id = selectedId(kind);
    if (!id || !csrfToken) return false;
    const session = entries.current;
    onError(null);
    try {
      if (change.type === "edit") {
        const updated = await requests[kind].edit(id, change.messageId, change.content, csrfToken);
        if (entries.current !== session) return false;
        applyMessage(updated);
        return true;
      }

      await requests[kind].remove(id, change.messageId, csrfToken);
      if (entries.current !== session || selectedId(kind) !== id) return false;
      markHistoryMessageDeleted(change.messageId);
      return true;
    } catch (error) {
      if (entries.current !== session) return false;
      const apiError = error instanceof ApiError ? error : null;
      if (apiError?.status === 401) onSessionExpired();
      else if (selectedId(kind) === id) onError(changeError(apiError, kind, change));
      return false;
    }
  }, [applyMessage, csrfToken, entries, markHistoryMessageDeleted, onError, onSessionExpired, selectedId]);

  return {
    applyMessage,
    requeueSending,
    dropUnreadableChannels,
    rejectChannel,
    replayChannels,
    actions: {
      submit,
      retry,
      edit: (kind: MessageScope, messageId: string, content: string) =>
        changeMessage(kind, { type: "edit", messageId, content }),
      remove: async (kind: MessageScope, messageId: string) => {
        await changeMessage(kind, { type: "delete", messageId });
      }
    }
  };
}
