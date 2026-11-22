import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  getChannels,
  getCsrfToken,
  getCurrentUser,
  getOrganization,
  listConversations,
  login,
  logout,
  type AuthUser,
  type Conversation,
  type Organization
} from "../api";

type WorkspaceIdentity = { generation: number; user: AuthUser; organization: Organization };

export type WorkspaceBootstrap = {
  user: AuthUser;
  channelData: Awaited<ReturnType<typeof getChannels>>;
  conversations: Conversation[] | null | undefined;
};

type WorkspaceSessionOptions = {
  applyBootstrap: (data: WorkspaceBootstrap | null) => void;
  clearWorkspace: () => void;
  onError: (message: string | null) => void;
};

const bootstrapError = "Не удалось загрузить данные установки. Обновите страницу и попробуйте снова.";
const passwordChanged = "Пароль изменён. Войдите снова с новым паролем.";

async function loadWorkspace(restore: boolean) {
  const [user, organization, channelData, conversations] = await Promise.all([
    getCurrentUser(),
    getOrganization(),
    getChannels(),
    // Список переписок в восстанавливаемой сессии обновляется независимо от входа.
    restore ? listConversations().catch(() => null) : undefined
  ]);
  return { user, organization, channelData, conversations };
}

function loginFailure(status: number | undefined, credentialsAccepted: boolean): string {
  if (credentialsAccepted) return status === 401 ? "Сессия завершилась. Войдите снова." : bootstrapError;
  return status === 401 ? "Неверный логин или пароль." : "Не удалось завершить вход. Попробуйте ещё раз.";
}

export function useWorkspaceSession({ applyBootstrap, clearWorkspace, onError }: WorkspaceSessionOptions) {
  const [identity, setIdentity] = useState<WorkspaceIdentity | null>();
  const [csrfToken, setCsrfToken] = useState<string | null>(null);
  const [loginValue, setLoginValue] = useState("");
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const generation = useRef(0);
  const loginInFlight = useRef(false);

  const renewToken = useCallback(async (current: number): Promise<string | null> => {
    const token = await getCsrfToken().catch(() => null);
    if (generation.current !== current) return null;
    setCsrfToken(token);
    return token;
  }, []);

  const showGuest = useCallback((error: string | null) => {
    applyBootstrap(null);
    setIdentity(null);
    onError(error);
  }, [applyBootstrap, onError]);

  const openWorkspace = useCallback(async (current: number, restore: boolean) => {
    const data = await loadWorkspace(restore);
    if (generation.current !== current) return;
    applyBootstrap(data);
    setIdentity({ generation: current, user: data.user, organization: data.organization });
  }, [applyBootstrap]);

  useEffect(() => {
    const current = ++generation.current;
    async function restoreWorkspace(): Promise<void> {
      const token = await renewToken(current);
      if (generation.current !== current) return;
      if (!token) {
        showGuest("Не удалось связаться с сервером. Проверьте подключение и повторите попытку.");
        return;
      }
      try {
        await openWorkspace(current, true);
      } catch (error) {
        if (generation.current !== current) return;
        showGuest(error instanceof ApiError && error.status === 401 ? null : bootstrapError);
      }
    }
    void restoreWorkspace();
    return () => { generation.current += 1; };
  }, [openWorkspace, renewToken, showGuest]);

  const resetSession = useCallback((success: string | null = null) => {
    const current = ++generation.current;
    loginInFlight.current = false;
    setIsSubmitting(false);
    setIsLoggingOut(false);
    clearWorkspace();
    setCsrfToken(null);
    setSuccessMessage(success);
    showGuest(null);
    void renewToken(current);
  }, [clearWorkspace, renewToken, showGuest]);

  const currentIdentity = identity?.generation;
  const clearPrivateSession = useCallback(() => {
    if (generation.current === currentIdentity) resetSession();
  }, [currentIdentity, resetSession]);

  const submitLogin = useCallback(async (password: string): Promise<void> => {
    if (loginInFlight.current) return;
    onError(null);
    setSuccessMessage(null);
    if (!csrfToken) {
      onError("Не удалось подготовить защищённый вход. Обновите страницу.");
      return;
    }

    const current = ++generation.current;
    loginInFlight.current = true;
    setIsSubmitting(true);
    let credentialsAccepted = false;
    try {
      const token = await login({ login: loginValue, password }, csrfToken);
      if (generation.current !== current) return;
      setCsrfToken(token);
      credentialsAccepted = true;
      await openWorkspace(current, false);
    } catch (error) {
      if (generation.current !== current) return;
      const status = error instanceof ApiError ? error.status : undefined;
      showGuest(loginFailure(status, credentialsAccepted));
      if (status === 403) await renewToken(current);
    } finally {
      if (generation.current === current) {
        loginInFlight.current = false;
        setIsSubmitting(false);
      }
    }
  }, [csrfToken, loginValue, onError, openWorkspace, renewToken, showGuest]);

  const handleLogout = useCallback(async (): Promise<void> => {
    if (currentIdentity !== generation.current) return;
    onError(null);
    setIsLoggingOut(true);
    try {
      if (csrfToken) await logout(csrfToken);
    } catch (error) {
      if (currentIdentity !== generation.current) return;
      if (!(error instanceof ApiError && error.status === 401)) {
        onError("Не удалось завершить сеанс. Попробуйте ещё раз.");
        setIsLoggingOut(false);
        return;
      }
    }
    if (currentIdentity === generation.current) resetSession();
  }, [csrfToken, currentIdentity, onError, resetSession]);

  const handlePasswordChanged = useCallback(() => {
    if (currentIdentity === undefined) return;
    if (generation.current === currentIdentity) resetSession(passwordChanged);
    // Сокет может сообщить об отзыве раньше подтверждения HTTP-запроса.
    else if (generation.current === currentIdentity + 1) setSuccessMessage(passwordChanged);
  }, [currentIdentity, resetSession]);

  const updateIdentity = useCallback((update: (current: WorkspaceIdentity) => WorkspaceIdentity) => {
    setIdentity((current) => current && current.generation === currentIdentity ? update(current) : current);
  }, [currentIdentity]);

  const updateUser = useCallback((user: AuthUser) => {
    updateIdentity((current) => current.user.id === user.id ? { ...current, user } : current);
  }, [updateIdentity]);

  const updateOrganizationName = useCallback((name: string) => {
    updateIdentity((current) => ({ ...current, organization: { ...current.organization, name } }));
  }, [updateIdentity]);

  const refreshOrganization = useCallback(() => {
    void getOrganization().then((organization) => {
      updateIdentity((current) => ({ ...current, organization }));
    }).catch(() => undefined);
  }, [updateIdentity]);

  const user = identity?.user ?? null;
  const permissions = user?.permissions ?? [];
  const hasAdminPermission = permissions.includes("ADMINISTRATOR");
  const isAdministrator = user?.isOwner === true || hasAdminPermission;
  return {
    screen: identity === undefined ? "loading" : identity === null ? "guest" : "authenticated",
    user,
    organization: identity?.organization ?? null,
    csrfToken,
    loginValue,
    setLoginValue,
    submitLogin,
    handleLogout,
    handlePasswordChanged,
    isSubmitting,
    isLoggingOut,
    successMessage,
    clearPrivateSession,
    updateUser,
    updateOrganizationName,
    refreshOrganization,
    isAdministrator,
    canManageRoles: hasAdminPermission || permissions.includes("MANAGE_ROLES"),
    canManageChannels: isAdministrator || permissions.includes("MANAGE_CHANNELS")
  };
}
