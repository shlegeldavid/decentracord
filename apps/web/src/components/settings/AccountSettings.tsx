import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ApiError, changePassword, updatePreferences, type AuthUser } from "../../api";
import { useTimezone } from "../../hooks/useTimezone";
import { avatarColor, initials } from "../../lib/avatar";
import type { Theme } from "../../lib/roles";

interface AccountSettingsProps {
  csrfToken: string;
  user: AuthUser;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  onUserUpdated: (user: AuthUser) => void;
  onSessionExpired: () => void;
  onPasswordChanged: () => void;
}

const timeZoneCityCache = new Map<string, string>();

function displayTimeZoneCity(timeZone: string): string {
  const cached = timeZoneCityCache.get(timeZone);
  if (cached) return cached;
  let city = timeZone.split("/").at(-1)?.replaceAll("_", " ") ?? timeZone;
  try {
    const zoneName = new Intl.DateTimeFormat("ru-RU", { timeZone, timeZoneName: "long" })
      .formatToParts(new Date())
      .find((part) => part.type === "timeZoneName")?.value;
    if (zoneName) city = zoneName.split(",")[0] ?? city;
  } catch {
    // Use the IANA city identifier when the browser cannot localize this zone.
  }
  timeZoneCityCache.set(timeZone, city);
  return city;
}

function filterTimeZones(timeZones: string[], search: string, selected: string): string[] {
  const query = search.trim().toLocaleLowerCase("ru-RU");
  const matches = timeZones.filter((timeZone) =>
    !query || timeZone.toLocaleLowerCase("ru-RU").includes(query) ||
    displayTimeZoneCity(timeZone).toLocaleLowerCase("ru-RU").includes(query)
  );
  return selected && !matches.includes(selected) ? [selected, ...matches] : matches;
}

function AccountPreferences({
  csrfToken,
  user,
  theme,
  onThemeChange,
  onUserUpdated,
  onSessionExpired
}: Omit<AccountSettingsProps, "onPasswordChanged">) {
  const { listTimeZones } = useTimezone(user);
  const [timeZoneSearch, setTimeZoneSearch] = useState("");
  const [isSavingTimeZone, setIsSavingTimeZone] = useState(false);
  const [selectedTimeZone, setSelectedTimeZone] = useState(user.timezone ?? "");
  const [timeZoneError, setTimeZoneError] = useState<string | null>(null);
  const [timeZoneStatus, setTimeZoneStatus] = useState<string | null>(null);
  const requestGeneration = useRef(0);
  const timeZones = useMemo(
    () => filterTimeZones(listTimeZones(), timeZoneSearch, selectedTimeZone),
    [listTimeZones, selectedTimeZone, timeZoneSearch]
  );

  useEffect(() => {
    setSelectedTimeZone(user.timezone ?? "");
  }, [user.timezone]);

  async function saveTimeZone(timeZone: string): Promise<void> {
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    setIsSavingTimeZone(true);
    setTimeZoneError(null);
    setTimeZoneStatus(null);
    try {
      const updatedUser = await updatePreferences({ timezone: timeZone || null }, csrfToken);
      if (requestGeneration.current !== generation) return;
      onUserUpdated(updatedUser);
      setTimeZoneStatus("Часовой пояс сохранён.");
    } catch (error) {
      if (requestGeneration.current !== generation) return;
      if (error instanceof ApiError && error.status === 401) {
        onSessionExpired();
      } else {
        setSelectedTimeZone(user.timezone ?? "");
        setTimeZoneError("Не удалось сохранить часовой пояс. Попробуйте ещё раз.");
      }
    } finally {
      if (requestGeneration.current === generation) setIsSavingTimeZone(false);
    }
  }

  return (
    <div className="account-preferences">
      <section className="account-profile" aria-label="Профиль">
        <span
          className="account-profile-avatar"
          ref={(element) => element?.style.setProperty("background", avatarColor(user.login))}
          aria-hidden="true"
        >
          {initials(user.login)}
        </span>
        <div className="account-profile-copy">
          <strong>{user.login}</strong>
          <span>{user.roleNames.length > 0 ? user.roleNames.join(", ") : "Без роли"}</span>
        </div>
      </section>

      <div className="settings-form-fields">
        <label htmlFor="account-theme">Тема</label>
        <select
          id="account-theme"
          value={theme}
          onChange={(event) => onThemeChange(event.currentTarget.value as Theme)}
        >
          <option value="dark">Тёмная</option>
          <option value="light">Светлая</option>
        </select>

        <label htmlFor="account-timezone-search">Поиск города</label>
        <input
          id="account-timezone-search"
          type="search"
          autoComplete="off"
          placeholder="Например, Москва"
          value={timeZoneSearch}
          onChange={(event) => setTimeZoneSearch(event.currentTarget.value)}
        />
        <label htmlFor="account-timezone">Часовой пояс</label>
        <select
          id="account-timezone"
          value={selectedTimeZone}
          disabled={isSavingTimeZone}
          onChange={(event) => {
            const timeZone = event.currentTarget.value;
            setSelectedTimeZone(timeZone);
            void saveTimeZone(timeZone);
          }}
          aria-describedby={timeZoneError ? "account-timezone-error" : undefined}
        >
          <option value="">Часовой пояс браузера</option>
          {timeZones.map((timeZone) => (
            <option key={timeZone} value={timeZone}>{displayTimeZoneCity(timeZone)} ({timeZone})</option>
          ))}
        </select>
        {timeZoneError && <p className="form-error" id="account-timezone-error" role="alert">{timeZoneError}</p>}
        {timeZoneStatus && <p className="form-success" aria-live="polite">{timeZoneStatus}</p>}
      </div>
    </div>
  );
}

function passwordRequestError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "CURRENT_PASSWORD_INVALID") return "Текущий пароль неверен.";
    if (error.status === 400) return "Новый пароль должен содержать от 12 до 128 символов.";
    if (error.status === 429) return "Слишком много попыток. Подождите и попробуйте ещё раз.";
  }
  return "Не удалось сменить пароль. Попробуйте ещё раз.";
}

const passwordFields = {
  current: { id: "current-password", name: "currentPassword", label: "Текущий пароль", toggleLabel: "текущий пароль" },
  new: { id: "new-password", name: "newPassword", label: "Новый пароль", toggleLabel: "новый пароль" }
} as const;

function PasswordField({ field, value, onChange, errorId }: {
  field: keyof typeof passwordFields;
  value: string;
  onChange: (value: string) => void;
  errorId: string | undefined;
}) {
  const [visible, setVisible] = useState(false);
  const { id, name, label, toggleLabel } = passwordFields[field];
  const action = visible ? "Скрыть" : "Показать";
  return (
    <>
      <label htmlFor={id}>{label}</label>
      <div className="password-field">
        <input
          autoComplete={id}
          id={id}
          maxLength={256}
          minLength={12}
          name={name}
          required
          type={visible ? "text" : "password"}
          value={value}
          onChange={(event) => onChange(event.currentTarget.value)}
          aria-describedby={errorId}
        />
        <button type="button" aria-label={action + " " + toggleLabel} onClick={() => setVisible(!visible)}>
          {action}
        </button>
      </div>
    </>
  );
}

function AccountPasswordForm({ csrfToken, onPasswordChanged, onSessionExpired }: {
  csrfToken: string;
  onPasswordChanged: () => void;
  onSessionExpired: () => void;
}) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
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
      onPasswordChanged();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        onSessionExpired();
      } else {
        setErrorMessage(passwordRequestError(error));
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  const errorId = errorMessage ? "account-password-error" : undefined;
  return (
    <section className="settings-card account-password-settings" aria-label="Смена пароля">
      <p className="eyebrow">АККАУНТ</p>
      <p className="settings-copy">
        Смена пароля добровольная. После неё все открытые сеансы завершатся — войдите снова с новым паролем.
      </p>
      <form onSubmit={(event) => void handleSubmit(event)} aria-busy={isSubmitting}>
        <PasswordField field="current" value={currentPassword} onChange={setCurrentPassword} errorId={errorId} />
        <PasswordField field="new" value={newPassword} onChange={setNewPassword} errorId={errorId} />
        {errorMessage && <p className="form-error" id={errorId} role="alert">{errorMessage}</p>}
        <button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Меняем…" : "Сменить пароль"}
        </button>
      </form>
    </section>
  );
}

export function AccountSettings({ onPasswordChanged, ...preferences }: AccountSettingsProps) {
  return (
    <>
      <AccountPreferences {...preferences} />
      <AccountPasswordForm
        csrfToken={preferences.csrfToken}
        onPasswordChanged={onPasswordChanged}
        onSessionExpired={preferences.onSessionExpired}
      />
    </>
  );
}
