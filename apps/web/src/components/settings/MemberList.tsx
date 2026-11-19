import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import {
  ApiError,
  assignMemberRoles,
  disableMember,
  getMembers,
  getRoles,
  resetMemberPassword,
  type Member,
  type Role
} from "../../api";
import { ConfirmDialog } from "../ui/ConfirmDialog";

interface MemberListProps {
  csrfToken: string;
  currentUserId: string;
  canManageRoles: boolean;
  isAdministrator: boolean;
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

export function MemberList({
  csrfToken,
  currentUserId,
  canManageRoles,
  isAdministrator,
  onError,
  onSessionExpired
}: MemberListProps) {
  const [members, setMembers] = useState<Member[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [roleEditMemberId, setRoleEditMemberId] = useState<string | null>(null);
  const [memberRoleSelections, setMemberRoleSelections] = useState<Record<string, string[]>>({});
  const [roleBusyId, setRoleBusyId] = useState<string | null>(null);
  const [roleMessages, setRoleMessages] = useState<Record<string, string>>({});
  const [roleErrors, setRoleErrors] = useState<Record<string, string>>({});
  const [resetMemberId, setResetMemberId] = useState<string | null>(null);
  const [resetPasswords, setResetPasswords] = useState<Record<string, string>>({});
  const [resetDialogMemberId, setResetDialogMemberId] = useState<string | null>(null);
  const [disableDialogMemberId, setDisableDialogMemberId] = useState<string | null>(null);
  const [actionBusyId, setActionBusyId] = useState<string | null>(null);
  const [actionMessages, setActionMessages] = useState<Record<string, string>>({});
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    let active = true;
    void Promise.all([getMembers(), canManageRoles ? getRoles() : Promise.resolve([])]).then(([items, availableRoles]) => {
      if (active) {
        setMembers(items);
        setRoles(availableRoles);
      }
    }).catch((error: unknown) => {
      if (!active) return;
      if (error instanceof ApiError && error.status === 401) onSessionExpired();
      else onError("Не удалось загрузить список участников.");
    }).finally(() => {
      if (active) setIsLoading(false);
    });
    return () => {
      active = false;
    };
  }, [canManageRoles, onError, onSessionExpired]);

  async function refreshMembers(): Promise<void> {
    setMembers(await getMembers());
  }

  function reportRowError(memberId: string, error: unknown, fallback: string): void {
    if (error instanceof ApiError && error.status === 401) {
      onSessionExpired();
      return;
    }
    setActionErrors((current) => ({ ...current, [memberId]: error instanceof ApiError ? requestError(error) : fallback }));
  }

  async function handleAssignRoles(event: FormEvent<HTMLFormElement>, member: Member): Promise<void> {
    event.preventDefault();
    setRoleErrors((current) => ({ ...current, [member.id]: "" }));
    setRoleMessages((current) => ({ ...current, [member.id]: "" }));
    setActionErrors((current) => ({ ...current, [member.id]: "" }));
    setActionMessages((current) => ({ ...current, [member.id]: "" }));
    setRoleBusyId(member.id);
    try {
      await assignMemberRoles(member.id, memberRoleSelections[member.id] ?? member.roleIds, csrfToken);
      await refreshMembers();
      setRoleEditMemberId(null);
      setRoleMessages((current) => ({ ...current, [member.id]: "Роли участника сохранены." }));
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onSessionExpired();
      else setRoleErrors((current) => ({ ...current, [member.id]: requestError(error) }));
    } finally {
      setRoleBusyId(null);
    }
  }

  async function confirmResetPassword(member: Member): Promise<void> {
    setActionErrors((current) => ({ ...current, [member.id]: "" }));
    setActionMessages((current) => ({ ...current, [member.id]: "" }));
    setActionBusyId(member.id);
    try {
      await resetMemberPassword(member.id, resetPasswords[member.id] ?? "", csrfToken);
      setResetPasswords((current) => ({ ...current, [member.id]: "" }));
      setResetMemberId(null);
      setResetDialogMemberId(null);
      setActionMessages((current) => ({ ...current, [member.id]: "Пароль сброшен. Все прежние сеансы завершены." }));
    } catch (error) {
      reportRowError(member.id, error, "Не удалось сбросить пароль. Проверьте данные и попробуйте ещё раз.");
      setResetDialogMemberId(null);
    } finally {
      setActionBusyId(null);
    }
  }

  async function confirmDisableMember(member: Member): Promise<void> {
    setActionErrors((current) => ({ ...current, [member.id]: "" }));
    setActionMessages((current) => ({ ...current, [member.id]: "" }));
    setActionBusyId(member.id);
    try {
      await disableMember(member.id, csrfToken);
      setMembers((current) => current.map((item) => item.id === member.id ? { ...item, active: false } : item));
      setActionMessages((current) => ({ ...current, [member.id]: "Учётная запись отключена. Все прежние сеансы завершены." }));
      setDisableDialogMemberId(null);
    } catch (error) {
      reportRowError(member.id, error, "Не удалось отключить учётную запись. Попробуйте ещё раз.");
      setDisableDialogMemberId(null);
    } finally {
      setActionBusyId(null);
    }
  }

  return (
    <section className="member-list-section" aria-label="Список участников">
      <h3 className="settings-subsection-title">Учётные записи</h3>
      <div className="member-list" aria-live="polite" aria-busy={isLoading}>
        {isLoading ? (
          <p className="loading-copy" aria-live="polite">Загружаем участников…</p>
        ) : members.length === 0 ? (
          <p className="settings-copy">Участников пока нет.</p>
        ) : (
          <ul>
            {members.map((member) => (
              <li className="member-list-row" key={member.id} data-member-id={member.id}>
                <span className="member-list-login">{member.login}</span>
                <span className={member.active ? "member-state member-state-active" : "member-state"}>
                  {member.active ? "Активен" : "Отключён"}
                </span>
                <span className="member-roles">Роли: {member.roleNames.length > 0 ? member.roleNames.join(", ") : "не назначены"}</span>

                {member.active && member.id !== currentUserId && (
                  <div className="member-actions">
                    {canManageRoles && (roleEditMemberId === member.id ? (
                      <form onSubmit={(event) => void handleAssignRoles(event, member)} aria-busy={roleBusyId === member.id}>
                        <label htmlFor={`member-role-assignment-${member.id}`}>Роли для {member.login}</label>
                        <select
                          id={`member-role-assignment-${member.id}`}
                          aria-label={`Роли для ${member.login}`}
                          multiple
                          size={Math.min(Math.max(roles.filter((role) => role.systemKey === null).length, 2), 6)}
                          value={memberRoleSelections[member.id] ?? member.roleIds}
                          onChange={(event) => {
                            const roleIds = Array.from(event.currentTarget.selectedOptions, (option) => option.value);
                            setMemberRoleSelections((current) => ({ ...current, [member.id]: roleIds }));
                          }}
                        >
                          {roles.filter((role) => role.systemKey === null).map((role) => (
                            <option key={role.id} value={role.id}>{role.name}</option>
                          ))}
                        </select>
                        {roleErrors[member.id] && <p className="form-error" role="alert">{roleErrors[member.id]}</p>}
                        <div className="role-actions">
                          <button type="submit" disabled={roleBusyId === member.id}>
                            {roleBusyId === member.id ? "Сохраняем…" : "Сохранить роли"}
                          </button>
                          <button type="button" disabled={roleBusyId === member.id} onClick={() => setRoleEditMemberId(null)}>Отмена</button>
                        </div>
                      </form>
                    ) : canManageRoles ? (
                      <button type="button" onClick={() => {
                        setRoleErrors((current) => ({ ...current, [member.id]: "" }));
                        setRoleMessages((current) => ({ ...current, [member.id]: "" }));
                        setActionErrors((current) => ({ ...current, [member.id]: "" }));
                        setActionMessages((current) => ({ ...current, [member.id]: "" }));
                        setMemberRoleSelections((current) => ({ ...current, [member.id]: member.roleIds }));
                        setRoleEditMemberId(member.id);
                        setResetMemberId(null);
                        setDisableDialogMemberId(null);
                        setResetDialogMemberId(null);
                      }}>Роли</button>
                    ) : null)}

                    {isAdministrator && (resetMemberId === member.id ? (
                      <form className="member-reset-form" onSubmit={(event) => event.preventDefault()}>
                        <label htmlFor={`member-reset-password-${member.id}`}>Новый пароль для {member.login}</label>
                        <input
                          autoComplete="new-password"
                          id={`member-reset-password-${member.id}`}
                          minLength={12}
                          maxLength={256}
                          required
                          type="password"
                          value={resetPasswords[member.id] ?? ""}
                          onChange={(event) => {
                            const password = event.currentTarget.value;
                            setResetPasswords((current) => ({ ...current, [member.id]: password }));
                          }}
                        />
                        <button
                          type="button"
                          disabled={(resetPasswords[member.id] ?? "").length < 12 || actionBusyId === member.id}
                          onClick={() => setResetDialogMemberId(member.id)}
                        >
                          Сбросить пароль
                        </button>
                      </form>
                    ) : (
                      <button type="button" onClick={() => {
                        setActionErrors((current) => ({ ...current, [member.id]: "" }));
                        setActionMessages((current) => ({ ...current, [member.id]: "" }));
                        setRoleErrors((current) => ({ ...current, [member.id]: "" }));
                        setRoleMessages((current) => ({ ...current, [member.id]: "" }));
                        setResetMemberId(member.id);
                        setResetDialogMemberId(null);
                        setDisableDialogMemberId(null);
                        setRoleEditMemberId(null);
                      }}>Сбросить пароль</button>
                    ))}

                    {isAdministrator && (
                      <button type="button" onClick={() => {
                        setActionErrors((current) => ({ ...current, [member.id]: "" }));
                        setActionMessages((current) => ({ ...current, [member.id]: "" }));
                        setRoleErrors((current) => ({ ...current, [member.id]: "" }));
                        setRoleMessages((current) => ({ ...current, [member.id]: "" }));
                        setDisableDialogMemberId(member.id);
                        setResetDialogMemberId(null);
                        setResetMemberId(null);
                        setRoleEditMemberId(null);
                      }}>Отключить</button>
                    )}
                  </div>
                )}

                {actionErrors[member.id] && <p className="form-error" role="alert">{actionErrors[member.id]}</p>}
                {roleErrors[member.id] && roleEditMemberId !== member.id && (
                  <p className="form-error" role="alert">{roleErrors[member.id]}</p>
                )}
                {actionMessages[member.id] && <p className="form-success" role="status">{actionMessages[member.id]}</p>}
                {roleMessages[member.id] && <p className="form-success" role="status">{roleMessages[member.id]}</p>}

                <ConfirmDialog
                  open={resetDialogMemberId === member.id}
                  title="Сбросить пароль"
                  description={`Сброс пароля участника ${member.login} завершит все его входы.`}
                  confirmCheckboxLabel="Подтверждаю завершение всех входов сотрудника"
                  confirmLabel="Сбросить пароль и завершить входы"
                  onConfirm={() => void confirmResetPassword(member)}
                  onCancel={() => setResetDialogMemberId(null)}
                  busy={actionBusyId === member.id}
                />
                <ConfirmDialog
                  open={disableDialogMemberId === member.id}
                  title="Отключить участника"
                  description={`Учётная запись ${member.login} будет отключена, а все входы завершены.`}
                  confirmCheckboxLabel="Подтверждаю отключение учётной записи и завершение всех входов"
                  confirmLabel="Отключить участника"
                  onConfirm={() => void confirmDisableMember(member)}
                  onCancel={() => setDisableDialogMemberId(null)}
                  busy={actionBusyId === member.id}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
