export interface MessageView {
  id: string;
  // Область сообщения: канал или переписка. Ровно одно из двух полей заполнено,
  // второе — null (ограничение `messages_scope_exactly_one` в БД).
  channelId: string | null;
  conversationId: string | null;
  authorId: string;
  authorLogin: string;
  seq: number;
  updatedSeq: number;
  content: string;
  mentions: Array<{ id: string; login: string }>;
  authorRoles: MessageAuthorRole[];
  editedAt: string | null;
  deleted: boolean;
  clientRequestId: string;
  createdAt: string;
  forwardedFrom: ForwardedFrom | null;
}

export interface MessageAuthorRole {
  id: string;
  name: string;
  color: string | null;
  position: number;
}

// Атрибуция пересылки: оригинал (messageId + область), его автор и признак
// удаления оригинала. Область оригинала — канал или переписка: ровно одно из
// двух полей заполнено, второе — null. `messageId` и `authorLogin` есть всегда.
// Область едет всем получателям — клиент сам решает, строить ли ссылку на
// оригинал: у переписки адреса нет, поэтому ссылка не строится.
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

// Закреплённое сообщение канала. authorId нужен, чтобы панель показала
// «Открепить» именно автору закреплённого сообщения, authorRoles —
// чтобы имя автора выводилось цветом его роли.
export interface PinnedMessage {
  messageId: string;
  channelId: string;
  authorId: string;
  authorLogin: string;
  authorRoles: MessageAuthorRole[];
  content: string;
  mentions: Array<{ id: string; login: string }>;
  createdAt: string;
  pinnedAt: string;
}

export interface MessageListResponse {
  messages: MessageView[];
  hasMore: boolean;
  cursor: number;
}

export interface SendMessageInput {
  content: string;
  clientRequestId: string;
}

export interface EditMessageInput {
  content: string;
}

export interface MessageHistoryQuery {
  before?: number;
  after?: number;
  limit: number;
}

export interface ReadRetentionInput {
  keepForever: boolean;
  days: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function parseMessageContent(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const length = Array.from(value).length;
  if (length < 1 || length > 2000 || value.includes("\u0000")) return null;
  return value;
}

function parseQueryInteger(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== "string" || !/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function parseSendMessageInput(value: unknown): SendMessageInput | null {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => key !== "content" && key !== "clientRequestId") ||
    !Object.hasOwn(value, "content") ||
    !Object.hasOwn(value, "clientRequestId")
  ) {
    return null;
  }
  const content = parseMessageContent(value.content);
  if (content === null || !isUuid(value.clientRequestId)) return null;
  return { content, clientRequestId: value.clientRequestId };
}

export function parseEditMessageInput(value: unknown): EditMessageInput | null {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => key !== "content") ||
    !Object.hasOwn(value, "content")
  ) {
    return null;
  }
  const content = parseMessageContent(value.content);
  return content === null ? null : { content };
}

export function parseMessageId(value: unknown): string | null {
  return isUuid(value) ? value : null;
}

// Закрепление: тело разбирается по allow-list — допустим только ключ
// messageId со значением-uuid. Любой другой ключ означает некорректный запрос.
export function parsePinMessageInput(value: unknown): { messageId: string } | null {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => key !== "messageId") ||
    !Object.hasOwn(value, "messageId")
  ) {
    return null;
  }
  return isUuid(value.messageId) ? { messageId: value.messageId } : null;
}

// Цель пересылки: канал или переписка. Источник и цель проверяются независимо,
// поэтому цель — размеченное объединение, а не «универсальный» идентификатор.
export type ForwardTarget =
  | { kind: "channel"; id: string }
  | { kind: "conversation"; id: string };

// Пересылка: тело разбирается по allow-list — допустим ровно один ключ,
// `targetChannelId` или `targetConversationId`, со значением-uuid. Оба ключа
// одновременно, ни одного, лишний ключ или не-uuid означают некорректный запрос.
export function parseForwardMessageInput(value: unknown): ForwardTarget | null {
  if (!isRecord(value) || Object.keys(value).length !== 1) return null;
  if (Object.hasOwn(value, "targetChannelId") && isUuid(value.targetChannelId)) {
    return { kind: "channel", id: value.targetChannelId };
  }
  if (Object.hasOwn(value, "targetConversationId") && isUuid(value.targetConversationId)) {
    return { kind: "conversation", id: value.targetConversationId };
  }
  return null;
}

// Срок хранения журнала прочтений: целое число дней 1…3650 либо бессрочно.
// Тело разбирается по allow-list — неизвестный ключ означает некорректный запрос.
export function parseReadRetentionInput(value: unknown): ReadRetentionInput | null {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => key !== "keepForever" && key !== "days") ||
    !Object.hasOwn(value, "keepForever") ||
    typeof value.keepForever !== "boolean"
  ) {
    return null;
  }
  if (value.keepForever) return { keepForever: true, days: null };
  if (!Object.hasOwn(value, "days")) return null;
  const days = value.days;
  if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > 3650) return null;
  return { keepForever: false, days };
}

export function parseHistoryQuery(value: unknown): MessageHistoryQuery | null {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => key !== "before" && key !== "after" && key !== "limit")
  ) {
    return null;
  }

  const before = parseQueryInteger(value.before);
  const after = parseQueryInteger(value.after);
  const requestedLimit = parseQueryInteger(value.limit);
  if (before === null || after === null || requestedLimit === null || (before !== undefined && after !== undefined)) {
    return null;
  }

  const isCatchUp = after !== undefined;
  const limit = requestedLimit ?? (isCatchUp ? 200 : 50);
  if (limit < 1 || limit > (isCatchUp ? 200 : 100)) return null;

  const query: MessageHistoryQuery = { limit };
  if (before !== undefined) query.before = before;
  if (after !== undefined) query.after = after;
  return query;
}
