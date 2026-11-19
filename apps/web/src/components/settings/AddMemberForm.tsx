import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { ApiError, createMember, getRoles, type Role } from "../../api";

interface AddMemberFormProps {
  csrfToken: string;
  canManageRoles: boolean;
  onCreated: () => void;
  onError: (message: string) => void;
  onSessionExpired: () => void;
}

function requestError(error: unknown): string {
  if (error instanceof ApiError && error.status === 400) return "Проверьте логин, пароль и роли.";
  if (error instanceof ApiError && error.status === 409) return "Участник с таким логином уже существует.";
  if (error instanceof ApiError && error.code === "MISSING_PERMISSION") return "Вы не можете выдать выбранную роль.";
  if (error instanceof ApiError && error.code === "HIERARCHY") return "Нельзя назначить роль с таким же или более высоким положением.";
  if (error instanceof ApiError && error.status === 403) return "Недостаточно прав для этого действия.";
  return "Не удалось выполнить запрос. Попробуйте ещё раз.";
}

export function AddMemberForm({ csrfToken, canManageRoles, onCreated, onError, onSessionExpired }: AddMemberFormProps) {
  const [roles, setRoles] = useState<Role[]>([]);
  const [isExpanded, setIsExpanded] = useState(false);
  const [isLoadingRoles, setIsLoadingRoles] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [selectedRoleIds, setSelectedRoleIds] = useState<string[]>([]);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!canManageRoles) return;
    let active = true;
    setIsLoadingRoles(true);
    void getRoles().then((items) => {
      if (active) setRoles(items);
    }).catch((error: unknown) => {
      if (!active) return;
      if (error instanceof ApiError && error.status === 401) onSessionExpired();
      else onError("Не удалось загрузить роли для нового участника.");
    }).finally(() => {
      if (active) setIsLoadingRoles(false);
    });
    return () => {
      active = false;
    };
  }, [canManageRoles, onError, onSessionExpired]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setStatusMessage(null);
    setIsSubmitting(true);
    try {
      await createMember({ login, password }, csrfToken, selectedRoleIds);
      setLogin("");
      setPassword("");
      setSelectedRoleIds([]);
      setIsExpanded(false);
      setStatusMessage("Участник создан. Пароль больше не отображается.");
      onCreated();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onSessionExpired();
      else onError(requestError(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <section className="add-member-subsection" aria-labelledby="add-member-title">
      <div className="add-member-heading">
        <h3 id="add-member-title">Добавить</h3>
        <button
          type="button"
          aria-expanded={isExpanded}
          aria-controls="new-member-form"
          onClick={() => {
            setIsExpanded((current) => !current);
            setStatusMessage(null);
          }}
        >
          Добавить участника
        </button>
      </div>
      {statusMessage && <p className="form-success" aria-live="polite">{statusMessage}</p>}
      {isExpanded && (
        <form id="new-member-form" onSubmit={(event) => void handleSubmit(event)} aria-busy={isSubmitting} data-member-create-form>
          <h3>Новый участник</h3>
          <label htmlFor="member-login">Логин</label>
          <input
            autoComplete="off"
            autoCapitalize="none"
            id="member-login"
            maxLength={64}
            minLength={3}
            name="login"
            pattern="[A-Za-z0-9_.-]{3,64}"
            required
            value={login}
            onChange={(event) => setLogin(event.currentTarget.value)}
          />
          <label htmlFor="member-password">Пароль</label>
          <input
            autoComplete="new-password"
            id="member-password"
            maxLength={256}
            minLength={12}
            name="password"
            required
            type="password"
            value={password}
            onChange={(event) => setPassword(event.currentTarget.value)}
          />
          {canManageRoles && (
            <>
              <label htmlFor="new-member-roles">Роли нового участника</label>
              <select
                id="new-member-roles"
                aria-label="Роли нового участника"
                multiple
                disabled={isLoadingRoles}
                size={Math.min(Math.max(roles.filter((role) => role.systemKey === null).length, 2), 6)}
                value={selectedRoleIds}
                onChange={(event) => setSelectedRoleIds(Array.from(event.currentTarget.selectedOptions, (option) => option.value))}
              >
                {roles.filter((role) => role.systemKey === null).map((role) => (
                  <option key={role.id} value={role.id}>{role.name}</option>
                ))}
              </select>
            </>
          )}
          <div className="add-member-actions">
            <button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Создаём…" : "Создать участника"}
            </button>
            <button type="button" className="button-secondary" disabled={isSubmitting} onClick={() => setIsExpanded(false)}>
              Отмена
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
