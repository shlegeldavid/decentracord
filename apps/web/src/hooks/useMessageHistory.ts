import { useCallback, useEffect, useState, type RefObject } from "react";
import { ApiError, getConversationMessages, getMessages, type Channel, type MessageView } from "../api.js";
import { HistoryCursors, type ApplyMessageOptions } from "../lib/historyCursors.js";
import {
  CONVERSATION_SCOPE_PREFIX,
  channelIdFromScope,
  messageScopeKey,
  withoutDeletedContent,
  type MessageHistoryPage,
  type MessageScope,
  type ScopeKey
} from "../lib/messageHistory.js";

export type { ApplyMessageOptions } from "../lib/historyCursors.js";

type HistoryLoadState = "loading" | "ready" | "error";

const pageRequests = {
  channel: getMessages,
  conversation: getConversationMessages
};

export function useMessageHistoryState() {
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [historyLoadState, setHistoryLoadState] = useState<HistoryLoadState>("ready");
  const [cursors] = useState(() => new HistoryCursors());

  const getMaxAppliedSeq = useCallback((key: ScopeKey) => cursors.maxAppliedSeq(key), [cursors]);
  const setSelectedScope = useCallback((key: ScopeKey | null) => cursors.select(key), [cursors]);
  const forgetChannelHistory = useCallback((id: string) => cursors.forget(messageScopeKey("channel", id)), [cursors]);

  const resetHistoryStatus = useCallback((status: HistoryLoadState = "ready") => {
    setHasMoreHistory(false);
    setHistoryLoadState(status);
  }, []);

  const clearHistory = useCallback((status: HistoryLoadState = "ready") => {
    setMessages([]);
    resetHistoryStatus(status);
  }, [resetHistoryStatus]);

  const resetHistory = useCallback(() => {
    cursors.reset();
    clearHistory();
  }, [clearHistory, cursors]);

  const applyHistoryMessage = useCallback((message: MessageView, options: ApplyMessageOptions = {}): boolean => {
    const { key, hasGap } = cursors.recordMessage(message, options);
    if (cursors.isSelected(key)) setMessages((current) => cursors.mergeMessage(current, message));
    return hasGap;
  }, [cursors]);

  const markHistoryMessageDeleted = useCallback((
    messageId: string,
    event?: { scopeKey: ScopeKey; updatedSeq: number }
  ) => {
    cursors.recordDeletion(messageId, event);
    setMessages((current) => current.map((message) => message.id === messageId
      ? withoutDeletedContent({ ...message, updatedSeq: event?.updatedSeq ?? message.updatedSeq })
      : message));
  }, [cursors]);

  const showPage = useCallback((key: ScopeKey, page: MessageHistoryPage, preserveCurrent: boolean) => {
    if (cursors.isSelected(key)) {
      setMessages((current) => cursors.mergePage(current, key, page, preserveCurrent));
    }
  }, [cursors]);

  return {
    messages, hasMoreHistory, historyLoadState, clearHistory, resetHistory, resetHistoryStatus,
    getMaxAppliedSeq, setSelectedScope, forgetChannelHistory, applyHistoryMessage, markHistoryMessageDeleted,
    cursors, showPage, setHasMoreHistory, setHistoryLoadState
  };
}

type HistoryPagingOptions = {
  history: ReturnType<typeof useMessageHistoryState>;
  channelId: string | null;
  conversationId: string | null;
  channelIdRef: RefObject<string | null>;
  conversationIdRef: RefObject<string | null>;
  channelsRef: RefObject<Channel[]>;
  revokedChannelRef: RefObject<{ id: string } | null>;
  applyMessage: (message: MessageView, options: ApplyMessageOptions) => boolean;
  markChannelRead: (id: string) => void;
  markConversationRead: (id: string) => void;
  clearDraft: () => void;
  reportError: (message: string) => void;
  onSessionExpired: () => void;
};

export function useMessageHistoryPaging({
  history,
  channelId,
  conversationId,
  channelIdRef,
  conversationIdRef,
  channelsRef,
  revokedChannelRef,
  applyMessage,
  markChannelRead,
  markConversationRead,
  clearDraft,
  reportError,
  onSessionExpired
}: HistoryPagingOptions) {
  const { cursors, showPage, clearHistory, setHasMoreHistory, setHistoryLoadState } = history;

  const isSelected = useCallback((kind: MessageScope, id: string) =>
    (kind === "channel" ? channelIdRef : conversationIdRef).current === id,
  [channelIdRef, conversationIdRef]);

  const isRevoked = useCallback((kind: MessageScope, id: string) =>
    kind === "channel" && revokedChannelRef.current?.id === id,
  [revokedChannelRef]);

  const canDisplay = useCallback((kind: MessageScope, id: string) =>
    isSelected(kind, id) && !isRevoked(kind, id),
  [isSelected, isRevoked]);

  const loadHistoryPage = useCallback(async (kind: MessageScope, id: string, before: number | undefined) => {
    const initial = before === undefined;
    if (isRevoked(kind, id)) {
      if (initial) setHistoryLoadState("ready");
      return;
    }
    if (initial) setHistoryLoadState("loading");

    const key = messageScopeKey(kind, id);
    const request = cursors.beginPage(key, () => canDisplay(kind, id));
    try {
      const page = await pageRequests[kind](id, initial ? { limit: 50 } : { before, limit: 50 });
      if (!request.canApply()) return;
      cursors.recordPage(key, page, true);
      showPage(key, page, true);
      setHasMoreHistory(page.hasMore);
      if (initial) setHistoryLoadState("ready");
      if (kind === "conversation") markConversationRead(id);
      else if (initial) markChannelRead(id);
    } catch (error) {
      if (!request.sameSession()) return;
      if (error instanceof ApiError && error.status === 401) {
        onSessionExpired();
        return;
      }
      if (!request.canApply()) return;
      if (initial) setHistoryLoadState("error");
      throw error;
    }
  }, [canDisplay, cursors, isRevoked, markChannelRead, markConversationRead, showPage,
    onSessionExpired, setHasMoreHistory, setHistoryLoadState]);

  const catchUp = useCallback(async (kind: MessageScope, id: string) => {
    if (kind === "channel" && !channelsRef.current.some((channel) => channel.id === id && channel.canView)) return;
    const key = messageScopeKey(kind, id);
    await cursors.catchUp({
      key,
      isSelected: () => isSelected(kind, id),
      canDisplay: () => canDisplay(kind, id),
      fetchPage: (query) => pageRequests[kind](id, query),
      showBaseline: (page) => {
        showPage(key, page, false);
        setHasMoreHistory(page.hasMore);
      },
      applyEvent: (message) => applyMessage(message, { requestCatchUpOnGap: false, authoritativeSnapshot: true }),
      markRead: () => (kind === "channel" ? markChannelRead : markConversationRead)(id)
    });
  }, [applyMessage, canDisplay, channelsRef, cursors, isSelected, markChannelRead,
    markConversationRead, setHasMoreHistory, showPage]);

  useEffect(() => cursors.setGapHandler((key) => {
    const conversation = key.startsWith(CONVERSATION_SCOPE_PREFIX);
    const id = conversation ? key.slice(CONVERSATION_SCOPE_PREFIX.length) : channelIdFromScope(key);
    if (!id) return;
    void catchUp(conversation ? "conversation" : "channel", id).catch((error: unknown) => {
      if (error instanceof ApiError && error.status === 401) {
        onSessionExpired();
        return;
      }
      if (cursors.isSelected(key)) reportError("Не удалось обновить переписку");
    });
  }), [catchUp, cursors, onSessionExpired, reportError]);

  useEffect(() => {
    const id = conversationId || channelId;
    clearHistory(id ? "loading" : "ready");
    clearDraft();
    if (id) void loadHistoryPage(conversationId ? "conversation" : "channel", id, undefined).catch(() => undefined);
  }, [channelId, conversationId, clearDraft, clearHistory, loadHistoryPage]);

  return { catchUp, loadHistoryPage };
}
