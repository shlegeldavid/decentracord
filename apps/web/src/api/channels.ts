import { ApiError, isRecord, jsonWrite, requestJson, requestNoContent } from "./http.js";
import type {
  Channel,
  ChannelCategory,
  ChannelMember,
  ChannelMemberSubject,
  ChannelOverride,
  ChannelSubject,
  ChannelSubjects,
  CreateChannelInput,
  StoredChannelOverride
} from "./types.js";
import { isRoleSummary } from "./guards.js";

export function isChannel(value: unknown): value is Channel {
  return isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    (value.categoryId === null || typeof value.categoryId === "string") &&
    (value.description === null || typeof value.description === "string") &&
    (value.visibility === "hidden" || value.visibility === "known") &&
    typeof value.canView === "boolean" &&
    typeof value.canSend === "boolean" &&
    typeof value.canManageMessages === "boolean" &&
    typeof value.ownerEditable === "boolean" &&
    (value.lastReadSeq === undefined ||
      (typeof value.lastReadSeq === "number" && Number.isInteger(value.lastReadSeq) && value.lastReadSeq >= 0));
}

export function isChannelCategory(value: unknown): value is ChannelCategory {
  return isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.position === "number" && Number.isInteger(value.position);
}

export function isChannelWithUnread(value: unknown): value is Channel & { unreadCount: number } {
  return isChannel(value) && typeof value.unreadCount === "number" && Number.isInteger(value.unreadCount) && value.unreadCount >= 0;
}

function isChannelMember(value: unknown): value is ChannelMember {
  return isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.login === "string" &&
    Array.isArray(value.roles) && value.roles.every(isRoleSummary) &&
    (value.presence === "online" || value.presence === "offline");
}

function isStoredChannelOverride(value: unknown): value is StoredChannelOverride {
  return isRecord(value) &&
    (value.subject === "everyone" || value.subject === "role" || value.subject === "member") &&
    ((value.subject === "everyone" && value.subjectId === null) ||
      ((value.subject === "role" || value.subject === "member") && typeof value.subjectId === "string")) &&
    typeof value.permission === "string" &&
    (value.effect === "allow" || value.effect === "deny");
}

export async function getChannels(): Promise<{ channels: Channel[]; categories: ChannelCategory[] }> {
  const result = await requestJson<{ channels?: unknown; categories?: unknown }>("/api/channels");
  if (
    !Array.isArray(result.channels) || !result.channels.every(isChannelWithUnread) ||
    !Array.isArray(result.categories) || !result.categories.every(isChannelCategory)
  ) {
    throw new ApiError(502, "INVALID_RESPONSE", "Сервер вернул некорректный список каналов");
  }
  return { channels: result.channels, categories: result.categories };
}

export async function createCategory(name: string, csrfToken: string): Promise<ChannelCategory> {
  const result = await requestJson<unknown>("/api/channels/categories", jsonWrite("POST", csrfToken, { name }));
  if (!isChannelCategory(result)) {
    throw new ApiError(502, "INVALID_RESPONSE", "Сервер вернул некорректные данные категории");
  }
  return result;
}

export async function renameCategory(categoryId: string, name: string, csrfToken: string): Promise<ChannelCategory> {
  const result = await requestJson<unknown>(`/api/channels/categories/${encodeURIComponent(categoryId)}`, jsonWrite("PATCH", csrfToken, { name }));
  if (!isChannelCategory(result)) {
    throw new ApiError(502, "INVALID_RESPONSE", "Сервер вернул некорректные данные категории");
  }
  return result;
}

export function deleteCategory(categoryId: string, csrfToken: string): Promise<void> {
  return requestNoContent(
    `/api/channels/categories/${encodeURIComponent(categoryId)}`,
    "DELETE",
    csrfToken,
    undefined,
    "Сервер вернул некорректный ответ при удалении категории"
  );
}

export function reorderCategories(categoryIds: string[], csrfToken: string): Promise<void> {
  return requestNoContent(
    "/api/channels/categories/order",
    "PUT",
    csrfToken,
    { categoryIds },
    "Сервер вернул некорректный ответ при изменении порядка категорий"
  );
}

export function reorderChannels(
  groups: Array<{ categoryId: string | null; channelIds: string[] }>,
  csrfToken: string
): Promise<void> {
  return requestNoContent(
    "/api/channels/order",
    "PUT",
    csrfToken,
    { groups },
    "Сервер вернул некорректный ответ при изменении порядка каналов"
  );
}

export function createChannel(input: CreateChannelInput, csrfToken: string): Promise<Channel>;
export function createChannel(name: string, csrfToken: string): Promise<Channel>;
export async function createChannel(input: CreateChannelInput | string, csrfToken: string): Promise<Channel> {
  const result = await requestJson<unknown>("/api/channels", jsonWrite("POST", csrfToken, typeof input === "string" ? { name: input } : input));
  if (!isChannel(result)) {
    throw new ApiError(502, "INVALID_RESPONSE", "Сервер вернул некорректные данные канала");
  }
  return result;
}

export async function renameChannel(channelId: string, name: string, csrfToken: string): Promise<Channel> {
  const result = await requestJson<unknown>(`/api/channels/${encodeURIComponent(channelId)}`, jsonWrite("PATCH", csrfToken, { name }));
  if (!isChannel(result)) {
    throw new ApiError(502, "INVALID_RESPONSE", "Сервер вернул некорректные данные канала");
  }
  return result;
}

export async function updateChannelProperties(
  channelId: string,
  payload: { name?: string; description?: string | null; visibility?: "hidden" | "known"; categoryId?: string | null },
  csrfToken: string
): Promise<Channel> {
  const result = await requestJson<unknown>(`/api/channels/${encodeURIComponent(channelId)}`, jsonWrite("PATCH", csrfToken, payload));
  if (!isChannel(result)) {
    throw new ApiError(502, "INVALID_RESPONSE", "Сервер вернул некорректные данные канала");
  }
  return result;
}

export async function moveChannelToCategory(
  channelId: string,
  categoryId: string | null,
  csrfToken: string
): Promise<Channel> {
  const result = await requestJson<unknown>(`/api/channels/${encodeURIComponent(channelId)}`, jsonWrite("PATCH", csrfToken, { categoryId }));
  if (!isChannel(result)) {
    throw new ApiError(502, "INVALID_RESPONSE", "Сервер вернул некорректные данные канала");
  }
  return result;
}

export async function getChannel(channelId: string): Promise<{ channel: Channel; overrides: StoredChannelOverride[] }> {
  const result = await requestJson<{ channel?: unknown; overrides?: unknown }>(
    `/api/channels/${encodeURIComponent(channelId)}`
  );
  if (!isChannel(result.channel) || !Array.isArray(result.overrides) || !result.overrides.every(isStoredChannelOverride)) {
    throw new ApiError(502, "INVALID_RESPONSE", "Сервер вернул некорректные данные канала");
  }
  return { channel: result.channel, overrides: result.overrides };
}

export async function getChannelMembers(channelId: string): Promise<ChannelMember[]> {
  const result = await requestJson<unknown>(`/api/channels/${encodeURIComponent(channelId)}/members`);
  if (!isRecord(result) ||
      !Array.isArray(result.members)) {
    throw new ApiError(502, "INVALID_RESPONSE", "Сервер вернул некорректный список участников канала");
  }
  const members = result.members;
  if (!members.every(isChannelMember)) {
    throw new ApiError(502, "INVALID_RESPONSE", "Сервер вернул некорректный список участников канала");
  }
  return members;
}

export async function getChannelSubjects(): Promise<ChannelSubjects> {
  const result = await requestJson<{ roles?: unknown; members?: unknown }>("/api/channels/subjects");
  if (
    !Array.isArray(result.roles) ||
    !result.roles.every((value) => isRecord(value) && typeof value.id === "string" && typeof value.name === "string") ||
    !Array.isArray(result.members) ||
    !result.members.every((value) => isRecord(value) && typeof value.id === "string" && typeof value.login === "string")
  ) {
    throw new ApiError(502, "INVALID_RESPONSE", "Сервер вернул некорректный список субъектов канала");
  }
  return {
    roles: result.roles as ChannelSubject[],
    members: result.members as ChannelMemberSubject[]
  };
}

export function updateChannelOverrides(
  channelId: string,
  overrides: ChannelOverride[],
  csrfToken: string
): Promise<void> {
  return requestNoContent(
    `/api/channels/${encodeURIComponent(channelId)}/overrides`,
    "PUT",
    csrfToken,
    { overrides },
    "Сервер вернул некорректный ответ при изменении переопределений канала"
  );
}
