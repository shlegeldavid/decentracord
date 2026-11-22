import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  markConversationRead,
  markChannelRead,
  type Channel
} from "./api";
import { ChannelMembersPanel } from "./components/ChannelMembersPanel";
import { WorkspaceChannelSidebar } from "./components/WorkspaceChannelSidebar";
import { WorkspaceChatPane } from "./components/WorkspaceChatPane";
import { DmMembersPanel } from "./components/DmMembersPanel";
import { DmSection } from "./components/DmSection";
import { WorkspaceConversationControls } from "./components/WorkspaceConversationControls";
import { AppHeader } from "./components/AppHeader";
import { PeopleSearch } from "./components/PeopleSearch";
import { LoginScreen } from "./components/LoginScreen";
import { SettingsModal, type SettingsSection } from "./components/SettingsModal";
import { useChannelPins } from "./hooks/useChannelPins";
import { useConversationTyping } from "./hooks/useConversationTyping";
import { useConversationActions, useConversationState } from "./hooks/useWorkspaceConversations";
import { useMessageDelivery, useMessageQueue } from "./hooks/useMessageDelivery";
import { useMessageHistoryPaging, useMessageHistoryState } from "./hooks/useMessageHistory";
import { useTheme } from "./hooks/useTheme";
import { useTimezone } from "./hooks/useTimezone";
import { useWorkspaceChannels } from "./hooks/useWorkspaceChannels";
import { useWorkspaceConnection, useWorkspaceRealtime } from "./hooks/useWorkspaceRealtime";
import { useWorkspaceSession, type WorkspaceBootstrap } from "./hooks/useWorkspaceSession";
import { messageScopeKey } from "./lib/messageHistory";

type WorkspaceOverlay = "channels" | "members" | null;

const SIDEBAR_WIDTH_KEY = "decentracord:sidebar-width";
const SIDEBAR_COLLAPSED_KEY = "decentracord:sidebar-collapsed";
const COLLAPSED_CATEGORIES_KEY = "decentracord:sidebar-collapsed-categories";
const COLLAPSED_UNCATEGORIZED_KEY = "decentracord:sidebar-collapsed-uncategorized";
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

export function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("account");
  const [channelPropertiesTarget, setChannelPropertiesTarget] = useState<Channel | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(readInitialSidebarWidth);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readInitialSidebarCollapsed);
  const [collapsedCategoryIds, setCollapsedCategoryIds] = useState<Set<string>>(() => new Set());
  const [uncategorizedCollapsed, setUncategorizedCollapsed] = useState(false);
  const [openOverlay, setOpenOverlay] = useState<WorkspaceOverlay>(null);
  const [accessDeniedChannelId, setAccessDeniedChannelId] = useState<string | null>(null);
  const [expandedChannelTopicId, setExpandedChannelTopicId] = useState<string | null>(null);
  const history = useMessageHistoryState();
  const {
    messages, hasMoreHistory, historyLoadState, clearHistory, resetHistory, resetHistoryStatus,
    getMaxAppliedSeq, setSelectedScope, applyHistoryMessage, markHistoryMessageDeleted
  } = history;
  const channelState = useWorkspaceChannels(resetHistoryStatus);
  const {
    channels, categories, selectedChannel, selectedId: selectedChannelId, selectedIdRef: selectedChannelIdRef,
    revoked: revokedChannel, revokedRef: revokedChannelRef, unreadCounts, lastReadSeq: channelLastReadSeq,
    channelsRef, replaceChannels, setCategories, replaceChannelList,
    deselectChannel, resetChannelSession, leaveRevokedChannel, selectReadableChannel, confirmRead
  } = channelState;
  const messageQueue = useMessageQueue();
  const { pendingMessages, resetQueue } = messageQueue;
  const [messageInput, setMessageInput] = useState("");
  const [messageError, setMessageError] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const connection = useWorkspaceConnection();
  const { status: realtimeStatus, disconnect, reconnect, isConnected, sendTyping } = connection;
  const appShellElementRef = useRef<HTMLElement | null>(null);
  const overlayPanelRef = useRef<HTMLElement | null>(null);
  const overlayReturnFocusRef = useRef<HTMLElement | null>(null);
  const appShellRef = useCallback((element: HTMLElement | null) => {
    appShellElementRef.current = element;
    element?.style.setProperty("--sidebar-width", sidebarCollapsed ? "48px" : `${sidebarWidth}px`);
  }, [sidebarCollapsed, sidebarWidth]);
  const leaveChannelForConversation = useCallback(() => {
    deselectChannel();
    setAccessDeniedChannelId(null);
    setExpandedChannelTopicId(null);
  }, [deselectChannel]);
  const conversationState = useConversationState({ leaveChannel: leaveChannelForConversation, clearHistory });
  const {
    conversations, selectedId: selectedConversationId, selectedIdRef: selectedConversationIdRef,
    selectedConversation, openConversation, isConversationHidden, loadConversations, resetConversations,
    selectConversation, deselectConversation, closeOpenConversation
  } = conversationState;
  const typing = useConversationTyping(sendTyping);
  const { emitTyping, clearTyping, typingByConversation, typingLabelFor } = typing;

  const applyWorkspaceBootstrap = useCallback((data: WorkspaceBootstrap | null) => {
    if (data) {
      setCollapsedCategoryIds(readInitialCollapsedCategories(data.user.id));
      setUncategorizedCollapsed(readInitialUncategorizedCollapsed(data.user.id));
      if (data.conversations !== undefined) loadConversations(data.conversations);
    }
    replaceChannelList(data?.channelData ?? { channels: [], categories: [] }, "replace");
    deselectChannel();
  }, [deselectChannel, loadConversations, replaceChannelList]);

  const clearWorkspace = useCallback(() => {
    disconnect();
    setAccessDeniedChannelId(null);
    setExpandedChannelTopicId(null);
    resetChannelSession();
    resetHistory();
    resetQueue();
    resetConversations();
    // На экране входа заголовок вкладки не показывает непрочитанные сообщения.
    document.title = "Decentracord";
    setMessageInput("");
    setMessageError(null);
    clearTyping();
    setSettingsOpen(false);
    setSettingsSection("account");
    setOpenOverlay(null);
    setChannelPropertiesTarget(null);
  }, [clearTyping, disconnect, resetChannelSession, resetConversations, resetHistory, resetQueue]);

  const {
    screen, user, organization, csrfToken, loginValue, setLoginValue, submitLogin, handleLogout,
    handlePasswordChanged, isSubmitting, isLoggingOut, successMessage, clearPrivateSession,
    updateUser, updateOrganizationName, refreshOrganization, isAdministrator, canManageRoles, canManageChannels
  } = useWorkspaceSession({
    applyBootstrap: applyWorkspaceBootstrap,
    clearWorkspace,
    onError: setErrorMessage
  });
  const { theme, setTheme, toggleTheme } = useTheme(user, csrfToken);
  const { timeZone, dayKey, formatMessageTime } = useTimezone(user);

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

  const clearComposer = useCallback(() => setMessageInput(""), []);
  const delivery = useMessageDelivery({
    queue: messageQueue,
    currentUserId: user?.id,
    csrfToken,
    realtimeStatus,
    isSocketConnected: isConnected,
    channelIdRef: selectedChannelIdRef,
    conversationIdRef: selectedConversationIdRef,
    channelsRef,
    applyHistoryMessage,
    markHistoryMessageDeleted,
    clearComposer,
    onError: setMessageError,
    onSessionExpired: clearPrivateSession
  });
  const { applyMessage, actions: messageActions } = delivery;

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

  useEffect(() => {
    setSelectedScope(selectedConversationId
      ? messageScopeKey("conversation", selectedConversationId)
      : selectedChannelId ? messageScopeKey("channel", selectedChannelId) : null);
  }, [selectedChannelId, selectedConversationId, setSelectedScope]);

  const channelPins = useChannelPins({
    channelId: selectedChannelId,
    selectedChannelId: selectedChannelIdRef,
    csrfToken,
    onError: setMessageError,
    onSessionExpired: clearPrivateSession
  });
  const { setPinned } = channelPins;

  const markReadThroughAppliedMessages = useCallback((channelId: string) => {
    if (!csrfToken) return;
    const seq = getMaxAppliedSeq(messageScopeKey("channel", channelId));
    void markChannelRead(channelId, seq, csrfToken).then(confirmRead(channelId, seq)).catch((error: unknown) => {
      if (error instanceof ApiError && error.status === 401) clearPrivateSession();
    });
  }, [confirmRead, csrfToken, clearPrivateSession, getMaxAppliedSeq]);

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

  const conversationActions = useConversationActions({
    state: conversationState,
    csrfToken,
    userId: user?.id,
    markRead: markConversationReadThroughApplied,
    onError: setErrorMessage,
    onSessionExpired: clearPrivateSession
  });
  const { refreshConversations, startConversationWith } = conversationActions;

  const selectChannel = useCallback((channelId: string) => {
    if (!selectReadableChannel(channelId)) return;
    setAccessDeniedChannelId(null);
    setExpandedChannelTopicId(null);
    deselectConversation();
    markReadThroughAppliedMessages(channelId);
  }, [deselectConversation, markReadThroughAppliedMessages, selectReadableChannel]);

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

  useWorkspaceRealtime({
    user,
    connection,
    channels: channelState,
    conversations: conversationState,
    conversationActions,
    typing,
    delivery,
    history,
    catchUp,
    markChannelRead: markReadThroughAppliedMessages,
    setPinned,
    onSessionExpired: clearPrivateSession,
    onRefreshError: setErrorMessage,
    onHistoryError: setMessageError
  });

  if (screen !== "authenticated" || !user || !organization || !csrfToken) {
    return (
      <LoginScreen
        loading={screen === "loading"}
        loginValue={loginValue}
        onLoginChange={setLoginValue}
        onSubmit={submitLogin}
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
        onReconnect={reconnect}
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
          replaceChannels={replaceChannels}
          replaceChannelList={replaceChannelList}
          setCategories={setCategories}
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
              collapsed={conversationState.collapsed}
              onToggleCollapsed={conversationState.toggleCollapsed}
              onCreate={() => conversationState.setCreateOpen(true)}
              onSelect={(conversationId) => {
                selectConversation(conversationId);
                if (openOverlay === "channels") closeOverlay();
              }}
              onCloseRequest={conversationState.openMenu}
              status={conversationState.status}
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
        <WorkspaceConversationControls
          state={conversationState}
          actions={conversationActions}
          csrfToken={csrfToken}
          onSessionExpired={clearPrivateSession}
        />
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
            onBack: closeOpenConversation
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
          actions={messageActions}
          channels={channels}
          categories={categories}
          conversations={conversations}
          selectedChannelId={selectedChannelIdRef}
          pins={channelPins}
          topicExpanded={expandedChannelTopicId === selectedChannelId}
          accessDenied={accessDeniedChannelId !== null}
          dmAnnouncements={[conversationState.announcement, conversationState.membersAnnouncement]}
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
              onOpenAddMembers={() => conversationState.setAddMembersOpen(true)}
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
        onOrganizationSaved={updateOrganizationName}
        onLogoChanged={refreshOrganization}
        onUserUpdated={updateUser}
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
