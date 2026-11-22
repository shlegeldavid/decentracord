import { useCallback, useState } from "react";
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
import { messageScopeKey, type MessageScope } from "../lib/messageHistory.js";
import { MessageOutbox, type PendingMessage } from "../lib/messageOutbox.js";
import type { RealtimeStatus } from "../realtime.js";
import type { ApplyMessageOptions } from "./useMessageHistory";

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
  const [pendingMessages, setPendingMessages] = useState<PendingMessage[]>([]);
  const [outbox] = useState(() => new MessageOutbox(setPendingMessages));
  const resetQueue = useCallback(() => outbox.reset(), [outbox]);
  return { outbox, pendingMessages, resetQueue };
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
  const { outbox } = queue;
  const selectedId = useCallback((kind: MessageScope) =>
    (kind === "channel" ? channelIdRef : conversationIdRef).current,
  [channelIdRef, conversationIdRef]);

  const applyMessage = useCallback((message: MessageView, options?: ApplyMessageOptions) => {
    const hasGap = applyHistoryMessage(message, options);
    outbox.acknowledge(message, currentUserId);
    return hasGap;
  }, [applyHistoryMessage, currentUserId, outbox]);

  const send = useCallback(async (kind: MessageScope, id: string, entry: PendingMessage, token: string) => {
    const attempt = outbox.startSending(entry);
    if (selectedId(kind) === id) onError(null);

    try {
      const message = await requests[kind].send(id, entry, token);
      if (outbox.awaitsDelivery(attempt)) applyMessage(message);
    } catch (error) {
      if (!attempt.isCurrent()) return;
      const apiError = error instanceof ApiError ? error : null;
      if (apiError?.status === 401) {
        onSessionExpired();
        return;
      }

      const rejected = apiError?.status === 403 || apiError?.status === 404;
      const reason = rejectionReason(apiError, kind);
      const state = outbox.recordFailure(kind, attempt, rejected ? { rejected, reason } : { rejected, isConnected: isSocketConnected });
      if (state === "failed" && selectedId(kind) === id) {
        const denied = kind === "channel" && apiError?.code === "SEND_NOT_ALLOWED";
        onError(denied ? reason : apiError?.message ?? "Не удалось отправить сообщение. Попробуйте ещё раз.");
      }
    }
  }, [applyMessage, isSocketConnected, onError, onSessionExpired, outbox, selectedId]);

  const sendOrQueue = useCallback((kind: MessageScope, id: string, entry: PendingMessage, token: string) => {
    if (realtimeStatus === "connected" && isSocketConnected()) void send(kind, id, entry, token);
    else outbox.enqueue(entry);
  }, [isSocketConnected, outbox, realtimeStatus, send]);

  const submit = useCallback((kind: MessageScope, content: string, token: string) => {
    const id = selectedId(kind);
    if (!id) return;
    clearComposer();
    const entry: PendingMessage = {
      clientRequestId: createClientRequestId(), scopeKey: messageScopeKey(kind, id), content, state: "queued"
    };
    sendOrQueue(kind, id, entry, token);
  }, [clearComposer, selectedId, sendOrQueue]);

  const retry = useCallback((kind: MessageScope, clientRequestId: string) => {
    const retry = outbox.retryEntry(kind, clientRequestId);
    if (retry && csrfToken) sendOrQueue(kind, retry.scopeId, retry.entry, csrfToken);
  }, [csrfToken, outbox, sendOrQueue]);

  const requeueSending = useCallback(() => outbox.requeueSending(), [outbox]);
  const dropUnreadableChannels = useCallback((readableIds: ReadonlySet<string>) => outbox.dropUnreadableChannels(readableIds), [outbox]);
  const rejectChannel = useCallback((channelId: string, error: unknown) => {
    outbox.rejectChannel(channelId, rejectionReason(error instanceof ApiError ? error : null, "channel"));
  }, [outbox]);

  const replayChannels = useCallback(async (canReplay: () => boolean) => {
    if (!csrfToken) return;
    await outbox.replayChannels({
      canReplay,
      canView: (id) => channelsRef.current.some((channel) => channel.id === id && channel.canView),
      send: (id, entry) => send("channel", id, entry, csrfToken)
    });
  }, [channelsRef, csrfToken, outbox, send]);

  const changeMessage = useCallback(async (kind: MessageScope, change: MessageChange): Promise<boolean> => {
    const id = selectedId(kind);
    if (!id || !csrfToken) return false;
    const isCurrent = outbox.captureSession();
    onError(null);
    try {
      if (change.type === "edit") {
        const updated = await requests[kind].edit(id, change.messageId, change.content, csrfToken);
        if (!isCurrent()) return false;
        applyMessage(updated);
        return true;
      }

      await requests[kind].remove(id, change.messageId, csrfToken);
      if (!isCurrent() || selectedId(kind) !== id) return false;
      markHistoryMessageDeleted(change.messageId);
      return true;
    } catch (error) {
      if (!isCurrent()) return false;
      const apiError = error instanceof ApiError ? error : null;
      if (apiError?.status === 401) onSessionExpired();
      else if (selectedId(kind) === id) onError(changeError(apiError, kind, change));
      return false;
    }
  }, [applyMessage, csrfToken, markHistoryMessageDeleted, onError, onSessionExpired, outbox, selectedId]);

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
