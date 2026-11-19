import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Modal } from "./ui/Modal";

interface CategoryDialogProps {
  open: boolean;
  onClose: () => void;
  mode: "create" | "rename";
  initialName?: string;
  onSubmit: (name: string) => Promise<void>;
  onError: (message: string) => void;
}

export function CategoryDialog({ open, onClose, mode, initialName, onSubmit, onError }: CategoryDialogProps) {
  const [name, setName] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const title = mode === "create" ? "Создать категорию" : "Переименовать категорию";
  const submitLabel = mode === "create" ? "Создать категорию" : "Сохранить название категории";
  const waitingLabel = mode === "create" ? "Создаём…" : "Сохраняем…";

  useEffect(() => {
    if (!open) return;
    setName(mode === "rename" ? initialName ?? "" : "");
    setErrorMessage(null);
    setSuccessMessage("");
  }, [initialName, mode, open]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setErrorMessage(null);
    setSuccessMessage("");
    setIsSubmitting(true);
    try {
      await onSubmit(name.trim());
      setSuccessMessage(mode === "create" ? "Категория создана." : "Название категории сохранено.");
      onClose();
    } catch (error) {
      const message = error instanceof Error && error.message
        ? error.message
        : "Не удалось выполнить запрос. Попробуйте ещё раз.";
      setErrorMessage(message);
      onError(message);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      labelledBy="category-dialog-title"
      initialFocusRef={nameInputRef}
      dialogClassName="modal-dialog category-dialog"
    >
      <form onSubmit={(event) => void handleSubmit(event)} aria-busy={isSubmitting}>
        <h2 id="category-dialog-title">{title}</h2>
        <label htmlFor="category-name">Название категории</label>
        <input
          ref={nameInputRef}
          id="category-name"
          type="text"
          value={name}
          maxLength={80}
          required
          disabled={isSubmitting}
          onChange={(event) => setName(event.currentTarget.value)}
        />
        {errorMessage && <p className="channel-dialog-error" role="alert">{errorMessage}</p>}
        <div className="category-dialog-actions">
          <button type="button" className="button-secondary" disabled={isSubmitting} onClick={onClose}>Отмена</button>
          <button type="submit" disabled={isSubmitting} aria-busy={isSubmitting}>
            {isSubmitting ? waitingLabel : submitLabel}
          </button>
        </div>
        <p className="form-success" aria-live="polite">{successMessage}</p>
      </form>
    </Modal>
  );
}
