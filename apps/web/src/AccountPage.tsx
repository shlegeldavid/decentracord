import { useState } from "react";
import type { FormEvent } from "react";
import { ApiError, changePassword } from "./api";

interface AccountPageProps {
  csrfToken: string;
  onChanged: () => void;
  onSessionExpired: () => void;
}

function requestError(error: unknown): string {
  if (error instanceof ApiError && error.code === "CURRENT_PASSWORD_INVALID") {
    return "Текущий пароль неверен.";
  }
  if (error instanceof ApiError && error.status === 400) {
    return "Новый пароль должен содержать от 12 до 128 символов.";
  }
  if (error instanceof ApiError && error.status === 429) {
    return "Слишком много попыток. Подождите и попробуйте ещё раз.";
  }
  return "Не удалось сменить пароль. Попробуйте ещё раз.";
}

export function AccountPage({ csrfToken, onChanged, onSessionExpired }: AccountPageProps) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setErrorMessage(null);
    setIsSubmitting(true);
    try {
      await changePassword({ currentPassword, newPassword }, csrfToken);
      setCurrentPassword("");
      setNewPassword("");
      onChanged();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        onSessionExpired();
      } else {
        setErrorMessage(requestError(error));
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <section className="settings-card" aria-labelledby="account-settings-title">
      <p className="eyebrow">АККАУНТ</p>
      <h2 id="account-settings-title">Настройки аккаунта</h2>
      <p className="settings-copy">
        Смена пароля добровольная. После неё все открытые сеансы завершатся — войдите снова с новым паролем.
      </p>
      <form onSubmit={(event) => void handleSubmit(event)} aria-busy={isSubmitting}>
        <label htmlFor="current-password">Текущий пароль</label>
        <div className="password-field">
          <input
            autoComplete="current-password"
            id="current-password"
            maxLength={256}
            minLength={12}
            name="currentPassword"
            required
            type={showCurrentPassword ? "text" : "password"}
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.currentTarget.value)}
            aria-describedby={errorMessage ? "account-password-error" : undefined}
          />
          <button
            type="button"
            aria-label={showCurrentPassword ? "Скрыть текущий пароль" : "Показать текущий пароль"}
            onClick={() => setShowCurrentPassword(!showCurrentPassword)}
          >
            {showCurrentPassword ? "Скрыть" : "Показать"}
          </button>
        </div>

        <label htmlFor="new-password">Новый пароль</label>
        <div className="password-field">
          <input
            autoComplete="new-password"
            id="new-password"
            maxLength={256}
            minLength={12}
            name="newPassword"
            required
            type={showNewPassword ? "text" : "password"}
            value={newPassword}
            onChange={(event) => setNewPassword(event.currentTarget.value)}
            aria-describedby={errorMessage ? "account-password-error" : undefined}
          />
          <button
            type="button"
            aria-label={showNewPassword ? "Скрыть новый пароль" : "Показать новый пароль"}
            onClick={() => setShowNewPassword(!showNewPassword)}
          >
            {showNewPassword ? "Скрыть" : "Показать"}
          </button>
        </div>

        {errorMessage && <p className="form-error" id="account-password-error" role="alert">{errorMessage}</p>}
        <button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Сохраняем…" : "Сменить пароль"}
        </button>
      </form>
    </section>
  );
}
