import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  closeConversation,
  createConversation,
  listConversations,
  type Conversation,
  type MessageView
} from "../api.js";

type ConversationStatus = "loading" | "ready" | "error";
type MenuPosition = { x: number; y: number };
type ConversationMenu = { conversationId: string; position: MenuPosition };
type HiddenConversation = { id: string; snapshot: Conversation | null };

const collapsedKey = "decentracord:sidebar-collapsed-direct-messages";
const unknownConversationRefreshInterval = 2_000;

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(collapsedKey) === "true";
  } catch {
    return false;
  }
}

function focusAfterClose(index: number): void {
  window.requestAnimationFrame(() => {
    const rows = [...document.querySelectorAll<HTMLElement>(".dm-section .dm-row-select")];
    const target = rows[Math.min(Math.max(index, 0), rows.length - 1)]
      ?? document.querySelector<HTMLElement>(".dm-section-add");
    target?.focus();
  });
}

type ConversationStateOptions = {
  leaveChannel: () => void;
  clearHistory: () => void;
};

export function useConversationState({ leaveChannel, clearHistory }: ConversationStateOptions) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [status, setStatus] = useState<ConversationStatus>("loading");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hidden, setHidden] = useState<HiddenConversation | null>(null);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [menu, setMenu] = useState<ConversationMenu | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [addMembersOpen, setAddMembersOpen] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [membersAnnouncement, setMembersAnnouncement] = useState("");
  const list = useRef<Conversation[]>([]);
  const selectedIdRef = useRef<string | null>(null);
  const session = useRef(0);
  const refreshedAt = useRef(new Map<string, number>());

  const replaceList = useCallback((items: Conversation[]) => {
    list.current = items;
    setConversations(items);
  }, []);

  const loadConversations = useCallback((items: Conversation[] | null) => {
    setCollapsed(readCollapsed());
    replaceList(items ?? []);
    setStatus(items === null ? "error" : "ready");
  }, [replaceList]);

  const clearUnread = useCallback((id: string) => {
    replaceList(list.current.map((entry) => entry.id === id ? { ...entry, unreadCount: 0 } : entry));
  }, [replaceList]);

  useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);

  const deselectConversation = useCallback(() => setSelectedId(null), []);

  const closeOpenConversation = useCallback(() => {
    deselectConversation();
    setHidden(null);
    clearHistory();
  }, [clearHistory, deselectConversation]);

  const selectConversation = useCallback((id: string) => {
    setSelectedId(id);
    leaveChannel();
    clearHistory();
    clearUnread(id);
    setHidden(null);
  }, [clearHistory, clearUnread, leaveChannel]);

  const applyConversations = useCallback((items: Conversation[]) => {
    const previous = list.current;
    replaceList(items);
    setStatus("ready");
    const id = selectedIdRef.current;
    if (id === null) return;
    if (items.some((entry) => entry.id === id)) {
      setHidden((current) => current?.id === id ? null : current);
    } else {
      const snapshot = previous.find((entry) => entry.id === id);
      setHidden((current) => ({ id, snapshot: snapshot ?? (current?.id === id ? current.snapshot : null) }));
    }
  }, [replaceList]);

  const applyNewMessage = useCallback((id: string, message: MessageView, userId: string | undefined): boolean => {
    const current = list.current;
    const index = current.findIndex((entry) => entry.id === id);
    const target = current[index];
    if (!target) return false;
    const unread = selectedIdRef.current !== id && message.authorId !== userId ? 1 : 0;
    const updated = { ...target, lastMessageAt: message.createdAt, unreadCount: target.unreadCount + unread };
    replaceList([updated, ...current.filter((_, position) => position !== index)]);
    return true;
  }, [replaceList]);

  const shouldRefresh = useCallback((id: string): boolean => {
    const now = Date.now();
    if (now - (refreshedAt.current.get(id) ?? 0) <= unknownConversationRefreshInterval) return false;
    refreshedAt.current.set(id, now);
    return true;
  }, []);

  const closeConversationRow = useCallback((id: string) => {
    const index = list.current.findIndex((entry) => entry.id === id);
    replaceList(list.current.filter((entry) => entry.id !== id));
    setAnnouncement("Переписка закрыта.");
    if (selectedIdRef.current === id) {
      selectedIdRef.current = null;
      closeOpenConversation();
    }
    focusAfterClose(index);
  }, [closeOpenConversation, replaceList]);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(collapsedKey, String(next));
      } catch {
        // Свёрнутость остаётся доступной в текущей вкладке.
      }
      return next;
    });
  }, []);

  const openMenu = useCallback((conversationId: string, position: MenuPosition) => {
    setMenu({
      conversationId,
      position: {
        x: Math.max(8, Math.min(position.x, window.innerWidth - 208)),
        y: Math.max(8, Math.min(position.y, window.innerHeight - 56))
      }
    });
  }, []);

  const resetConversations = useCallback(() => {
    session.current += 1;
    refreshedAt.current.clear();
    replaceList([]);
    setStatus("loading");
    selectedIdRef.current = null;
    deselectConversation();
    setHidden(null);
    setMenu(null);
    setCreateOpen(false);
    setAddMembersOpen(false);
    setAnnouncement("");
    setMembersAnnouncement("");
  }, [deselectConversation, replaceList]);

  const selectedConversation = conversations.find((entry) => entry.id === selectedId) ?? null;
  const isConversationHidden = hidden !== null && hidden.id === selectedId;
  return {
    conversations, status, setStatus, selectedId, selectedIdRef, selectedConversation,
    isConversationHidden, openConversation: selectedConversation ?? (isConversationHidden ? hidden.snapshot : null),
    collapsed, toggleCollapsed, menu, setMenu, openMenu, createOpen, setCreateOpen, addMembersOpen, setAddMembersOpen,
    announcement, membersAnnouncement, setMembersAnnouncement, session, loadConversations, resetConversations,
    selectConversation, deselectConversation, closeOpenConversation, applyConversations,
    clearUnread, applyNewMessage, shouldRefresh, closeConversationRow
  };
}

type ConversationActionsOptions = {
  state: ReturnType<typeof useConversationState>;
  csrfToken: string | null;
  userId: string | undefined;
  markRead: (conversationId: string) => void;
  onError: (message: string) => void;
  onSessionExpired: () => void;
};

export function useConversationActions({ state, csrfToken, userId, markRead, onError, onSessionExpired }: ConversationActionsOptions) {
  const {
    session, selectedIdRef, setStatus, selectConversation, setMenu, setMembersAnnouncement,
    applyConversations, applyNewMessage, shouldRefresh, closeConversationRow
  } = state;
  const generation = session.current;

  const refreshConversations = useCallback(async () => {
    if (session.current !== generation) return;
    setStatus("loading");
    try {
      const items = await listConversations();
      if (session.current === generation) applyConversations(items);
    } catch (error) {
      if (session.current !== generation) return;
      if (error instanceof ApiError && error.status === 401) onSessionExpired();
      else setStatus("error");
    }
  }, [applyConversations, generation, onSessionExpired, session, setStatus]);

  const onMessageCreated = useCallback((id: string, message: MessageView) => {
    if (session.current !== generation) return;
    if (applyNewMessage(id, message, userId)) {
      if (selectedIdRef.current === id) markRead(id);
    } else if (shouldRefresh(id)) {
      // Закрытый диалог возвращается в список после нового сообщения.
      void refreshConversations();
    }
  }, [applyNewMessage, generation, markRead, refreshConversations, selectedIdRef, session, shouldRefresh, userId]);

  const startConversationWith = useCallback(async (participantId: string): Promise<void> => {
    if (session.current !== generation) return;
    if (!csrfToken) throw new Error("Не удалось подготовить защищённый запрос");
    const conversation = await createConversation([participantId], csrfToken);
    await refreshConversations();
    if (session.current === generation) selectConversation(conversation.id);
  }, [csrfToken, generation, refreshConversations, selectConversation, session]);

  const onCreated = useCallback((conversation: Conversation) => {
    if (session.current !== generation) return;
    void refreshConversations();
    selectConversation(conversation.id);
  }, [generation, refreshConversations, selectConversation, session]);

  const onMembersAdded = useCallback((announcement: string) => {
    if (session.current !== generation) return;
    setMembersAnnouncement(announcement);
    void refreshConversations();
  }, [generation, refreshConversations, session, setMembersAnnouncement]);

  const closeConversationFromMenu = useCallback(async (id: string): Promise<void> => {
    if (session.current !== generation) return;
    setMenu(null);
    if (!csrfToken) return;
    try {
      await closeConversation(id, csrfToken);
      if (session.current === generation) closeConversationRow(id);
    } catch (error) {
      if (session.current !== generation) return;
      if (error instanceof ApiError && error.status === 401) onSessionExpired();
      else onError("Не удалось закрыть переписку. Попробуйте ещё раз.");
    }
  }, [closeConversationRow, csrfToken, generation, onError, onSessionExpired, session, setMenu]);

  return { refreshConversations, onMessageCreated, startConversationWith, onCreated, onMembersAdded, closeConversationFromMenu };
}
