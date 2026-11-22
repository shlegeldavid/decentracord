import { ApiError, isRecord, jsonWrite, postNoContent, requestJson, requestNoContent } from "./http.js";
import { type ForwardedFrom, type MessageMention, type MessageReader, type MessageView, type PinnedMessage } from "./types.js";
import { isRoleSummary } from "./guards.js";

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

type MessagePageOptions = { before?: number; after?: number; limit?: number };
type MessagePage = { messages: MessageView[]; hasMore: boolean; cursor: number };

function messagesPath(scope: "channels" | "conversations", id: string): string {
  return `/api/${scope}/${encodeURIComponent(id)}/messages`;
}

async function requestMessagePage(
  scope: "channels" | "conversations",
  id: string,
  options: MessagePageOptions | undefined,
  invalidResponse: string
): Promise<MessagePage> {
  if (options?.before !== undefined && options?.after !== undefined) {
    throw new ApiError(400, "INVALID_REQUEST", "Нельзя запрашивать историю и догон одновременно");
  }

  const params = new URLSearchParams();
  if (options?.before !== undefined) params.set("before", String(options.before));
  if (options?.after !== undefined) params.set("after", String(options.after));
  params.set("limit", String(options?.limit ?? 50));

  const result = await requestJson<unknown>(`${messagesPath(scope, id)}?${params.toString()}`);
  if (!isRecord(result) ||
      !Array.isArray(result.messages) ||
      !result.messages.every(isMessage) ||
      typeof result.hasMore !== "boolean" ||
      typeof result.cursor !== "number") {
    throw new ApiError(502, "INVALID_RESPONSE", invalidResponse);
  }
  return { messages: result.messages, hasMore: result.hasMore, cursor: result.cursor };
}

export function getMessages(channelId: string, options?: MessagePageOptions): Promise<MessagePage> {
  return requestMessagePage("channels", channelId, options, "Сервер вернул некорректные данные сообщений");
}

export async function getMessageReaders(channelId: string, messageId: string): Promise<MessageReader[]> {
  const result = await requestJson<unknown>(
    `/api/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/readers`
  );
  if (!isRecord(result) || !Array.isArray(result.readers) || !result.readers.every(isMessageReader)) {
    throw new ApiError(502, "INVALID_RESPONSE", "Сервер вернул некорректные данные списка прочитанных");
  }
  return result.readers;
}

const invalidChannelMessage = "Сервер вернул некорректные данные сообщения";
const invalidConversationMessage = "Сервер вернул некорректные данные сообщения переписки";

async function writeMessage(path: string, request: RequestInit, invalidResponse: string): Promise<MessageView> {
  const result = await requestJson<unknown>(path, request);
  if (!isMessage(result)) throw new ApiError(502, "INVALID_RESPONSE", invalidResponse);
  return result;
}

export async function sendMessage(
  channelId: string,
  content: string,
  clientRequestId: string,
  csrfToken: string
): Promise<MessageView> {
  return writeMessage(
    messagesPath("channels", channelId), jsonWrite("POST", csrfToken, { content, clientRequestId }), invalidChannelMessage
  );
}

export async function editMessage(
  channelId: string,
  messageId: string,
  content: string,
  csrfToken: string
): Promise<MessageView> {
  return writeMessage(
    `${messagesPath("channels", channelId)}/${encodeURIComponent(messageId)}`,
    jsonWrite("PATCH", csrfToken, { content }),
    invalidChannelMessage
  );
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
  return writeMessage(
    forwardPath(source, messageId),
    jsonWrite("POST", csrfToken, body),
    "Сервер вернул некорректные данные пересланного сообщения"
  );
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

export function getConversationMessages(conversationId: string, options?: MessagePageOptions): Promise<MessagePage> {
  return requestMessagePage("conversations", conversationId, options, "Сервер вернул некорректные данные истории переписки");
}

export async function sendConversationMessage(
  conversationId: string,
  payload: { content: string; clientRequestId: string },
  csrfToken: string
): Promise<MessageView> {
  return writeMessage(
    messagesPath("conversations", conversationId), jsonWrite("POST", csrfToken, payload), invalidConversationMessage
  );
}

// Правка сообщения переписки: сервер разрешает её только автору и только в
// окне трёх дней, как в каналах.
export async function editConversationMessage(
  conversationId: string,
  messageId: string,
  content: string,
  csrfToken: string
): Promise<MessageView> {
  return writeMessage(
    `${messagesPath("conversations", conversationId)}/${encodeURIComponent(messageId)}`,
    jsonWrite("PATCH", csrfToken, { content }),
    invalidConversationMessage
  );
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
  return postNoContent(
    `/api/channels/${encodeURIComponent(channelId)}/read`,
    csrfToken,
    { seq },
    "Сервер вернул некорректный ответ при отметке канала прочитанным"
  );
}

// Отметка прочтения переписки: сервер продвигает курсор только вперёд и
// не выше последнего существующего сообщения.
export function markConversationRead(conversationId: string, seq: number, csrfToken: string): Promise<void> {
  return postNoContent(
    `/api/conversations/${encodeURIComponent(conversationId)}/read`,
    csrfToken,
    { seq },
    "Сервер вернул некорректный ответ при отметке переписки прочитанной"
  );
}
