import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { ApiError, createMember, disableMember, getMembers, resetMemberPassword, type Member } from "./api";

interface MembersPageProps {
  csrfToken: string;
  currentUserId: string;
}

function requestError(error: unknown): string {
  if (error instanceof ApiError && error.status === 400) return "Проверьте логин и пароль.";
  if (error instanceof ApiError && error.status === 409) return "Участник с таким логином уже существует.";
  return "Не удалось выполнить запрос. Попробуйте ещё раз.";
}

export function MembersPage({ csrfToken, currentUserId }: MembersPageProps) {
  const [members, setMembers] = useState<Member[]>([]);
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [resetMemberId, setResetMemberId] = useState<string | null>(null);
  const [disableMemberId, setDisableMemberId] = useState<string | null>(null);
  const [resetPasswords, setResetPasswords] = useState<Record<string, string>>({});
  const [resetConfirmed, setResetConfirmed] = useState<Record<string, boolean>>({});
  const [disableConfirmed, setDisableConfirmed] = useState<Record<string, boolean>>({});
  const [actionBusyId, setActionBusyId] = useState<string | null>(null);
  const [actionMessages, setActionMessages] = useState<Record<string, string>>({});
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    let active = true;
    void getMembers().then((items) => {
      if (active) setMembers(items);
    }).catch((error: unknown) => {
      if (active) setErrorMessage(requestError(error));
    }).finally(() => {
      if (active) setIsLoading(false);
    });
    return () => {
      active = false;
    };
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setErrorMessage(null);
    setStatusMessage(null);
    setIsSubmitting(true);
    try {
      await createMember({ login, password }, csrfToken);
      setLogin("");
      setPassword("");
      setStatusMessage("Участник создан. Пароль больше не отображается.");
      setMembers(await getMembers());
    } catch (error) {
      setErrorMessage(requestError(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleReset(event: FormEvent<HTMLFormElement>, member: Member): Promise<void> {
    event.preventDefault();
    setActionErrors((current) => ({ ...current, [member.id]: "" }));
    setActionMessages((current) => ({ ...current, [member.id]: "" }));
    setActionBusyId(member.id);
    try {
      await resetMemberPassword(member.id, resetPasswords[member.id] ?? "", csrfToken);
      setResetPasswords((current) => ({ ...current, [member.id]: "" }));
      setResetConfirmed((current) => ({ ...current, [member.id]: false }));
      setActionMessages((current) => ({ ...current, [member.id]: "Пароль сброшен. Все прежние сеансы завершены." }));
    } catch {
      setActionErrors((current) => ({ ...current, [member.id]: "Не удалось сбросить пароль. Проверьте данные и попробуйте ещё раз." }));
    } finally {
      setActionBusyId(null);
    }
  }

  async function handleDisable(event: FormEvent<HTMLFormElement>, member: Member): Promise<void> {
    event.preventDefault();
    setActionErrors((current) => ({ ...current, [member.id]: "" }));
    setActionMessages((current) => ({ ...current, [member.id]: "" }));
    setActionBusyId(member.id);
    try {
      await disableMember(member.id, csrfToken);
      setMembers((current) => current.map((item) => item.id === member.id ? { ...item, active: false } : item));
      setActionMessages((current) => ({ ...current, [member.id]: "Учётная запись отключена. Все прежние сеансы завершены." }));
      setDisableMemberId(null);
    } catch {
      setActionErrors((current) => ({ ...current, [member.id]: "Не удалось отключить учётную запись. Попробуйте ещё раз." }));
    } finally {
      setActionBusyId(null);
    }
  }

  return (
    <section className="settings-card members-card" aria-labelledby="members-title">
      <p className="eyebrow">УПРАВЛЕНИЕ</p>
      <h2 id="members-title">Участники</h2>
      <p className="settings-copy">Создавайте учётные записи с логином и выданным паролем.</p>
      <form onSubmit={(event) => void handleSubmit(event)} aria-busy={isSubmitting}>
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
          aria-describedby={errorMessage ? "member-form-error" : undefined}
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
          aria-describedby={errorMessage ? "member-form-error" : undefined}
        />
        {errorMessage && <p className="form-error" id="member-form-error" role="alert">{errorMessage}</p>}
        {statusMessage && <p className="form-success" role="status">{statusMessage}</p>}
        <button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Создаём…" : "Создать участника"}
        </button>
      </form>

      <div className="member-list" aria-live="polite" aria-busy={isLoading}>
        <h3>Учётные записи</h3>
        {isLoading ? (
          <p className="loading-copy" role="status">Загружаем участников…</p>
        ) : members.length === 0 ? (
          <p className="settings-copy">Участников пока нет.</p>
        ) : (
          <ul>
            {members.map((member) => (
              <li key={member.id} data-member-id={member.id}>
                <span>{member.login}</span>
                <span className={member.active ? "member-state member-state-active" : "member-state"}>
                  {member.active ? "Активен" : "Отключён"}
                </span>
                {member.active && member.id !== currentUserId && (
                  <div className="member-actions">
                    {resetMemberId === member.id ? (
                      <form onSubmit={(event) => void handleReset(event, member)} aria-busy={actionBusyId === member.id}>
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
                            const value = event.currentTarget.value;
                            setResetPasswords((current) => ({ ...current, [member.id]: value }));
                          }}
                        />
                        <div className="member-confirmation">
                          <input
                            checked={resetConfirmed[member.id] ?? false}
                            id={`member-reset-confirm-${member.id}`}
                            onChange={(event) => {
                              const checked = event.currentTarget.checked;
                              setResetConfirmed((current) => ({ ...current, [member.id]: checked }));
                            }}
                            required
                            type="checkbox"
                          />
                          <label htmlFor={`member-reset-confirm-${member.id}`}>Подтверждаю завершение всех входов сотрудника</label>
                        </div>
                        {actionErrors[member.id] && <p className="form-error" role="alert">{actionErrors[member.id]}</p>}
                        <button type="submit" disabled={actionBusyId === member.id || !resetConfirmed[member.id]}>
                          {actionBusyId === member.id ? "Сбрасываем…" : "Сбросить пароль и завершить входы"}
                        </button>
                      </form>
                    ) : (
                      <button type="button" onClick={() => {
                        setActionErrors((current) => ({ ...current, [member.id]: "" }));
                        setActionMessages((current) => ({ ...current, [member.id]: "" }));
                        setResetMemberId(member.id);
                        setDisableMemberId(null);
                      }}>Сбросить пароль</button>
                    )}
                    {disableMemberId === member.id ? (
                      <form onSubmit={(event) => void handleDisable(event, member)} aria-busy={actionBusyId === member.id}>
                        <div className="member-confirmation">
                          <input
                            checked={disableConfirmed[member.id] ?? false}
                            id={`member-disable-confirm-${member.id}`}
                            onChange={(event) => {
                              const checked = event.currentTarget.checked;
                              setDisableConfirmed((current) => ({ ...current, [member.id]: checked }));
                            }}
                            required
                            type="checkbox"
                          />
                          <label htmlFor={`member-disable-confirm-${member.id}`}>Подтверждаю отключение учётной записи и завершение всех входов</label>
                        </div>
                        {actionErrors[member.id] && <p className="form-error" role="alert">{actionErrors[member.id]}</p>}
                        <button type="submit" disabled={actionBusyId === member.id || !disableConfirmed[member.id]}>
                          {actionBusyId === member.id ? "Отключаем…" : "Подтвердить отключение"}
                        </button>
                      </form>
                    ) : (
                      <button type="button" onClick={() => {
                        setActionErrors((current) => ({ ...current, [member.id]: "" }));
                        setActionMessages((current) => ({ ...current, [member.id]: "" }));
                        setDisableMemberId(member.id);
                        setResetMemberId(null);
                      }}>Отключить</button>
                    )}
                  </div>
                )}
                {actionErrors[member.id] && resetMemberId !== member.id && disableMemberId !== member.id && (
                  <p className="form-error" role="alert">{actionErrors[member.id]}</p>
                )}
                {actionMessages[member.id] && <p className="form-success" role="status">{actionMessages[member.id]}</p>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
