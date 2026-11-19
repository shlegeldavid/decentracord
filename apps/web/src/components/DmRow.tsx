import { useRef } from "react";
import type { KeyboardEvent, MouseEvent, PointerEvent } from "react";
import type { Conversation } from "../api";
import { avatarColor, initials } from "../lib/avatar";

interface DmRowProps {
  conversation: Conversation;
  currentUserId: string;
  isSelected: boolean;
  // Признак набора приходит готовым: App.tsx держит карту «кто печатает».
  isTyping: boolean;
  typingCount: number;
  onSelect: (conversationId: string) => void;
  // Контекстное меню рисует App.tsx рядом со строкой — как меню канала;
  // строка только сообщает о запросе.
  onCloseRequest: (conversationId: string, position: { x: number; y: number }) => void;
}

// Долгое нажатие на касании, после которого открывается контекстное меню.
const LONG_PRESS_MS = 500;

/**
 * Название переписки.
 *
 * Названия в базе нет: у пары это логин собеседника, у группы — логины всех
 * участников через запятую в порядке ответа сервера.
 */
export function conversationTitle(conversation: Conversation, currentUserId: string): string {
  if (conversation.kind === "direct") {
    const peer = conversation.participants.find((participant) => participant.id !== currentUserId)
      ?? conversation.participants[0];
    return peer?.login ?? "Переписка";
  }
  const logins = conversation.participants.map((participant) => participant.login);
  return logins.length > 0 ? logins.join(", ") : "Переписка";
}

function avatarStyle(login: string) {
  return (element: HTMLSpanElement | null) => element?.style.setProperty("background", avatarColor(login));
}

// Стрелки, Home и End перемещают фокус внутри списка диалогов; Escape
// возвращает его в ленту — как у списка каналов.
function moveDmFocus(event: KeyboardEvent<HTMLButtonElement>): void {
  if (event.key === "Escape") {
    event.preventDefault();
    const feed = document.querySelector<HTMLElement>(".message-feed") ?? document.querySelector<HTMLElement>(".chat-pane");
    feed?.focus();
    return;
  }

  let offset: -1 | 0 | 1 | "first" | "last" | null = null;
  if (event.key === "ArrowDown") offset = 1;
  if (event.key === "ArrowUp") offset = -1;
  if (event.key === "Home") offset = "first";
  if (event.key === "End") offset = "last";
  if (offset === null) return;

  event.preventDefault();
  const list = event.currentTarget.closest(".dm-list");
  const buttons = [...list?.querySelectorAll<HTMLButtonElement>(".dm-row-select") ?? []];
  const visible = buttons.filter((button) => button.getClientRects().length > 0);
  const current = visible.indexOf(event.currentTarget);
  if (current < 0 || visible.length === 0) return;

  const targetIndex = offset === "first"
    ? 0
    : offset === "last"
      ? visible.length - 1
      : Math.min(visible.length - 1, Math.max(0, current + offset));
  visible[targetIndex]?.focus();
}

export function DmRow({ conversation, currentUserId, isSelected, isTyping, typingCount, onSelect, onCloseRequest }: DmRowProps) {
  const title = conversationTitle(conversation, currentUserId);
  const descriptionId = `dm-description-${conversation.id}`;
  // Части описания соединяются запятой в порядке «{N} непрочитанных, печатает…»
  const description = [
    conversation.unreadCount > 0 ? `${conversation.unreadCount} непрочитанных` : null,
    isTyping ? (typingCount > 1 ? "печатают…" : "печатает…") : null
  ].filter((part): part is string => part !== null).join(", ");
  const typingModifier = isTyping ? " is-typing" : "";
  const stack = conversation.kind === "group" ? conversation.participants.slice(0, 2) : [];
  const longPressTimer = useRef<number | null>(null);
  const longPressTriggered = useRef(false);

  function clearLongPress(): void {
    if (longPressTimer.current === null) return;
    window.clearTimeout(longPressTimer.current);
    longPressTimer.current = null;
  }

  function handlePointerDown(event: PointerEvent<HTMLButtonElement>): void {
    clearLongPress();
    longPressTriggered.current = false;
    const { clientX, clientY } = event;
    longPressTimer.current = window.setTimeout(() => {
      longPressTimer.current = null;
      longPressTriggered.current = true;
      onCloseRequest(conversation.id, { x: clientX, y: clientY });
    }, LONG_PRESS_MS);
  }

  function handleClick(): void {
    // Отпускание после долгого нажатия переписку не открывает.
    if (longPressTriggered.current) {
      longPressTriggered.current = false;
      return;
    }
    onSelect(conversation.id);
  }

  function handleContextMenu(event: MouseEvent<HTMLButtonElement>): void {
    event.preventDefault();
    clearLongPress();
    onCloseRequest(conversation.id, { x: event.clientX, y: event.clientY });
  }

  return (
    <li className="dm-row" data-dm-id={conversation.id}>
      <button
        type="button"
        className="dm-row-select"
        aria-current={isSelected ? "true" : undefined}
        aria-describedby={description ? descriptionId : undefined}
        onClick={handleClick}
        onKeyDown={moveDmFocus}
        onContextMenu={handleContextMenu}
        onPointerDown={handlePointerDown}
        onPointerUp={clearLongPress}
        onPointerLeave={clearLongPress}
        onPointerCancel={clearLongPress}
      >
        {conversation.kind === "direct" ? (
          <span
            className={`member-avatar dm-row-avatar${typingModifier}`}
            ref={avatarStyle(title)}
            aria-hidden="true"
          >
            {initials(title)}
          </span>
        ) : (
          <span className="dm-avatar-stack" aria-hidden="true">
            {stack.map((participant) => (
              <span
                key={participant.id}
                className={`member-avatar dm-row-avatar${typingModifier}`}
                ref={avatarStyle(participant.login)}
              >
                {initials(participant.login)}
              </span>
            ))}
          </span>
        )}
        <span className="dm-row-name">{title}</span>
        {conversation.unreadCount > 0 && (
          <span className="unread-badge" data-unread-count={conversation.unreadCount} aria-hidden="true">
            {conversation.unreadCount}
          </span>
        )}
      </button>
      {description && <span className="visually-hidden" id={descriptionId}>{description}</span>}
    </li>
  );
}
