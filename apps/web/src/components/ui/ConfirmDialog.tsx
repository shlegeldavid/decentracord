import { useEffect, useId, useRef, useState } from "react";
import { Modal } from "./Modal";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  confirmCheckboxLabel?: string;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
  busy?: boolean;
  errorMessage?: string;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Отключить участника",
  confirmCheckboxLabel = "Подтверждаю отключение учётной записи и завершение всех входов",
  onConfirm,
  onCancel,
  busy = false,
  errorMessage
}: ConfirmDialogProps) {
  const id = useId();
  const [confirmed, setConfirmed] = useState(false);
  const checkboxRef = useRef<HTMLInputElement>(null);
  const titleId = `${id}-title`;
  const descriptionId = `${id}-description`;
  const checkboxId = `${id}-checkbox`;

  useEffect(() => {
    if (!open) setConfirmed(false);
  }, [open]);

  useEffect(() => {
    if (!errorMessage) return;
    setConfirmed(false);
    checkboxRef.current?.focus();
  }, [errorMessage]);

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!busy) onCancel();
      }}
      labelledBy={titleId}
      describedBy={descriptionId}
      dialogClassName="modal-dialog confirm-dialog"
    >
      <h2 className="settings-section-title" id={titleId} tabIndex={-1}>{title}</h2>
      <p className="settings-copy" id={descriptionId}>{description}</p>
      <div className="confirm-dialog-checkbox">
        <input
          ref={checkboxRef}
          id={checkboxId}
          type="checkbox"
          checked={confirmed}
          disabled={busy}
          onChange={(event) => setConfirmed(event.currentTarget.checked)}
        />
        <label htmlFor={checkboxId}>{confirmCheckboxLabel}</label>
      </div>
      {errorMessage && <p className="channel-dialog-error" role="alert">{errorMessage}</p>}
      <div className="confirm-dialog-actions">
        <button type="button" className="button-secondary" disabled={busy} onClick={onCancel}>Отмена</button>
        <button type="button" className="button-danger" disabled={!confirmed || busy} onClick={() => void onConfirm()}>
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
