import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  ApiError,
  closeConversation,
  createConversation,
  deleteConversationMessage,
  deleteMessage,
  editConversationMessage,
  editMessage,
  getCsrfToken,
  getCurrentUser,
  getChannels,
  getOrganization,
  listConversations,
  markConversationRead,
  logout,
  login,
  markChannelRead,
  sendConversationMessage,
  sendMessage,
  type AuthUser,
  type Channel,
  type ChannelCategory,
  type Conversation,
  type MessageView,
  type Organization
} from "./api";
import type { PendingMessage } from "./components/MessageFeed";
import { ChannelMembersPanel } from "./components/ChannelMembersPanel";
import { WorkspaceChannelSidebar } from "./components/WorkspaceChannelSidebar";
import { WorkspaceChatPane } from "./components/WorkspaceChatPane";
import { CreateDmDialog } from "./components/CreateDmDialog";
import { AddDmMembersDialog } from "./components/AddDmMembersDialog";
import { DmMembersPanel } from "./components/DmMembersPanel";
import { DmSection } from "./components/DmSection";
import { AppHeader } from "./components/AppHeader";
import { PeopleSearch } from "./components/PeopleSearch";
import { LoginScreen } from "./components/LoginScreen";
import { SettingsModal, type SettingsSection } from "./components/SettingsModal";
import { useChannelPins } from "./hooks/useChannelPins";
import { useMessageHistoryPaging, useMessageHistoryState, type ApplyMessageOptions } from "./hooks/useMessageHistory";
import { useTheme } from "./hooks/useTheme";
import { useTimezone } from "./hooks/useTimezone";
import {
  CHANNEL_SCOPE_PREFIX,
  CONVERSATION_SCOPE_PREFIX,
  channelIdFromScope,
  messageScopeKey,
  type MessageScope
} from "./lib/messageHistory";
import { CONVERSATION_REALTIME, connectRealtime, type RealtimeStatus } from "./realtime";
import { bindChannelMessageEvents, bindConversationMessageEvents } from "./realtimeMessageEvents";
import { bindChannelEvents, bindSessionEvents, subscribeToReadableChannels, type ChannelSubscriptions } from "./realtimeWorkspaceEvents";

type ScreenState = "loading" | "guest" | "authenticated";
type WorkspaceOverlay = "channels" | "members" | null;
type LocalPendingMessage = Omit<PendingMessage, "state"> & { state: PendingMessage["state"] };
type RevokedChannel = { id: string; reason: string };
type OpenDmMenu = { conversationId: string; position: { x: number; y: number } };

const SIDEBAR_WIDTH_KEY = "decentracord:sidebar-width";
const SIDEBAR_COLLAPSED_KEY = "decentracord:sidebar-collapsed";
const COLLAPSED_CATEGORIES_KEY = "decentracord:sidebar-collapsed-categories";
const COLLAPSED_UNCATEGORIZED_KEY = "decentracord:sidebar-collapsed-uncategorized";
const COLLAPSED_DIRECT_MESSAGES_KEY = "decentracord:sidebar-collapsed-direct-messages";
const UNCATEGORIZED_ID = "__uncategorized__";

function readInitialSidebarWidth(): number {
  try {
    const stored = window.localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (stored === null) return 240;
    const parsed = Number(stored);
    if (!Number.isFinite(parsed) || parsed < 200 || parsed > 360) return 240;
    return Math.min(360, Math.max(200, Math.round(parsed / 8) * 8));
  } catch {
    return 240;
  }
}

function readInitialSidebarCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true";
  } catch {
    return false;
  }
}

function collapsedCategoriesStorageKey(userId: string): string {
  return `${COLLAPSED_CATEGORIES_KEY}:${userId}`;
}

function collapsedUncategorizedStorageKey(userId: string): string {
  return `${COLLAPSED_UNCATEGORIZED_KEY}:${userId}`;
}

function readInitialCollapsedCategories(userId: string): Set<string> {
  try {
    const stored = window.localStorage.getItem(collapsedCategoriesStorageKey(userId));
    if (stored === null) return new Set();
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((value): value is string => typeof value === "string" && value !== UNCATEGORIZED_ID));
  } catch {
    return new Set();
  }
}

function readInitialUncategorizedCollapsed(userId: string): boolean {
  try {
    return window.localStorage.getItem(collapsedUncategorizedStorageKey(userId)) === "true";
  } catch {
    return false;
  }
}

// Свёрнутость раздела «Личные сообщения» повторяет формат категорий 03.2:
// один ключ, значение «true» / «false», читается до первой отрисовки.
function readInitialDmCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_DIRECT_MESSAGES_KEY) === "true";
  } catch {
    return false;
  }
}

function guestError(error: unknown): string {
  if (error instanceof ApiError && error.status === 401) {
    return "Неверный логин или пароль.";
  }
  return "Не удалось завершить вход. Попробуйте ещё раз.";
}

function rejectedSendReason(error: unknown): string {
  if (!(error instanceof ApiError)) return "Отправка отклонена.";
  if (error.code === "SEND_NOT_ALLOWED") return "В этом канале запрещена отправка сообщений.";
  return error.message || "Отправка отклонена.";
}

const scopedMessageRequests = {
  channel: {
    prefix: CHANNEL_SCOPE_PREFIX,
    send: sendMessage,
    edit: editMessage,
    remove: deleteMessage
  },
  conversation: {
    prefix: CONVERSATION_SCOPE_PREFIX,
    send: (id: string, content: string, clientRequestId: string, token: string) =>
      sendConversationMessage(id, { content, clientRequestId }, token),
    edit: editConversationMessage,
    remove: deleteConversationMessage
  }
};

// Набор живёт только на клиенте: запись гаснет через 10 с без нового
// события, отправка ограничена одним событием в 2 с.
const TYPING_TTL_MS = 10_000;
const TYPING_THROTTLE_MS = 2_000;

function createClientRequestId(): string {
  if (typeof globalThis.crypto.randomUUID === "function") return globalThis.crypto.randomUUID();
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function App() {
  const [screen, setScreen] = useState<ScreenState>("loading");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("account");
  const [csrfToken, setCsrfToken] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [organization, setOrganization] = useState<Organization | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [categories, setCategories] = useState<ChannelCategory[]>([]);
  const [dmMenu, setDmMenu] = useState<OpenDmMenu | null>(null);
  const [channelPropertiesTarget, setChannelPropertiesTarget] = useState<Channel | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(readInitialSidebarWidth);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readInitialSidebarCollapsed);
  const [collapsedCategoryIds, setCollapsedCategoryIds] = useState<Set<string>>(() => new Set());
  const [uncategorizedCollapsed, setUncategorizedCollapsed] = useState(false);
  const [openOverlay, setOpenOverlay] = useState<WorkspaceOverlay>(null);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationsStatus, setConversationsStatus] = useState<"loading" | "ready" | "error">("loading");
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  // Открытая переписка, исчезнувшая из списка из-за отключения собеседника.
  const [hiddenConversationId, setHiddenConversationId] = useState<string | null>(null);
  const [hiddenConversationSnapshot, setHiddenConversationSnapshot] = useState<Conversation | null>(null);
  const [dmAnnouncement, setDmAnnouncement] = useState("");
  const [dmMembersAnnouncement, setDmMembersAnnouncement] = useState("");
  const [createDmOpen, setCreateDmOpen] = useState(false);
  const [addDmMembersOpen, setAddDmMembersOpen] = useState(false);
  const [dmCollapsed, setDmCollapsed] = useState(readInitialDmCollapsed);
  const [accessDeniedChannelId, setAccessDeniedChannelId] = useState<string | null>(null);
  const [expandedChannelTopicId, setExpandedChannelTopicId] = useState<string | null>(null);
  const history = useMessageHistoryState();
  const {
    messages, hasMoreHistory, historyLoadState, clearHistory, resetHistory, resetHistoryStatus,
    getMaxAppliedSeq, setSelectedScope, forgetChannelHistory, applyHistoryMessage, markHistoryMessageDeleted
  } = history;
  const [channelLastReadSeq, setChannelLastReadSeq] = useState<number | undefined>(undefined);
  const [revokedChannel, setRevokedChannel] = useState<RevokedChannel | null>(null);
  const [pendingMessages, setPendingMessages] = useState<LocalPendingMessage[]>([]);
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});
  const [messageInput, setMessageInput] = useState("");
  const [messageError, setMessageError] = useState<string | null>(null);
  const [isAdministrator, setIsAdministrator] = useState(false);
  const [canManageRoles, setCanManageRoles] = useState(false);
  const [loginValue, setLoginValue] = useState("");
  const [password, setPassword] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [realtimeStatus, setRealtimeStatus] = useState<RealtimeStatus>("connecting");
  const { theme, setTheme, toggleTheme } = useTheme(user, csrfToken);
  const { timeZone, dayKey, formatMessageTime } = useTimezone(user);
  const appShellElementRef = useRef<HTMLElement | null>(null);
  const dmMenuRef = useRef<HTMLDivElement | null>(null);
  const overlayPanelRef = useRef<HTMLElement | null>(null);
  const overlayReturnFocusRef = useRef<HTMLElement | null>(null);
  const appShellRef = useCallback((element: HTMLElement | null) => {
    appShellElementRef.current = element;
    element?.style.setProperty("--sidebar-width", sidebarCollapsed ? "48px" : `${sidebarWidth}px`);
  }, [sidebarCollapsed, sidebarWidth]);
  const loginInput = useRef<HTMLInputElement>(null);
  const realtimeSocket = useRef<ReturnType<typeof connectRealtime> | null>(null);
  const channelsRef = useRef<Channel[]>([]);
  const selectedChannelIdRef = useRef<string | null>(null);
  const selectedConversationIdRef = useRef<string | null>(null);
  const conversationsRef = useRef<Conversation[]>([]);
  const selectedChannelSnapshotRef = useRef<Channel | null>(null);
  const revokedChannelRef = useRef<RevokedChannel | null>(null);
  const pendingMessagesRef = useRef<LocalPendingMessage[]>([]);
  const unreadCountsRef = useRef<Record<string, number>>({});
  // Время последнего добора списка переписок по событию сообщения в конкретную
  // переписку: не чаще одного запроса в 2 секунды на строку.
  const conversationRefreshAtRef = useRef(new Map<string, number>());
  const channelSubscriptions = useRef<ChannelSubscriptions>(new Map());
  // Состояние набора живёт только здесь: карта «переписка → кто печатает»
  // с временем истечения и карта времени последней отправки на переписку.
  const typingRef = useRef(new Map<string, Map<string, { login: string; expiresAt: number }>>());
  const typingSentAtRef = useRef(new Map<string, number>());
  // Счётчик изменений карты набора: `Map` мутируется в обработчике ради
  // отсутствия лишних состояний, а перерисовку запрашивает версия.
  const [typingVersion, setTypingVersion] = useState(0);
  const canManageChannels = Boolean(user && (
    user.isOwner ||
    user.permissions.includes("MANAGE_CHANNELS") ||
    user.permissions.includes("ADMINISTRATOR")
  ));
  const selectedChannel = revokedChannel?.id === selectedChannelId
    ? selectedChannelSnapshotRef.current
    : channels.find((channel) => channel.id === selectedChannelId) ?? null;
  const selectedConversation = conversations.find((conversation) => conversation.id === selectedConversationId) ?? null;
  // Переписка скрыта: строки в списке уже нет, но лента и история остаются.
  const isConversationHidden = hiddenConversationId !== null && selectedConversationId === hiddenConversationId;
  const openConversation = selectedConversation ?? (isConversationHidden ? hiddenConversationSnapshot : null);

  const updatePendingMessages = useCallback((update: (current: LocalPendingMessage[]) => LocalPendingMessage[]) => {
    const next = update(pendingMessagesRef.current);
    pendingMessagesRef.current = next;
    setPendingMessages(next);
  }, []);

  // Отправка набора: не чаще одного события в 2 с на переписку. Payload — ровно
  // один ключ, логин на сервере берётся из базы.
  const emitTyping = useCallback((conversationId: string) => {
    const now = Date.now();
    if (now - (typingSentAtRef.current.get(conversationId) ?? 0) < TYPING_THROTTLE_MS) return;
    typingSentAtRef.current.set(conversationId, now);
    realtimeSocket.current?.emit(CONVERSATION_REALTIME.typing, { conversationId });
  }, []);

  // Один таймер на приложение: истёкшие записи удаляются, пустые внутренние
  // карты чистятся, перерисовка запрашивается только при изменении.
  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const [conversationId, entries] of typingRef.current) {
        for (const [userId, entry] of entries) {
          if (entry.expiresAt > now) continue;
          entries.delete(userId);
          changed = true;
        }
        if (entries.size === 0) typingRef.current.delete(conversationId);
      }
      if (changed) setTypingVersion((value) => value + 1);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, []);

  // Производные значения по версии карты: логины печатающих по переписке и
  // строка над композером. Если печатают несколько участников, имена скрыты.
  const typingByConversation = useMemo(() => {
    void typingVersion;
    const result = new Map<string, { logins: string[] }>();
    for (const [conversationId, entries] of typingRef.current) {
      if (entries.size === 0) continue;
      result.set(conversationId, { logins: [...entries.values()].map((entry) => entry.login) });
    }
    return result;
  }, [typingVersion]);

  const typingLabelFor = useCallback((conversationId: string): string | null => {
    const logins = typingByConversation.get(conversationId)?.logins ?? [];
    if (logins.length === 0) return null;
    if (logins.length === 1) return `${logins[0]} печатает…`;
    return "Печатают…";
  }, [typingByConversation]);

  const replaceUnreadCounts = useCallback((items: Channel[], preserveCurrent: boolean) => {
    const current = unreadCountsRef.current;
    const next: Record<string, number> = {};
    for (const channel of items) {
      next[channel.id] = preserveCurrent && current[channel.id] !== undefined
        ? current[channel.id]!
        : channel.unreadCount ?? 0;
    }
    unreadCountsRef.current = next;
    setUnreadCounts(next);
  }, []);

  const toggleCategoryCollapsed = useCallback((categoryId: string) => {
    if (!user) return;
    const knownCategoryIds = new Set(categories.map((category) => category.id).filter((id) => id !== UNCATEGORIZED_ID));
    const next = new Set([...collapsedCategoryIds].filter((id) => knownCategoryIds.has(id)));
    if (next.has(categoryId)) next.delete(categoryId);
    else if (knownCategoryIds.has(categoryId)) next.add(categoryId);
    setCollapsedCategoryIds(next);
    try {
      window.localStorage.setItem(collapsedCategoriesStorageKey(user.id), JSON.stringify([...next]));
    } catch {
      // Keep the in-memory state usable when browser storage is unavailable.
    }
  }, [categories, collapsedCategoryIds, user]);

  const toggleUncategorizedCollapsed = useCallback(() => {
    if (!user) return;
    const next = !uncategorizedCollapsed;
    setUncategorizedCollapsed(next);
    try {
      window.localStorage.setItem(collapsedUncategorizedStorageKey(user.id), String(next));
    } catch {
      // Keep the in-memory state usable when browser storage is unavailable.
    }
  }, [uncategorizedCollapsed, user]);

  const setChannelUnreadCount = useCallback((channelId: string, count: number) => {
    const next = { ...unreadCountsRef.current, [channelId]: count };
    unreadCountsRef.current = next;
    setUnreadCounts(next);
  }, []);

  const applyMessage = useCallback((message: MessageView, options?: ApplyMessageOptions) => {
    const hasGap = applyHistoryMessage(message, options);
    updatePendingMessages((current) => current.filter((entry) => entry.clientRequestId !== message.clientRequestId));
    return hasGap;
  }, [applyHistoryMessage, updatePendingMessages]);

  const subscribeToChannels = useCallback((items: Channel[]) => {
    subscribeToReadableChannels(realtimeSocket.current, channelSubscriptions.current, items);
  }, []);

  useEffect(() => {
    channelsRef.current = channels;
    const selected = channels.find((channel) => channel.id === selectedChannelId);
    if (selected?.canView && revokedChannelRef.current?.id !== selected.id) selectedChannelSnapshotRef.current = selected;
  }, [channels, selectedChannelId]);

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  // Заголовок вкладки: сумма непрочитанных по каналам и по перепискам
  // вместе. Только `title` — звука и системных уведомлений нет.
  useEffect(() => {
    const total = Object.values(unreadCounts).reduce((sum, value) => sum + value, 0)
      + conversations.reduce((sum, conversation) => sum + conversation.unreadCount, 0);
    document.title = total === 0
      ? "Decentracord"
      : total > 99
        ? "(99+) Decentracord"
        : `(${total}) Decentracord`;
  }, [unreadCounts, conversations]);

  // Меню строки диалога: фокус переходит на пункт, клик вне меню его закрывает.
  useEffect(() => {
    if (!dmMenu) return;
    dmMenuRef.current?.querySelector<HTMLButtonElement>("[role='menuitem']")?.focus();
    const closeOnOutside = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".context-menu") !== null) return;
      setDmMenu(null);
    };
    document.addEventListener("pointerdown", closeOnOutside);
    return () => document.removeEventListener("pointerdown", closeOnOutside);
  }, [dmMenu]);

  useEffect(() => {
    selectedChannelIdRef.current = selectedChannelId;
    selectedConversationIdRef.current = selectedConversationId;
    setSelectedScope(selectedConversationId
      ? messageScopeKey("conversation", selectedConversationId)
      : selectedChannelId ? messageScopeKey("channel", selectedChannelId) : null);
  }, [selectedChannelId, selectedConversationId, setSelectedScope]);

  useEffect(() => {
    if (!selectedChannelId) setChannelLastReadSeq(undefined);
  }, [selectedChannelId]);

  const clearPrivateSession = useCallback(() => {
    realtimeSocket.current?.disconnect();
    realtimeSocket.current = null;
    setUser(null);
    setOrganization(null);
    setChannels([]);
    setCategories([]);
    channelsRef.current = [];
    setSelectedChannelId(null);
    setAccessDeniedChannelId(null);
    setExpandedChannelTopicId(null);
    selectedChannelIdRef.current = null;
    selectedConversationIdRef.current = null;
    selectedChannelSnapshotRef.current = null;
    revokedChannelRef.current = null;
    setRevokedChannel(null);
    resetHistory();
    setChannelLastReadSeq(undefined);
    setPendingMessages([]);
    pendingMessagesRef.current = [];
    unreadCountsRef.current = {};
    setUnreadCounts({});
    setConversations([]);
    setConversationsStatus("loading");
    setSelectedConversationId(null);
    setCreateDmOpen(false);
    setAddDmMembersOpen(false);
    setDmMenu(null);
    setHiddenConversationId(null);
    setHiddenConversationSnapshot(null);
    setDmAnnouncement("");
    setDmMembersAnnouncement("");
    conversationsRef.current = [];
    conversationRefreshAtRef.current.clear();
    // На экране входа заголовок вкладки не показывает непрочитанные сообщения.
    document.title = "Decentracord";
    setMessageInput("");
    setMessageError(null);
    channelSubscriptions.current.clear();
    typingRef.current.clear();
    typingSentAtRef.current.clear();
    setTypingVersion((value) => value + 1);
    setIsAdministrator(false);
    setCanManageRoles(false);
    setSettingsOpen(false);
    setSettingsSection("account");
    setOpenOverlay(null);
    setChannelPropertiesTarget(null);
    setPassword("");
    setErrorMessage(null);
    setSuccessMessage(null);
    setRealtimeStatus("disconnected");
    setScreen("guest");
    void getCsrfToken().then(setCsrfToken).catch(() => setCsrfToken(null));
  }, [resetHistory]);

  const channelPins = useChannelPins({
    channelId: selectedChannelId,
    selectedChannelId: selectedChannelIdRef,
    csrfToken,
    onError: setMessageError,
    onSessionExpired: clearPrivateSession
  });
  const { setPinned } = channelPins;

  // Общий путь применения списка переписок: и полный ответ сервера, и добор по
  // сигналу `conversations: null`. Исчезновение открытой переписки — признак
  // отключения собеседника: показываем карточку, историю не стираем.
  const applyConversations = useCallback((items: Conversation[]) => {
    setConversations(items);
    setConversationsStatus("ready");
    const selectedId = selectedConversationIdRef.current;
    if (selectedId === null) return;
    if (items.some((conversation) => conversation.id === selectedId)) {
      setHiddenConversationId((current) => (current === selectedId ? null : current));
      return;
    }
    const previous = conversationsRef.current.find((conversation) => conversation.id === selectedId);
    if (previous) setHiddenConversationSnapshot(previous);
    setHiddenConversationId(selectedId);
  }, []);

  const refreshConversations = useCallback(() => {
    setConversationsStatus("loading");
    return listConversations()
      .then((items) => applyConversations(items))
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 401) {
          clearPrivateSession();
          return;
        }
        setConversationsStatus("error");
      });
  }, [applyConversations, clearPrivateSession]);

  const toggleDmCollapsed = useCallback(() => {
    setDmCollapsed((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(COLLAPSED_DIRECT_MESSAGES_KEY, String(next));
      } catch {
        // Раздел остаётся рабочим, когда хранилище браузера недоступно.
      }
      return next;
    });
  }, []);

  // Выбор переписки и выбор канала взаимоисключающие: открытая переписка живёт
  // в центральной ленте.
  const selectConversation = useCallback((conversationId: string) => {
    setSelectedConversationId(conversationId);
    setSelectedChannelId(null);
    selectedChannelIdRef.current = null;
    selectedChannelSnapshotRef.current = null;
    setAccessDeniedChannelId(null);
    setExpandedChannelTopicId(null);
    clearHistory();
    // Счётчик строки сбрасывается сразу; серверный курсор прочтения двигает
    // эффект применения первой страницы истории.
    setConversations((current) => current.map((conversation) => conversation.id === conversationId
      ? { ...conversation, unreadCount: 0 }
      : conversation));
    setHiddenConversationId(null);
    setHiddenConversationSnapshot(null);
  }, [clearHistory]);

  const startConversationWith = useCallback(async (participantId: string): Promise<void> => {
    if (!csrfToken) throw new Error("Не удалось подготовить защищённый запрос");
    const conversation = await createConversation([participantId], csrfToken);
    await refreshConversations();
    selectConversation(conversation.id);
  }, [csrfToken, refreshConversations, selectConversation]);

  const markReadThroughAppliedMessages = useCallback((channelId: string) => {
    if (!csrfToken) return;
    const seq = getMaxAppliedSeq(messageScopeKey("channel", channelId));
    void markChannelRead(channelId, seq, csrfToken).then(() => {
      const nextChannels = channelsRef.current.map((channel) => channel.id === channelId
        ? { ...channel, lastReadSeq: Math.max(channel.lastReadSeq ?? 0, seq) }
        : channel);
      channelsRef.current = nextChannels;
      setChannels(nextChannels);
    }).catch((error: unknown) => {
      if (error instanceof ApiError && error.status === 401) clearPrivateSession();
    });
  }, [csrfToken, clearPrivateSession, getMaxAppliedSeq]);

  // Курсор прочтения переписки: тот же путь, что у канала, но по области
  // `conversation:<id>`. Счётчик строки уже равен нулю, поэтому результат
  // пересчитывать не нужно — `Conversation` не отдаёт `lastReadSeq`.
  const markConversationReadThroughApplied = useCallback((conversationId: string) => {
    if (!csrfToken) return;
    const seq = getMaxAppliedSeq(messageScopeKey("conversation", conversationId));
    void markConversationRead(conversationId, seq, csrfToken).catch((error: unknown) => {
      if (error instanceof ApiError && error.status === 401) clearPrivateSession();
    });
  }, [csrfToken, clearPrivateSession, getMaxAppliedSeq]);

  const selectChannel = useCallback((channelId: string) => {
    const channel = channelsRef.current.find((item) => item.id === channelId);
    if (!channel?.canView) return;
    const changedChannel = selectedChannelIdRef.current !== channelId;
    setAccessDeniedChannelId(null);
    setExpandedChannelTopicId(null);
    selectedChannelSnapshotRef.current = channel;
    setChannelLastReadSeq(channel.lastReadSeq ?? 0);
    revokedChannelRef.current = null;
    setRevokedChannel(null);
    if (changedChannel) resetHistoryStatus("loading");
    selectedChannelIdRef.current = channelId;
    setSelectedChannelId(channelId);
    setSelectedConversationId(null);
    setChannelUnreadCount(channelId, 0);
    markReadThroughAppliedMessages(channelId);
  }, [markReadThroughAppliedMessages, resetHistoryStatus, setChannelUnreadCount]);

  const leaveRevokedChannel = useCallback(() => {
    revokedChannelRef.current = null;
    setRevokedChannel(null);
    selectedChannelSnapshotRef.current = null;
    selectedChannelIdRef.current = null;
    setSelectedChannelId(null);
    setChannelLastReadSeq(undefined);
    resetHistoryStatus();
  }, [resetHistoryStatus]);

  const toggleSidebarCollapsed = useCallback(() => {
    setAccessDeniedChannelId(null);
    setSidebarCollapsed((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next));
      } catch {
        // The sidebar remains usable when browser storage is unavailable.
      }
      return next;
    });
  }, []);

  const updateSidebarWidth = useCallback((nextWidth: number) => {
    setSidebarWidth(nextWidth);
  }, []);

  const saveSidebarWidth = useCallback((nextWidth: number) => {
    try {
      window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(nextWidth));
    } catch {
      // The current width remains applied when browser storage is unavailable.
    }
  }, []);

  const setOverlayPanelElement = useCallback((element: HTMLElement | null) => {
    overlayPanelRef.current = element;
  }, []);

  const openOverlayFromTrigger = useCallback((overlay: Exclude<WorkspaceOverlay, null>) => {
    const activeElement = document.activeElement;
    overlayReturnFocusRef.current = activeElement instanceof HTMLElement ? activeElement : null;
    setOpenOverlay(overlay);
  }, []);

  const closeOverlay = useCallback(() => {
    setOpenOverlay(null);
  }, []);

  useEffect(() => {
    if (!openOverlay) {
      const returnFocus = overlayReturnFocusRef.current;
      if (returnFocus?.isConnected) {
        window.requestAnimationFrame(() => returnFocus.focus());
      }
      overlayReturnFocusRef.current = null;
      return;
    }

    const appShell = appShellElementRef.current;
    if (!appShell) return;
    const backgroundSelectors = [
      ".app-header",
      ".workspace-alert",
      ".workspace-content",
      openOverlay === "channels" ? ".members-panel" : ".channel-sidebar"
    ];
    const backgroundElements = backgroundSelectors
      .map((selector) => appShell.querySelector<HTMLElement>(selector))
      .filter((element): element is HTMLElement => element !== null);
    const previousInertValues = backgroundElements.map((element) => element.inert);
    backgroundElements.forEach((element) => { element.inert = true; });

    const focusFrame = window.requestAnimationFrame(() => overlayPanelRef.current?.focus());
    const handleEscape = (event: KeyboardEvent) => {
      if (settingsOpen || event.key !== "Escape") return;
      event.stopPropagation();
      closeOverlay();
    };
    document.addEventListener("keydown", handleEscape);

    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleEscape);
      backgroundElements.forEach((element, index) => {
        element.inert = previousInertValues[index] ?? false;
      });
    };
  }, [closeOverlay, openOverlay, settingsOpen]);

  const clearMessageDraft = useCallback(() => {
    setMessageInput("");
    setMessageError(null);
  }, []);
  const { catchUp, loadHistoryPage } = useMessageHistoryPaging({
    history,
    channelId: selectedChannelId,
    conversationId: selectedConversationId,
    channelIdRef: selectedChannelIdRef,
    conversationIdRef: selectedConversationIdRef,
    channelsRef,
    revokedChannelRef,
    applyMessage,
    markChannelRead: markReadThroughAppliedMessages,
    markConversationRead: markConversationReadThroughApplied,
    clearDraft: clearMessageDraft,
    reportError: setMessageError,
    onSessionExpired: clearPrivateSession
  });

  const loadEarlierMessages = useCallback(async (before: number | undefined) => {
    const channelId = selectedChannelIdRef.current;
    if (channelId) await loadHistoryPage("channel", channelId, before);
  }, [loadHistoryPage]);

  const setPendingDelivery = useCallback((clientRequestId: string, delivery: Pick<PendingMessage, "state" | "reason">) => {
    updatePendingMessages((current) => current.map((message) => message.clientRequestId === clientRequestId
      ? { ...message, ...delivery }
      : message));
  }, [updatePendingMessages]);

  const submitScopedMessage = useCallback(async (
    kind: MessageScope,
    id: string,
    content: string,
    clientRequestId: string,
    token: string
  ): Promise<void> => {
    const { prefix, send } = scopedMessageRequests[kind];
    const selectedId = kind === "channel" ? selectedChannelIdRef : selectedConversationIdRef;
    const scopeKey = `${prefix}${id}`;
    updatePendingMessages((current) => {
      const exists = current.some((message) => message.clientRequestId === clientRequestId);
      if (exists) {
        return current.map((message) => message.clientRequestId === clientRequestId
          ? { ...message, scopeKey, content, state: "sending" }
          : message);
      }
      return [...current, { scopeKey, content, clientRequestId, state: "sending" }];
    });
    if (selectedId.current === id) setMessageError(null);

    try {
      const message = await send(id, content, clientRequestId, token);
      applyMessage(message);
    } catch (error: unknown) {
      const apiError = error instanceof ApiError ? error : null;
      if (apiError?.status === 401) {
        clearPrivateSession();
        return;
      }
      if (apiError?.status === 403 || apiError?.status === 404) {
        const reason = kind === "channel" ? rejectedSendReason(apiError) : apiError.message || "Отправка отклонена.";
        setPendingDelivery(clientRequestId, { state: "rejected", reason });
        return;
      }
      if (!realtimeSocket.current?.connected) {
        setPendingDelivery(clientRequestId, { state: "queued" });
        return;
      }
      setPendingDelivery(clientRequestId, { state: "failed" });
      if (selectedId.current === id) {
        const denied = kind === "channel" && apiError?.code === "SEND_NOT_ALLOWED";
        setMessageError(denied
          ? "В этом канале запрещена отправка сообщений."
          : apiError?.message ?? "Не удалось отправить сообщение. Попробуйте ещё раз.");
      }
    }
  }, [applyMessage, clearPrivateSession, setPendingDelivery, updatePendingMessages]);

  useEffect(() => {
    if (screen !== "authenticated" || !user) return;

    const socket = connectRealtime();
    let active = true;
    realtimeSocket.current = socket;
    setRealtimeStatus("connecting");

    const isCurrentConnection = () => active && realtimeSocket.current === socket;
    const invalidate = () => {
      if (!isCurrentConnection()) return;
      active = false;
      clearPrivateSession();
    };
    const markSelectedChannelRevoked = (channelId: string, reason = "Доступ к каналу отозван", inaccessibleChannel?: Channel) => {
      const snapshot = inaccessibleChannel ?? selectedChannelSnapshotRef.current;
      if (snapshot?.id === channelId) {
        selectedChannelSnapshotRef.current = {
          ...snapshot,
          description: null,
          canView: false,
          canSend: false,
          canManageMessages: false,
          ownerEditable: false,
          unreadCount: 0
        };
      }
      const revoked = { id: channelId, reason };
      revokedChannelRef.current = revoked;
      setRevokedChannel(revoked);
      resetHistoryStatus();
    };
    const clearUnavailableChannels = (items: Channel[]) => {
      const readableChannelIds = new Set(items.filter((channel) => channel.canView).map((channel) => channel.id));
      for (const channel of channelsRef.current) {
        if (readableChannelIds.has(channel.id)) continue;
        if (channel.canView) forgetChannelHistory(channel.id);
        channelSubscriptions.current.delete(channel.id);
      }
      updatePendingMessages((current) => current.filter((message) => {
        const pendingChannelId = channelIdFromScope(message.scopeKey);
        return pendingChannelId === null || readableChannelIds.has(pendingChannelId);
      }));
    };
    const syncSelectedChannel = (items: Channel[], preserveRevocationReason: boolean) => {
      const selectedId = selectedChannelIdRef.current;
      if (!selectedId) return;
      const selected = items.find((channel) => channel.id === selectedId);
      const revoked = revokedChannelRef.current;
      if (!selected?.canView) {
        const reason = (preserveRevocationReason || !selected) && revoked?.id === selectedId
          ? revoked.reason
          : undefined;
        markSelectedChannelRevoked(selectedId, reason, selected);
        return;
      }
      selectedChannelSnapshotRef.current = selected;
      if (revoked?.id === selectedId) {
        revokedChannelRef.current = null;
        setRevokedChannel(null);
      }
    };
    const applyChannelList = (items: Channel[], categories: ChannelCategory[], preserveUnread: boolean) => {
      channelsRef.current = items;
      replaceUnreadCounts(items, preserveUnread);
      setChannels(items);
      setCategories(categories);
    };
    const queueSendingMessages = () => {
      updatePendingMessages((current) => current.map((message) =>
        message.state === "sending" ? { ...message, state: "queued" } : message
      ));
    };
    const refreshChannels = () => {
      void getChannels().then(({ channels: items, categories: categoryItems }) => {
        if (!isCurrentConnection()) return;
        syncSelectedChannel(items, false);
        clearUnavailableChannels(items);
        applyChannelList(items, categoryItems, false);
      }).catch((error: unknown) => {
        if (!isCurrentConnection()) return;
        if (error instanceof ApiError && error.status === 401) {
          invalidate();
          return;
        }
        setErrorMessage("Не удалось загрузить данные установки. Обновите страницу и попробуйте снова.");
      });
    };

    const findChannel = (id: string) => channelsRef.current.find((channel) => channel.id === id);
    bindChannelEvents(socket, channelSubscriptions.current, {
      findChannel,
      refresh: refreshChannels,
      applySync: (items, categoryItems) => {
        clearUnavailableChannels(items);
        syncSelectedChannel(items, true);
        applyChannelList(items, categoryItems, true);
      },
      revoke: (id, reason) => {
        if (selectedChannelIdRef.current === id) markSelectedChannelRevoked(id, reason);
      }
    });

    async function recoverOpenScope(kind: MessageScope, id: string): Promise<boolean> {
      try {
        await catchUp(kind, id);
      } catch (error) {
        if (!isCurrentConnection()) return false;
        const status = error instanceof ApiError ? error.status : null;
        if (status === 401) {
          invalidate();
          return false;
        }
        if (kind === "channel" && (status === 403 || status === 404)) {
          const scopeKey = `${CHANNEL_SCOPE_PREFIX}${id}`;
          const reason = rejectedSendReason(error);
          updatePendingMessages((current) => current.map((message) =>
            message.scopeKey === scopeKey && (message.state === "queued" || message.state === "sending")
              ? { ...message, state: "rejected", reason }
              : message));
          refreshChannels();
        } else {
          const selectedId = kind === "channel" ? selectedChannelIdRef : selectedConversationIdRef;
          if (selectedId.current === id) setMessageError("Не удалось обновить переписку");
        }
      }
      return isCurrentConnection();
    }

    async function recoverAfterReconnect(): Promise<void> {
      setRealtimeStatus("connected");
      subscribeToChannels(channelsRef.current);
      const channelId = selectedChannelIdRef.current;
      const conversationId = selectedConversationIdRef.current;
      if (channelId && !await recoverOpenScope("channel", channelId)) return;
      if (conversationId && !await recoverOpenScope("conversation", conversationId)) return;
      void refreshConversations();

      if (!csrfToken || !socket.connected) return;
      const readableChannelIds = new Set(channelsRef.current.filter((channel) => channel.canView).map((channel) => channel.id));
      const queuedMessages = pendingMessagesRef.current.flatMap((message) => {
        if (message.state !== "queued") return [];
        const queuedChannelId = channelIdFromScope(message.scopeKey);
        return queuedChannelId !== null && readableChannelIds.has(queuedChannelId)
          ? [{ message, channelId: queuedChannelId }]
          : [];
      });
      for (const { message, channelId: queuedChannelId } of queuedMessages) {
        if (!isCurrentConnection() || !socket.connected) break;
        if (!pendingMessagesRef.current.some((pending) => pending.clientRequestId === message.clientRequestId)) continue;
        await submitScopedMessage("channel", queuedChannelId, message.content, message.clientRequestId, csrfToken);
      }
    }

    const onConversationMessage = (conversationId: string, message: MessageView) => {
      const isOpen = selectedConversationIdRef.current === conversationId;
      const known = conversationsRef.current.some((conversation) => conversation.id === conversationId);
      // Строка обновляется локально: сервер не рассылает список на каждое сообщение.
      setConversations((current) => {
        const index = current.findIndex((conversation) => conversation.id === conversationId);
        const target = current[index];
        if (!target) return current;
        const unreadCount = isOpen || message.authorId === user.id ? target.unreadCount : target.unreadCount + 1;
        const updated = { ...target, lastMessageAt: message.createdAt, unreadCount };
        return [updated, ...current.filter((_, position) => position !== index)];
      });

      if (!known) {
        // Закрытый диалог возвращается одним добором списка, не чаще раза в 2 с.
        const lastRefresh = conversationRefreshAtRef.current.get(conversationId) ?? 0;
        if (Date.now() - lastRefresh > 2_000) {
          conversationRefreshAtRef.current.set(conversationId, Date.now());
          void refreshConversations();
        }
        return;
      }
      if (isOpen) markConversationReadThroughApplied(conversationId);
    };

    bindChannelMessageEvents(socket, user.id, {
      canView: (channelId) => findChannel(channelId)?.canView === true,
      isSelected: (channelId) => selectedChannelIdRef.current === channelId,
      apply: applyMessage,
      remove: ({ scopeId, messageId, updatedSeq }) =>
        markHistoryMessageDeleted(messageId, { scopeKey: messageScopeKey("channel", scopeId), updatedSeq }),
      markRead: markReadThroughAppliedMessages,
      incrementUnread: (channelId) => setChannelUnreadCount(channelId, (unreadCountsRef.current[channelId] ?? 0) + 1),
      setPinned
    });
    bindConversationMessageEvents(socket, user.id, {
      apply: applyMessage,
      isSelected: (conversationId) => selectedConversationIdRef.current === conversationId,
      onCreated: onConversationMessage,
      remove: ({ scopeId, messageId, updatedSeq }) =>
        markHistoryMessageDeleted(messageId, { scopeKey: messageScopeKey("conversation", scopeId), updatedSeq }),
      replaceConversations: applyConversations,
      refreshConversations,
      clearUnread: (conversationId) => setConversations((current) => current.map((conversation) =>
        conversation.id === conversationId ? { ...conversation, unreadCount: 0 } : conversation)),
      recordTyping: (conversationId, userId, login) => {
        const entries = typingRef.current.get(conversationId) ?? new Map<string, { login: string; expiresAt: number }>();
        entries.set(userId, { login, expiresAt: Date.now() + TYPING_TTL_MS });
        typingRef.current.set(conversationId, entries);
        setTypingVersion((current) => current + 1);
      }
    });
    bindSessionEvents(socket, {
      ready: () => void recoverAfterReconnect(),
      setStatus: setRealtimeStatus,
      clearConnection: () => {
        channelSubscriptions.current.clear();
        // События набора не догоняются после переподключения.
        typingRef.current.clear();
        typingSentAtRef.current.clear();
        setTypingVersion((current) => current + 1);
      },
      requeueSending: queueSendingMessages,
      invalidate
    });
    socket.connect();

    return () => {
      active = false;
      socket.removeAllListeners();
      socket.disconnect();
      if (realtimeSocket.current === socket) {
        channelSubscriptions.current.clear();
        realtimeSocket.current = null;
      }
    };
  }, [screen, user, clearPrivateSession, subscribeToChannels, applyMessage, catchUp, refreshConversations, csrfToken, replaceUnreadCounts, setChannelUnreadCount, submitScopedMessage, updatePendingMessages, markReadThroughAppliedMessages, markConversationReadThroughApplied, applyConversations, forgetChannelHistory, markHistoryMessageDeleted, resetHistoryStatus, setPinned]);

  useEffect(() => {
    if (screen !== "authenticated" || !user) return;
    subscribeToChannels(channels);
  }, [channels, screen, user, subscribeToChannels]);

  useEffect(() => {
    let active = true;

    async function initialize(): Promise<void> {
      try {
        const token = await getCsrfToken();
        if (!active) return;
        setCsrfToken(token);

        try {
          const [currentUser, currentOrganization, channelData, conversationData] = await Promise.all([
            getCurrentUser(),
            getOrganization(),
            getChannels(),
            // Ошибка списка переписок не должна валить вход: раздел покажет
            // собственное состояние ошибки.
            listConversations().catch((): Conversation[] | null => null)
          ]);
          if (!active) return;
          const currentChannels = channelData.channels;
          setCollapsedCategoryIds(readInitialCollapsedCategories(currentUser.id));
          setUncategorizedCollapsed(readInitialUncategorizedCollapsed(currentUser.id));
          setDmCollapsed(readInitialDmCollapsed());
          setUser(currentUser);
          setOrganization(currentOrganization);
          channelsRef.current = currentChannels;
          replaceUnreadCounts(currentChannels, false);
          setChannels(currentChannels);
          setCategories(channelData.categories);
          setConversations(conversationData ?? []);
          setConversationsStatus(conversationData === null ? "error" : "ready");
          setSelectedChannelId(null);
          setIsAdministrator(currentUser.isOwner || currentUser.permissions.includes("ADMINISTRATOR"));
          setCanManageRoles(
            currentUser.permissions.includes("MANAGE_ROLES") || currentUser.permissions.includes("ADMINISTRATOR")
          );
          setScreen("authenticated");
        } catch (error) {
          if (!active) return;
          setUser(null);
          setOrganization(null);
          channelsRef.current = [];
          replaceUnreadCounts([], false);
          setChannels([]);
          setCategories([]);
          setSelectedChannelId(null);
          setIsAdministrator(false);
          setCanManageRoles(false);
          if (!(error instanceof ApiError && error.status === 401)) {
            setErrorMessage("Не удалось загрузить данные установки. Обновите страницу и попробуйте снова.");
          }
          setScreen("guest");
        }
      } catch {
        if (!active) return;
        setUser(null);
        setOrganization(null);
        channelsRef.current = [];
        replaceUnreadCounts([], false);
        setChannels([]);
        setCategories([]);
        setSelectedChannelId(null);
        setIsAdministrator(false);
        setCanManageRoles(false);
        setErrorMessage("Не удалось связаться с сервером. Проверьте подключение и повторите попытку.");
        setScreen("guest");
      }
    }

    void initialize();
    return () => {
      active = false;
    };
  }, [replaceUnreadCounts]);

  useEffect(() => {
    if (screen === "guest") loginInput.current?.focus();
  }, [screen]);

  function handleComposerSubmit(kind: MessageScope, content: string, token: string): void {
    const id = (kind === "channel" ? selectedChannelIdRef : selectedConversationIdRef).current;
    if (!id) return;
    setMessageInput("");
    const clientRequestId = createClientRequestId();
    if (realtimeStatus !== "connected" || !realtimeSocket.current?.connected) {
      const { prefix } = scopedMessageRequests[kind];
      updatePendingMessages((current) => [...current, {
        scopeKey: `${prefix}${id}`,
        content,
        clientRequestId,
        state: "queued"
      }]);
      return;
    }
    void submitScopedMessage(kind, id, content, clientRequestId, token);
  }

  const handleRetryMessage = useCallback((kind: MessageScope, clientRequestId: string) => {
    const message = pendingMessages.find((entry) => entry.clientRequestId === clientRequestId);
    if (!message || !csrfToken) return;
    if (realtimeStatus !== "connected" || !realtimeSocket.current?.connected) {
      setPendingDelivery(clientRequestId, { state: "queued" });
      return;
    }
    const { prefix } = scopedMessageRequests[kind];
    if (!message.scopeKey.startsWith(prefix)) return;
    const id = message.scopeKey.slice(prefix.length);
    if (kind === "conversation" && !id) return;
    void submitScopedMessage(kind, id, message.content, clientRequestId, csrfToken);
  }, [pendingMessages, csrfToken, realtimeStatus, submitScopedMessage, setPendingDelivery]);

  const handleEditMessage = useCallback(async (kind: MessageScope, messageId: string, content: string): Promise<boolean> => {
    const selectedId = kind === "channel" ? selectedChannelIdRef : selectedConversationIdRef;
    const id = selectedId.current;
    if (!id || !csrfToken) return false;
    setMessageError(null);
    try {
      const updated = await scopedMessageRequests[kind].edit(id, messageId, content, csrfToken);
      applyMessage(updated);
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        clearPrivateSession();
      } else if (selectedId.current === id) {
        setMessageError(error instanceof ApiError ? error.message : "Не удалось изменить сообщение.");
      }
      return false;
    }
  }, [csrfToken, applyMessage, clearPrivateSession]);

  const handleDeleteMessage = useCallback(async (kind: MessageScope, messageId: string) => {
    const selectedId = kind === "channel" ? selectedChannelIdRef : selectedConversationIdRef;
    const id = selectedId.current;
    if (!id || !csrfToken) return;
    setMessageError(null);
    try {
      await scopedMessageRequests[kind].remove(id, messageId, csrfToken);
      if (selectedId.current !== id) return;
      markHistoryMessageDeleted(messageId);
    } catch (error) {
      const apiError = error instanceof ApiError ? error : null;
      if (apiError?.status === 401) {
        clearPrivateSession();
        return;
      }
      if (selectedId.current !== id) return;
      if (kind === "conversation") {
        setMessageError("Не удалось удалить сообщение. Попробуйте ещё раз.");
        return;
      }
      setMessageError(apiError?.status === 403
        ? "Недостаточно прав для удаления этого сообщения"
        : apiError?.message ?? "Не удалось удалить сообщение.");
    }
  }, [csrfToken, clearPrivateSession, markHistoryMessageDeleted]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setErrorMessage(null);
    setSuccessMessage(null);
    if (!csrfToken) {
      setErrorMessage("Не удалось подготовить защищённый вход. Обновите страницу.");
      return;
    }

    setIsSubmitting(true);
    let credentialsAccepted = false;
    try {
      const nextCsrfToken = await login({ login: loginValue, password }, csrfToken);
      setCsrfToken(nextCsrfToken);
      credentialsAccepted = true;
      const [currentUser, currentOrganization, channelData] = await Promise.all([
        getCurrentUser(),
        getOrganization(),
        getChannels()
      ]);
      const currentChannels = channelData.channels;
      setCollapsedCategoryIds(readInitialCollapsedCategories(currentUser.id));
      setUncategorizedCollapsed(readInitialUncategorizedCollapsed(currentUser.id));
      setUser(currentUser);
      setOrganization(currentOrganization);
      channelsRef.current = currentChannels;
      replaceUnreadCounts(currentChannels, false);
      setChannels(currentChannels);
      setCategories(channelData.categories);
      setSelectedChannelId(null);
      setIsAdministrator(currentUser.isOwner || currentUser.permissions.includes("ADMINISTRATOR"));
      setCanManageRoles(
        currentUser.permissions.includes("MANAGE_ROLES") || currentUser.permissions.includes("ADMINISTRATOR")
      );
      setPassword("");
      setScreen("authenticated");
    } catch (error) {
      setUser(null);
      setOrganization(null);
      channelsRef.current = [];
      replaceUnreadCounts([], false);
      setChannels([]);
      setCategories([]);
      setSelectedChannelId(null);
      setIsAdministrator(false);
      setCanManageRoles(false);
      setScreen("guest");
      if (credentialsAccepted) {
        if (error instanceof ApiError && error.status === 401) {
          setErrorMessage("Сессия завершилась. Войдите снова.");
        } else {
          setErrorMessage("Не удалось загрузить данные установки. Обновите страницу и попробуйте снова.");
        }
      } else {
        setErrorMessage(guestError(error));
      }

      if (error instanceof ApiError && error.status === 403) {
        try {
          setCsrfToken(await getCsrfToken());
        } catch {
          setCsrfToken(null);
        }
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  // Меню строки диалога: единственный пункт «Закрыть переписку».
  function handleOpenDmMenu(conversationId: string, position: { x: number; y: number }): void {
    setDmMenu({
      conversationId,
      position: {
        x: Math.max(8, Math.min(position.x, window.innerWidth - 208)),
        y: Math.max(8, Math.min(position.y, window.innerHeight - 56))
      }
    });
  }

  function focusDmRow(conversationId: string): void {
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-dm-id="${conversationId}"] .dm-row-select`)?.focus();
    });
  }

  function closeDmMenuAndRestoreFocus(conversationId: string): void {
    setDmMenu(null);
    focusDmRow(conversationId);
  }

  // Закрытие выполняется сразу, без подтверждения: действие обратимо — новое
  // сообщение возвращает переписку в список.
  async function handleCloseConversation(conversationId: string): Promise<void> {
    setDmMenu(null);
    if (!csrfToken) return;
    try {
      await closeConversation(conversationId, csrfToken);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        clearPrivateSession();
        return;
      }
      setErrorMessage("Не удалось закрыть переписку. Попробуйте ещё раз.");
      return;
    }

    const previous = conversationsRef.current;
    const closedIndex = previous.findIndex((conversation) => conversation.id === conversationId);
    const remaining = previous.filter((conversation) => conversation.id !== conversationId);
    conversationsRef.current = remaining;
    setConversations(remaining);
    setDmAnnouncement("Переписка закрыта.");
    if (selectedConversationIdRef.current === conversationId) {
      setSelectedConversationId(null);
      selectedConversationIdRef.current = null;
      clearHistory();
      setHiddenConversationId(null);
      setHiddenConversationSnapshot(null);
    }

    // Фокус — на следующую строку, а если строк не осталось — на «Начать переписку».
    window.requestAnimationFrame(() => {
      const rows = [...document.querySelectorAll<HTMLElement>(".dm-section .dm-row-select")];
      const target = rows[Math.min(Math.max(closedIndex, 0), rows.length - 1)]
        ?? document.querySelector<HTMLElement>(".dm-section-add");
      target?.focus();
    });
  }

  async function handleLogout(): Promise<void> {
    if (!csrfToken) {
      clearPrivateSession();
      return;
    }
    setErrorMessage(null);
    setIsLoggingOut(true);
    try {
      await logout(csrfToken);
      clearPrivateSession();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        clearPrivateSession();
      } else {
        setErrorMessage("Не удалось завершить сеанс. Попробуйте ещё раз.");
      }
    } finally {
      setIsLoggingOut(false);
    }
  }

  function handlePasswordChanged(): void {
    clearPrivateSession();
    setSuccessMessage("Пароль изменён. Войдите снова с новым паролем.");
  }

  if (screen === "loading") {
    return (
      <main className="page-shell">
        <section className="status-card" aria-live="polite">
          <span className="brand-mark" aria-hidden="true">D</span>
          <p className="eyebrow">DECENTRACORD</p>
          <p role="status" className="loading-copy">Проверяем доступ…</p>
        </section>
      </main>
    );
  }

  if (screen !== "authenticated" || !user || !organization || !csrfToken) {
    return (
      <LoginScreen
        loginValue={loginValue}
        passwordValue={password}
        onLoginChange={setLoginValue}
        onPasswordChange={setPassword}
        onSubmit={(event) => void handleSubmit(event)}
        loginInputRef={loginInput}
        isSubmitting={isSubmitting}
        canSubmit={Boolean(csrfToken)}
        errorMessage={errorMessage}
        successMessage={successMessage}
      />
    );
  }

  return (
    <main ref={appShellRef} className="app-shell">
      <AppHeader
        organizationName={organization.name}
        logoUrl={organization.logoUrl ?? null}
        realtimeStatus={realtimeStatus}
        theme={theme}
        onToggleTheme={toggleTheme}
        onReconnect={() => realtimeSocket.current?.connect()}
        onOpenSettings={() => {
          setAccessDeniedChannelId(null);
          setSettingsOpen(true);
        }}
        onOpenChannels={() => openOverlayFromTrigger("channels")}
        onOpenMembers={() => openOverlayFromTrigger("members")}
        peopleSearch={(
          <PeopleSearch
            onSessionExpired={clearPrivateSession}
            onStartConversation={(person) => startConversationWith(person.id)}
            currentUserId={user.id}
          />
        )}
      />
      {errorMessage && <p className="form-error workspace-alert" role="alert">{errorMessage}</p>}

      <div className="workspace-grid">
        <WorkspaceChannelSidebar
          key={user.id}
          csrfToken={csrfToken}
          channelsRef={channelsRef}
          replaceChannels={(items) => {
            channelsRef.current = items;
            setChannels(items);
          }}
          setCategories={setCategories}
          preserveUnreadCounts={(items) => replaceUnreadCounts(items, true)}
          onSessionExpired={clearPrivateSession}
          propertiesTarget={channelPropertiesTarget}
          onPropertiesTargetChange={setChannelPropertiesTarget}
          channels={channels}
          categories={categories}
          dmSection={(
            <DmSection
              conversations={conversations}
              selectedConversationId={selectedConversationId}
              currentUserId={user.id}
              typingByConversation={typingByConversation}
              collapsed={dmCollapsed}
              onToggleCollapsed={toggleDmCollapsed}
              onCreate={() => setCreateDmOpen(true)}
              onSelect={(conversationId) => {
                selectConversation(conversationId);
                if (openOverlay === "channels") closeOverlay();
              }}
              onCloseRequest={handleOpenDmMenu}
              status={conversationsStatus}
              onRetry={() => void refreshConversations()}
            />
          )}
          canManageChannels={canManageChannels}
          onCategoryError={setErrorMessage}
          selectedChannelId={selectedChannelId}
          unreadCounts={unreadCounts}
          collapsedCategoryIds={collapsedCategoryIds}
          uncategorizedCollapsed={uncategorizedCollapsed}
          onToggleCategoryCollapsed={toggleCategoryCollapsed}
          onToggleUncategorizedCollapsed={toggleUncategorizedCollapsed}
          onSelect={selectChannel}
          onAccessDenied={(channelId) => {
            setAccessDeniedChannelId((current) => current === channelId ? null : channelId);
          }}
          sidebarWidth={sidebarWidth}
          collapsed={sidebarCollapsed}
          onToggleCollapsed={toggleSidebarCollapsed}
          onSidebarWidthChange={updateSidebarWidth}
          onSidebarWidthCommit={saveSidebarWidth}
          user={user}
          isOnline={realtimeStatus === "connected"}
          onLogout={() => void handleLogout()}
          isLoggingOut={isLoggingOut}
          isOverlayOpen={openOverlay === "channels"}
          onCloseOverlay={closeOverlay}
          {...(openOverlay === "channels" ? { dialogRef: setOverlayPanelElement } : {})}
        />
        {dmMenu && (
          <div
            ref={dmMenuRef}
            className="context-menu"
            role="menu"
            aria-label="Действия с перепиской"
            style={{ left: dmMenu.position.x, top: dmMenu.position.y }}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              closeDmMenuAndRestoreFocus(dmMenu.conversationId);
            }}
          >
            <button
              type="button"
              role="menuitem"
              className="context-menu-item"
              onClick={() => void handleCloseConversation(dmMenu.conversationId)}
            >
              <span>Закрыть переписку</span>
            </button>
          </div>
        )}
        <CreateDmDialog
          open={createDmOpen}
          onClose={() => setCreateDmOpen(false)}
          csrfToken={csrfToken}
          onCreated={(conversation) => {
            void refreshConversations();
            selectConversation(conversation.id);
          }}
          onSessionExpired={clearPrivateSession}
        />
        {selectedConversation?.kind === "group" && (
          <AddDmMembersDialog
            open={addDmMembersOpen}
            onClose={() => setAddDmMembersOpen(false)}
            conversation={selectedConversation}
            csrfToken={csrfToken}
            onAdded={(announcement) => {
              setDmMembersAnnouncement(announcement);
              void refreshConversations();
            }}
            onSessionExpired={clearPrivateSession}
          />
        )}
        <WorkspaceChatPane
          key={user.id}
          inactive={openOverlay !== null}
          currentUserId={user.id}
          scope={openConversation ? {
            kind: "conversation",
            conversation: openConversation,
            hidden: isConversationHidden,
            typingLabel: selectedConversationId ? typingLabelFor(selectedConversationId) : null,
            onType: () => { if (selectedConversationId) emitTyping(selectedConversationId); },
            onBack: () => {
              setSelectedConversationId(null);
              setHiddenConversationId(null);
              setHiddenConversationSnapshot(null);
              clearHistory();
            }
          } : selectedChannel ? {
            kind: "channel",
            channel: selectedChannel,
            revokedReason: revokedChannel?.id === selectedChannel.id ? revokedChannel.reason : null
          } : null}
          history={{
            messages,
            pending: pendingMessages,
            hasMoreHistory,
            historyLoadState,
            channelLastReadSeq: channelLastReadSeq ?? 0,
            loadChannelEarlier: loadEarlierMessages,
            loadConversationEarlier: (id, before) => loadHistoryPage("conversation", id, before)
          }}
          format={{ theme, timeZone, dayKey, formatMessageTime }}
          composer={{
            value: messageInput,
            onChange: setMessageInput,
            offline: realtimeStatus !== "connected",
            csrfToken,
            errorMessage: messageError
          }}
          actions={{
            retry: handleRetryMessage,
            edit: handleEditMessage,
            remove: handleDeleteMessage,
            submit: handleComposerSubmit
          }}
          channels={channels}
          categories={categories}
          conversations={conversations}
          selectedChannelId={selectedChannelIdRef}
          pins={channelPins}
          topicExpanded={expandedChannelTopicId === selectedChannelId}
          accessDenied={accessDeniedChannelId !== null}
          dmAnnouncements={[dmAnnouncement, dmMembersAnnouncement]}
          onToggleTopic={(id) => setExpandedChannelTopicId((current) => current === id ? null : id)}
          onOpenProperties={setChannelPropertiesTarget}
          onLeaveRevokedChannel={leaveRevokedChannel}
          onSessionExpired={clearPrivateSession}
          onSelectChannel={selectChannel}
          onForwarded={applyMessage}
        />
        <div
          ref={openOverlay === "members" ? setOverlayPanelElement : undefined}
          className={`members-panel${openOverlay === "members" ? " drawer drawer-right is-open" : ""}`}
          {...(openOverlay === "members"
            ? {
              role: "dialog",
              "aria-modal": true,
              "aria-label": openConversation ? "Участники переписки" : "Состав канала",
              tabIndex: -1
            }
            : {})}
        >
          {openConversation ? (
            <DmMembersPanel
              conversation={selectedConversation}
              currentUserId={user.id}
              csrfToken={csrfToken}
              onMembersChanged={() => void refreshConversations()}
              onOpenAddMembers={() => setAddDmMembersOpen(true)}
              onSessionExpired={clearPrivateSession}
            />
          ) : (
            <ChannelMembersPanel channelId={selectedChannelId} theme={theme} />
          )}
        </div>
        {openOverlay && <div className="overlay" aria-hidden="true" onClick={closeOverlay} />}
      </div>
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        section={settingsSection}
        onSectionChange={(section) => {
          setAccessDeniedChannelId(null);
          setSettingsSection(section);
        }}
        csrfToken={csrfToken}
        user={user}
        organizationName={organization.name}
        organizationLogoUrl={organization.logoUrl ?? null}
        onOrganizationSaved={(name) => {
          // Переименование не должно убирать логотип из шапки.
          setOrganization((current) => current ? { ...current, name } : { name, logoUrl: null });
        }}
        onLogoChanged={() => {
          void getOrganization().then(setOrganization).catch(() => undefined);
        }}
        onUserUpdated={setUser}
        canManageRoles={canManageRoles}
        canManageChannels={canManageChannels}
        isAdministrator={isAdministrator}
        onSessionExpired={clearPrivateSession}
        onPasswordChanged={handlePasswordChanged}
        theme={theme}
        onThemeChange={setTheme}
      />
    </main>
  );
}
