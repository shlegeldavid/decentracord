export interface AuthUser {
  id: string;
  login: string;
}

export interface Organization {
  name: string;
}

export interface Member {
  id: string;
  login: string;
  active: boolean;
}

interface ErrorResponse {
  error?: {
    code?: unknown;
    message?: unknown;
  };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeError(response: ErrorResponse, status: number): ApiError {
  const code = typeof response.error?.code === "string" ? response.error.code : "REQUEST_FAILED";
  const message = typeof response.error?.message === "string" && response.error.message.length <= 160
    ? response.error.message
    : "Не удалось выполнить запрос";
  return new ApiError(status, code, message);
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("accept", "application/json");
  const response = await fetch(path, {
    ...init,
    cache: "no-store",
    credentials: "same-origin",
    headers
  });
  const text = await response.text();
  let payload: unknown;

  try {
    payload = text.length > 0 ? JSON.parse(text) as unknown : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    throw safeError(isRecord(payload) ? payload as ErrorResponse : {}, response.status);
  }
  if (!isRecord(payload)) {
    throw new ApiError(502, "INVALID_RESPONSE", "Сервер вернул некорректный ответ");
  }
  return payload as T;
}

export async function getCsrfToken(): Promise<string> {
  const result = await requestJson<{ csrfToken?: unknown }>("/api/auth/csrf");
  if (typeof result.csrfToken !== "string" || result.csrfToken.length < 32 || result.csrfToken.length > 128) {
    throw new ApiError(502, "INVALID_RESPONSE", "Не удалось подготовить защищённый вход");
  }
  return result.csrfToken;
}

export async function login(
  credentials: { login: string; password: string },
  csrfToken: string
): Promise<string> {
  const result = await requestJson<{ csrfToken?: unknown }>("/api/auth/login", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": csrfToken
    },
    body: JSON.stringify(credentials)
  });
  if (typeof result.csrfToken !== "string" || result.csrfToken.length < 32 || result.csrfToken.length > 128) {
    throw new ApiError(502, "INVALID_RESPONSE", "Не удалось обновить защищённую сессию");
  }
  return result.csrfToken;
}

export async function logout(csrfToken: string): Promise<void> {
  const response = await fetch("/api/auth/logout", {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      "x-csrf-token": csrfToken
    }
  });
  if (!response.ok) {
    const text = await response.text();
    let payload: unknown;
    try {
      payload = text.length > 0 ? JSON.parse(text) as unknown : null;
    } catch {
      payload = null;
    }
    throw safeError(isRecord(payload) ? payload as ErrorResponse : {}, response.status);
  }
  if (response.status !== 204) {
    throw new ApiError(502, "INVALID_RESPONSE", "Сервер вернул некорректный ответ при выходе");
  }
}

export async function changePassword(
  credentials: { currentPassword: string; newPassword: string },
  csrfToken: string
): Promise<void> {
  const response = await fetch("/api/auth/password", {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-csrf-token": csrfToken
    },
    body: JSON.stringify(credentials)
  });
  if (!response.ok) {
    const text = await response.text();
    let payload: unknown;
    try {
      payload = text.length > 0 ? JSON.parse(text) as unknown : null;
    } catch {
      payload = null;
    }
    throw safeError(isRecord(payload) ? payload as ErrorResponse : {}, response.status);
  }
  if (response.status !== 204) {
    throw new ApiError(502, "INVALID_RESPONSE", "Сервер вернул некорректный ответ при смене пароля");
  }
}

export async function getCurrentUser(): Promise<AuthUser> {
  const result = await requestJson<{ id?: unknown; login?: unknown }>("/api/auth/me");
  if (typeof result.id !== "string" || typeof result.login !== "string") {
    throw new ApiError(502, "INVALID_RESPONSE", "Сервер вернул некорректные данные пользователя");
  }
  return { id: result.id, login: result.login };
}

export async function getOrganization(): Promise<Organization> {
  const result = await requestJson<{ name?: unknown }>("/api/organization");
  if (typeof result.name !== "string" || Array.from(result.name).length < 1 || Array.from(result.name).length > 100) {
    throw new ApiError(502, "INVALID_RESPONSE", "Сервер вернул некорректные данные организации");
  }
  return { name: result.name };
}

export async function updateOrganization(name: string, csrfToken: string): Promise<Organization> {
  const result = await requestJson<{ name?: unknown }>("/api/organization", {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": csrfToken
    },
    body: JSON.stringify({ name })
  });
  if (typeof result.name !== "string" || Array.from(result.name).length < 1 || Array.from(result.name).length > 100) {
    throw new ApiError(502, "INVALID_RESPONSE", "Сервер вернул некорректные данные организации");
  }
  return { name: result.name };
}

export async function getMembers(): Promise<Member[]> {
  const result = await requestJson<{ members?: unknown }>("/api/members");
  if (!Array.isArray(result.members)) {
    throw new ApiError(502, "INVALID_RESPONSE", "Сервер вернул некорректный список участников");
  }

  return result.members.map((value) => {
    if (
      !isRecord(value) ||
      typeof value.id !== "string" ||
      typeof value.login !== "string" ||
      typeof value.active !== "boolean"
    ) {
      throw new ApiError(502, "INVALID_RESPONSE", "Сервер вернул некорректный список участников");
    }
    return { id: value.id, login: value.login, active: value.active };
  });
}

export async function createMember(
  credentials: { login: string; password: string },
  csrfToken: string
): Promise<Member> {
  const result = await requestJson<{ id?: unknown; login?: unknown; active?: unknown }>("/api/members", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": csrfToken
    },
    body: JSON.stringify(credentials)
  });
  if (typeof result.id !== "string" || typeof result.login !== "string" || typeof result.active !== "boolean") {
    throw new ApiError(502, "INVALID_RESPONSE", "Сервер вернул некорректные данные участника");
  }
  return { id: result.id, login: result.login, active: result.active };
}

async function postMemberAction(path: string, csrfToken: string, body?: unknown): Promise<void> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "x-csrf-token": csrfToken
  };
  const init: RequestInit = {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    headers
  };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const response = await fetch(path, init);
  if (!response.ok) {
    const text = await response.text();
    let payload: unknown;
    try {
      payload = text.length > 0 ? JSON.parse(text) as unknown : null;
    } catch {
      payload = null;
    }
    throw safeError(isRecord(payload) ? payload as ErrorResponse : {}, response.status);
  }
  if (response.status !== 204) {
    throw new ApiError(502, "INVALID_RESPONSE", "Сервер вернул некорректный ответ при изменении доступа");
  }
}

export function resetMemberPassword(memberId: string, newPassword: string, csrfToken: string): Promise<void> {
  return postMemberAction(`/api/members/${encodeURIComponent(memberId)}/reset-password`, csrfToken, { newPassword });
}

export function disableMember(memberId: string, csrfToken: string): Promise<void> {
  return postMemberAction(`/api/members/${encodeURIComponent(memberId)}/disable`, csrfToken);
}
