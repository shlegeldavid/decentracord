import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { ApiError, getConversationMessages, getMessages, type Channel, type MessageView } from "../api.js";
import {
  CONVERSATION_SCOPE_PREFIX,
  channelIdFromScope,
  compareMessageOrder,
  mergeHistoryPage,
  messageScopeKey,
  scopeKeyOf,
  withoutDeletedContent,
  type MessageHistoryPage,
  type MessageScope,
  type ScopeKey
} from "../lib/messageHistory.js";

type HistoryLoadState = "loading" | "ready" | "error";

export type ApplyMessageOptions = {
  requestCatchUpOnGap?: boolean;
  authoritativeSnapshot?: boolean;
};

type ScopeHistory = {
  cursor?: number;
  observedCursor: number;
  maxAppliedSeq: number;
  catchingUp: boolean;
  catchUpRequested: boolean;
};

const pageRequests = {
  channel: getMessages,
  conversation: getConversationMessages
};

function advanceCursor(history: ScopeHistory, cursor: number): number {
  const next = Math.max(history.cursor ?? 0, cursor);
  history.cursor = next;
  history.observedCursor = Math.max(history.observedCursor, next);
  return next;
}

export function useMessageHistoryState() {
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [historyLoadState, setHistoryLoadState] = useState<HistoryLoadState>("ready");
  const scopes = useRef(new Map<ScopeKey, ScopeHistory>());
  const deletedIds = useRef(new Set<string>());
  const selectedScope = useRef<ScopeKey | null>(null);
  const requestCatchUp = useRef<(scopeKey: ScopeKey) => void>(() => undefined);

  const getScope = useCallback((key: ScopeKey): ScopeHistory => {
    const existing = scopes.current.get(key);
    if (existing) return existing;
    const next: ScopeHistory = { observedCursor: 0, maxAppliedSeq: 0, catchingUp: false, catchUpRequested: false };
    scopes.current.set(key, next);
    return next;
  }, []);

  const getMaxAppliedSeq = useCallback((key: ScopeKey): number => scopes.current.get(key)?.maxAppliedSeq ?? 0, []);
  const setSelectedScope = useCallback((key: ScopeKey | null) => { selectedScope.current = key; }, []);
  const forgetChannelHistory = useCallback((id: string) => { scopes.current.delete(messageScopeKey("channel", id)); }, []);

  const resetHistoryStatus = useCallback((status: HistoryLoadState = "ready") => {
    setHasMoreHistory(false);
    setHistoryLoadState(status);
  }, []);

  const clearHistory = useCallback((status: HistoryLoadState = "ready") => {
    setMessages([]);
    resetHistoryStatus(status);
  }, [resetHistoryStatus]);

  const resetHistory = useCallback(() => {
    selectedScope.current = null;
    scopes.current = new Map();
    deletedIds.current = new Set();
    clearHistory();
  }, [clearHistory]);

  const observeCursor = useCallback((key: ScopeKey, updatedSeq: number, catchUpOnGap = true): boolean => {
    const history = getScope(key);
    const current = history.cursor ?? 0;
    history.observedCursor = Math.max(history.observedCursor, updatedSeq);
    if (updatedSeq <= current) return false;
    if (updatedSeq === current + 1) {
      history.cursor = updatedSeq;
      return false;
    }
    if (catchUpOnGap && selectedScope.current === key) requestCatchUp.current(key);
    return true;
  }, [getScope]);

  const applyHistoryMessage = useCallback((message: MessageView, options: ApplyMessageOptions = {}): boolean => {
    const key = scopeKeyOf(message);
    const hasGap = observeCursor(key, message.updatedSeq, options.requestCatchUpOnGap !== false);
    if (message.deleted) deletedIds.current.add(message.id);
    const tombstoned = deletedIds.current.has(message.id);
    if ((!hasGap || options.authoritativeSnapshot) && (message.deleted || !tombstoned)) {
      const history = getScope(key);
      history.maxAppliedSeq = Math.max(history.maxAppliedSeq, message.seq);
    }

    if (selectedScope.current === key) {
      setMessages((current) => {
        const existing = current.find((entry) => entry.id === message.id);
        if (!message.deleted && (deletedIds.current.has(message.id) || (existing && message.updatedSeq <= existing.updatedSeq))) {
          return current;
        }
        const others = current.filter((entry) => entry.id !== message.id && entry.clientRequestId !== message.clientRequestId);
        return [...others, message.deleted ? withoutDeletedContent(message) : message].sort(compareMessageOrder);
      });
    }
    return hasGap;
  }, [getScope, observeCursor]);

  const markHistoryMessageDeleted = useCallback((
    messageId: string,
    event?: { scopeKey: ScopeKey; updatedSeq: number }
  ) => {
    deletedIds.current.add(messageId);
    if (event) observeCursor(event.scopeKey, event.updatedSeq);
    setMessages((current) => current.map((message) => message.id === messageId
      ? withoutDeletedContent({ ...message, updatedSeq: event?.updatedSeq ?? message.updatedSeq })
      : message));
  }, [observeCursor]);

  const applyPage = useCallback((key: ScopeKey, page: MessageHistoryPage, preserveCurrent: boolean) => {
    const history = getScope(key);
    if (!preserveCurrent) {
      const cursor = advanceCursor(history, page.cursor);
      if (selectedScope.current === key && history.observedCursor > cursor) requestCatchUp.current(key);
    }
    for (const message of page.messages) {
      history.maxAppliedSeq = Math.max(history.maxAppliedSeq, message.seq);
      if (message.deleted) deletedIds.current.add(message.id);
    }
    if (selectedScope.current === key) {
      setMessages((current) => mergeHistoryPage(current, key, page, deletedIds.current, preserveCurrent));
    }
  }, [getScope]);

  return {
    messages, hasMoreHistory, historyLoadState, clearHistory, resetHistory, resetHistoryStatus,
    getMaxAppliedSeq, setSelectedScope, forgetChannelHistory, applyHistoryMessage, markHistoryMessageDeleted,
    scopes, selectedScope, requestCatchUp, getScope, applyPage, setHasMoreHistory, setHistoryLoadState
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
  const { scopes, selectedScope, requestCatchUp, getScope, applyPage, clearHistory, setHasMoreHistory, setHistoryLoadState } = history;

  const isSelected = useCallback((kind: MessageScope, id: string) =>
    (kind === "channel" ? channelIdRef : conversationIdRef).current === id,
  [channelIdRef, conversationIdRef]);

  const isRevoked = useCallback((kind: MessageScope, id: string) =>
    kind === "channel" && revokedChannelRef.current?.id === id,
  [revokedChannelRef]);

  const loadHistoryPage = useCallback(async (kind: MessageScope, id: string, before: number | undefined) => {
    const initial = before === undefined;
    if (isRevoked(kind, id)) {
      if (initial) setHistoryLoadState("ready");
      return;
    }
    if (initial) setHistoryLoadState("loading");

    const key = messageScopeKey(kind, id);
    const scope = getScope(key);
    const session = scopes.current;
    const canApply = () => scopes.current.get(key) === scope && isSelected(kind, id) && !isRevoked(kind, id);
    try {
      const page = await pageRequests[kind](id, initial ? { limit: 50 } : { before, limit: 50 });
      if (!canApply()) return;
      applyPage(key, page, true);
      setHasMoreHistory(page.hasMore);
      if (initial) setHistoryLoadState("ready");
      if (kind === "conversation") markConversationRead(id);
      else if (initial) markChannelRead(id);
    } catch (error) {
      if (scopes.current !== session) return;
      if (error instanceof ApiError && error.status === 401) {
        onSessionExpired();
        return;
      }
      if (!canApply()) return;
      if (initial) setHistoryLoadState("error");
      throw error;
    }
  }, [applyPage, getScope, isRevoked, isSelected, markChannelRead, markConversationRead, onSessionExpired, scopes, setHasMoreHistory, setHistoryLoadState]);

  const catchUp = useCallback(async (kind: MessageScope, id: string) => {
    if (kind === "channel" && !channelsRef.current.some((channel) => channel.id === id && channel.canView)) return;

    const key = messageScopeKey(kind, id);
    const scope = getScope(key);
    if (scope.catchingUp) {
      scope.catchUpRequested = true;
      return;
    }

    scope.catchingUp = true;
    const isCurrent = () => scopes.current.get(key) === scope;
    const canApply = () => isCurrent() && isSelected(kind, id) && !isRevoked(kind, id);
    const getPage = pageRequests[kind];
    let cursor = scope.cursor;
    let completed = false;
    try {
      if (cursor === undefined) {
        if (!canApply()) return;
        const latestPage = await getPage(id, { limit: 50 });
        if (!canApply()) return;
        applyPage(key, latestPage, false);
        setHasMoreHistory(latestPage.hasMore);
        cursor = scope.cursor;
      }
      if (cursor === undefined) return;

      while (canApply()) {
        const page = await getPage(id, { after: cursor, limit: 200 });
        if (!canApply()) return;
        for (const message of page.messages) {
          applyMessage(message, { requestCatchUpOnGap: false, authoritativeSnapshot: true });
        }
        const next = advanceCursor(scope, Math.max(cursor, page.cursor));
        if (next <= cursor) break;
        cursor = next;
        if (page.messages.length < 200 && scope.observedCursor <= cursor) break;
      }
      completed = true;
      if (canApply()) (kind === "channel" ? markChannelRead : markConversationRead)(id);
    } catch (error) {
      if (isCurrent()) throw error;
    } finally {
      if (isCurrent()) {
        scope.catchingUp = false;
        const requested = scope.catchUpRequested;
        scope.catchUpRequested = false;
        const cursor = scope.cursor ?? 0;
        const observed = scope.observedCursor;
        if (completed && requested && observed > cursor && isSelected(kind, id)) {
          queueMicrotask(() => {
            if (isCurrent()) requestCatchUp.current(key);
          });
        }
      }
    }
  }, [applyMessage, applyPage, channelsRef, getScope, isRevoked, isSelected, markChannelRead, markConversationRead, requestCatchUp, scopes, setHasMoreHistory]);

  useEffect(() => {
    requestCatchUp.current = (key) => {
      const conversation = key.startsWith(CONVERSATION_SCOPE_PREFIX);
      const id = conversation ? key.slice(CONVERSATION_SCOPE_PREFIX.length) : channelIdFromScope(key);
      if (!id) return;
      void catchUp(conversation ? "conversation" : "channel", id).catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 401) {
          onSessionExpired();
          return;
        }
        if (selectedScope.current === key) reportError("Не удалось обновить переписку");
      });
    };
  }, [catchUp, onSessionExpired, reportError, requestCatchUp, selectedScope]);

  useEffect(() => {
    const id = conversationId || channelId;
    clearHistory(id ? "loading" : "ready");
    clearDraft();
    if (id) void loadHistoryPage(conversationId ? "conversation" : "channel", id, undefined).catch(() => undefined);
  }, [channelId, conversationId, clearDraft, clearHistory, loadHistoryPage]);

  return { catchUp, loadHistoryPage };
}
