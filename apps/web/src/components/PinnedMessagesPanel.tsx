import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import { ApiError, getPinnedMessages, type PinnedMessage } from "../api";
import { roleColorForTheme, type Theme } from "../lib/roles";
import { MessageMarkdown } from "../markdown/MessageMarkdown";
import { CloseIcon, PinIcon } from "./icons";
import { Modal } from "./ui/Modal";

interface PinnedMessagesPanelProps {
  open: boolean;
  onClose: () => void;
  channelId: string;
  canManageMessages: boolean;
  currentUserId: string;
  pinnedMessageIds: Set<string>;
  onUnpin: (messageId: string) => Promise<void>;
  onJumpToMessage: (messageId: string) => boolean;
  timeZone: string;
  theme: Theme;
  onSessionExpired: () => void;
}

type PinsState = "loading" | "ready" | "empty" | "error";

function formatPinnedTime(createdAt: string, timeZone: string): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return createdAt;
  try {
    return new Intl.DateTimeFormat("ru-RU", {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat("ru-RU", {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone: "UTC"
    }).format(date);
  }
}

function formatPinnedDateTime(createdAt: string, timeZone: string): string {
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

export function PinnedMessagesPanel({
  open,
  onClose,
  channelId,
  canManageMessages,
  currentUserId,
  pinnedMessageIds,
  onUnpin,
  onJumpToMessage,
  timeZone,
  theme,
  onSessionExpired
}: PinnedMessagesPanelProps) {
  const [state, setState] = useState<PinsState>("loading");
  const [pins, setPins] = useState<PinnedMessage[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const [missingMessageId, setMissingMessageId] = useState<string | null>(null);
  const [unpinningMessageId, setUnpinningMessageId] = useState<string | null>(null);
  // Ключ, при котором список загружается заново «с нуля»: смена канала, повтор
  // после ошибки и повторное открытие панели. Обновление по событиям закрепления
  // список не сбрасывает — он подменяется молча.
  const resetKey = `${channelId}|${reloadKey}|${open ? "open" : "closed"}`;
  const lastResetKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    if (lastResetKeyRef.current !== resetKey) {
      lastResetKeyRef.current = resetKey;
      setState("loading");
      setPins([]);
      setMissingMessageId(null);
    }
    void getPinnedMessages(channelId)
      .then((result) => {
        if (!active) return;
        setPins(result);
        setState(result.length === 0 ? "empty" : "ready");
      })
      .catch((error: unknown) => {
        if (!active) return;
        // Истёкшая сессия: участник возвращается на экран входа.
        if (error instanceof ApiError && error.status === 401) {
          onSessionExpired();
          return;
        }
        setState("error");
      });
    return () => {
      active = false;
    };
  }, [open, channelId, reloadKey, resetKey, pinnedMessageIds, onSessionExpired]);

  function jumpToMessage(messageId: string): void {
    const jumped = onJumpToMessage(messageId);
    setMissingMessageId(jumped ? null : messageId);
  }

  function handleItemClick(event: MouseEvent<HTMLLIElement>, messageId: string): void {
    const target = event.target;
    // Клик по ссылке внутри тела сообщения не запускает переход к сообщению.
    if (target instanceof Element && target.closest("a, .message-link")) return;
    jumpToMessage(messageId);
  }

  function handleBodyKeyDown(event: KeyboardEvent<HTMLDivElement>, messageId: string): void {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    jumpToMessage(messageId);
  }

  async function handleUnpin(messageId: string): Promise<void> {
    if (unpinningMessageId !== null) return;
    setUnpinningMessageId(messageId);
    try {
      await onUnpin(messageId);
    } finally {
      setUnpinningMessageId(null);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      labelledBy="channel-pins-title"
      dialogClassName="pins-panel"
    >
      <div id="channel-pins-panel" className="pins-panel-content">
        <header className="pins-panel-header">
          <h2 id="channel-pins-title" className="settings-section-title" tabIndex={-1}>
            Закреплённые сообщения
          </h2>
          <button
            type="button"
            className="icon-btn"
            aria-label="Закрыть закреплённые сообщения"
            onClick={onClose}
          >
            <CloseIcon />
          </button>
        </header>
        {state === "loading" && (
          <p className="loading-copy" aria-live="polite">Загружаем закреплённые сообщения…</p>
        )}
        {state === "error" && (
          <div className="form-error" role="alert">
            <p>Не удалось загрузить закреплённые сообщения. Попробуйте ещё раз.</p>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setReloadKey((value) => value + 1)}
            >
              Повторить
            </button>
          </div>
        )}
        {state === "empty" && (
          <>
            <p className="settings-copy">Нет закреплённых</p>
            <p className="settings-copy">Закреплённые сообщения появятся здесь, когда их закрепят.</p>
          </>
        )}
        {state === "ready" && (
          <ul className="pinned-list">
            {pins.map((pinned) => {
              const roleColor = pinned.authorRoles.find((role) => role.color !== null)?.color ?? null;
              const canUnpin = canManageMessages || pinned.authorId === currentUserId;
              return (
                <li
                  className="pinned-item"
                  key={pinned.messageId}
                  onClick={(event) => handleItemClick(event, pinned.messageId)}
                >
                  <div className="pinned-item-header">
                    <span
                      className="message-author"
                      ref={(element) => {
                        if (!element) return;
                        const color = roleColorForTheme(roleColor, theme);
                        if (color) element.style.setProperty("--role-color", color);
                        else element.style.removeProperty("--role-color");
                      }}
                    >
                      {pinned.authorLogin}
                    </span>
                    <time
                      className="message-time"
                      dateTime={pinned.createdAt}
                      title={formatPinnedDateTime(pinned.createdAt, timeZone)}
                    >
                      {formatPinnedTime(pinned.createdAt, timeZone)}
                    </time>
                    <PinIcon size={16} />
                  </div>
                  <div
                    className="pinned-item-body"
                    tabIndex={0}
                    onKeyDown={(event) => handleBodyKeyDown(event, pinned.messageId)}
                  >
                    <MessageMarkdown
                      content={pinned.content}
                      mentions={pinned.mentions.map((mention) => mention.login)}
                    />
                  </div>
                  {canUnpin && (
                    <button
                      type="button"
                      className="pinned-unpin"
                      disabled={unpinningMessageId !== null}
                      onClick={(event) => {
                        // Клик по кнопке не запускает переход к сообщению.
                        event.stopPropagation();
                        void handleUnpin(pinned.messageId).catch(() => undefined);
                      }}
                    >
                      Открепить
                    </button>
                  )}
                  {missingMessageId === pinned.messageId && (
                    <p className="pinned-item-hint">
                      Сообщение не загружено в ленте — прокрутите ленту вверх
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Modal>
  );
}
