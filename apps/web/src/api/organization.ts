import { ApiError, expectNoContent, isRecord, jsonWrite, requestJson, requestNoContent } from "./http.js";
import { type Organization, type ReadRetention } from "./types.js";

function isReadRetention(value: unknown): value is ReadRetention {
  return isRecord(value) &&
    typeof value.keepForever === "boolean" &&
    (value.days === null || (typeof value.days === "number" && Number.isInteger(value.days)));
}

// Поле logoUrl сервер отдаёт как относительный путь либо null. Значение любого
// другого типа — повод отклонить ответ целиком, а не потерять логотип молча.
function parseOrganizationLogoUrl(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new ApiError(502, "INVALID_RESPONSE", "Сервер вернул некорректные данные организации");
  }
  return value;
}

export async function getOrganization(): Promise<Organization> {
  const result = await requestJson<{ name?: unknown; logoUrl?: unknown }>("/api/organization");
  if (typeof result.name !== "string" || Array.from(result.name).length < 1 || Array.from(result.name).length > 100) {
    throw new ApiError(502, "INVALID_RESPONSE", "Сервер вернул некорректные данные организации");
  }
  return { name: result.name, logoUrl: parseOrganizationLogoUrl(result.logoUrl) };
}

export async function updateOrganization(
  name: string,
  csrfToken: string,
  currentLogoUrl: string | null = null
): Promise<Organization> {
  const result = await requestJson<{ name?: unknown; logoUrl?: unknown }>("/api/organization", jsonWrite("PATCH", csrfToken, { name }));
  if (typeof result.name !== "string" || Array.from(result.name).length < 1 || Array.from(result.name).length > 100) {
    throw new ApiError(502, "INVALID_RESPONSE", "Сервер вернул некорректные данные организации");
  }
  // Если сервер не прислал поле, прежний логотип сохраняется: переименование
  // организации не должно убирать его из шапки.
  const logoUrl = result.logoUrl === undefined
    ? currentLogoUrl
    : parseOrganizationLogoUrl(result.logoUrl);
  return { name: result.name, logoUrl };
}

// Загрузка логотипа: тело запроса — сам файл PNG, а не JSON и не base64:
// base64 не влезает в лимит 32 КБ и раздувает тело на треть.
export async function uploadOrganizationLogo(file: File, csrfToken: string): Promise<void> {
  const response = await fetch("/api/organization/logo", {
    method: "PUT",
    cache: "no-store",
    credentials: "same-origin",
    headers: {
      accept: "image/png",
      "content-type": "image/png",
      "x-csrf-token": csrfToken
    },
    body: file
  });
  await expectNoContent(response, "Сервер вернул некорректный ответ при загрузке логотипа");
}

export function deleteOrganizationLogo(csrfToken: string): Promise<void> {
  return requestNoContent(
    "/api/organization/logo",
    "DELETE",
    csrfToken,
    undefined,
    "Сервер вернул некорректный ответ при удалении логотипа"
  );
}

export async function getReadRetention(): Promise<ReadRetention> {
  const result = await requestJson<unknown>("/api/organization/read-retention");
  if (!isReadRetention(result)) {
    throw new ApiError(502, "INVALID_RESPONSE", "Сервер вернул некорректные данные срока хранения");
  }
  return result;
}

export async function updateReadRetention(payload: ReadRetention, csrfToken: string): Promise<ReadRetention> {
  const result = await requestJson<unknown>("/api/organization/read-retention", jsonWrite("PATCH", csrfToken, payload));
  if (!isReadRetention(result)) {
    throw new ApiError(502, "INVALID_RESPONSE", "Сервер вернул некорректные данные срока хранения");
  }
  return result;
}
