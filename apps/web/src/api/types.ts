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
