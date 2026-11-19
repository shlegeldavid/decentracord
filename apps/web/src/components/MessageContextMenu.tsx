import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { CopyIcon, EditIcon, ForwardIcon, PinIcon, TrashIcon } from "./icons";

export interface MessageContextMenuProps {
  messageId: string;
  authorLogin: string;
  messageTime: string;
  content: string;
  position: { x: number; y: number };
  canEdit: boolean;
  canDelete: boolean;
  canSeeReaders: boolean;
  canPin: boolean;
  canUnpin: boolean;
  isPinned: boolean;
  canForward?: boolean;
  onCopy: () => void;
  onCopyError: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onPin: () => void;
  onUnpin: () => void;
  onForward: () => void;
  onOpenReaders: () => void;
  onClose: () => void;
}

export function MessageContextMenu({
  messageId,
  authorLogin,
  messageTime,
  content,
  position,
  canEdit,
  canDelete,
  canSeeReaders,
  canPin,
  canUnpin,
  isPinned,
  canForward,
  onCopy,
  onCopyError,
  onEdit,
  onDelete,
  onPin,
  onUnpin,
  onForward,
  onOpenReaders,
  onClose
}: MessageContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [copyFailed, setCopyFailed] = useState(false);

  function focusMessage(): void {
    const message = Array.from(document.querySelectorAll<HTMLElement>("[data-message-id]"))
      .find((element) => element.dataset.messageId === messageId);
    message?.focus();
  }

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;

    const bounds = menu.getBoundingClientRect();
    const left = Math.max(8, Math.min(position.x, window.innerWidth - bounds.width - 8));
    const top = Math.max(8, Math.min(position.y, window.innerHeight - bounds.height - 8));
    menu.style.setProperty("left", `${left}px`);
    menu.style.setProperty("top", `${top}px`);
    menu.querySelector<HTMLButtonElement>("[role='menuitem']")?.focus();
  }, [copyFailed, position]);

  useEffect(() => {
    function dismissOutside(event: PointerEvent): void {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) onClose();
    }

    document.addEventListener("pointerdown", dismissOutside);
    return () => document.removeEventListener("pointerdown", dismissOutside);
  }, [onClose]);

  function focusMenuItem(direction: -1 | 1): void {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role='menuitem']") ?? []);
    if (items.length === 0) return;
    const focusedIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    const currentIndex = focusedIndex < 0 ? 0 : focusedIndex;
    const nextIndex = (currentIndex + direction + items.length) % items.length;
    items[nextIndex]?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusMenuItem(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusMenuItem(-1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      window.requestAnimationFrame(focusMessage);
    }
  }

  async function copyAndClose(): Promise<void> {
    try {
      await navigator.clipboard.writeText(`${authorLogin}, ${messageTime}\n${content}`);
      setCopyFailed(false);
      onCopy();
      onClose();
      window.requestAnimationFrame(focusMessage);
    } catch {
      setCopyFailed(true);
      onCopyError();
    }
  }

  function deleteAndClose(): void {
    onDelete();
    onClose();
    window.requestAnimationFrame(focusMessage);
  }

  function pinAndClose(): void {
    onPin();
    onClose();
    window.requestAnimationFrame(focusMessage);
  }

  function unpinAndClose(): void {
    onUnpin();
    onClose();
    window.requestAnimationFrame(focusMessage);
  }

  function forwardAndClose(): void {
    // Фокус переносим на сообщение до открытия диалога: диалог запоминает
    // элемент, к которому вернёт фокус при закрытии.
    focusMessage();
    onForward();
    onClose();
  }

  return (
    <div
      ref={menuRef}
      className="context-menu"
      role="menu"
      aria-label="Действия с сообщением"
      onKeyDown={handleKeyDown}
    >
      <button
        type="button"
        role="menuitem"
        className="context-menu-item"
        onClick={copyAndClose}
        aria-label={copyFailed ? "Повторить копирование" : undefined}
        aria-describedby={copyFailed ? "context-menu-copy-error" : undefined}
      >
        <CopyIcon />
        <span className="context-menu-copy-content">
          <span>{copyFailed ? "Повторить копирование" : "Копировать текст"}</span>
          {copyFailed && (
            <span className="context-menu-copy-error" id="context-menu-copy-error">
              Не удалось скопировать. Проверьте разрешение буфера обмена.
            </span>
          )}
        </span>
      </button>
      {canEdit && (
        <button type="button" role="menuitem" className="context-menu-item" onClick={() => { onEdit(); onClose(); }}>
          <EditIcon />
          <span>Править</span>
        </button>
      )}
      {canPin && !isPinned && (
        <button type="button" role="menuitem" className="context-menu-item" onClick={pinAndClose}>
          <PinIcon />
          <span>Закрепить</span>
        </button>
      )}
      {canUnpin && isPinned && (
        <button type="button" role="menuitem" className="context-menu-item" onClick={unpinAndClose}>
          <PinIcon />
          <span>Открепить</span>
        </button>
      )}
      {canForward !== false && (
        <button type="button" role="menuitem" className="context-menu-item" onClick={forwardAndClose}>
          <ForwardIcon />
          <span>Переслать</span>
        </button>
      )}
      {canSeeReaders && (
        <button
          type="button"
          role="menuitem"
          className="context-menu-item"
          onClick={() => {
            // Фокус переносим на сообщение до открытия окна: окно запоминает
            // элемент, к которому вернёт фокус при закрытии.
            focusMessage();
            onOpenReaders();
            onClose();
          }}
        >
          <span>Кто прочитал</span>
        </button>
      )}
      {canDelete && (
        <>
          <div role="separator" className="context-menu-separator" />
          <button type="button" role="menuitem" className="context-menu-item context-menu-item-danger" onClick={deleteAndClose}>
            <TrashIcon />
            <span>Удалить</span>
          </button>
        </>
      )}
    </div>
  );
}
