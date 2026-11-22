import { ApiError, isRecord, jsonWrite, requestJson, requestNoContent } from "./http.js";
import { type AuthUser } from "./types.js";
import { isRoleSummary, isStringArray } from "./guards.js";

function isAuthUser(value: unknown): value is AuthUser {
  return isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.login === "string" &&
    isStringArray(value.permissions) &&
    typeof value.isOwner === "boolean" &&
    isStringArray(value.roleIds) &&
    isStringArray(value.roleNames) &&
    (value.theme === "dark" || value.theme === "light") &&
    (value.timezone === null || typeof value.timezone === "string") &&
    Array.isArray(value.roles) && value.roles.every(isRoleSummary);
}

function validCsrfToken(value: unknown): value is string {
  return typeof value === "string" && value.length >= 32 && value.length <= 128;
}

export async function getCsrfToken(): Promise<string> {
  const result = await requestJson<{ csrfToken?: unknown }>("/api/auth/csrf");
  if (!validCsrfToken(result.csrfToken)) {
    throw new ApiError(502, "INVALID_RESPONSE", "Не удалось подготовить защищённый вход");
  }
  return result.csrfToken;
}

export async function login(
  credentials: { login: string; password: string },
  csrfToken: string
): Promise<string> {
  const result = await requestJson<{ csrfToken?: unknown }>("/api/auth/login", jsonWrite("POST", csrfToken, credentials));
  if (!validCsrfToken(result.csrfToken)) {
    throw new ApiError(502, "INVALID_RESPONSE", "Не удалось обновить защищённую сессию");
  }
  return result.csrfToken;
}

export function logout(csrfToken: string): Promise<void> {
  return requestNoContent(
    "/api/auth/logout", "POST", csrfToken, undefined,
    "Сервер вернул некорректный ответ при выходе"
  );
}

export function changePassword(
  credentials: { currentPassword: string; newPassword: string },
  csrfToken: string
): Promise<void> {
  return requestNoContent(
    "/api/auth/password", "POST", csrfToken, credentials,
    "Сервер вернул некорректный ответ при смене пароля"
  );
}

export async function getCurrentUser(): Promise<AuthUser> {
  const result = await requestJson<unknown>("/api/auth/me");
  if (!isAuthUser(result)) {
    throw new ApiError(502, "INVALID_RESPONSE", "Сервер вернул некорректные данные пользователя");
  }
  return result;
}

export async function updatePreferences(
  input: { theme?: "dark" | "light"; timezone?: string | null },
  csrfToken: string
): Promise<AuthUser> {
  const result = await requestJson<unknown>("/api/auth/preferences", jsonWrite("PATCH", csrfToken, input));
  if (!isAuthUser(result)) {
    throw new ApiError(502, "INVALID_RESPONSE", "Сервер вернул некорректные данные пользователя");
  }
  return result;
}
