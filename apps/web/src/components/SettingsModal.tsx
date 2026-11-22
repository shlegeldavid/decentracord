import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import {
  ApiError,
  getRoles,
  updateRolePermissions,
  type AuthUser,
  type Role
} from "../api";
import type { Theme } from "../lib/roles";
import { AccountSettings } from "./settings/AccountSettings";
import { AddMemberForm } from "./settings/AddMemberForm";
import { ChannelOverrideEditor } from "./settings/ChannelOverrideEditor";
import { MemberList } from "./settings/MemberList";
import { OrganizationSettings } from "./settings/OrganizationSettings";
import { PermissionMatrix } from "./settings/PermissionMatrix";
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

type SettingsPrivilege = "isAdministrator" | "canManageRoles" | "canManageChannels";
type SettingsNavItem = { id: SettingsSection; label: string; requires?: SettingsPrivilege };

const accountSection: SettingsNavItem = { id: "account", label: "Настройки аккаунта" };
const settingsNavigation: SettingsNavItem[] = [
  { id: "organization", label: "Организация", requires: "isAdministrator" },
  { id: "members", label: "Участники", requires: "canManageRoles" },
  { id: "roles", label: "Роли", requires: "canManageRoles" },
  { id: "channels", label: "Каналы", requires: "canManageChannels" },
  { id: "permissions", label: "Права", requires: "canManageRoles" },
  accountSection
];

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
  const privileges = { isAdministrator, canManageRoles, canManageChannels };
  const navigationItems = settingsNavigation.filter(({ requires }) => !requires || privileges[requires]);
  const activeSection = navigationItems.find((item) => item.id === section) ?? navigationItems[0] ?? accountSection;
  const selectedSection = activeSection.id;

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

  if (!open) return null;

  const content = {
    organization: (
      <OrganizationSettings
        name={organizationName}
        logoUrl={organizationLogoUrl}
        csrfToken={csrfToken}
        onNameSaved={onOrganizationSaved}
        onLogoChanged={onLogoChanged}
        onSessionExpired={onSessionExpired}
      />
    ),
    members: (
      <>
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
    ),
    roles: (
      <RoleEditor
        roles={roles}
        isLoading={rolesLoading}
        csrfToken={csrfToken}
        theme={theme}
        onChanged={refreshRoles}
        onError={reportSettingsError}
        onSessionExpired={onSessionExpired}
      />
    ),
    channels: (
      <ChannelOverrideEditor
        csrfToken={csrfToken}
        onError={reportSettingsError}
        onSessionExpired={onSessionExpired}
      />
    ),
    permissions: (
      <PermissionMatrix
        roles={roles}
        isLoading={rolesLoading}
        onChange={(roleId, permissions) => void handlePermissionChange(roleId, permissions)}
        busyRoleId={busyRoleId}
      />
    ),
    account: (
      <AccountSettings
        csrfToken={csrfToken}
        user={user}
        theme={theme}
        onThemeChange={onThemeChange}
        onUserUpdated={onUserUpdated}
        onSessionExpired={onSessionExpired}
        onPasswordChanged={onPasswordChanged}
      />
    )
  }[selectedSection];

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
        {settingsError && <p className="form-error" role="alert">{settingsError}</p>}
        <h2 className="settings-section-title">{activeSection.label}</h2>
        {content}
      </div>
    </Modal>
  );
}
