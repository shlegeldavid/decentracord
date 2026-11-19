import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import {
  ApiError,
  changePassword,
  getRoles,
  updateOrganization,
  updatePreferences,
  updateRolePermissions,
  type AuthUser,
  type Role
} from "../api";
import { useTimezone } from "../hooks/useTimezone";
import { avatarColor, initials } from "../lib/avatar";
import type { Theme } from "../lib/roles";
import { AddMemberForm } from "./settings/AddMemberForm";
import { ChannelOverrideEditor } from "./settings/ChannelOverrideEditor";
import { MemberList } from "./settings/MemberList";
import { OrganizationLogoSettings } from "./settings/OrganizationLogoSettings";
import { PermissionMatrix } from "./settings/PermissionMatrix";
import { ReadRetentionSettings } from "./settings/ReadRetentionSettings";
import { RoleEditor } from "./settings/RoleEditor";
import { Modal } from "./ui/Modal";

export type SettingsSection = "organization" | "members" | "roles" | "channels" | "permissions" | "account";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  section: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
  csrfToken: string;
  user: AuthUser;
  organizationName: string;
  organizationLogoUrl: string | null;
  onOrganizationSaved: (name: string) => void;
  onLogoChanged: () => void;
  onUserUpdated: (user: AuthUser) => void;
  canManageRoles: boolean;
  canManageChannels: boolean;
  isAdministrator: boolean;
  onSessionExpired: () => void;
  onPasswordChanged: () => void;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
}

type SettingsNavItem = { id: SettingsSection; label: string };

const timeZoneCityCache = new Map<string, string>();

function requestError(error: unknown): string {
  if (error instanceof ApiError && error.status === 401) return "Сеанс завершён. Войдите снова.";
  return "Не удалось сохранить часовой пояс. Попробуйте ещё раз.";
}

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

function AccountPreferences({
  csrfToken,
  user,
  theme,
  onThemeChange,
  onUserUpdated,
  onSessionExpired
}: Pick<SettingsModalProps, "csrfToken" | "user" | "theme" | "onThemeChange" | "onUserUpdated" | "onSessionExpired">) {
  const { listTimeZones } = useTimezone(user);
  const [timeZoneSearch, setTimeZoneSearch] = useState("");
  const [isSavingTimeZone, setIsSavingTimeZone] = useState(false);
  const [selectedTimeZone, setSelectedTimeZone] = useState(user.timezone ?? "");
  const [timeZoneError, setTimeZoneError] = useState<string | null>(null);
  const [timeZoneStatus, setTimeZoneStatus] = useState<string | null>(null);
  const requestGeneration = useRef(0);
  const timeZones = useMemo(() => {
    const normalizedSearch = timeZoneSearch.trim().toLocaleLowerCase("ru-RU");
    const matchesSearch = (timeZone: string) =>
      normalizedSearch.length === 0 ||
      timeZone.toLocaleLowerCase("ru-RU").includes(normalizedSearch) ||
      displayTimeZoneCity(timeZone).toLocaleLowerCase("ru-RU").includes(normalizedSearch);
    const filteredTimeZones = listTimeZones().filter(matchesSearch);
    if (selectedTimeZone && !filteredTimeZones.includes(selectedTimeZone)) {
      return [selectedTimeZone, ...filteredTimeZones];
    }
    return filteredTimeZones;
  }, [listTimeZones, selectedTimeZone, timeZoneSearch]);

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
        setTimeZoneError(requestError(error));
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

function OrganizationNameSettings({
  name: initialName,
  logoUrl,
  csrfToken,
  onSaved,
  onSessionExpired
}: {
  name: string;
  logoUrl: string | null;
  csrfToken: string;
  onSaved: (name: string) => void;
  onSessionExpired: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  useEffect(() => setName(initialName), [initialName]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setErrorMessage(null);
    setStatusMessage(null);
    setIsSaving(true);
    try {
      const updatedOrganization = await updateOrganization(name, csrfToken, logoUrl);
      setName(updatedOrganization.name);
      onSaved(updatedOrganization.name);
      setStatusMessage("Название сохранено.");
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        onSessionExpired();
      } else {
        setErrorMessage(error instanceof ApiError && error.status === 400
          ? "Название должно содержать от 1 до 100 символов."
          : "Не удалось сохранить название. Попробуйте ещё раз.");
      }
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <section className="settings-card" aria-label="Название организации">
      <p className="eyebrow">УПРАВЛЕНИЕ</p>
      <p className="settings-copy">Это название увидят участники после входа.</p>
      <form onSubmit={(event) => void handleSubmit(event)} aria-busy={isSaving}>
        <label htmlFor="organization-name">Название организации</label>
        <input
          autoComplete="organization"
          id="organization-name"
          name="organizationName"
          maxLength={100}
          required
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
          aria-describedby={errorMessage ? "organization-name-error" : undefined}
        />
        {errorMessage && <p className="form-error" id="organization-name-error" role="alert">{errorMessage}</p>}
        {statusMessage && <p className="form-success" aria-live="polite">{statusMessage}</p>}
        <button type="submit" disabled={isSaving}>
          {isSaving ? "Сохраняем…" : "Сохранить название"}
        </button>
      </form>
    </section>
  );
}

function passwordRequestError(error: unknown): string {
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

function AccountPasswordForm({ csrfToken, onPasswordChanged, onSessionExpired }: {
  csrfToken: string;
  onPasswordChanged: () => void;
  onSessionExpired: () => void;
}) {
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

  return (
    <section className="settings-card account-password-settings" aria-label="Смена пароля">
      <p className="eyebrow">АККАУНТ</p>
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
          {isSubmitting ? "Меняем…" : "Сменить пароль"}
        </button>
      </form>
    </section>
  );
}

export function SettingsModal({
  open,
  onClose,
  section,
  onSectionChange,
  csrfToken,
  user,
  organizationName,
  organizationLogoUrl,
  onOrganizationSaved,
  onLogoChanged,
  onUserUpdated,
  canManageRoles,
  canManageChannels,
  isAdministrator,
  onSessionExpired,
  onPasswordChanged,
  theme,
  onThemeChange
}: SettingsModalProps) {
  const navRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [rolesLoading, setRolesLoading] = useState(false);
  const [busyRoleId, setBusyRoleId] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [memberListRevision, setMemberListRevision] = useState(0);
  const navigationItems: SettingsNavItem[] = [
    ...(isAdministrator ? [{ id: "organization" as const, label: "Организация" }] : []),
    ...(canManageRoles ? [
      { id: "members" as const, label: "Участники" },
      { id: "roles" as const, label: "Роли" }
    ] : []),
    ...(canManageChannels ? [{ id: "channels" as const, label: "Каналы" }] : []),
    ...(canManageRoles ? [{ id: "permissions" as const, label: "Права" }] : []),
    { id: "account", label: "Настройки аккаунта" }
  ];
  const selectedSection = navigationItems.some((item) => item.id === section)
    ? section
    : navigationItems[0]?.id ?? "account";

  const refreshRoles = useCallback(async (): Promise<void> => {
    const items = await getRoles();
    setRoles(items);
  }, []);

  useEffect(() => {
    if (!open || !canManageRoles || (selectedSection !== "roles" && selectedSection !== "permissions")) {
      setRoles([]);
      setRolesLoading(false);
      return;
    }
    let active = true;
    setRolesLoading(true);
    void getRoles().then((items) => {
      if (active) setRoles(items);
    }).catch((error: unknown) => {
      if (!active) return;
      if (error instanceof ApiError && error.status === 401) {
        onSessionExpired();
      } else if (error instanceof ApiError && error.status === 403) {
        setSettingsError("Недостаточно прав для просмотра ролей.");
      } else {
        setSettingsError("Не удалось загрузить роли. Попробуйте ещё раз.");
      }
    }).finally(() => {
      if (active) setRolesLoading(false);
    });
    return () => {
      active = false;
    };
  }, [canManageRoles, onSessionExpired, open, selectedSection]);

  const reportSettingsError = useCallback((message: string) => setSettingsError(message), []);

  function selectSection(nextSection: SettingsSection): void {
    setSettingsError(null);
    onSectionChange(nextSection);
  }

  async function handlePermissionChange(roleId: string, permissions: string[]): Promise<void> {
    setSettingsError(null);
    setBusyRoleId(roleId);
    try {
      await updateRolePermissions(roleId, permissions, csrfToken);
      await refreshRoles();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        onSessionExpired();
      } else if (error instanceof ApiError && error.code === "MISSING_PERMISSION") {
        setSettingsError("Вы не можете выдать разрешение, которого нет у вас.");
        await refreshRoles().catch(() => undefined);
      } else if (error instanceof ApiError && error.code === "HIERARCHY") {
        setSettingsError("Нельзя изменить роль с таким же или более высоким положением.");
        await refreshRoles().catch(() => undefined);
      } else if (error instanceof ApiError && error.status === 403) {
        setSettingsError("Недостаточно прав для изменения этой роли.");
      } else {
        setSettingsError("Не удалось сохранить права роли. Попробуйте ещё раз.");
        await refreshRoles().catch(() => undefined);
      }
    } finally {
      setBusyRoleId(null);
    }
  }

  function handleNavigationKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const direction = event.key === "ArrowDown" ? 1 : -1;
    const nextIndex = (index + direction + navigationItems.length) % navigationItems.length;
    const nextItem = navigationItems[nextIndex];
    if (!nextItem) return;
    selectSection(nextItem.id);
    navRefs.current[nextIndex]?.focus();
  }

  const content = (
    <>
      {settingsError && <p className="form-error" role="alert">{settingsError}</p>}
      {selectedSection === "organization" ? (
        <>
          <h2 className="settings-section-title">Организация</h2>
          <OrganizationNameSettings
            name={organizationName}
            logoUrl={organizationLogoUrl}
            csrfToken={csrfToken}
            onSaved={onOrganizationSaved}
            onSessionExpired={onSessionExpired}
          />
          <OrganizationLogoSettings
            logoUrl={organizationLogoUrl}
            csrfToken={csrfToken}
            onChanged={onLogoChanged}
            onSessionExpired={onSessionExpired}
          />
          <ReadRetentionSettings
            csrfToken={csrfToken}
            onSessionExpired={onSessionExpired}
          />
        </>
      ) : selectedSection === "members" ? (
        <>
          <h2 className="settings-section-title">Участники</h2>
          <AddMemberForm
            csrfToken={csrfToken}
            canManageRoles={canManageRoles}
            onCreated={() => setMemberListRevision((current) => current + 1)}
            onError={reportSettingsError}
            onSessionExpired={onSessionExpired}
          />
          <MemberList
            key={memberListRevision}
            csrfToken={csrfToken}
            currentUserId={user.id}
            canManageRoles={canManageRoles}
            isAdministrator={isAdministrator}
            onError={reportSettingsError}
            onSessionExpired={onSessionExpired}
          />
        </>
      ) : selectedSection === "roles" ? (
        <>
          <h2 className="settings-section-title">Роли</h2>
          <RoleEditor
            roles={roles}
            isLoading={rolesLoading}
            csrfToken={csrfToken}
            theme={theme}
            onChanged={refreshRoles}
            onError={reportSettingsError}
            onSessionExpired={onSessionExpired}
          />
        </>
      ) : selectedSection === "channels" ? (
        <>
          <h2 className="settings-section-title">Каналы</h2>
          <ChannelOverrideEditor
            csrfToken={csrfToken}
            onError={reportSettingsError}
            onSessionExpired={onSessionExpired}
          />
        </>
      ) : selectedSection === "permissions" ? (
        <>
          <h2 className="settings-section-title">Права</h2>
          <PermissionMatrix
            roles={roles}
            isLoading={rolesLoading}
            onChange={(roleId, permissions) => void handlePermissionChange(roleId, permissions)}
            busyRoleId={busyRoleId}
          />
        </>
      ) : (
        <>
          <h2 className="settings-section-title">Настройки аккаунта</h2>
          <AccountPreferences
            csrfToken={csrfToken}
            user={user}
            theme={theme}
            onThemeChange={onThemeChange}
            onUserUpdated={onUserUpdated}
            onSessionExpired={onSessionExpired}
          />
          <AccountPasswordForm
            csrfToken={csrfToken}
            onPasswordChanged={onPasswordChanged}
            onSessionExpired={onSessionExpired}
          />
        </>
      )}
    </>
  );

  if (open === false) return null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      labelledBy="settings-modal-title"
      dialogClassName="modal-dialog settings-modal"
    >
      <header className="settings-modal-header">
        <h1 id="settings-modal-title" tabIndex={-1}>Настройки</h1>
        <button
          type="button"
          className="settings-modal-close"
          aria-label="Закрыть настройки"
          onClick={onClose}
        >
          Закрыть
        </button>
      </header>
      <nav className="settings-modal-nav" aria-label="Разделы">
        {navigationItems.map((item, index) => (
          <button
            ref={(element) => { navRefs.current[index] = element; }}
            key={item.id}
            type="button"
            className="settings-modal-nav-item"
            aria-current={selectedSection === item.id ? "page" : undefined}
            onClick={() => selectSection(item.id)}
            onKeyDown={(event) => handleNavigationKeyDown(event, index)}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <div className="settings-modal-content" key={selectedSection}>
        {content}
      </div>
    </Modal>
  );
}
