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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requestFailed(status: number, payload: unknown): ApiError {
  const response = isRecord(payload) ? payload as ErrorResponse : {};
  const error = response.error;
  const code = typeof error?.code === "string" ? error.code : "REQUEST_FAILED";
  const message = typeof error?.message === "string" && error.message.length <= 160
    ? error.message
    : "Не удалось выполнить запрос";
  return new ApiError(status, code, message);
}

async function readPayload(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return text.length > 0 ? JSON.parse(text) as unknown : null;
  } catch {
    return null;
  }
}

export function jsonWrite(method: "POST" | "PATCH" | "PUT", csrfToken: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
    body: JSON.stringify(body)
  };
}

export async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("accept", "application/json");
  const response = await fetch(path, { ...init, cache: "no-store", credentials: "same-origin", headers });
  const payload = await readPayload(response);
  if (!response.ok) throw requestFailed(response.status, payload);
  if (!isRecord(payload)) {
    throw new ApiError(502, "INVALID_RESPONSE", "Сервер вернул некорректный ответ");
  }
  return payload as T;
}

export async function expectNoContent(response: Response, invalidResponseMessage: string): Promise<void> {
  if (!response.ok) throw requestFailed(response.status, await readPayload(response));
  if (response.status !== 204) {
    throw new ApiError(502, "INVALID_RESPONSE", invalidResponseMessage);
  }
}

export async function requestNoContent(
  path: string,
  method: "PATCH" | "PUT" | "POST" | "DELETE",
  csrfToken: string,
  body?: unknown,
  invalidResponseMessage = "Сервер вернул некорректный ответ при изменении ролей"
): Promise<void> {
  const headers: Record<string, string> = { accept: "application/json", "x-csrf-token": csrfToken };
  const init: RequestInit = { method, cache: "no-store", credentials: "same-origin", headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  await expectNoContent(await fetch(path, init), invalidResponseMessage);
}

export function postNoContent(
  path: string,
  csrfToken: string,
  body?: unknown,
  invalidResponseMessage = "Сервер вернул некорректный ответ при изменении доступа"
): Promise<void> {
  return requestNoContent(path, "POST", csrfToken, body, invalidResponseMessage);
}
