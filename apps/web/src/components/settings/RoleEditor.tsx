import { useState } from "react";
import type { FormEvent } from "react";
import {
  ApiError,
  createRole,
  reorderRoles,
  updateRole,
  type Role
} from "../../api";
import { PERMISSION_LABELS } from "../../lib/permissions";
import { ROLE_COLOR_PALETTE, roleColorForTheme } from "../../lib/roles";
import type { Theme } from "../../lib/roles";

type Permission = keyof typeof PERMISSION_LABELS;

interface RoleEditorProps {
  roles: Role[];
  isLoading?: boolean;
  csrfToken: string;
  theme: Theme;
  onChanged: () => Promise<void> | void;
  onError: (message: string) => void;
  onSessionExpired: () => void;
}

const permissions = Object.keys(PERMISSION_LABELS) as Permission[];

function requestError(error: unknown): string {
  if (!(error instanceof ApiError)) return "Не удалось выполнить запрос. Попробуйте ещё раз.";
  if (error.code === "ROLE_ALREADY_EXISTS") return "Роль с таким названием уже существует.";
  if (error.code === "MISSING_PERMISSION") return "Вы не можете выдать разрешение, которого нет у вас.";
  if (error.code === "HIERARCHY") return "Нельзя изменить роль с таким же или более высоким положением.";
  if (error.code === "FORBIDDEN" || error.status === 403) return "Недостаточно прав для этого действия.";
  if (error.status === 400) return "Проверьте название роли и выбранные разрешения.";
  return "Не удалось выполнить запрос. Попробуйте ещё раз.";
}

function ColorPalette({
  name,
  value,
  theme,
  onChange
}: {
  name: string;
  value: string | null;
  theme: Theme;
  onChange: (value: string | null) => void;
}) {
  return (
    <fieldset className="role-color-palette">
      <legend>Цвет роли</legend>
      <div className="role-color-options">
        <label htmlFor={`${name}-none`}>
          <input
            checked={value === null}
            id={`${name}-none`}
            name={name}
            onChange={() => onChange(null)}
            type="radio"
          />
          <span>Без цвета</span>
        </label>
        {ROLE_COLOR_PALETTE.map((entry) => (
          <label htmlFor={`${name}-${entry.name}`} key={entry.base}>
            <input
              checked={value?.toLowerCase() === entry.base.toLowerCase()}
              id={`${name}-${entry.name}`}
              name={name}
              onChange={() => onChange(entry.base)}
              type="radio"
            />
            <span className="role-color-swatch" style={{ backgroundColor: roleColorForTheme(entry.base, theme) ?? entry.base }} aria-hidden="true" />
            <span>{entry.name}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function PermissionChoices({
  idPrefix,
  roleName,
  selected,
  disabled,
  onChange
}: {
  idPrefix: string;
  roleName: string;
  selected: string[];
  disabled?: boolean;
  onChange: (permission: Permission, enabled: boolean) => void;
}) {
  return (
    <fieldset className="role-permissions" disabled={disabled}>
      <legend>Базовые разрешения</legend>
      {permissions.map((permission) => (
        <label key={permission} htmlFor={`${idPrefix}-${permission}`}>
          <input
            checked={selected.includes(permission)}
            id={`${idPrefix}-${permission}`}
            aria-label={idPrefix === "new-role-permission" ? `Новое разрешение ${permission}` : `Разрешение ${permission} для ${roleName}`}
            onChange={(event) => onChange(permission, event.currentTarget.checked)}
            type="checkbox"
          />
          <span>{PERMISSION_LABELS[permission]}</span>
        </label>
      ))}
    </fieldset>
  );
}

export function RoleEditor({ roles, isLoading = false, csrfToken, theme, onChanged, onError, onSessionExpired }: RoleEditorProps) {
  const [newRoleName, setNewRoleName] = useState("");
  const [newRoleColor, setNewRoleColor] = useState<string | null>(ROLE_COLOR_PALETTE[0]?.base ?? null);
  const [newRolePermissions, setNewRolePermissions] = useState<string[]>([]);
  const [editingRoleId, setEditingRoleId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [editColor, setEditColor] = useState<string | null>(null);
  const [editPermissions, setEditPermissions] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [busyRoleId, setBusyRoleId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const displayRoles = [...roles].sort((left, right) => right.position - left.position || left.name.localeCompare(right.name));
  const editableRoles = displayRoles.filter((role) => role.editable);

  function reportRequestError(error: unknown): void {
    if (error instanceof ApiError && error.status === 401) {
      onSessionExpired();
      return;
    }
    onError(requestError(error));
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setStatusMessage(null);
    setIsSubmitting(true);
    try {
      const created = await createRole({
        name: newRoleName,
        permissions: newRolePermissions,
        color: newRoleColor
      }, csrfToken);
      await onChanged();
      setNewRoleName("");
      setNewRoleColor(ROLE_COLOR_PALETTE[0]?.base ?? null);
      setNewRolePermissions([]);
      setStatusMessage(`Роль «${created.name}» создана.`);
    } catch (error) {
      reportRequestError(error);
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleSaveRole(event: FormEvent<HTMLFormElement>, role: Role): Promise<void> {
    event.preventDefault();
    setStatusMessage(null);
    setBusyRoleId(role.id);
    try {
      const updated = await updateRole(role.id, {
        name: renameValue,
        permissions: editPermissions,
        color: editColor
      }, csrfToken);
      await onChanged();
      setEditingRoleId(null);
      setStatusMessage(`Название роли изменено на «${updated.name}».`);
    } catch (error) {
      reportRequestError(error);
    } finally {
      setBusyRoleId(null);
    }
  }

  async function moveRole(roleId: string, direction: -1 | 1): Promise<void> {
    const index = editableRoles.findIndex((role) => role.id === roleId);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= editableRoles.length) return;
    const reordered = [...editableRoles];
    [reordered[index], reordered[nextIndex]] = [reordered[nextIndex]!, reordered[index]!];
    setStatusMessage(null);
    setBusyRoleId(roleId);
    try {
      await reorderRoles(reordered.reverse().map((role) => role.id), csrfToken);
      await onChanged();
      setStatusMessage("Порядок ролей изменён.");
    } catch (error) {
      reportRequestError(error);
    } finally {
      setBusyRoleId(null);
    }
  }

  return (
    <section className="role-editor" aria-label="Редактор ролей">
      <p className="eyebrow">УПРАВЛЕНИЕ</p>
      <p className="settings-copy">Создавайте роли, задавайте разрешения и меняйте порядок.</p>
      {statusMessage && <p className="form-success" aria-live="polite">{statusMessage}</p>}

      <form onSubmit={(event) => void handleCreate(event)} aria-busy={isSubmitting} data-role-create-form>
        <h3 className="settings-subsection-title">Создать роль</h3>
        <label htmlFor="new-role-name">Название роли</label>
        <input
          autoComplete="off"
          id="new-role-name"
          maxLength={80}
          required
          value={newRoleName}
          onChange={(event) => setNewRoleName(event.currentTarget.value)}
        />
        <ColorPalette name="new-role-color" value={newRoleColor} theme={theme} onChange={setNewRoleColor} />
        <PermissionChoices
          idPrefix="new-role-permission"
          roleName="Новая роль"
          selected={newRolePermissions}
          onChange={(permission, enabled) => setNewRolePermissions((current) => enabled
            ? [...new Set([...current, permission])]
            : current.filter((item) => item !== permission))}
        />
        <button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Создаём…" : "Создать роль"}
        </button>
      </form>

      <div className="role-list" aria-busy={busyRoleId !== null}>
        <h3>Список ролей</h3>
        {isLoading ? (
          <p className="loading-copy" aria-live="polite">Загружаем роли…</p>
        ) : roles.length === 0 ? (
          <p className="settings-copy">Ролей пока нет.</p>
        ) : (
          <ul>
            {displayRoles.map((role) => {
              const editableIndex = editableRoles.findIndex((item) => item.id === role.id);
              const isEditing = editingRoleId === role.id;
              return (
                <li key={role.id} data-role-id={role.id}>
                  <div className="role-heading">
                    {isEditing ? (
                      <form onSubmit={(event) => void handleSaveRole(event, role)} aria-busy={busyRoleId === role.id}>
                        <label htmlFor={`rename-role-${role.id}`}>Название роли</label>
                        <input
                          autoComplete="off"
                          id={`rename-role-${role.id}`}
                          maxLength={80}
                          required
                          value={renameValue}
                          onChange={(event) => setRenameValue(event.currentTarget.value)}
                        />
                        <ColorPalette name={`edit-role-color-${role.id}`} value={editColor} theme={theme} onChange={setEditColor} />
                        <PermissionChoices
                          idPrefix={`edit-role-${role.id}`}
                          roleName={role.name}
                          selected={editPermissions}
                          disabled={!role.editable || busyRoleId === role.id}
                          onChange={(permission, enabled) => setEditPermissions((current) => enabled
                            ? [...new Set([...current, permission])]
                            : current.filter((item) => item !== permission))}
                        />
                        <div className="role-actions">
                          <button type="submit" disabled={busyRoleId === role.id}>
                            {busyRoleId === role.id ? "Сохраняем…" : "Сохранить роль"}
                          </button>
                          <button type="button" disabled={busyRoleId === role.id} onClick={() => setEditingRoleId(null)}>Отмена</button>
                        </div>
                      </form>
                    ) : (
                      <>
                        <div className="role-editor-name">
                          <strong>{role.name}</strong>
                          <span className="role-position">Позиция {role.position}</span>
                          {role.color && (
                            <span
                              className="role-color-swatch"
                              style={{ backgroundColor: roleColorForTheme(role.color, theme) ?? role.color }}
                              aria-hidden="true"
                            />
                          )}
                        </div>
                        {role.editable && (
                          <button type="button" onClick={() => {
                            setEditingRoleId(role.id);
                            setRenameValue(role.name);
                            setEditColor(role.color);
                            setEditPermissions(role.permissions);
                          }}>Переименовать</button>
                        )}
                      </>
                    )}
                  </div>
                  {!role.editable && <p className="role-system-note">Роль доступна только для чтения.</p>}
                  {role.editable && !isEditing && (
                    <div className="role-order">
                      <span>Порядок</span>
                      <div className="role-actions">
                        <button type="button" disabled={editableIndex <= 0 || busyRoleId === role.id} onClick={() => void moveRole(role.id, -1)}>Выше</button>
                        <button type="button" disabled={editableIndex === editableRoles.length - 1 || busyRoleId === role.id} onClick={() => void moveRole(role.id, 1)}>Ниже</button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
