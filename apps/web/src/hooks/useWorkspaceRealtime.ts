import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, getChannels, type AuthUser } from "../api.js";
import { messageScopeKey, type MessageScope } from "../lib/messageHistory.js";
import { CONVERSATION_REALTIME, connectRealtime, type RealtimeStatus } from "../realtime.js";
import { bindChannelMessageEvents, bindConversationMessageEvents, type MessageDeletion } from "../realtimeMessageEvents.js";
import { bindChannelEvents, bindSessionEvents, subscribeToReadableChannels, type ChannelSubscriptions } from "../realtimeWorkspaceEvents.js";
import type { useConversationTyping } from "./useConversationTyping.js";
import type { useMessageDelivery } from "./useMessageDelivery.js";
import type { useMessageHistoryPaging, useMessageHistoryState } from "./useMessageHistory.js";
import type { useWorkspaceChannels } from "./useWorkspaceChannels.js";
import type { useConversationActions, useConversationState } from "./useWorkspaceConversations.js";

type Connection = {
  socket: ReturnType<typeof connectRealtime>;
  subscriptions: ChannelSubscriptions;
};

export function useWorkspaceConnection() {
  const current = useRef<Connection | null>(null);
  const [status, setStatus] = useState<RealtimeStatus>("connecting");

  const disconnect = useCallback(() => {
    const connection = current.current;
    current.current = null;
    connection?.socket.removeAllListeners().disconnect();
    setStatus("disconnected");
  }, []);

  const reconnect = useCallback(() => { current.current?.socket.connect(); }, []);
  const isConnected = useCallback(() => current.current?.socket.connected === true, []);
  const sendTyping = useCallback((conversationId: string): boolean => {
    const socket = current.current?.socket;
    if (!socket?.connected) return false;
    socket.emit(CONVERSATION_REALTIME.typing, { conversationId });
    return true;
  }, []);

  return { current, status, setStatus, disconnect, reconnect, isConnected, sendTyping };
}

type WorkspaceRealtimeOptions = {
  user: AuthUser | null;
  connection: ReturnType<typeof useWorkspaceConnection>;
  channels: Pick<ReturnType<typeof useWorkspaceChannels>,
    "channels" | "channelsRef" | "selectedIdRef" | "findChannel" | "incrementUnread" | "reconcileChannelList" | "revokeSelectedChannel">;
  conversations: Pick<ReturnType<typeof useConversationState>, "selectedIdRef" | "applyConversations" | "clearUnread">;
  conversationActions: Pick<ReturnType<typeof useConversationActions>, "onMessageCreated" | "refreshConversations">;
  typing: Pick<ReturnType<typeof useConversationTyping>, "clearTyping" | "recordTyping">;
  delivery: Pick<ReturnType<typeof useMessageDelivery>,
    "applyMessage" | "dropUnreadableChannels" | "rejectChannel" | "replayChannels" | "requeueSending">;
  history: Pick<ReturnType<typeof useMessageHistoryState>, "forgetChannelHistory" | "markHistoryMessageDeleted">;
  catchUp: ReturnType<typeof useMessageHistoryPaging>["catchUp"];
  markChannelRead: (id: string) => void;
  setPinned: (messageId: string, pinned: boolean) => void;
  onSessionExpired: () => void;
  onRefreshError: (message: string) => void;
  onHistoryError: (message: string) => void;
};

export function useWorkspaceRealtime({
  user, connection: { current, setStatus, disconnect }, channels: channelState, conversations,
  conversationActions, typing, delivery, history, catchUp, markChannelRead, setPinned,
  onSessionExpired, onRefreshError, onHistoryError
}: WorkspaceRealtimeOptions): void {
  const { selectedIdRef: channelId, channels, channelsRef, findChannel, incrementUnread, reconcileChannelList, revokeSelectedChannel } = channelState;
  const { selectedIdRef: conversationId, applyConversations, clearUnread } = conversations;
  const { onMessageCreated, refreshConversations } = conversationActions;
  const { clearTyping, recordTyping } = typing;
  const { applyMessage, dropUnreadableChannels, rejectChannel, replayChannels, requeueSending } = delivery;
  const { forgetChannelHistory, markHistoryMessageDeleted } = history;

  useEffect(() => {
    if (!user) return;

    const socket = connectRealtime();
    const subscriptions: ChannelSubscriptions = new Map();
    const active = { socket, subscriptions };
    current.current = active;
    setStatus("connecting");

    const isCurrent = () => current.current === active;
    const invalidate = () => {
      if (!isCurrent()) return;
      disconnect();
      onSessionExpired();
    };
    const accessEffects = {
      forgetHistory: forgetChannelHistory,
      forgetSubscription: (id: string) => { subscriptions.delete(id); },
      dropUnreadableMessages: dropUnreadableChannels
    };

    const refreshChannels = () => {
      void getChannels().then((list) => {
        if (isCurrent()) reconcileChannelList(list, "http", accessEffects);
      }).catch((error: unknown) => {
        if (!isCurrent()) return;
        if (error instanceof ApiError && error.status === 401) invalidate();
        else onRefreshError("Не удалось загрузить данные установки. Обновите страницу и попробуйте снова.");
      });
    };

    const selection = { channel: channelId, conversation: conversationId };
    async function recover(kind: MessageScope, id: string): Promise<boolean> {
      try {
        await catchUp(kind, id);
      } catch (error) {
        if (!isCurrent()) return false;
        const status = error instanceof ApiError ? error.status : null;
        if (status === 401) invalidate();
        else if (kind === "channel" && (status === 403 || status === 404)) {
          rejectChannel(id, error);
          refreshChannels();
        } else if (selection[kind].current === id) {
          onHistoryError("Не удалось обновить переписку");
        }
      }
      return isCurrent();
    }

    async function recoverAfterReconnect(): Promise<void> {
      setStatus("connected");
      subscribeToReadableChannels(socket, subscriptions, channelsRef.current);
      const channel = channelId.current;
      const conversation = conversationId.current;
      if (channel && !await recover("channel", channel)) return;
      if (conversation && !await recover("conversation", conversation)) return;
      void refreshConversations();
      await replayChannels(() => isCurrent() && socket.connected);
    }

    const remove = (kind: MessageScope) =>
      ({ scopeId, messageId, updatedSeq }: MessageDeletion) =>
        markHistoryMessageDeleted(messageId, { scopeKey: messageScopeKey(kind, scopeId), updatedSeq });

    bindChannelEvents(socket, subscriptions, {
      findChannel,
      refresh: refreshChannels,
      applySync: (channels, categories) => reconcileChannelList({ channels, categories }, "socket", accessEffects),
      revoke: revokeSelectedChannel
    });
    bindChannelMessageEvents(socket, user.id, {
      canView: (id) => findChannel(id)?.canView === true,
      isSelected: (id) => channelId.current === id,
      apply: applyMessage,
      remove: remove("channel"),
      markRead: markChannelRead,
      incrementUnread,
      setPinned
    });
    bindConversationMessageEvents(socket, user.id, {
      apply: applyMessage,
      isSelected: (id) => conversationId.current === id,
      onCreated: onMessageCreated,
      remove: remove("conversation"),
      replaceConversations: applyConversations,
      refreshConversations,
      clearUnread,
      recordTyping
    });
    bindSessionEvents(socket, {
      ready: () => void recoverAfterReconnect(),
      setStatus,
      clearConnection: () => {
        subscriptions.clear();
        clearTyping();
      },
      requeueSending,
      invalidate
    });
    socket.connect();

    return () => { if (isCurrent()) disconnect(); };
  }, [user, current, setStatus, disconnect, channelId, channelsRef, findChannel, incrementUnread,
    reconcileChannelList, revokeSelectedChannel, conversationId, applyConversations, clearUnread, onMessageCreated,
    refreshConversations, clearTyping, recordTyping, applyMessage, dropUnreadableChannels, rejectChannel,
    replayChannels, requeueSending, forgetChannelHistory, markHistoryMessageDeleted, catchUp, markChannelRead,
    setPinned, onSessionExpired, onRefreshError, onHistoryError]);

  useEffect(() => {
    const active = current.current;
    if (active) subscribeToReadableChannels(active.socket, active.subscriptions, channels);
  }, [channels, current]);
}
