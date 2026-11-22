import { ApiError, isRecord, jsonWrite, postNoContent, requestJson, requestNoContent } from "./http.js";
import { type Conversation, type ConversationParticipant } from "./types.js";

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
  const result = await requestJson<unknown>("/api/conversations", jsonWrite("POST", csrfToken, { participantIds }));
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

// Закрытие переписки «у себя»: история не удаляется, новое сообщение
// возвращает строку в список.
export function closeConversation(conversationId: string, csrfToken: string): Promise<void> {
  return postNoContent(
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
  return postNoContent(
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
