import { useLayoutEffect, useRef } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { SendIcon } from "./icons";

interface MessageComposerProps {
  value: string;
  onChange: (value: string) => void;
  // Необязательный сигнал набора: канальный композер его не передаёт, поэтому
  // поведение каналов не меняется.
  onInput?: () => void;
  onSubmit: (content: string, csrfToken: string) => void;
  disabled: boolean;
  disabledReason?: string;
  offline?: boolean;
  csrfToken: string;
  maxLength?: number;
  isSending: boolean;
  errorMessage?: string | null;
}

export function MessageComposer({
  value,
  onChange,
  onInput,
  onSubmit,
  disabled,
  disabledReason,
  offline = false,
  csrfToken,
  maxLength = 2000,
  isSending,
  errorMessage
}: MessageComposerProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const length = Array.from(value).length;
  const overLimit = length > maxLength;
  const showCounter = length >= Math.ceil(maxLength * 0.9);
  const cannotSubmit = disabled || isSending || overLimit || value.trim().length === 0;

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;

    const styles = window.getComputedStyle(input);
    const lineHeight = Number.parseFloat(styles.lineHeight) || Number.parseFloat(styles.fontSize) * 1.5 || 21;
    const verticalPadding = Number.parseFloat(styles.paddingTop) + Number.parseFloat(styles.paddingBottom);
    const verticalBorder = Number.parseFloat(styles.borderTopWidth) + Number.parseFloat(styles.borderBottomWidth);
    const maxHeight = lineHeight * 8 + verticalPadding + verticalBorder;

    input.style.setProperty("height", "auto");
    const contentHeight = input.scrollHeight;
    input.style.setProperty("height", `${Math.min(contentHeight, maxHeight)}px`);
    input.style.setProperty("overflow-y", contentHeight > maxHeight ? "auto" : "hidden");
  }, [value]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (cannotSubmit) return;
    onSubmit(value, csrfToken);
  }

  function handleInputKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (!cannotSubmit) event.currentTarget.form?.requestSubmit();
  }

  return (
    <form className="message-composer" onSubmit={handleSubmit} aria-busy={isSending}>
      <label className="visually-hidden" htmlFor="message-composer-input">Сообщение</label>
      <div className="message-composer-input-wrap">
        <textarea
          ref={inputRef}
          className="message-composer-input"
          id="message-composer-input"
          name="message"
          rows={1}
          placeholder="Написать сообщение"
          required
          value={value}
          onChange={(event) => {
            onChange(event.currentTarget.value);
            onInput?.();
          }}
          onKeyDown={handleInputKeyDown}
          disabled={disabled}
          aria-describedby={showCounter ? "message-composer-counter" : undefined}
        />
        <button
          type="submit"
          className="message-composer-send"
          aria-label="Отправить"
          disabled={cannotSubmit}
          aria-busy={isSending}
        >
          <SendIcon />
        </button>
      </div>
      <div className="message-composer-footer">
        {showCounter && (
          <span
            className={overLimit ? "message-counter message-error" : "message-counter"}
            id="message-composer-counter"
            aria-live="polite"
          >
            {length}/{maxLength}
          </span>
        )}
        {disabled && disabledReason && (
          <div className="message-composer-notice">
            <p className="settings-copy">{disabledReason}</p>
            <p className="settings-copy">Канал только для чтения — отправка недоступна.</p>
          </div>
        )}
        {offline && !disabled && <p className="settings-copy">Нет связи — отправится после восстановления.</p>}
        {overLimit && <p className="message-error" role="alert">Сообщение превышает лимит в {maxLength} символов.</p>}
        {errorMessage && <p className="form-error" role="alert">{errorMessage}</p>}
      </div>
    </form>
  );
}
