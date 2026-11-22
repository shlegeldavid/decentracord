import { Fragment, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { MessageView } from "../api.js";
import type { Theme } from "../lib/roles";
import { useMessageFeedScroll } from "../hooks/useMessageFeedScroll";
import { DayDivider, JumpToLatestBar, NewMessagesDivider } from "./FeedDecorations";
import { FeedEmptyState, FeedErrorState, FeedLoadingState } from "./MessageFeedStates";
import { MessageContextMenu } from "./MessageContextMenu";
import { MessageFeedRow, cancelMessageLongPress, type LongPressState } from "./MessageFeedRow";
import { PendingMessageList, type PendingMessage } from "./PendingMessageList";

export type { PendingMessage } from "./PendingMessageList";

interface MessageMenuState {
  message: MessageView;
  position: { x: number; y: number };
  canEdit: boolean;
  canDelete: boolean;
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
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [savingMessageId, setSavingMessageId] = useState<string | null>(null);
  const editLength = Array.from(editContent).length;
  const canSaveEdit = (message: MessageView) =>
    savingMessageId === null && editContent.trim().length > 0 && editLength <= 2000 && editContent !== message.content;
  const [contextMenu, setContextMenu] = useState<MessageMenuState | null>(null);
  const [copyAnnouncement, setCopyAnnouncement] = useState("");
  const longPressRef = useRef<LongPressState | null>(null);
  const uniqueMessages = Array.from(new Map(messages.map((message) => [message.id, message])).values())
    .sort((left, right) => left.seq - right.seq);
  // Без курсора прочтения «первым непрочитанным» не считается ничего: дефолт 0
  // пометил бы так самое первое сообщение любой переписки.
  const unreadFloor = lastReadSeq ?? Number.POSITIVE_INFINITY;
  const firstUnread = uniqueMessages.find((message) => message.seq > unreadFloor);

  const {
    scrollContainer,
    topSentinel,
    focusMessage,
    jumpToLatest,
    loadEarlier,
    isLoadingEarlier,
    paginationError,
    isAwayFromLatest
  } = useMessageFeedScroll({ channelId, hasMoreHistory, historyLoadState, isRevoked, onLoadEarlier, messages: uniqueMessages, pending });

  useEffect(() => {
    setEditingMessageId(null);
    setEditContent("");
    setContextMenu(null);
    cancelMessageLongPress(longPressRef);
  }, [channelId]);

  useEffect(() => () => cancelMessageLongPress(longPressRef), []);

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
    if (!canSaveEdit(message)) return;

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
              const isFirstUnread = firstUnread?.id === message.id;
              const edit = editingMessageId === message.id ? {
                content: editContent,
                length: editLength,
                saving: savingMessageId === message.id,
                canSave: canSaveEdit(message),
                onChange: setEditContent,
                onSave: (event: FormEvent<HTMLFormElement>) => void saveEdit(event, message),
                onCancel: () => cancelEditing(message.id)
              } : null;

              return (
                <Fragment key={message.id}>
                  {showDayDivider && <DayDivider label={formatDayDivider(message.createdAt, dayKey, timeZone)} />}
                  {isFirstUnread && (
                    <NewMessagesDivider onJump={() => {
                      if (onJumpToUnread) onJumpToUnread();
                      else focusMessage(message.id, true);
                    }} />
                  )}
                  <MessageFeedRow
                    message={message}
                    grouped={grouped}
                    firstUnread={isFirstUnread}
                    showDelivery={showDelivery && isOwnMessage && !message.deleted}
                    theme={theme}
                    timeZone={timeZone}
                    formatMessageTime={formatMessageTime}
                    edit={edit}
                    isRevoked={isRevoked}
                    longPressRef={longPressRef}
                    visibleChannelIds={visibleChannelIds}
                    onJumpToMessage={onJumpToMessage}
                    onOpenMenu={(position) => openContextMenu(message, position, canEditMessage, canDeleteMessage)}
                  />
                </Fragment>
              );
            })}
            <PendingMessageList messages={pending} onRetry={onRetry} />
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
