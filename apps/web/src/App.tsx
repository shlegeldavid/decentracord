import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { AccountPage } from "./AccountPage";
import {
  ApiError,
  getCsrfToken,
  getCurrentUser,
  getMembers,
  getOrganization,
  logout,
  login,
  type AuthUser,
  type Organization
} from "./api";
import { MembersPage } from "./MembersPage";
import { OrganizationSettings } from "./OrganizationSettings";
import { connectRealtime, type RealtimeStatus } from "./realtime";

type ScreenState = "loading" | "guest" | "authenticated";
type WorkspaceView = "home" | "organization" | "members" | "account";

function guestError(error: unknown): string {
  if (error instanceof ApiError && error.status === 401) {
    return "Неверный логин или пароль.";
  }
  return "Не удалось завершить вход. Попробуйте ещё раз.";
}

async function canManageMembers(): Promise<boolean> {
  try {
    await getMembers();
    return true;
  } catch (error) {
    if (error instanceof ApiError && error.status === 403) return false;
    throw error;
  }
}

export function App() {
  const [screen, setScreen] = useState<ScreenState>("loading");
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>("home");
  const [csrfToken, setCsrfToken] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [organization, setOrganization] = useState<Organization | null>(null);
  const [isAdministrator, setIsAdministrator] = useState(false);
  const [loginValue, setLoginValue] = useState("");
  const [password, setPassword] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [realtimeStatus, setRealtimeStatus] = useState<RealtimeStatus>("connecting");
  const loginInput = useRef<HTMLInputElement>(null);
  const realtimeSocket = useRef<ReturnType<typeof connectRealtime> | null>(null);

  const clearPrivateSession = useCallback(() => {
    realtimeSocket.current?.disconnect();
    realtimeSocket.current = null;
    setUser(null);
    setOrganization(null);
    setIsAdministrator(false);
    setWorkspaceView("home");
    setPassword("");
    setErrorMessage(null);
    setSuccessMessage(null);
    setRealtimeStatus("disconnected");
    setScreen("guest");
    void getCsrfToken().then(setCsrfToken).catch(() => setCsrfToken(null));
  }, []);

  useEffect(() => {
    if (screen !== "authenticated" || !user) return;

    const socket = connectRealtime();
    let active = true;
    realtimeSocket.current = socket;
    setRealtimeStatus("connecting");

    const invalidate = () => {
      if (!active) return;
      active = false;
      clearPrivateSession();
    };
    socket.on("session:ready", () => setRealtimeStatus("connected"));
    socket.on("session:revoked", (value: unknown) => {
      if (typeof value === "object" && value !== null && "code" in value && value.code === "SESSION_REVOKED") invalidate();
    });
    socket.on("connect_error", (error) => {
      setRealtimeStatus("disconnected");
      if (error.message === "UNAUTHORIZED") invalidate();
    });
    socket.on("disconnect", (reason) => {
      setRealtimeStatus("disconnected");
      if (reason === "io server disconnect") invalidate();
    });
    socket.connect();

    return () => {
      active = false;
      socket.removeAllListeners();
      socket.disconnect();
      if (realtimeSocket.current === socket) realtimeSocket.current = null;
    };
  }, [screen, user, clearPrivateSession]);

  useEffect(() => {
    let active = true;

    async function initialize(): Promise<void> {
      try {
        const token = await getCsrfToken();
        if (!active) return;
        setCsrfToken(token);

        try {
          const [currentUser, currentOrganization] = await Promise.all([
            getCurrentUser(),
            getOrganization()
          ]);
          const canAdminister = await canManageMembers();
          if (!active) return;
          setUser(currentUser);
          setOrganization(currentOrganization);
          setIsAdministrator(canAdminister);
          setScreen("authenticated");
        } catch (error) {
          if (!active) return;
          setUser(null);
          setOrganization(null);
          setIsAdministrator(false);
          if (error instanceof ApiError && error.status !== 401) {
            setErrorMessage("Не удалось загрузить данные установки. Обновите страницу и попробуйте снова.");
          }
          setScreen("guest");
        }
      } catch {
        if (!active) return;
        setUser(null);
        setOrganization(null);
        setIsAdministrator(false);
        setErrorMessage("Не удалось связаться с сервером. Проверьте подключение и повторите попытку.");
        setScreen("guest");
      }
    }

    void initialize();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (screen === "guest") loginInput.current?.focus();
  }, [screen]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setErrorMessage(null);
    setSuccessMessage(null);
    if (!csrfToken) {
      setErrorMessage("Не удалось подготовить защищённый вход. Обновите страницу.");
      return;
    }

    setIsSubmitting(true);
    let credentialsAccepted = false;
    try {
      const nextCsrfToken = await login({ login: loginValue, password }, csrfToken);
      setCsrfToken(nextCsrfToken);
      credentialsAccepted = true;
      const [currentUser, currentOrganization] = await Promise.all([
        getCurrentUser(),
        getOrganization()
      ]);
      const canAdminister = await canManageMembers();
      setUser(currentUser);
      setOrganization(currentOrganization);
      setIsAdministrator(canAdminister);
      setWorkspaceView("home");
      setPassword("");
      setScreen("authenticated");
    } catch (error) {
      setUser(null);
      setOrganization(null);
      setIsAdministrator(false);
      setScreen("guest");
      if (credentialsAccepted && error instanceof ApiError && error.status === 401) {
        setErrorMessage("Сессия завершилась. Войдите снова.");
      } else {
        setErrorMessage(guestError(error));
      }

      if (error instanceof ApiError && error.status === 403) {
        try {
          setCsrfToken(await getCsrfToken());
        } catch {
          setCsrfToken(null);
        }
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleLogout(): Promise<void> {
    if (!csrfToken) {
      clearPrivateSession();
      return;
    }
    setErrorMessage(null);
    setIsLoggingOut(true);
    try {
      await logout(csrfToken);
      clearPrivateSession();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        clearPrivateSession();
      } else {
        setErrorMessage("Не удалось завершить сеанс. Попробуйте ещё раз.");
      }
    } finally {
      setIsLoggingOut(false);
    }
  }

  function handlePasswordChanged(): void {
    clearPrivateSession();
    setSuccessMessage("Пароль изменён. Войдите снова с новым паролем.");
  }

  if (screen === "loading") {
    return (
      <main className="page-shell">
        <section className="status-card" aria-live="polite">
          <span className="brand-mark" aria-hidden="true">D</span>
          <p className="eyebrow">DECENTRACORD</p>
          <p role="status" className="loading-copy">Проверяем доступ…</p>
        </section>
      </main>
    );
  }

  if (screen === "authenticated" && user && organization && csrfToken) {
    return (
      <main className="workspace-shell">
        <header className="workspace-header">
          <div className="brand-row">
            <span className="brand-mark" aria-hidden="true">D</span>
            <span className="brand-name">Decentracord</span>
          </div>
          <p className="eyebrow">РАБОЧЕЕ ПРОСТРАНСТВО</p>
          <h1 id="workspace-organization-name">{organization.name}</h1>
          <p className="signed-in">Вы вошли как <strong>{user.login}</strong></p>
          <div className="workspace-session-controls">
            <p className="connection-status" role="status" aria-live="polite">
              Защищённое подключение: {realtimeStatus === "connected" ? "подключено" : realtimeStatus === "connecting" ? "подключаемся…" : "нет связи"}
            </p>
            <button type="button" onClick={() => void handleLogout()} disabled={isLoggingOut}>
              {isLoggingOut ? "Выходим…" : "Выйти"}
            </button>
          </div>
          {errorMessage && <p className="form-error" role="alert">{errorMessage}</p>}
        </header>

        <nav className="workspace-nav" aria-label="Разделы">
          {isAdministrator && (
            <>
            <button
              type="button"
              aria-current={workspaceView === "organization" ? "page" : undefined}
              onClick={() => setWorkspaceView("organization")}
            >
              Настройки организации
            </button>
            <button
              type="button"
              aria-current={workspaceView === "members" ? "page" : undefined}
              onClick={() => setWorkspaceView("members")}
            >
              Участники
            </button>
            </>
          )}
          <button
            type="button"
            aria-current={workspaceView === "account" ? "page" : undefined}
            onClick={() => setWorkspaceView("account")}
          >
            Настройки аккаунта
          </button>
        </nav>

        <div className="workspace-content">
          {workspaceView === "account" ? (
            <AccountPage
              csrfToken={csrfToken}
              onChanged={handlePasswordChanged}
              onSessionExpired={clearPrivateSession}
            />
          ) : workspaceView === "organization" && isAdministrator ? (
            <OrganizationSettings
              name={organization.name}
              csrfToken={csrfToken}
              onSaved={(name) => setOrganization({ name })}
            />
          ) : workspaceView === "members" && isAdministrator ? (
            <MembersPage csrfToken={csrfToken} currentUserId={user.id} />
          ) : (
            <section className="welcome-card" aria-labelledby="workspace-title">
              <p className="eyebrow">ДОБРО ПОЖАЛОВАТЬ</p>
              <h2 id="workspace-title">Добро пожаловать</h2>
              <p className="settings-copy">Вы вошли в закрытую организацию.</p>
            </section>
          )}
        </div>
      </main>
    );
  }

  return (
    <main className="page-shell">
      <section className="login-card" aria-labelledby="login-title">
        <div className="brand-row">
          <span className="brand-mark" aria-hidden="true">D</span>
          <span className="brand-name">Decentracord</span>
        </div>
        <p className="eyebrow">ЗАКРЫТАЯ ОРГАНИЗАЦИЯ</p>
        <h1 id="login-title">Вход</h1>
        <p className="intro-copy">Войдите с данными, выданными администратором.</p>

        {successMessage && <p className="form-success" role="status">{successMessage}</p>}
        {errorMessage && <p className="form-error" id="login-error" role="alert">{errorMessage}</p>}

        <form onSubmit={(event) => void handleSubmit(event)} aria-busy={isSubmitting}>
          <label htmlFor="login">Логин</label>
          <input
            autoComplete="username"
            autoCapitalize="none"
            id="login"
            name="login"
            ref={loginInput}
            required
            value={loginValue}
            onChange={(event) => setLoginValue(event.currentTarget.value)}
            aria-describedby={errorMessage ? "login-error" : undefined}
          />

          <label htmlFor="password">Пароль</label>
          <input
            autoComplete="current-password"
            id="password"
            name="password"
            required
            type="password"
            value={password}
            onChange={(event) => setPassword(event.currentTarget.value)}
            aria-describedby={errorMessage ? "login-error" : undefined}
          />

          <button type="submit" disabled={!csrfToken || isSubmitting}>
            {isSubmitting ? "Входим…" : "Войти"}
          </button>
        </form>
      </section>
    </main>
  );
}
