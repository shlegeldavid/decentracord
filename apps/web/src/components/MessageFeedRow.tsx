import type { FormEventHandler, RefObject } from "react";
import type { MessageView } from "../api.js";
import { avatarColor, initials } from "../lib/avatar";
import { roleColorForTheme, type Theme } from "../lib/roles";
import { MessageMarkdown } from "../markdown/MessageMarkdown";
import { CheckIcon } from "./icons";

export interface LongPressState {
  timer: number;
  pointerId: number;
  x: number;
  y: number;
}

export function cancelMessageLongPress(ref: RefObject<LongPressState | null>, pointerId?: number): void {
  const press = ref.current;
  if (!press || (pointerId !== undefined && press.pointerId !== pointerId)) return;
  window.clearTimeout(press.timer);
  ref.current = null;
}

interface MessageEditState {
  content: string;
  length: number;
  saving: boolean;
  canSave: boolean;
  onChange: (content: string) => void;
  onSave: FormEventHandler<HTMLFormElement>;
  onCancel: () => void;
}

interface MessageFeedRowProps {
  message: MessageView;
  grouped: boolean;
  firstUnread: boolean;
  showDelivery: boolean;
  theme: Theme;
  timeZone: string;
  formatMessageTime: (value: Date | string | number) => string;
  edit: MessageEditState | null;
  isRevoked: boolean;
  longPressRef: RefObject<LongPressState | null>;
  onOpenMenu: (position: { x: number; y: number }) => void;
  visibleChannelIds: Set<string> | undefined;
  onJumpToMessage: ((messageId: string, channelId?: string) => boolean) | undefined;
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

function MessageRowHeader({
  message,
  grouped,
  showDelivery,
  theme,
  timeZone,
  formatMessageTime
}: Pick<MessageFeedRowProps, "message" | "grouped" | "showDelivery" | "theme" | "timeZone" | "formatMessageTime">) {
  const roleColor = message.authorRoles.find((role) => role.color !== null)?.color ?? null;
  return (
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
      <time className="message-time" dateTime={message.createdAt} title={formatMessageDateTime(message.createdAt, timeZone)}>
        {formatMessageTime(message.createdAt)}
      </time>
      {showDelivery && (
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
  );
}

function MessageEditForm({ content, length, saving, canSave, onChange, onSave, onCancel }: MessageEditState) {
  return (
    <form className="message-edit-form" onSubmit={onSave}>
      <textarea
        aria-label="Изменить сообщение"
        autoFocus
        rows={3}
        value={content}
        onChange={(event) => onChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !saving) onCancel();
        }}
      />
      <div className="message-edit-footer">
        <span className={length > 2000 ? "message-counter message-error" : "message-counter"}>
          {length}/2000
        </span>
        <button type="submit" disabled={!canSave} aria-busy={saving}>
          {saving ? "Сохраняем…" : "Сохранить"}
        </button>
        <button type="button" disabled={saving} onClick={onCancel}>Отмена</button>
      </div>
    </form>
  );
}

function MessageRowBody({
  message,
  visibleChannelIds,
  onJumpToMessage
}: Pick<MessageFeedRowProps, "message" | "visibleChannelIds" | "onJumpToMessage">) {
  if (message.deleted) return <p className="message-body message-deleted">Сообщение удалено</p>;
  const forwardedFrom = message.forwardedFrom;
  if (!forwardedFrom) {
    return <MessageMarkdown content={message.content} mentions={message.mentions.map((entry) => entry.login)} />;
  }
  // Оригиналы из переписок и недоступных каналов остаются обычным текстом.
  const sourceChannel = forwardedFrom.channelId;
  const canLinkToOriginal = sourceChannel !== null
    && forwardedFrom.conversationId === null
    && !forwardedFrom.originalDeleted
    && visibleChannelIds?.has(sourceChannel);

  return (
    <div className="forwarded-block">
      <p className="forwarded-label">
        {"Переслано от "}
        {canLinkToOriginal ? (
          <button
            type="button"
            className="forwarded-author"
            onClick={() => onJumpToMessage?.(forwardedFrom.messageId, sourceChannel)}
          >
            {forwardedFrom.authorLogin}
          </button>
        ) : (
          <span className="forwarded-author">{forwardedFrom.authorLogin}</span>
        )}
      </p>
      <MessageMarkdown content={message.content} mentions={[]} />
    </div>
  );
}

export function MessageFeedRow({
  message,
  grouped,
  firstUnread,
  showDelivery,
  theme,
  timeZone,
  formatMessageTime,
  edit,
  isRevoked,
  longPressRef,
  onOpenMenu,
  visibleChannelIds,
  onJumpToMessage
}: MessageFeedRowProps) {
  const menuDisabled = isRevoked || edit !== null;
  return (
    <article
      className={`${grouped ? "message-row message-row-grouped" : "message-row"}${message.deleted ? " message-row-deleted" : ""}`}
      data-message-id={message.id}
      data-first-unread={firstUnread || undefined}
      aria-label={grouped ? `${message.authorLogin}: ${formatMessageDateTime(message.createdAt, timeZone)}` : undefined}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || menuDisabled) return;
        if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
        event.preventDefault();
        const { left, top, height } = event.currentTarget.getBoundingClientRect();
        onOpenMenu({ x: left + 16, y: top + Math.min(height, 32) });
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        cancelMessageLongPress(longPressRef);
        if (!menuDisabled) onOpenMenu({ x: event.clientX, y: event.clientY });
      }}
      onPointerDown={(event) => {
        if (menuDisabled || event.pointerType !== "touch") return;
        cancelMessageLongPress(longPressRef);
        const x = event.clientX;
        const y = event.clientY;
        const timer = window.setTimeout(() => {
          if (longPressRef.current?.timer !== timer) return;
          longPressRef.current = null;
          onOpenMenu({ x, y });
        }, 500);
        longPressRef.current = { timer, pointerId: event.pointerId, x, y };
      }}
      onPointerMove={(event) => {
        const press = longPressRef.current;
        if (!press || press.pointerId !== event.pointerId) return;
        if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > 10) {
          cancelMessageLongPress(longPressRef, event.pointerId);
        }
      }}
      onPointerUp={(event) => cancelMessageLongPress(longPressRef, event.pointerId)}
      onPointerCancel={(event) => cancelMessageLongPress(longPressRef, event.pointerId)}
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
        {edit ? <MessageEditForm {...edit} /> : (
          <>
            <MessageRowHeader
              message={message}
              grouped={grouped}
              showDelivery={showDelivery}
              theme={theme}
              timeZone={timeZone}
              formatMessageTime={formatMessageTime}
            />
            <MessageRowBody
              message={message}
              visibleChannelIds={visibleChannelIds}
              onJumpToMessage={onJumpToMessage}
            />
          </>
        )}
      </div>
    </article>
  );
}
