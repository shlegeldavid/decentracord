import { useEffect, useState } from "react";
import { ApiError, getMessageReaders, type MessageReader } from "../api";
import { avatarColor, initials } from "../lib/avatar";
import { CloseIcon } from "./icons";
import { Modal } from "./ui/Modal";

interface MessageReadersModalProps {
  open: boolean;
  onClose: () => void;
  channelId: string;
  messageId: string;
  timeZone: string;
  onSessionExpired: () => void;
}

type ReadersState = "loading" | "ready" | "empty" | "error";

function formatReaderTime(readAt: string, timeZone: string): string {
  const date = new Date(readAt);
  if (Number.isNaN(date.getTime())) return readAt;
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

function formatReaderDateTime(readAt: string, timeZone: string): string {
  const date = new Date(readAt);
  if (Number.isNaN(date.getTime())) return readAt;
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

export function MessageReadersModal({
  open,
  onClose,
  channelId,
  messageId,
  timeZone,
  onSessionExpired
}: MessageReadersModalProps) {
  const [state, setState] = useState<ReadersState>("loading");
  const [readers, setReaders] = useState<MessageReader[]>([]);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setState("loading");
    setReaders([]);
    void getMessageReaders(channelId, messageId)
      .then((result) => {
        if (!active) return;
        setReaders(result);
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
  }, [open, channelId, messageId, reloadKey, onSessionExpired]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      labelledBy="message-readers-title"
      dialogClassName="readers-modal"
    >
      <header className="readers-modal-header">
        <h2 id="message-readers-title" className="settings-section-title" tabIndex={-1}>
          Кто прочитал сообщение
        </h2>
        <button
          type="button"
          className="icon-btn"
          aria-label="Закрыть список прочитанных"
          onClick={onClose}
        >
          <CloseIcon />
        </button>
      </header>
      {state === "loading" && (
        <p className="loading-copy" aria-live="polite">Загружаем список прочитанных…</p>
      )}
      {state === "error" && (
        <div className="form-error readers-modal-error" role="alert">
          <p>Не удалось загрузить список прочитанных. Попробуйте ещё раз.</p>
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
          <p className="settings-copy">Пока никто не прочитал это сообщение.</p>
          <p className="settings-copy">Список появится, когда участники прочитают сообщение.</p>
        </>
      )}
      {state === "ready" && (
        <ul className="readers-list">
          {readers.map((reader) => (
            <li className="reader-row" key={reader.userId}>
              <span
                className="member-avatar"
                aria-hidden="true"
                ref={(element) => element?.style.setProperty("background", avatarColor(reader.login))}
              >
                {initials(reader.login)}
              </span>
              <span className="member-name">{reader.login}</span>
              <span className="reader-time" title={formatReaderDateTime(reader.readAt, timeZone)}>
                {formatReaderTime(reader.readAt, timeZone)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
