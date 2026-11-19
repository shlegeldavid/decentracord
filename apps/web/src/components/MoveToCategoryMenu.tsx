import { useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import type { ChannelCategory } from "../api";
import { Modal } from "./ui/Modal";

interface MoveToCategoryMenuProps {
  open: boolean;
  channelName: string;
  currentCategoryId: string | null;
  categories: ChannelCategory[];
  onClose: () => void;
  onMove: (categoryId: string | null) => Promise<void>;
}

export function MoveToCategoryMenu({
  open,
  channelName,
  currentCategoryId,
  categories,
  onClose,
  onMove
}: MoveToCategoryMenuProps) {
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(currentCategoryId);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isMoving, setIsMoving] = useState(false);
  const optionsRef = useRef<HTMLDivElement>(null);
  const title = `Переместить канал «${channelName}»`;

  async function handleMove(event?: FormEvent<HTMLFormElement>): Promise<void> {
    event?.preventDefault();
    if (isMoving) return;
    setErrorMessage(null);
    setIsMoving(true);
    try {
      await onMove(selectedCategoryId);
      onClose();
    } catch {
      setErrorMessage("Не удалось переместить канал. Попробуйте ещё раз.");
    } finally {
      setIsMoving(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLFormElement>): void {
    if (event.key === "Enter" && event.target instanceof HTMLInputElement && event.target.type === "radio") {
      event.preventDefault();
      void handleMove();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const options = Array.from(optionsRef.current?.querySelectorAll<HTMLInputElement>("input[type='radio']") ?? []);
    const currentIndex = options.indexOf(document.activeElement as HTMLInputElement);
    if (currentIndex < 0 || options.length === 0) return;
    event.preventDefault();
    const offset = event.key === "ArrowDown" ? 1 : -1;
    const next = options[(currentIndex + offset + options.length) % options.length];
    next?.focus();
    if (next) setSelectedCategoryId(next.value === "__uncategorized__" ? null : next.value);
  }

  return (
    <Modal
      open={open}
      onClose={() => { if (!isMoving) onClose(); }}
      labelledBy="channel-move-dialog-title"
      dialogClassName="modal-dialog channel-move-dialog"
    >
      <form onSubmit={(event) => void handleMove(event)} onKeyDown={handleKeyDown} aria-busy={isMoving}>
        <h2 id="channel-move-dialog-title" tabIndex={-1}>{title}</h2>
        <div ref={optionsRef} className="channel-move-options" role="radiogroup" aria-label="Категория">
          <label className="channel-move-option">
            <input
              type="radio"
              name="channel-move-category"
              value="__uncategorized__"
              checked={selectedCategoryId === null}
              disabled={isMoving}
              onChange={() => setSelectedCategoryId(null)}
            />
            <span>Без категории</span>
          </label>
          {categories.map((category) => (
            <label className="channel-move-option" key={category.id}>
              <input
                type="radio"
                name="channel-move-category"
                value={category.id}
                checked={selectedCategoryId === category.id}
                disabled={isMoving}
                onChange={() => setSelectedCategoryId(category.id)}
              />
              <span>{category.name}</span>
            </label>
          ))}
        </div>
        {errorMessage && <p className="channel-dialog-error" role="alert">{errorMessage}</p>}
        <div className="channel-move-actions">
          <button type="button" className="button-secondary" disabled={isMoving} onClick={onClose}>Отмена</button>
          <button type="submit" className="btn-primary" disabled={isMoving} aria-busy={isMoving}>
            {isMoving ? "Перемещаем…" : "Переместить"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
