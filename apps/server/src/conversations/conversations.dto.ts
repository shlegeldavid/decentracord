// Контракт переписки. Название и аватар в ответе отсутствуют: они
// собираются на клиенте из логинов участников.
export type ConversationKind = "direct" | "group";

export interface ConversationParticipant {
  id: string;
  login: string;
  presence: "online" | "offline";
  // Выданное право добавлять участников: переключатель в панели
  // показывает серверное состояние, а не догадку клиента.
  canAddParticipants: boolean;
}

export interface ConversationView {
  id: string;
  kind: ConversationKind;
  participants: ConversationParticipant[];
  lastMessageAt: string | null;
  createdAt: string;
  unreadCount: number;
  canManageMembers: boolean;
  // Право выдавать и отзывать право добавлять есть только у создателя:
  // `canManageMembers` этого не различает, потому что оно истинно и у носителя
  // выданного права.
  isCreator: boolean;
}

export interface CreateConversationInput {
  participantIds: string[];
}

const MAX_PARTICIPANTS_PER_REQUEST = 10;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

// Тело разбирается по allow-list: допустим только ключ `participantIds` со
// значением — массивом 1…10 уникальных uuid. Любой другой ключ, пустой массив,
// не-uuid и повтор id означают некорректный запрос.
export function parseCreateConversationInput(value: unknown): CreateConversationInput | null {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => key !== "participantIds") ||
    !Object.hasOwn(value, "participantIds") ||
    !Array.isArray(value.participantIds)
  ) {
    return null;
  }
  const participantIds = value.participantIds;
  if (participantIds.length < 1 || participantIds.length > MAX_PARTICIPANTS_PER_REQUEST) return null;
  if (!participantIds.every(isUuid)) return null;
  if (new Set(participantIds).size !== participantIds.length) return null;
  return { participantIds };
}

export function parseConversationId(value: unknown): string | null {
  return isUuid(value) ? value : null;
}

// Добавление участника. Тело разбирается по allow-list: ровно
// ключи `userId` и `showHistory`. Флажок истории персональный, поэтому
// добавляемый всегда один: массив участников с общим флажком исказил бы
// решение «кто что увидит».
export function parseAddParticipantInput(value: unknown): { userId: string; showHistory: boolean } | null {
  if (!isRecord(value) || Object.keys(value).length !== 2) return null;
  if (!Object.hasOwn(value, "userId") || !Object.hasOwn(value, "showHistory")) return null;
  const userId = value.userId;
  const showHistory = value.showHistory;
  if (!isUuid(userId) || typeof showHistory !== "boolean") return null;
  return { userId, showHistory };
}

// Право добавлять участников: ровно один булев ключ. Выдаёт и отзывает
// право только создатель переписки.
export function parseParticipantRightInput(value: unknown): { canAddParticipants: boolean } | null {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, "canAddParticipants")) return null;
  const canAddParticipants = value.canAddParticipants;
  if (typeof canAddParticipants !== "boolean") return null;
  return { canAddParticipants };
}

// Отметка прочтения переписки. Тело разбирается по allow-list: ровно
// один ключ `seq` с целым неотрицательным числом. Лишний ключ, строка вместо
// числа и дробь — некорректный запрос.
export function parseReadConversationBody(value: unknown): { seq: number } | null {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, "seq")) return null;
  const seq = value.seq;
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0) return null;
  return { seq };
}
