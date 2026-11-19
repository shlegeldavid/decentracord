export interface AuthUser {
  id: string;
  login: string;
  permissions: string[];
  isOwner: boolean;
  roleIds: string[];
  roleNames: string[];
  theme: "dark" | "light";
  timezone: string | null;
  roles: RoleSummary[];
}

export interface RoleSummary {
  id: string;
  name: string;
  color: string | null;
  position: number;
}

export interface Organization {
  name: string;
  // Относительный путь к логотипу с установки («/api/organization/logo») либо null.
  logoUrl: string | null;
}

export interface ReadRetention {
  keepForever: boolean;
  days: number | null;
}

export interface Member {
  id: string;
  login: string;
  active: boolean;
  roleIds: string[];
  roleNames: string[];
}

export interface CreatedMember {
  id: string;
  login: string;
  active: boolean;
}

export interface Role {
  id: string;
  name: string;
  position: number;
  permissions: string[];
  systemKey: string | null;
  ownerEditable: boolean;
  color: string | null;
  editable: boolean;
}

export type OverrideEffect = "allow" | "deny" | "unset";

export interface ChannelOverride {
  subject: "everyone" | "role" | "member";
  subjectId: string | null;
  permission: string;
  effect: OverrideEffect;
}

export interface CreateChannelInput {
  name: string;
  description?: string | null;
  categoryId?: string | null;
  overrides?: ChannelOverride[];
}

export interface Channel {
  id: string;
  name: string;
  categoryId: string | null;
  description: string | null;
  visibility: "hidden" | "known";
  canView: boolean;
  canSend: boolean;
  canManageMessages: boolean;
  ownerEditable: boolean;
  unreadCount?: number;
  lastReadSeq?: number;
}

export interface ChannelCategory {
  id: string;
  name: string;
  position: number;
}

export interface ChannelMember {
  id: string;
  login: string;
  roles: RoleSummary[];
  presence: "online" | "offline";
}

// Результат поиска людей по логину. Роли — все, кроме системной @everyone;
// общие каналы — пересечение видимых каналов ищущего и найденного участника.
export interface PersonSearchRole {
  id: string;
  name: string;
  color: string | null;
}

export interface PersonSearchChannel {
  id: string;
  name: string;
}

export interface PersonSearchResult {
  id: string;
  login: string;
  roles: PersonSearchRole[];
  commonChannels: PersonSearchChannel[];
  presence: "online" | "offline";
}

export type ConversationKind = "direct" | "group";

export interface ConversationParticipant {
  id: string;
  login: string;
  presence: "online" | "offline";
  // Выданное право добавлять участников: переключатель права в панели
  // показывает серверное состояние.
  canAddParticipants: boolean;
}

// Переписка на двоих и группа — один тип с полем `kind`. Названия и аватара в
// ответе нет: они собираются на клиенте из логинов участников.
export interface Conversation {
  id: string;
  kind: ConversationKind;
  participants: ConversationParticipant[];
  lastMessageAt: string | null;
  createdAt: string;
  unreadCount: number;
  canManageMembers: boolean;
  // Только создатель выдаёт и отзывает право добавлять.
  isCreator: boolean;
}

export type MessageMention = {
  id: string;
  login: string;
};

export interface MessageView {
  id: string;
  // Область сообщения: канал или переписка. Ровно одно из двух полей заполнено,
  // второе — null.
  channelId: string | null;
  conversationId: string | null;
  authorId: string;
  authorLogin: string;
  seq: number;
  updatedSeq: number;
  content: string;
  mentions: MessageMention[];
  editedAt: string | null;
  deleted: boolean;
  clientRequestId: string;
  createdAt: string;
  authorRoles: RoleSummary[];
  forwardedFrom: ForwardedFrom | null;
}

// Атрибуция пересылки: оригинал, его область, автор и признак удаления
// оригинала. Область ровно одна: канал или переписка. Клиент сам решает,
// строить ли ссылку на оригинал; у переписки адреса нет.
export interface ForwardedFrom {
  messageId: string;
  channelId: string | null;
  conversationId: string | null;
  authorLogin: string;
  originalDeleted: boolean;
}

export interface MessageReader {
  userId: string;
  login: string;
  readAt: string;
}

// Закреплённое сообщение канала. authorId нужен, чтобы кнопка «Открепить» была
// у автора закреплённого сообщения, authorRoles — чтобы имя автора выводилось
// цветом его роли.
export interface PinnedMessage {
  messageId: string;
  channelId: string;
  authorId: string;
  authorLogin: string;
  authorRoles: RoleSummary[];
  content: string;
  mentions: MessageMention[];
  createdAt: string;
  pinnedAt: string;
}

export type ChannelOverrideEffect = "allow" | "deny";

export interface StoredChannelOverride {
  subject: "everyone" | "role" | "member";
  subjectId: string | null;
  permission: string;
  effect: ChannelOverrideEffect;
}

export interface ChannelSubject {
  id: string;
  name: string;
}

export interface ChannelMemberSubject {
  id: string;
  login: string;
}

export interface ChannelSubjects {
  roles: ChannelSubject[];
  members: ChannelMemberSubject[];
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

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isRoleSummary(value: unknown): value is RoleSummary {
  return isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    (value.color === null || typeof value.color === "string") &&
    typeof value.position === "number" && Number.isInteger(value.position);
}

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

function isRole(value: unknown): value is Role {
  return isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.position === "number" && Number.isInteger(value.position) &&
    isStringArray(value.permissions) &&
    (value.systemKey === null || typeof value.systemKey === "string") &&
    typeof value.ownerEditable === "boolean" &&
    (value.color === null || typeof value.color === "string") &&
    typeof value.editable === "boolean";
}

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

function isMessageMention(value: unknown): value is MessageMention {
  return isRecord(value) && typeof value.id === "string" && typeof value.login === "string";
}

function isMessageReader(value: unknown): value is MessageReader {
  return isRecord(value) &&
    typeof value.userId === "string" &&
    typeof value.login === "string" &&
    typeof value.readAt === "string";
}

export function isForwardedFrom(value: unknown): value is ForwardedFrom {
  return isRecord(value) &&
    typeof value.messageId === "string" &&
    (value.channelId === null || typeof value.channelId === "string") &&
    (value.conversationId === null || typeof value.conversationId === "string") &&
    // Ровно одна область оригинала: канал или переписка.
    (value.channelId === null) !== (value.conversationId === null) &&
    typeof value.authorLogin === "string" &&
    typeof value.originalDeleted === "boolean";
}

export function isPinnedMessage(value: unknown): value is PinnedMessage {
  return isRecord(value) &&
    typeof value.messageId === "string" &&
    typeof value.channelId === "string" &&
    typeof value.authorId === "string" &&
    typeof value.authorLogin === "string" &&
    Array.isArray(value.authorRoles) && value.authorRoles.every(isRoleSummary) &&
    typeof value.content === "string" &&
    Array.isArray(value.mentions) && value.mentions.every(isMessageMention) &&
    typeof value.createdAt === "string" &&
    typeof value.pinnedAt === "string";
}

export function isMessage(value: unknown): value is MessageView {
  return isRecord(value) &&
    typeof value.id === "string" &&
    (value.channelId === null || typeof value.channelId === "string") &&
    (value.conversationId === null || typeof value.conversationId === "string") &&
    // Ровно одна привязка: канал или переписка.
    (value.channelId === null) !== (value.conversationId === null) &&
    typeof value.authorId === "string" &&
    typeof value.authorLogin === "string" &&
    typeof value.seq === "number" &&
    typeof value.updatedSeq === "number" &&
    typeof value.content === "string" &&
    Array.isArray(value.mentions) && value.mentions.every(isMessageMention) &&
    Array.isArray(value.authorRoles) && value.authorRoles.every(isRoleSummary) &&
    (value.editedAt === null || typeof value.editedAt === "string") &&
    typeof value.deleted === "boolean" &&
    typeof value.clientRequestId === "string" &&
    typeof value.createdAt === "string" &&
    (value.forwardedFrom === null || isForwardedFrom(value.forwardedFrom));
}

function isChannelMember(value: unknown): value is ChannelMember {
  return isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.login === "string" &&
    Array.isArray(value.roles) && value.roles.every(isRoleSummary) &&
    (value.presence === "online" || value.presence === "offline");
}

function isPersonSearchRole(value: unknown): value is PersonSearchRole {
  return isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    (value.color === null || typeof value.color === "string");
}

function isPersonSearchChannel(value: unknown): value is PersonSearchChannel {
  return isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string";
}

export function isPersonSearchResult(value: unknown): value is PersonSearchResult {
  return isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.login === "string" &&
    Array.isArray(value.roles) && value.roles.every(isPersonSearchRole) &&
    Array.isArray(value.commonChannels) && value.commonChannels.every(isPersonSearchChannel) &&
    (value.presence === "online" || value.presence === "offline");
}

function isConversationParticipant(value: unknown): value is ConversationParticipant {
  return isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.login === "string" &&
    (value.presence === "online" || value.presence === "offline") &&
    typeof value.canAddParticipants === "boolean";
}

export function isConversation(value: unknown): value is Conversation {
  return isRecord(value) &&
    typeof value.id === "string" &&
    (value.kind === "direct" || value.kind === "group") &&
    Array.isArray(value.participants) && value.participants.every(isConversationParticipant) &&
    (value.lastMessageAt === null || typeof value.lastMessageAt === "string") &&
    typeof value.createdAt === "string" &&
    typeof value.unreadCount === "number" && Number.isInteger(value.unreadCount) && value.unreadCount >= 0 &&
    typeof value.canManageMembers === "boolean" &&
    typeof value.isCreator === "boolean";
}

function isStoredChannelOverride(value: unknown): value is StoredChannelOverride {
  return isRecord(value) &&
    (value.subject === "everyone" || value.subject === "role" || value.subject === "member") &&
    ((value.subject === "everyone" && value.subjectId === null) ||
      ((value.subject === "role" || value.subject === "member") && typeof value.subjectId === "string")) &&
    typeof value.permission === "string" &&
    (value.effect === "allow" || value.effect === "deny");
}

function isReadRetention(value: unknown): value is ReadRetention {
  return isRecord(value) &&
    typeof value.keepForever === "boolean" &&
    (value.days === null || (typeof value.days === "number" && Number.isInteger(value.days)));
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
  const result = await requestJson<unknown>("/api/auth/preferences", {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": csrfToken
    },
    body: JSON.stringify(input)
  });
  if (!isAuthUser(result)) {
    throw new ApiError(502, "INVALID_RESPONSE", "Сервер вернул некорректные данные пользователя");
  }
  return result;
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
  const result = await requestJson<{ name?: unknown; logoUrl?: unknown }>("/api/organization", {
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
    throw new ApiError(502, "INVALID_RESPONSE", "Сервер вернул некорректный ответ при загрузке логотипа");
  }
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
  const result = await requestJson<unknown>("/api/organization/read-retention", {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": csrfToken
    },
    body: JSON.stringify(payload)
  });
  if (!isReadRetention(result)) {
    throw new ApiError(502, "INVALID_RESPONSE", "Сервер вернул некорректные данные срока хранения");
  }
  return result;
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
      typeof value.active !== "boolean" ||
      !isStringArray(value.roleIds) ||
      !isStringArray(value.roleNames)
    ) {
      throw new ApiError(502, "INVALID_RESPONSE", "Сервер вернул некорректный список участников");
    }
    return {
      id: value.id,
      login: value.login,
      active: value.active,
      roleIds: value.roleIds,
      roleNames: value.roleNames
    };
  });
}

export async function createMember(
  credentials: { login: string; password: string },
  csrfToken: string,
  roleIds: string[]
): Promise<CreatedMember> {
  const result = await requestJson<{ id?: unknown; login?: unknown; active?: unknown }>("/api/members", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": csrfToken
    },
    body: JSON.stringify({ ...credentials, roleIds })
  });
  if (typeof result.id !== "string" || typeof result.login !== "string" || typeof result.active !== "boolean") {
    throw new ApiError(502, "INVALID_RESPONSE", "Сервер вернул некорректные данные участника");
  }
  return { id: result.id, login: result.login, active: result.active };
}

function invalidRoleResponse(): ApiError {
  return new ApiError(502, "INVALID_RESPONSE", "Сервер вернул некорректные данные роли");
}

function parseRolePayload(value: unknown): Role {
  if (!isRole(value)) throw invalidRoleResponse();
  return {
    id: value.id,
    name: value.name,
    position: value.position,
    permissions: value.permissions,
    systemKey: value.systemKey,
    ownerEditable: value.ownerEditable,
    color: value.color,
    editable: value.editable
  };
}

export async function getRoles(): Promise<Role[]> {
  const result = await requestJson<{ roles?: unknown }>("/api/roles");
  if (!Array.isArray(result.roles)) {
    throw new ApiError(502, "INVALID_RESPONSE", "Сервер вернул некорректный список ролей");
  }
  return result.roles.map(parseRolePayload);
}

export async function createRole(
  input: { name: string; permissions: string[]; color?: string | null },
  csrfToken: string
): Promise<Role> {
  const result = await requestJson<unknown>("/api/roles", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": csrfToken
    },
    body: JSON.stringify(input)
  });
  return parseRolePayload(result);
}

export async function updateRole(
  roleId: string,
  input: { name?: string; permissions?: string[]; color?: string | null },
  csrfToken: string
): Promise<Role> {
  const result = await requestJson<unknown>(`/api/roles/${encodeURIComponent(roleId)}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": csrfToken
    },
    body: JSON.stringify(input)
  });
  return parseRolePayload(result);
}

export async function renameRole(roleId: string, name: string, csrfToken: string): Promise<Role> {
  const result = await requestJson<unknown>(`/api/roles/${encodeURIComponent(roleId)}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": csrfToken
    },
    body: JSON.stringify({ name })
  });
  return parseRolePayload(result);
}

export async function updateRolePermissions(roleId: string, permissions: string[], csrfToken: string): Promise<Role> {
  const result = await requestJson<unknown>(`/api/roles/${encodeURIComponent(roleId)}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": csrfToken
    },
    body: JSON.stringify({ permissions })
  });
  return parseRolePayload(result);
}

async function requestNoContent(
  path: string,
  method: "PATCH" | "PUT" | "POST" | "DELETE",
  csrfToken: string,
  body?: unknown,
  invalidResponseMessage = "Сервер вернул некорректный ответ при изменении ролей"
): Promise<void> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "x-csrf-token": csrfToken
  };
  const init: RequestInit = {
    method,
    cache: "no-store",
    credentials: "same-origin",
    headers
  };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const response = await fetch(path, {
    ...init
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
    throw new ApiError(502, "INVALID_RESPONSE", invalidResponseMessage);
  }
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
  const result = await requestJson<unknown>("/api/channels/categories", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": csrfToken
    },
    body: JSON.stringify({ name })
  });
  if (!isChannelCategory(result)) {
    throw new ApiError(502, "INVALID_RESPONSE", "Сервер вернул некорректные данные категории");
  }
  return result;
}

export async function renameCategory(categoryId: string, name: string, csrfToken: string): Promise<ChannelCategory> {
  const result = await requestJson<unknown>(`/api/channels/categories/${encodeURIComponent(categoryId)}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": csrfToken
    },
    body: JSON.stringify({ name })
  });
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
  const result = await requestJson<unknown>("/api/channels", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": csrfToken
    },
    body: JSON.stringify(typeof input === "string" ? { name: input } : input)
  });
  if (!isChannel(result)) {
    throw new ApiError(502, "INVALID_RESPONSE", "Сервер вернул некорректные данные канала");
  }
  return result;
}

export async function renameChannel(channelId: string, name: string, csrfToken: string): Promise<Channel> {
  const result = await requestJson<unknown>(`/api/channels/${encodeURIComponent(channelId)}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": csrfToken
    },
    body: JSON.stringify({ name })
  });
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
  const result = await requestJson<unknown>(`/api/channels/${encodeURIComponent(channelId)}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": csrfToken
    },
    body: JSON.stringify(payload)
  });
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
  const result = await requestJson<unknown>(`/api/channels/${encodeURIComponent(channelId)}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": csrfToken
    },
    body: JSON.stringify({ categoryId })
  });
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

export async function getMessages(
  channelId: string,
  options?: { before?: number; after?: number; limit?: number }
): Promise<{ messages: MessageView[]; hasMore: boolean; cursor: number }> {
  if (options?.before !== undefined && options?.after !== undefined) {
    throw new ApiError(400, "INVALID_REQUEST", "Нельзя запрашивать историю и догон одновременно");
  }

  const params = new URLSearchParams();
  if (options?.before !== undefined) params.set("before", String(options.before));
  if (options?.after !== undefined) params.set("after", String(options.after));
  params.set("limit", String(options?.limit ?? 50));

  const result = await requestJson<unknown>(
    `/api/channels/${encodeURIComponent(channelId)}/messages?${params.toString()}`
  );
  if (!isRecord(result) ||
      !Array.isArray(result.messages) ||
      !result.messages.every(isMessage) ||
      typeof result.hasMore !== "boolean" ||
      typeof result.cursor !== "number") {
    throw new ApiError(502, "INVALID_RESPONSE", "Сервер вернул некорректные данные сообщений");
  }
  return {
    messages: result.messages,
    hasMore: result.hasMore,
    cursor: result.cursor
  };
}

export async function getMessageReaders(channelId: string, messageId: string): Promise<MessageReader[]> {
  const result = await requestJson<unknown>(
    `/api/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/readers`
  );
  if (!isRecord(result) || !Array.isArray(result.readers)) {
    throw new ApiError(502, "INVALID_RESPONSE", "Сервер вернул некорректные данные списка прочитанных");
  }
  const readers = result.readers;
  if (!readers.every(isMessageReader)) {
    throw new ApiError(502, "INVALID_RESPONSE", "Сервер вернул некорректные данные списка прочитанных");
  }
  return readers;
}

export async function sendMessage(
  channelId: string,
  content: string,
  clientRequestId: string,
  csrfToken: string
): Promise<MessageView> {
  const result = await requestJson<unknown>(`/api/channels/${encodeURIComponent(channelId)}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": csrfToken
    },
    body: JSON.stringify({ content, clientRequestId })
  });
  if (!isMessage(result)) {
    throw new ApiError(502, "INVALID_RESPONSE", "Сервер вернул некорректные данные сообщения");
  }
  return result;
}

export async function editMessage(
  channelId: string,
  messageId: string,
  content: string,
  csrfToken: string
): Promise<MessageView> {
  const result = await requestJson<unknown>(
    `/api/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`,
    {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": csrfToken
      },
      body: JSON.stringify({ content })
    }
  );
  if (!isMessage(result)) {
    throw new ApiError(502, "INVALID_RESPONSE", "Сервер вернул некорректные данные сообщения");
  }
  return result;
}

export function deleteMessage(channelId: string, messageId: string, csrfToken: string): Promise<void> {
  return requestNoContent(
    `/api/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`,
    "DELETE",
    csrfToken,
    undefined,
    "Сервер вернул некорректный ответ при удалении сообщения"
  );
}

// Пересылка: источник называется в пути, цель — в теле, потому что белый
// список сервера состоит из пар «метод + шаблон пути» и у каждого источника
// свой шаблон. Область источника — размеченная пара, а не один id.
export type MessageForwardSource = { kind: "channel" | "conversation"; id: string };

function forwardPath(source: MessageForwardSource, messageId: string): string {
  const scope = source.kind === "channel" ? "channels" : "conversations";
  return `/api/${scope}/${encodeURIComponent(source.id)}/messages/${encodeURIComponent(messageId)}/forward`;
}

async function forwardMessageTo(
  source: MessageForwardSource,
  messageId: string,
  body: { targetChannelId: string } | { targetConversationId: string },
  csrfToken: string
): Promise<MessageView> {
  const result = await requestJson<unknown>(forwardPath(source, messageId), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": csrfToken
    },
    body: JSON.stringify(body)
  });
  if (!isMessage(result)) {
    throw new ApiError(502, "INVALID_RESPONSE", "Сервер вернул некорректные данные пересланного сообщения");
  }
  return result;
}

export function forwardMessageToChannel(
  source: MessageForwardSource,
  messageId: string,
  targetChannelId: string,
  csrfToken: string
): Promise<MessageView> {
  return forwardMessageTo(source, messageId, { targetChannelId }, csrfToken);
}

export function forwardMessageToConversation(
  source: MessageForwardSource,
  messageId: string,
  targetConversationId: string,
  csrfToken: string
): Promise<MessageView> {
  return forwardMessageTo(source, messageId, { targetConversationId }, csrfToken);
}

export async function getPinnedMessages(channelId: string): Promise<PinnedMessage[]> {
  const result = await requestJson<unknown>(`/api/channels/${encodeURIComponent(channelId)}/pins`);
  if (!isRecord(result) || !Array.isArray(result.pins) || !result.pins.every(isPinnedMessage)) {
    throw new ApiError(502, "INVALID_RESPONSE", "Сервер вернул некорректные данные закреплений");
  }
  return result.pins;
}

export function pinMessage(channelId: string, messageId: string, csrfToken: string): Promise<void> {
  return requestNoContent(
    `/api/channels/${encodeURIComponent(channelId)}/pins`,
    "POST",
    csrfToken,
    { messageId },
    "Сервер вернул некорректный ответ при закреплении сообщения"
  );
}

export function unpinMessage(channelId: string, messageId: string, csrfToken: string): Promise<void> {
  return requestNoContent(
    `/api/channels/${encodeURIComponent(channelId)}/pins/${encodeURIComponent(messageId)}`,
    "DELETE",
    csrfToken,
    undefined,
    "Сервер вернул некорректный ответ при снятии закрепления"
  );
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

export async function searchPeople(query: string): Promise<{ results: PersonSearchResult[]; truncated: boolean }> {
  const params = new URLSearchParams();
  params.set("q", query);
  const result = await requestJson<unknown>(`/api/members/search?${params.toString()}`);
  if (!isRecord(result) ||
      !Array.isArray(result.results) ||
      !result.results.every(isPersonSearchResult) ||
      typeof result.truncated !== "boolean") {
    throw new ApiError(502, "INVALID_RESPONSE", "Сервер вернул некорректные данные поиска");
  }
  return { results: result.results, truncated: result.truncated };
}

export async function listConversations(): Promise<Conversation[]> {
  const result = await requestJson<unknown>("/api/conversations");
  if (!isRecord(result) ||
      !Array.isArray(result.conversations) ||
      !result.conversations.every(isConversation)) {
    throw new ApiError(502, "INVALID_RESPONSE", "Сервер вернул некорректный список переписок");
  }
  return result.conversations;
}

export async function createConversation(participantIds: string[], csrfToken: string): Promise<Conversation> {
  const result = await requestJson<unknown>("/api/conversations", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": csrfToken
    },
    body: JSON.stringify({ participantIds })
  });
  if (!isConversation(result)) {
    throw new ApiError(502, "INVALID_RESPONSE", "Сервер вернул некорректные данные переписки");
  }
  return result;
}

export async function getConversation(conversationId: string): Promise<Conversation> {
  const result = await requestJson<unknown>(`/api/conversations/${encodeURIComponent(conversationId)}`);
  if (!isConversation(result)) {
    throw new ApiError(502, "INVALID_RESPONSE", "Сервер вернул некорректные данные переписки");
  }
  return result;
}

export async function getConversationMessages(
  conversationId: string,
  options?: { before?: number; after?: number; limit?: number }
): Promise<{ messages: MessageView[]; hasMore: boolean; cursor: number }> {
  if (options?.before !== undefined && options?.after !== undefined) {
    throw new ApiError(400, "INVALID_REQUEST", "Нельзя запрашивать историю и догон одновременно");
  }

  const params = new URLSearchParams();
  if (options?.before !== undefined) params.set("before", String(options.before));
  if (options?.after !== undefined) params.set("after", String(options.after));
  params.set("limit", String(options?.limit ?? 50));

  const result = await requestJson<unknown>(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages?${params.toString()}`
  );
  if (!isRecord(result) ||
      !Array.isArray(result.messages) ||
      !result.messages.every(isMessage) ||
      typeof result.hasMore !== "boolean" ||
      typeof result.cursor !== "number") {
    throw new ApiError(502, "INVALID_RESPONSE", "Сервер вернул некорректные данные истории переписки");
  }
  return {
    messages: result.messages,
    hasMore: result.hasMore,
    cursor: result.cursor
  };
}

export async function sendConversationMessage(
  conversationId: string,
  payload: { content: string; clientRequestId: string },
  csrfToken: string
): Promise<MessageView> {
  const result = await requestJson<unknown>(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": csrfToken
      },
      body: JSON.stringify(payload)
    }
  );
  if (!isMessage(result)) {
    throw new ApiError(502, "INVALID_RESPONSE", "Сервер вернул некорректные данные сообщения переписки");
  }
  return result;
}

// Правка сообщения переписки: сервер разрешает её только автору и только в
// окне трёх дней, как в каналах.
export async function editConversationMessage(
  conversationId: string,
  messageId: string,
  content: string,
  csrfToken: string
): Promise<MessageView> {
  const result = await requestJson<unknown>(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}`,
    {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": csrfToken
      },
      body: JSON.stringify({ content })
    }
  );
  if (!isMessage(result)) {
    throw new ApiError(502, "INVALID_RESPONSE", "Сервер вернул некорректные данные сообщения переписки");
  }
  return result;
}

// Удаление сообщения переписки: только автор, право модератора здесь
// не действует.
export function deleteConversationMessage(
  conversationId: string,
  messageId: string,
  csrfToken: string
): Promise<void> {
  return requestNoContent(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}`,
    "DELETE",
    csrfToken,
    undefined,
    "Сервер вернул некорректный ответ при удалении сообщения"
  );
}

export function markChannelRead(channelId: string, seq: number, csrfToken: string): Promise<void> {
  return postMemberAction(
    `/api/channels/${encodeURIComponent(channelId)}/read`,
    csrfToken,
    { seq },
    "Сервер вернул некорректный ответ при отметке канала прочитанным"
  );
}

// Отметка прочтения переписки: сервер продвигает курсор только вперёд и
// не выше последнего существующего сообщения.
export function markConversationRead(conversationId: string, seq: number, csrfToken: string): Promise<void> {
  return postMemberAction(
    `/api/conversations/${encodeURIComponent(conversationId)}/read`,
    csrfToken,
    { seq },
    "Сервер вернул некорректный ответ при отметке переписки прочитанной"
  );
}

// Закрытие переписки «у себя»: история не удаляется, новое сообщение
// возвращает строку в список.
export function closeConversation(conversationId: string, csrfToken: string): Promise<void> {
  return postMemberAction(
    `/api/conversations/${encodeURIComponent(conversationId)}/close`,
    csrfToken,
    undefined,
    "Сервер вернул некорректный ответ при закрытии переписки"
  );
}

// Добавление участника группы. Флажок истории персональный,
// поэтому всегда добавляется ровно один человек.
export function addConversationParticipants(
  conversationId: string,
  payload: { userId: string; showHistory: boolean },
  csrfToken: string
): Promise<void> {
  return postMemberAction(
    `/api/conversations/${encodeURIComponent(conversationId)}/participants`,
    csrfToken,
    payload,
    "Сервер вернул некорректный ответ при изменении состава переписки"
  );
}

// Удаление участника: его сообщения остаются в переписке.
export function removeConversationParticipant(
  conversationId: string,
  userId: string,
  csrfToken: string
): Promise<void> {
  return requestNoContent(
    `/api/conversations/${encodeURIComponent(conversationId)}/participants/${encodeURIComponent(userId)}`,
    "DELETE",
    csrfToken,
    undefined,
    "Сервер вернул некорректный ответ при изменении состава переписки"
  );
}

// Право добавлять участников выдаёт и отзывает только создатель.
export function updateConversationParticipantRight(
  conversationId: string,
  userId: string,
  canAddParticipants: boolean,
  csrfToken: string
): Promise<void> {
  return requestNoContent(
    `/api/conversations/${encodeURIComponent(conversationId)}/participants/${encodeURIComponent(userId)}`,
    "PATCH",
    csrfToken,
    { canAddParticipants },
    "Сервер вернул некорректный ответ при изменении состава переписки"
  );
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

export function reorderRoles(roleIds: string[], csrfToken: string): Promise<void> {
  return requestNoContent("/api/roles/order", "PUT", csrfToken, { roleIds });
}

export function assignMemberRoles(memberId: string, roleIds: string[], csrfToken: string): Promise<void> {
  return requestNoContent(`/api/members/${encodeURIComponent(memberId)}/roles`, "PATCH", csrfToken, { roleIds });
}

async function postMemberAction(
  path: string,
  csrfToken: string,
  body?: unknown,
  invalidResponseMessage = "Сервер вернул некорректный ответ при изменении доступа"
): Promise<void> {
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
    throw new ApiError(502, "INVALID_RESPONSE", invalidResponseMessage);
  }
}

export function resetMemberPassword(memberId: string, newPassword: string, csrfToken: string): Promise<void> {
  return postMemberAction(`/api/members/${encodeURIComponent(memberId)}/reset-password`, csrfToken, { newPassword });
}

export function disableMember(memberId: string, csrfToken: string): Promise<void> {
  return postMemberAction(`/api/members/${encodeURIComponent(memberId)}/disable`, csrfToken);
}
