import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FormEvent, PointerEvent } from "react";
import type { MessageView } from "../api.js";
import { getMessages } from "../api.js";
import { avatarColor, initials } from "../lib/avatar";
import { roleColorForTheme, type Theme } from "../lib/roles";
import { MessageMarkdown } from "../markdown/MessageMarkdown";
import { ClockIcon, CheckIcon } from "./icons";
import { DayDivider, JumpToLatestBar, NewMessagesDivider } from "./FeedDecorations";
import { FeedEmptyState, FeedErrorState, FeedLoadingState } from "./MessageFeedStates";
import { MessageContextMenu } from "./MessageContextMenu";

export function getEarlierMessagePage(channelId: string, before: number | undefined) {
  return before === undefined
    ? getMessages(channelId, { limit: 50 })
    : getMessages(channelId, { before, limit: 50 });
}

// Область ожидающего сообщения: `channel:<id>` или `conversation:<id>` — тот же
// ключ, которым App.tsx различает курсоры и карты сообщений.
export interface PendingMessage {
  clientRequestId: string;
  scopeKey: string;
  content: string;
  state: "sending" | "failed" | "queued" | "rejected";
  reason?: string;
}

interface MessageMenuState {
  message: MessageView;
  position: { x: number; y: number };
  canEdit: boolean;
  canDelete: boolean;
}

interface LongPressState {
  timer: number;
  pointerId: number;
  x: number;
  y: number;
}

interface MessageFeedProps {
  channelId: string;
  hasMoreHistory: boolean;
  historyLoadState: "loading" | "ready" | "error";
  // В переписке проп не передаётся: отметки прочтения появятся в следующем плане,
  // а разделитель «Новые сообщения» без курсора не рендерится.
  lastReadSeq?: number;
  isRevoked?: boolean;
  onLoadEarlier: (before: number | undefined) => Promise<void>;
  messages: MessageView[];
  pending: PendingMessage[];
  currentUserId: string;
  canManageMessages: boolean;
  theme: Theme;
  timeZone: string;
  dayKey: (value: Date | string | number) => string;
  formatMessageTime: (value: Date | string | number) => string;
  onJumpToUnread?: () => void;
  onRetry: (clientRequestId: string) => void;
  onEdit: (messageId: string, content: string) => Promise<boolean>;
  onDelete: (messageId: string) => void;
  canEdit: (message: MessageView) => boolean;
  // Необязательное переопределение условия удаления: переписка запрещает
  // удаление до плана 06, каналы поведение не меняют.
  canDelete?: (message: MessageView) => boolean;
  // Галочка «Доставлено на сервер» — только у своих сообщений переписки.
  showDelivery?: boolean;
  // Пустые состояния переписки: канальные строки остаются по умолчанию.
  emptyState?: { heading: string; body: string };
  canSeeReaders?: (message: MessageView) => boolean;
  onOpenReaders?: (message: MessageView) => void;
  canPin?: boolean;
  canUnpin?: (message: MessageView) => boolean;
  isPinned?: (messageId: string) => boolean;
  onPin?: (message: MessageView) => void;
  onUnpin?: (message: MessageView) => void;
  onForward?: (message: MessageView) => void;
  visibleChannelIds?: Set<string>;
  onJumpToMessage?: (messageId: string, channelId?: string) => boolean;
}

function formatMessageDateTime(createdAt: string, timeZone: string): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return createdAt;
  try {
    return new Intl.DateTimeFormat("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone: "UTC"
    }).format(date);
  }
}

function formatDayDivider(
  createdAt: string,
  dayKey: MessageFeedProps["dayKey"],
  timeZone: string
): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return createdAt;

  const today = dayKey(new Date());
  const yesterdayDate = new Date();
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const key = dayKey(date);
  if (key === today) return "Сегодня";
  if (key === dayKey(yesterdayDate)) return "Вчера";
  try {
    return new Intl.DateTimeFormat("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      timeZone
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      timeZone: "UTC"
    }).format(date);
  }
}

function continuesAuthorGroup(
  previous: MessageView | undefined,
  current: MessageView,
  dayKey: MessageFeedProps["dayKey"]
): boolean {
  if (!previous || previous.authorId !== current.authorId) return false;
  const previousDate = new Date(previous.createdAt);
  const currentDate = new Date(current.createdAt);
  const elapsed = currentDate.getTime() - previousDate.getTime();
  return dayKey(previousDate) === dayKey(currentDate) && elapsed >= 0 && elapsed < 5 * 60 * 1000;
}

export function MessageFeed({
  channelId,
  hasMoreHistory,
  historyLoadState,
  lastReadSeq,
  isRevoked = false,
  onLoadEarlier,
  messages,
  pending,
  currentUserId,
  canManageMessages,
  theme,
  timeZone,
  dayKey,
  formatMessageTime,
  onJumpToUnread,
  onRetry,
  onEdit,
  onDelete,
  canEdit,
  canDelete,
  showDelivery = false,
  emptyState,
  canSeeReaders,
  onOpenReaders,
  canPin,
  canUnpin,
  isPinned,
  onPin,
  onUnpin,
  onForward,
  visibleChannelIds,
  onJumpToMessage
}: MessageFeedProps) {
  const [isLoadingEarlier, setIsLoadingEarlier] = useState(false);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [savingMessageId, setSavingMessageId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<MessageMenuState | null>(null);
  const [copyAnnouncement, setCopyAnnouncement] = useState("");
  const [paginationError, setPaginationError] = useState(false);
  const [isAwayFromLatest, setIsAwayFromLatest] = useState(false);
  const scrollContainer = useRef<HTMLDivElement>(null);
  const topSentinel = useRef<HTMLDivElement>(null);
  const currentChannelId = useRef(channelId);
  const positionedChannelId = useRef<string | null>(null);
  const wasAtLatestRef = useRef(false);
  const longPressRef = useRef<LongPressState | null>(null);
  const uniqueMessages = Array.from(new Map(messages.map((message) => [message.id, message])).values())
    .sort((left, right) => left.seq - right.seq);
  const latestMessage = uniqueMessages.at(-1);
  const pendingRenderKey = JSON.stringify(pending.map(({ clientRequestId, content, reason, state }) => ({
    clientRequestId,
    content,
    reason,
    state
  })));
  // Без курсора прочтения «первым непрочитанным» не считается ничего: дефолт 0
  // пометил бы так самое первое сообщение любой переписки.
  const unreadFloor = lastReadSeq ?? Number.POSITIVE_INFINITY;
  const firstUnread = uniqueMessages.find((message) => message.seq > unreadFloor);
  const firstMessageSeq = uniqueMessages[0]?.seq;

  function motionBehavior(): ScrollBehavior {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
  }

  const updateLatestDistance = useCallback(() => {
    const container = scrollContainer.current;
    if (!container) return;
    const distanceFromLatest = Math.max(0, container.scrollHeight - container.scrollTop - container.clientHeight);
    const isAway = distanceFromLatest > 200;
    wasAtLatestRef.current = distanceFromLatest <= 2;
    setIsAwayFromLatest(isAway);
  }, []);

  function focusMessage(messageId: string, scrollToStart = false): void {
    const article = Array.from(document.querySelectorAll<HTMLElement>("[data-message-id]"))
      .find((element) => element.dataset.messageId === messageId);
    if (scrollToStart) article?.scrollIntoView({ behavior: motionBehavior(), block: "start" });
    article?.focus({ preventScroll: true });
  }

  function jumpToLatest(): void {
    const container = scrollContainer.current;
    if (!container) return;
    container.scrollTo({ top: container.scrollHeight, behavior: motionBehavior() });
    window.requestAnimationFrame(updateLatestDistance);
  }

  function cancelLongPress(pointerId?: number): void {
    const press = longPressRef.current;
    if (!press || (pointerId !== undefined && press.pointerId !== pointerId)) return;
    window.clearTimeout(press.timer);
    longPressRef.current = null;
  }

  useEffect(() => {
    currentChannelId.current = channelId;
    setIsLoadingEarlier(false);
    setPaginationError(false);
    setIsAwayFromLatest(false);
    positionedChannelId.current = null;
    setEditingMessageId(null);
    setEditContent("");
    setContextMenu(null);
    cancelLongPress();
  }, [channelId]);

  useEffect(() => () => cancelLongPress(), []);

  const loadEarlier = useCallback(async () => {
    if (!hasMoreHistory || isLoadingEarlier || isRevoked) return;
    const container = scrollContainer.current;
    const previousHeight = container?.scrollHeight ?? 0;
    const previousTop = container?.scrollTop ?? 0;
    const channelAtStart = channelId;
    const before = firstMessageSeq;

    setPaginationError(false);
    setIsLoadingEarlier(true);
    try {
      await onLoadEarlier(before);
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => resolve());
      }));
      if (container && currentChannelId.current === channelAtStart && !isRevoked) {
        container.scrollTop = previousTop + (container.scrollHeight - previousHeight);
      }
    } catch {
      if (currentChannelId.current === channelAtStart) setPaginationError(true);
    } finally {
      setIsLoadingEarlier(false);
    }
  }, [channelId, firstMessageSeq, hasMoreHistory, isLoadingEarlier, isRevoked, onLoadEarlier]);

  useLayoutEffect(() => {
    const container = scrollContainer.current;
    if (!container || historyLoadState !== "ready" || (uniqueMessages.length === 0 && pending.length === 0)) return;
    if (positionedChannelId.current !== channelId || wasAtLatestRef.current) {
      container.scrollTop = container.scrollHeight;
    }
    positionedChannelId.current = channelId;
    updateLatestDistance();
  }, [
    channelId,
    historyLoadState,
    latestMessage?.content,
    latestMessage?.id,
    latestMessage?.seq,
    pendingRenderKey,
    uniqueMessages.length,
    updateLatestDistance
  ]);

  useEffect(() => {
    const sentinel = topSentinel.current;
    const container = scrollContainer.current;
    if (!sentinel || !container || firstMessageSeq === undefined || !hasMoreHistory || isRevoked || paginationError) return;
    const observer = new IntersectionObserver((entries) => {
      if (positionedChannelId.current === channelId && entries.some((entry) => entry.isIntersecting)) {
        void loadEarlier();
      }
    }, { root: container, rootMargin: "120px 0px 0px 0px", threshold: 0 });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [channelId, firstMessageSeq, hasMoreHistory, isRevoked, loadEarlier, paginationError]);

  useEffect(() => {
    const container = scrollContainer.current;
    if (!container) return;
    container.addEventListener("scroll", updateLatestDistance, { passive: true });
    updateLatestDistance();
    return () => container.removeEventListener("scroll", updateLatestDistance);
  }, [channelId, updateLatestDistance]);

  useEffect(() => {
    if (isRevoked) setContextMenu(null);
  }, [isRevoked]);

  function beginEditing(message: MessageView): void {
    setEditingMessageId(message.id);
    setEditContent(message.content);
  }

  function cancelEditing(messageId: string): void {
    if (savingMessageId === messageId) return;
    setEditingMessageId(null);
    setEditContent("");
    window.requestAnimationFrame(() => focusMessage(messageId));
  }

  async function saveEdit(event: FormEvent<HTMLFormElement>, message: MessageView): Promise<void> {
    event.preventDefault();
    const length = Array.from(editContent).length;
    if (
      savingMessageId !== null ||
      editContent.trim().length === 0 ||
      length > 2000 ||
      editContent === message.content
    ) {
      return;
    }

    setSavingMessageId(message.id);
    try {
      if (await onEdit(message.id, editContent)) {
        setEditingMessageId((current) => current === message.id ? null : current);
        setEditContent("");
        window.requestAnimationFrame(() => focusMessage(message.id));
      }
    } finally {
      setSavingMessageId((current) => current === message.id ? null : current);
    }
  }

  function openContextMenu(
    message: MessageView,
    position: { x: number; y: number },
    canEditMessage: boolean,
    canDeleteMessage: boolean
  ): void {
    if (isRevoked) return;
    setContextMenu({
      message,
      position,
      canEdit: canEditMessage,
      canDelete: canDeleteMessage
    });
  }

  function announceCopiedText(): void {
    setCopyAnnouncement("");
    window.requestAnimationFrame(() => setCopyAnnouncement("Текст сообщения скопирован"));
  }

  function announceCopyError(): void {
    setCopyAnnouncement("");
    window.requestAnimationFrame(() => setCopyAnnouncement("Не удалось скопировать текст. Проверьте разрешение буфера обмена и повторите попытку."));
  }

  return (
    <>
      <div className="message-feed" ref={scrollContainer} role="log" tabIndex={0} aria-live="polite" aria-busy={historyLoadState === "loading" || isLoadingEarlier}>
        {hasMoreHistory && !isRevoked && <div className="feed-sentinel" ref={topSentinel} aria-hidden="true" />}
        {(isLoadingEarlier || paginationError) && uniqueMessages.length > 0 && (
          <div className="feed-pagination-overlay">
            {paginationError ? (
              <FeedErrorState onRetry={() => void loadEarlier()} />
            ) : (
              <FeedLoadingState message="Загружаем более ранние сообщения…" />
            )}
          </div>
        )}
        {historyLoadState === "loading" && uniqueMessages.length === 0 && <FeedLoadingState />}
        {historyLoadState === "error" && uniqueMessages.length === 0 && (
          <FeedErrorState onRetry={() => void onLoadEarlier(undefined).catch(() => undefined)} />
        )}
        {historyLoadState === "ready" && uniqueMessages.length === 0 && pending.length === 0 && (
          emptyState ? <FeedEmptyState heading={emptyState.heading} body={emptyState.body} /> : <FeedEmptyState />
        )}
        {(uniqueMessages.length > 0 || pending.length > 0) && (
          <>
            {uniqueMessages.map((message, index) => {
              const isOwnMessage = message.authorId === currentUserId;
              const previous = uniqueMessages[index - 1];
              const grouped = continuesAuthorGroup(previous, message, dayKey);
              const showDayDivider = !previous || dayKey(previous.createdAt) !== dayKey(message.createdAt);
              const canEditMessage = !isRevoked && !message.deleted && isOwnMessage && canEdit(message);
              const canDeleteMessage = !isRevoked && !message.deleted &&
                (canDelete ? canDelete(message) : (isOwnMessage || canManageMessages));
              const roleColor = message.authorRoles.find((role) => role.color !== null)?.color ?? null;
              // Ссылка на оригинал строится только если оригинал жив, он из
              // канала и канал-источник виден участнику. У оригинала из
              // переписки адреса нет — логин выводится текстом.
              const forwardedFrom = message.forwardedFrom;
              const forwardedChannelId = forwardedFrom?.channelId ?? null;
              const canLinkToOriginal = forwardedFrom !== null &&
                forwardedChannelId !== null &&
                forwardedFrom.conversationId === null &&
                forwardedFrom.originalDeleted === false &&
                visibleChannelIds !== undefined &&
                visibleChannelIds.has(forwardedChannelId);

              return (
                <Fragment key={message.id}>
                  {showDayDivider && <DayDivider label={formatDayDivider(message.createdAt, dayKey, timeZone)} />}
                  {firstUnread?.id === message.id && (
                    <NewMessagesDivider onJump={() => {
                      if (onJumpToUnread) onJumpToUnread();
                      else focusMessage(message.id, true);
                    }} />
                  )}
                  <article
                    className={`${grouped ? "message-row message-row-grouped" : "message-row"}${message.deleted ? " message-row-deleted" : ""}`}
                    data-message-id={message.id}
                    data-first-unread={firstUnread?.id === message.id || undefined}
                    aria-label={grouped ? `${message.authorLogin}: ${formatMessageDateTime(message.createdAt, timeZone)}` : undefined}
                    tabIndex={0}
                    onKeyDown={(event) => {
                      if (event.target !== event.currentTarget || isRevoked || editingMessageId === message.id) return;
                      if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
                      event.preventDefault();
                      const { left, top, height } = event.currentTarget.getBoundingClientRect();
                      openContextMenu(message, { x: left + 16, y: top + Math.min(height, 32) }, canEditMessage, canDeleteMessage);
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      cancelLongPress();
                      if (isRevoked) return;
                      if (editingMessageId === message.id) return;
                      openContextMenu(message, { x: event.clientX, y: event.clientY }, canEditMessage, canDeleteMessage);
                    }}
                    onPointerDown={(event: PointerEvent<HTMLElement>) => {
                      if (isRevoked || event.pointerType !== "touch" || editingMessageId === message.id) return;
                      cancelLongPress();
                      const x = event.clientX;
                      const y = event.clientY;
                      const timer = window.setTimeout(() => {
                        if (longPressRef.current?.timer !== timer) return;
                        longPressRef.current = null;
                        openContextMenu(message, { x, y }, canEditMessage, canDeleteMessage);
                      }, 500);
                      longPressRef.current = {
                        timer,
                        pointerId: event.pointerId,
                        x,
                        y
                      };
                    }}
                    onPointerMove={(event: PointerEvent<HTMLElement>) => {
                      const press = longPressRef.current;
                      if (!press || press.pointerId !== event.pointerId) return;
                      if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > 10) cancelLongPress(event.pointerId);
                    }}
                    onPointerUp={(event: PointerEvent<HTMLElement>) => cancelLongPress(event.pointerId)}
                    onPointerCancel={(event: PointerEvent<HTMLElement>) => cancelLongPress(event.pointerId)}
                  >
                    {grouped ? (
                      <span className="message-avatar-spacer" aria-hidden="true" />
                    ) : (
                      <div
                        className="message-avatar"
                        ref={(element) => element?.style.setProperty("background", avatarColor(message.authorLogin))}
                        aria-hidden="true"
                      >
                        {initials(message.authorLogin)}
                      </div>
                    )}
                    <div className="message-content">
                      {editingMessageId !== message.id && (
                        <header className="message-header">
                          {!grouped && (
                            <span
                              className="message-author"
                              ref={(element) => {
                                if (!element) return;
                                const color = roleColorForTheme(roleColor, theme);
                                if (color) element.style.setProperty("--role-color", color);
                                else element.style.removeProperty("--role-color");
                              }}
                            >
                              {message.authorLogin}
                            </span>
                          )}
                          <time
                            className="message-time"
                            dateTime={message.createdAt}
                            title={formatMessageDateTime(message.createdAt, timeZone)}
                          >
                            {formatMessageTime(message.createdAt)}
                          </time>
                          {showDelivery && isOwnMessage && !message.deleted && (
                            <span
                              className="message-delivery"
                              role="img"
                              aria-label="Доставлено на сервер"
                              title="Доставлено на сервер"
                            >
                              <CheckIcon size={16} />
                            </span>
                          )}
                          {message.editedAt !== null && <span className="message-edited">изменено</span>}
                        </header>
                      )}
                      {editingMessageId === message.id ? (
                        <form className="message-edit-form" onSubmit={(event) => void saveEdit(event, message)}>
                          <textarea
                            aria-label="Изменить сообщение"
                            autoFocus
                            rows={3}
                            value={editContent}
                            onChange={(event) => setEditContent(event.currentTarget.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Escape" && savingMessageId !== message.id) cancelEditing(message.id);
                            }}
                          />
                          <div className="message-edit-footer">
                            <span className={Array.from(editContent).length > 2000 ? "message-counter message-error" : "message-counter"}>
                              {Array.from(editContent).length}/2000
                            </span>
                            <button
                              type="submit"
                              disabled={savingMessageId !== null || editContent.trim().length === 0 ||
                                Array.from(editContent).length > 2000 || editContent === message.content}
                              aria-busy={savingMessageId === message.id}
                            >
                              {savingMessageId === message.id ? "Сохраняем…" : "Сохранить"}
                            </button>
                            <button type="button" disabled={savingMessageId === message.id} onClick={() => cancelEditing(message.id)}>
                              Отмена
                            </button>
                          </div>
                        </form>
                      ) : message.deleted ? (
                        <p className="message-body message-deleted">Сообщение удалено</p>
                      ) : forwardedFrom ? (
                        <div className="forwarded-block">
                          <p className="forwarded-label">
                            {"Переслано от "}
                            {canLinkToOriginal ? (
                              <button
                                type="button"
                                className="forwarded-author"
                                onClick={() => {
                                  if (forwardedChannelId !== null) {
                                    onJumpToMessage?.(forwardedFrom.messageId, forwardedChannelId);
                                  }
                                }}
                              >
                                {forwardedFrom.authorLogin}
                              </button>
                            ) : (
                              <span className="forwarded-author">{forwardedFrom.authorLogin}</span>
                            )}
                          </p>
                          <MessageMarkdown content={message.content} mentions={[]} />
                        </div>
                      ) : (
                        <MessageMarkdown content={message.content} mentions={message.mentions.map((entry) => entry.login)} />
                      )}
                    </div>
                  </article>
                </Fragment>
              );
            })}
            {pending.length > 0 && (
              <div className="message-pending-list" aria-live="polite">
                {pending.map((message) => (
                  <article
                    className={`message-row message-pending ${message.state}`}
                    data-client-request-id={message.clientRequestId}
                    key={message.clientRequestId}
                  >
                    <span className="message-avatar-spacer" aria-hidden="true" />
                    <div className="message-content">
                      <header className="message-header">
                        <span className="message-author">Вы</span>
                      </header>
                      <MessageMarkdown content={message.content} mentions={[]} />
                      <div className="message-meta">
                        {message.state === "sending" && (
                          <span className="message-clock" aria-label="Отправляется"><ClockIcon size={16} /></span>
                        )}
                        {message.state === "failed" && <span className="message-error">Не отправлено</span>}
                        {message.state === "queued" && <span className="message-queued">В очереди</span>}
                        {message.state === "rejected" && (
                          <span className="message-error">Отправка отклонена: {message.reason || "Отправка отклонена."}</span>
                        )}
                        {message.state === "failed" && (
                          <button type="button" className="message-action" onClick={() => onRetry(message.clientRequestId)}>
                            Повторить
                          </button>
                        )}
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </>
        )}
      </div>
      {uniqueMessages.length > 0 && isAwayFromLatest && !isRevoked && (
        <JumpToLatestBar onJump={jumpToLatest} />
      )}
      <p className="visually-hidden" aria-live="polite">{copyAnnouncement}</p>
      {contextMenu && (
        <MessageContextMenu
          messageId={contextMenu.message.id}
          authorLogin={contextMenu.message.authorLogin}
          messageTime={formatMessageTime(contextMenu.message.createdAt)}
          content={contextMenu.message.deleted ? "Сообщение удалено" : contextMenu.message.content}
          position={contextMenu.position}
          canEdit={contextMenu.canEdit && savingMessageId === null}
          canDelete={contextMenu.canDelete}
          canSeeReaders={canSeeReaders ? canSeeReaders(contextMenu.message) : false}
          canPin={Boolean(canPin) && !isPinned?.(contextMenu.message.id)}
          canUnpin={Boolean(canUnpin?.(contextMenu.message)) && Boolean(isPinned?.(contextMenu.message.id))}
          isPinned={Boolean(isPinned?.(contextMenu.message.id))}
          canForward={!isRevoked && !contextMenu.message.deleted}
          onCopy={announceCopiedText}
          onCopyError={announceCopyError}
          onEdit={() => beginEditing(contextMenu.message)}
          onDelete={() => onDelete(contextMenu.message.id)}
          onPin={() => onPin?.(contextMenu.message)}
          onUnpin={() => onUnpin?.(contextMenu.message)}
          onForward={() => onForward?.(contextMenu.message)}
          onOpenReaders={() => onOpenReaders?.(contextMenu.message)}
          onClose={() => setContextMenu(null)}
        />
      )}
    </>
  );
}
