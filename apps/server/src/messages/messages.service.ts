import { HttpException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { AccessService } from "../access/access.service.js";
import type { AuthPrincipal } from "../auth/session.service.js";
import { ConversationsService } from "../conversations/conversations.service.js";
import { parseConversationId } from "../conversations/conversations.dto.js";
import { RealtimeGateway } from "../realtime/realtime.gateway.js";
import {
  parseEditMessageInput,
  parseForwardMessageInput,
  parseHistoryQuery,
  parseMessageId,
  parsePinMessageInput,
  parseSendMessageInput,
  type ForwardTarget,
  type MessageHistoryQuery,
  type MessageListResponse,
  type MessageAuthorRole,
  type MessageReader,
  type MessageView,
  type PinnedMessage
} from "./message.dto.js";
import { MentionsService } from "./mentions.service.js";

interface MessageRow {
  id: string;
  channel_id: string | null;
  conversation_id: string | null;
  author_id: string;
  author_login: string;
  seq: number;
  updated_seq: number;
  content: string;
  edited_at: Date | string | null;
  deleted_at: Date | string | null;
  client_request_id: string;
  created_at: Date | string;
  forwarded_from_message_id: string | null;
  forwarded_from_channel_id: string | null;
  forwarded_from_conversation_id: string | null;
  original_author_login: string | null;
  original_deleted_at: Date | string | null;
}

interface MessageMentionRow {
  message_id: string;
  user_id: string;
  login: string;
}

interface MessageAuthorRoleRow extends MessageAuthorRole {
  author_id: string;
}

interface MessageChannelCursorRow {
  cursor: number;
  history_before: string;
}

interface EditPermissionRow {
  author_id: string;
  edit_window_expired: boolean;
}

interface DeletePermissionRow {
  author_id: string;
}

interface ChannelReadCursorRow {
  max_seq: number;
}

interface ChannelReadAdvanceRow {
  advanced_seq: string;
}

interface ReadRetentionRow {
  read_retention_days: number | null;
}

interface MessageReaderRow {
  user_id: string;
  login: string;
  read_at: Date | string;
}

interface MessageAuthorRow {
  id: string;
  channel_id: string;
  seq: number;
  created_at: Date | string;
  author_id: string;
}

interface PinnedMessageRow {
  message_id: string;
  channel_id: string;
  pinned_at: Date | string;
  id: string;
  author_id: string;
  author_login: string;
  content: string;
  created_at: Date | string;
}

// Исходное сообщение пересылки: атрибуция оригинала и признак того, что
// сообщение само является пересылкой (цепочка не возникает — атрибуция
// наследуется с одного уровня). Область исходника — канал или переписка.
interface ForwardSourceRow {
  id: string;
  channel_id: string | null;
  conversation_id: string | null;
  author_id: string;
  author_login: string;
  content: string;
  deleted_at: Date | string | null;
  forwarded_from_message_id: string | null;
  forwarded_from_channel_id: string | null;
  forwarded_from_conversation_id: string | null;
}

// Атрибуция оригинала, которую получает копия: ровно одна область заполнена.
interface ForwardAttribution {
  messageId: string;
  channelId: string | null;
  conversationId: string | null;
  authorLogin: string;
}

interface OriginalAuthorRow {
  login: string;
}

type QueryExecutor = Pick<PoolClient, "query">;

function apiError(status: number, code: string, message: string): HttpException {
  return new HttpException({ code, message }, status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function toIsoString(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid message timestamp");
  return date.toISOString();
}

function toMessageView(
  row: MessageRow,
  mentions: Array<{ id: string; login: string }>,
  authorRoles: MessageAuthorRole[]
): MessageView {
  // Атрибуция пересылки собирается из одного уровня: original — это оригинал,
  // а не промежуточное пересланное сообщение. Область оригинала ровно одна:
  // канал (`channelId`) или переписка (`conversationId`).
  const forwardedFrom = row.forwarded_from_message_id &&
    (row.forwarded_from_channel_id !== null || row.forwarded_from_conversation_id !== null)
    ? {
        messageId: row.forwarded_from_message_id,
        channelId: row.forwarded_from_channel_id,
        conversationId: row.forwarded_from_conversation_id,
        authorLogin: row.original_author_login ?? "",
        originalDeleted: row.original_deleted_at !== null
      }
    : null;
  return {
    id: row.id,
    channelId: row.channel_id,
    conversationId: row.conversation_id,
    authorId: row.author_id,
    authorLogin: row.author_login,
    seq: row.seq,
    updatedSeq: row.updated_seq,
    content: row.content,
    mentions,
    authorRoles,
    editedAt: row.edited_at === null ? null : toIsoString(row.edited_at),
    deleted: row.deleted_at !== null,
    clientRequestId: row.client_request_id,
    createdAt: toIsoString(row.created_at),
    forwardedFrom
  };
}

// Область аудита: канал или переписка. Идентификатор переписки нельзя писать в
// поле `channelId` — получатели журнала различают области по `scopeKind`.
function auditMessage(
  event: string,
  actorUserId: string,
  scopeId: string,
  messageId: string | null,
  outcome: string,
  scopeKind: "channel" | "conversation" = "channel"
): void {
  try {
    process.stdout.write(`${JSON.stringify({
      event,
      actorUserId,
      target: {
        type: "message",
        id: messageId,
        ...(scopeKind === "channel" ? { channelId: scopeId } : {}),
        scopeKind,
        scopeId
      },
      outcome
    })}\n`);
  } catch {
    // Audit output must not change the message operation result.
  }
}

const messageSelect = `
  SELECT
    m.id::text AS id,
    m.channel_id::text AS channel_id,
    m.conversation_id::text AS conversation_id,
    m.author_id::text AS author_id,
    u.login AS author_login,
    m.seq::int AS seq,
    m.updated_seq::int AS updated_seq,
    m.content,
    m.edited_at,
    m.deleted_at,
    m.client_request_id::text AS client_request_id,
    m.created_at,
    m.forwarded_from_message_id::text AS forwarded_from_message_id,
    m.forwarded_from_channel_id::text AS forwarded_from_channel_id,
    m.forwarded_from_conversation_id::text AS forwarded_from_conversation_id,
    original.deleted_at AS original_deleted_at,
    original_author.login AS original_author_login
  FROM messages AS m
  JOIN users AS u ON u.id = m.author_id
  LEFT JOIN messages AS original ON original.id = m.forwarded_from_message_id
  LEFT JOIN users AS original_author ON original_author.id = original.author_id
`;

// Исходное сообщение пересылки: тело, автор и признак того, что сообщение
// само является пересылкой. Канальный вариант фильтрует область канала.
const forwardSourceSelect = `
  SELECT m.id::text AS id,
         m.channel_id::text AS channel_id,
         m.conversation_id::text AS conversation_id,
         m.author_id::text AS author_id,
         author_account.login AS author_login,
         m.content,
         m.deleted_at,
         m.forwarded_from_message_id::text AS forwarded_from_message_id,
         m.forwarded_from_channel_id::text AS forwarded_from_channel_id,
         m.forwarded_from_conversation_id::text AS forwarded_from_conversation_id
  FROM messages AS m
  JOIN users AS author_account ON author_account.id = m.author_id
  WHERE m.id = $1 AND m.channel_id = $2
`;

// Тот же набор колонок для области переписки: источник проверяется отдельно,
// поэтому у переписки свой предикат, а не подстановка идентификатора в канальный.
const conversationForwardSourceSelect = `
  SELECT m.id::text AS id,
         m.channel_id::text AS channel_id,
         m.conversation_id::text AS conversation_id,
         m.author_id::text AS author_id,
         author_account.login AS author_login,
         m.content,
         m.deleted_at,
         m.forwarded_from_message_id::text AS forwarded_from_message_id,
         m.forwarded_from_channel_id::text AS forwarded_from_channel_id,
         m.forwarded_from_conversation_id::text AS forwarded_from_conversation_id
  FROM messages AS m
  JOIN users AS author_account ON author_account.id = m.author_id
  WHERE m.id = $1 AND m.conversation_id = $2
`;

export class MessagesService {
  constructor(
    private readonly pool: Pool,
    private readonly access: AccessService,
    private readonly realtime: RealtimeGateway,
    private readonly mentions: MentionsService,
    private readonly conversations: ConversationsService
  ) {}

  async send(principal: AuthPrincipal, channelId: string, input: unknown): Promise<MessageView> {
    await this.access.requireChannelPermission(principal, channelId, "VIEW_CHANNEL");
    const channel = (await this.access.listVisibleChannels(principal)).find((entry) => entry.id === channelId);
    if (!channel) throw apiError(404, "CHANNEL_NOT_FOUND", "Канал не найден");
    if (!channel.canSend) throw apiError(403, "SEND_NOT_ALLOWED", "В этом канале запрещена отправка сообщений");

    const parsed = parseSendMessageInput(input);
    if (!parsed || !isUuid(parsed.clientRequestId)) throw apiError(400, "INVALID_REQUEST", "Некорректное сообщение");
    const resolvedMentions = await this.mentions.resolveForChannel(channelId, parsed.content);

    let client: PoolClient | undefined;
    let message: MessageView | undefined;
    let messageId: string | null = null;
    let created = false;
    try {
      client = await this.pool.connect();
      await client.query("BEGIN");
      const sequence = await client.query<{ seq: number }>(
        "UPDATE channels SET last_seq = last_seq + 1, updated_at = now() WHERE id = $1 RETURNING last_seq::int AS seq",
        [channelId]
      );
      const seq = sequence.rows[0]?.seq;
      if (seq === undefined) throw apiError(404, "CHANNEL_NOT_FOUND", "Канал не найден");

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO messages (channel_id, author_id, seq, updated_seq, content, client_request_id)
         VALUES ($1, $2, $3, $3, $4, $5)
         ON CONFLICT (channel_id, author_id, client_request_id) DO NOTHING
         RETURNING id::text AS id`,
        [channelId, principal.userId, seq, parsed.content, parsed.clientRequestId]
      );
      created = inserted.rows.length > 0;

      if (created) {
        messageId = inserted.rows[0]?.id ?? null;
      } else {
        const existing = await client.query<{ id: string }>(
          "SELECT id::text AS id FROM messages WHERE channel_id = $1 AND author_id = $2 AND client_request_id = $3",
          [channelId, principal.userId, parsed.clientRequestId]
        );
        messageId = existing.rows[0]?.id ?? null;
      }
      if (!messageId) throw new Error("Message idempotency record was not found");

      if (created) {
        await this.mentions.recordMentions(messageId, resolvedMentions, client);
      }

      const row = await this.loadMessageRow(client, channelId, messageId);
      if (!row) throw new Error("Created message was not found");
      const mentionsByMessage = await this.loadMentions(client, [messageId]);
      const authorRolesByUser = await this.loadAuthorRoles(client, [row.author_id]);
      message = toMessageView(
        row,
        mentionsByMessage.get(messageId) ?? [],
        authorRolesByUser.get(row.author_id) ?? []
      );
      await client.query("COMMIT");
      auditMessage("audit.message.create", principal.userId, channelId, messageId, created ? "created" : "duplicate");
    } catch (error) {
      await client?.query("ROLLBACK").catch(() => undefined);
      auditMessage("audit.message.create", principal.userId, channelId, messageId, "failed");
      throw error;
    } finally {
      client?.release();
    }

    if (!message) throw new Error("Message was not returned");
    if (created) {
      try {
        await this.realtime.emitChannelEvent(channelId, "message:created", { channelId, message });
      } catch {
        auditMessage("audit.message.create", principal.userId, channelId, message.id, "notification_failed");
      }
    }
    return message;
  }

  // Отправка в переписку. Сообщения переписок — строки той же таблицы
  // `messages` с областью `conversation_id`, поэтому `seq`, `updated_seq`,
  // идемпотентность и `MessageView` переиспользуются без второй копии.
  async sendToConversation(principal: AuthPrincipal, conversationIdValue: string, input: unknown): Promise<MessageView> {
    const conversationId = parseConversationId(conversationIdValue);
    if (!conversationId) throw apiError(400, "INVALID_REQUEST", "Некорректный идентификатор переписки");
    // Проверки участия — до pool.connect(): пул соединений максимум один.
    await this.conversations.assertParticipant(principal, conversationId);

    const parsed = parseSendMessageInput(input);
    if (!parsed || !isUuid(parsed.clientRequestId)) throw apiError(400, "INVALID_REQUEST", "Некорректное сообщение");
    // Упоминания резолвятся по составу переписки до pool.connect().
    const resolvedMentions = await this.mentions.resolveForConversation(conversationId, parsed.content);

    let client: PoolClient | undefined;
    let message: MessageView | undefined;
    let messageId: string | null = null;
    let created = false;
    try {
      client = await this.pool.connect();
      await client.query("BEGIN");
      // Номер выдаёт строка переписки под row-lock: отдельный advisory-lock на
      // отправке не берётся, ключ (21471, 901) остаётся за каналами.
      const sequence = await client.query<{ seq: number }>(
        "UPDATE conversations SET last_seq = last_seq + 1, last_message_at = now() WHERE id = $1 RETURNING last_seq::int AS seq",
        [conversationId]
      );
      const seq = sequence.rows[0]?.seq;
      if (seq === undefined) throw apiError(404, "CONVERSATION_NOT_FOUND", "Переписка не найдена");

      // Уникальность переписок держит партиальный индекс: при `channel_id IS NULL`
      // канальный `ON CONFLICT` не срабатывает, поэтому предикат указан явно.
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO messages (conversation_id, author_id, seq, updated_seq, content, client_request_id)
         VALUES ($1, $2, $3, $3, $4, $5)
         ON CONFLICT (conversation_id, author_id, client_request_id) WHERE conversation_id IS NOT NULL DO NOTHING
         RETURNING id::text AS id`,
        [conversationId, principal.userId, seq, parsed.content, parsed.clientRequestId]
      );
      created = inserted.rows.length > 0;

      if (created) {
        messageId = inserted.rows[0]?.id ?? null;
        // новое сообщение возвращает переписку в список у всех участников.
        // Идемпотентный повтор этого не делает — иначе повторная отправка
        // «переоткрывала» бы закрытую переписку.
        await client.query(
          "UPDATE conversation_participants SET closed_at = NULL WHERE conversation_id = $1 AND closed_at IS NOT NULL",
          [conversationId]
        );
      } else {
        const existing = await client.query<{ id: string }>(
          `SELECT id::text AS id FROM messages
           WHERE conversation_id = $1 AND author_id = $2 AND client_request_id = $3`,
          [conversationId, principal.userId, parsed.clientRequestId]
        );
        messageId = existing.rows[0]?.id ?? null;
      }
      if (!messageId) throw new Error("Conversation message idempotency record was not found");

      // Строки упоминаний пишутся только для нового сообщения: идемпотентный
      // повтор уже записанные не дублирует.
      if (created) {
        await this.mentions.recordMentions(messageId, resolvedMentions, client);
      }

      const row = await this.loadConversationMessageRow(client, conversationId, messageId);
      if (!row) throw new Error("Created conversation message was not found");
      // Упоминания читаются из тех же строк, что пишет `recordMentions`:
      // ответ и событие несут один и тот же массив.
      const mentionsByMessage = await this.loadMentions(client, [messageId]);
      const authorRolesByUser = await this.loadAuthorRoles(client, [row.author_id]);
      message = toMessageView(
        row,
        mentionsByMessage.get(messageId) ?? [],
        authorRolesByUser.get(row.author_id) ?? []
      );
      await client.query("COMMIT");
      auditMessage(
        "audit.message.create",
        principal.userId,
        conversationId,
        messageId,
        created ? "created" : "duplicate",
        "conversation"
      );
    } catch (error) {
      await client?.query("ROLLBACK").catch(() => undefined);
      auditMessage("audit.message.create", principal.userId, conversationId, messageId, "failed", "conversation");
      throw error;
    } finally {
      client?.release();
    }

    if (!message) throw new Error("Conversation message was not returned");
    // Состав переписки читается после COMMIT: событие не уйдёт тому, кого уже
    // убрали из переписки.
    if (created) {
      try {
        const participants = await this.conversations.participantIds(conversationId);
        await this.realtime.emitConversationEvent(participants, "conversation:message:created", {
          conversationId,
          message
        });
      } catch {
        auditMessage(
          "audit.message.create",
          principal.userId,
          conversationId,
          message.id,
          "notification_failed",
          "conversation"
        );
      }
    }
    return message;
  }

  // Пересылка сообщения из канала. Оригинал остаётся на
  // месте — пересылка это копия. Целью может быть канал или переписка:
  // источник и цель проверяются независимо. Упоминания не переносятся:
  // подсистема упоминаний в этом пути не вызывается вовсе.
  async forwardMessage(
    principal: AuthPrincipal,
    sourceChannelId: string,
    messageIdValue: unknown,
    body: unknown
  ): Promise<MessageView> {
    // Все проверки прав — до pool.connect(): пул соединений максимум один.
    await this.access.requireChannelPermission(principal, sourceChannelId, "VIEW_CHANNEL");

    const target = parseForwardMessageInput(body);
    if (!target) throw apiError(400, "INVALID_REQUEST", "Некорректная пересылка");
    const messageId = parseMessageId(messageIdValue);
    if (!messageId) throw apiError(400, "INVALID_REQUEST", "Некорректная пересылка");
    await this.assertForwardTarget(principal, target);

    // Исходное сообщение проверяется до транзакции: отсутствующее или удалённое
    // сообщение отклоняется сразу, цель при этом не затрагивается.
    const visible = await this.pool.query<ForwardSourceRow>(forwardSourceSelect, [messageId, sourceChannelId]);
    const visibleRow = visible.rows[0];
    if (!visibleRow || visibleRow.deleted_at !== null) {
      throw apiError(404, "MESSAGE_NOT_FOUND", "Сообщение не найдено");
    }

    return this.forwardCopy(principal, { kind: "channel", id: sourceChannelId }, target, messageId);
  }

  // Пересылка сообщения из переписки: доступ к источнику даёт только
  // участие, поэтому движок прав каналов здесь не вызывается.
  async forwardFromConversation(
    principal: AuthPrincipal,
    conversationIdValue: string,
    messageIdValue: unknown,
    body: unknown
  ): Promise<MessageView> {
    const sourceConversationId = parseConversationId(conversationIdValue);
    if (!sourceConversationId) throw apiError(400, "INVALID_REQUEST", "Некорректный идентификатор переписки");
    // Проверки участия — до pool.connect(): пул соединений максимум один.
    await this.conversations.assertParticipant(principal, sourceConversationId);

    const target = parseForwardMessageInput(body);
    if (!target) throw apiError(400, "INVALID_REQUEST", "Некорректная пересылка");
    const messageId = parseMessageId(messageIdValue);
    if (!messageId) throw apiError(400, "INVALID_REQUEST", "Некорректная пересылка");
    await this.assertForwardTarget(principal, target);

    const visible = await this.pool.query<ForwardSourceRow>(
      conversationForwardSourceSelect,
      [messageId, sourceConversationId]
    );
    const visibleRow = visible.rows[0];
    if (!visibleRow || visibleRow.deleted_at !== null) {
      throw apiError(404, "MESSAGE_NOT_FOUND", "Сообщение не найдено");
    }

    return this.forwardCopy(principal, { kind: "conversation", id: sourceConversationId }, target, messageId);
  }

  // Цель пересылки проверяется независимо от источника: канал — видимость и
  // право отправки, переписка — участие. Не-участник получает 404, чтобы код
  // не подтверждал существование переписки.
  private async assertForwardTarget(principal: AuthPrincipal, target: ForwardTarget): Promise<void> {
    if (target.kind === "conversation") {
      await this.conversations.assertParticipant(principal, target.id);
      return;
    }
    const channel = (await this.access.listVisibleChannels(principal)).find((entry) => entry.id === target.id);
    if (!channel) throw apiError(404, "CHANNEL_NOT_FOUND", "Канал не найден");
    if (!channel.canSend) throw apiError(403, "SEND_NOT_ALLOWED", "В этом канале запрещена отправка сообщений");
  }

  // Общая часть пересылки для обеих областей источника: транзакция, повторное
  // чтение оригинала под блокировкой, копия в целевой области и событие после
  // COMMIT и release(). Различаются только предикат источника и область цели.
  private async forwardCopy(
    principal: AuthPrincipal,
    source: { kind: "channel" | "conversation"; id: string },
    target: ForwardTarget,
    messageId: string
  ): Promise<MessageView> {
    const sourceSelect = source.kind === "channel" ? forwardSourceSelect : conversationForwardSourceSelect;
    let client: PoolClient | undefined;
    let message: MessageView | undefined;
    let forwardedMessageId: string | null = null;
    try {
      client = await this.pool.connect();
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(21471, 901)");

      // Повторное чтение под блокировкой: оригинал не мог быть удалён между
      // проверкой и вставкой копии.
      const locked = await client.query<ForwardSourceRow>(`${sourceSelect} FOR SHARE OF m`, [
        messageId,
        source.id
      ]);
      const origin = locked.rows[0];
      if (!origin || origin.deleted_at !== null) {
        throw apiError(404, "MESSAGE_NOT_FOUND", "Сообщение не найдено");
      }

      const attribution = await this.resolveForwardAttribution(client, origin);
      forwardedMessageId = await this.insertForwardCopy(client, principal, target, origin.content, attribution);

      const row = target.kind === "channel"
        ? await this.loadMessageRow(client, target.id, forwardedMessageId)
        : await this.loadConversationMessageRow(client, target.id, forwardedMessageId);
      if (!row) throw new Error("Forwarded message was not found");
      const authorRolesByUser = await this.loadAuthorRoles(client, [row.author_id]);
      // Упоминания не переносятся: MentionsService здесь не
      // вызывается, поэтому в message_mentions не появляется строки, а mentions пуст.
      message = toMessageView(row, [], authorRolesByUser.get(row.author_id) ?? []);
      await client.query("COMMIT");
      auditMessage(
        "audit.message.forward",
        principal.userId,
        target.id,
        forwardedMessageId,
        "forwarded",
        target.kind
      );
    } catch (error) {
      await client?.query("ROLLBACK").catch(() => undefined);
      auditMessage("audit.message.forward", principal.userId, target.id, forwardedMessageId, "failed", target.kind);
      throw error;
    } finally {
      client?.release();
    }

    if (!message) throw new Error("Forwarded message was not returned");
    await this.emitForwardedCopy(principal, target, message);
    return message;
  }

  // Атрибуция — с одного уровня: пересылка пересланного сообщения наследует
  // атрибуцию оригинала, цепочек не возникает. Область
  // оригинала — ровно одна: канал или переписка.
  private async resolveForwardAttribution(
    client: QueryExecutor,
    origin: ForwardSourceRow
  ): Promise<ForwardAttribution> {
    const inheritedScope = origin.forwarded_from_channel_id !== null ||
      origin.forwarded_from_conversation_id !== null;
    if (!origin.forwarded_from_message_id || !inheritedScope) {
      return {
        messageId: origin.id,
        channelId: origin.channel_id,
        conversationId: origin.conversation_id,
        authorLogin: origin.author_login
      };
    }
    const originalAuthor = await client.query<OriginalAuthorRow>(
      "SELECT u.login AS login FROM messages AS o JOIN users AS u ON u.id = o.author_id WHERE o.id = $1",
      [origin.forwarded_from_message_id]
    );
    return {
      messageId: origin.forwarded_from_message_id,
      channelId: origin.forwarded_from_channel_id,
      conversationId: origin.forwarded_from_conversation_id,
      authorLogin: originalAuthor.rows[0]?.login ?? origin.author_login
    };
  }

  // Копия оригинала в целевой области. `seq` выдаёт строка области под
  // row-lock, тело копируется дословно — форматирование сохраняется.
  private async insertForwardCopy(
    client: PoolClient,
    principal: AuthPrincipal,
    target: ForwardTarget,
    content: string,
    attribution: ForwardAttribution
  ): Promise<string> {
    const clientRequestId = randomUUID();
    if (target.kind === "channel") {
      const sequence = await client.query<{ seq: number }>(
        "UPDATE channels SET last_seq = last_seq + 1, updated_at = now() WHERE id = $1 RETURNING last_seq::int AS seq",
        [target.id]
      );
      const seq = sequence.rows[0]?.seq;
      if (seq === undefined) throw apiError(404, "CHANNEL_NOT_FOUND", "Канал не найден");
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO messages (
           channel_id, author_id, seq, updated_seq, content, client_request_id,
           forwarded_from_message_id, forwarded_from_channel_id, forwarded_from_conversation_id
         )
         VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8)
         RETURNING id::text AS id`,
        [
          target.id,
          principal.userId,
          seq,
          content,
          clientRequestId,
          attribution.messageId,
          attribution.channelId,
          attribution.conversationId
        ]
      );
      const messageId = inserted.rows[0]?.id;
      if (!messageId) throw new Error("Forwarded message was not stored");
      return messageId;
    }

    const sequence = await client.query<{ seq: number }>(
      "UPDATE conversations SET last_seq = last_seq + 1, last_message_at = now() WHERE id = $1 RETURNING last_seq::int AS seq",
      [target.id]
    );
    const seq = sequence.rows[0]?.seq;
    if (seq === undefined) throw apiError(404, "CONVERSATION_NOT_FOUND", "Переписка не найдена");
    // новое сообщение возвращает переписку в список у всех участников —
    // пересланная копия для получателя такое же новое сообщение.
    await client.query(
      "UPDATE conversation_participants SET closed_at = NULL WHERE conversation_id = $1 AND closed_at IS NOT NULL",
      [target.id]
    );
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO messages (
         conversation_id, author_id, seq, updated_seq, content, client_request_id,
         forwarded_from_message_id, forwarded_from_channel_id, forwarded_from_conversation_id
       )
       VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8)
       RETURNING id::text AS id`,
      [
        target.id,
        principal.userId,
        seq,
        content,
        clientRequestId,
        attribution.messageId,
        attribution.channelId,
        attribution.conversationId
      ]
    );
    const messageId = inserted.rows[0]?.id;
    if (!messageId) throw new Error("Forwarded message was not stored");
    return messageId;
  }

  // Событие копии: у канала — рассылка с проверкой доступа гейтвея, у
  // переписки — комнаты участников, прочитанные после COMMIT.
  private async emitForwardedCopy(
    principal: AuthPrincipal,
    target: ForwardTarget,
    message: MessageView
  ): Promise<void> {
    try {
      if (target.kind === "channel") {
        await this.realtime.emitChannelEvent(target.id, "message:created", { channelId: target.id, message });
        return;
      }
      const participants = await this.conversations.participantIds(target.id);
      await this.realtime.emitConversationEvent(participants, "conversation:message:created", {
        conversationId: target.id,
        message
      });
    } catch {
      auditMessage(
        "audit.message.forward",
        principal.userId,
        target.id,
        message.id,
        "notification_failed",
        target.kind
      );
    }
  }

  async listMessages(principal: AuthPrincipal, channelId: string, query: unknown): Promise<MessageListResponse> {
    if (!isRecord(query)) throw apiError(400, "INVALID_REQUEST", "Некорректные параметры запроса");
    const parsed = parseHistoryQuery(query);
    if (!parsed) throw apiError(400, "INVALID_REQUEST", "Некорректные параметры запроса");
    return parsed.after !== undefined
      ? this.listAfter(principal, channelId, parsed)
      : this.listHistory(principal, channelId, parsed);
  }

  private async listHistory(
    principal: AuthPrincipal,
    channelId: string,
    query: MessageHistoryQuery
  ): Promise<MessageListResponse> {
    await this.access.requireChannelPermission(principal, channelId, "VIEW_CHANNEL");
    const channel = await this.pool.query<MessageChannelCursorRow>(
      "SELECT last_seq::int AS cursor, (last_seq + 1)::text AS history_before FROM channels WHERE id = $1",
      [channelId]
    );
    const cursorRow = channel.rows[0];
    if (!cursorRow) throw apiError(404, "CHANNEL_NOT_FOUND", "Канал не найден");
    const before = query.before === undefined ? cursorRow.history_before : query.before;
    const result = await this.pool.query<MessageRow>(
      `${messageSelect}
       WHERE m.channel_id = $1 AND m.seq < $2::bigint AND m.deleted_at IS NULL
       ORDER BY m.seq DESC
       LIMIT $3`,
      [channelId, before, query.limit]
    );
    const rows = result.rows;
    const mentionsByMessage = await this.loadMentions(this.pool, rows.map((row) => row.id));
    const authorIds = [...new Set(rows.map((row) => row.author_id))];
    const authorRolesByUser = await this.loadAuthorRoles(this.pool, authorIds);
    const messages = rows.reverse().map((row) => toMessageView(
      row,
      mentionsByMessage.get(row.id) ?? [],
      authorRolesByUser.get(row.author_id) ?? []
    ));
    return { messages, hasMore: rows.length === query.limit, cursor: cursorRow.cursor };
  }

  private async listAfter(
    principal: AuthPrincipal,
    channelId: string,
    query: MessageHistoryQuery
  ): Promise<MessageListResponse> {
    await this.access.requireChannelPermission(principal, channelId, "VIEW_CHANNEL");
    const after = query.after;
    if (after === undefined) throw apiError(400, "INVALID_REQUEST", "Некорректные параметры запроса");
    const result = await this.pool.query<MessageRow>(
      `${messageSelect}
       WHERE m.channel_id = $1 AND m.updated_seq > $2::bigint
       ORDER BY m.updated_seq ASC
       LIMIT $3`,
      [channelId, after, query.limit]
    );
    const rows = result.rows;
    const mentionsByMessage = await this.loadMentions(this.pool, rows.map((row) => row.id));
    const authorIds = [...new Set(rows.map((row) => row.author_id))];
    const authorRolesByUser = await this.loadAuthorRoles(this.pool, authorIds);
    const messages = rows.map((row) => toMessageView(
      row,
      mentionsByMessage.get(row.id) ?? [],
      authorRolesByUser.get(row.author_id) ?? []
    ));
    return {
      messages,
      hasMore: rows.length === query.limit,
      cursor: rows.at(-1)?.updated_seq ?? after
    };
  }

  // История переписки и догон: тот же контракт, что у канала, но курсор берётся
  // из строки переписки, а все запросы ограничены её областью.
  async listConversationMessages(
    principal: AuthPrincipal,
    conversationIdValue: string,
    query: unknown
  ): Promise<MessageListResponse> {
    if (!isRecord(query)) throw apiError(400, "INVALID_REQUEST", "Некорректные параметры запроса");
    const parsed = parseHistoryQuery(query);
    if (!parsed) throw apiError(400, "INVALID_REQUEST", "Некорректные параметры запроса");
    const conversationId = parseConversationId(conversationIdValue);
    if (!conversationId) throw apiError(400, "INVALID_REQUEST", "Некорректный идентификатор переписки");
    await this.conversations.assertParticipant(principal, conversationId);
    // Граница видимости истории: у нового участника с снятым
    // флажком всё, что отправлено до добавления, скрыто и в истории, и в
    // догоне. Пропуск любого из двух мест раскрыл бы историю.
    const visibleFromSeq = await this.conversations.visibleFromSeq(principal.userId, conversationId);

    if (parsed.after !== undefined) {
      const result = await this.pool.query<MessageRow>(
        `${messageSelect}
         WHERE m.conversation_id = $1 AND m.updated_seq > $2::bigint AND m.seq > $4::bigint
         ORDER BY m.updated_seq ASC
         LIMIT $3`,
        [conversationId, parsed.after, parsed.limit, visibleFromSeq]
      );
      const rows = result.rows;
      const mentionsByMessage = await this.loadMentions(this.pool, rows.map((row) => row.id));
      const authorRolesByUser = await this.loadAuthorRoles(
        this.pool,
        [...new Set(rows.map((row) => row.author_id))]
      );
      return {
        messages: rows.map((row) => toMessageView(
          row,
          mentionsByMessage.get(row.id) ?? [],
          authorRolesByUser.get(row.author_id) ?? []
        )),
        hasMore: rows.length === parsed.limit,
        // Курсор не опускается ниже границы видимости: иначе клиент с пустой
        // страницей и прежним курсором запрашивал бы скрытый участок снова.
        cursor: Math.max(rows.at(-1)?.updated_seq ?? parsed.after, visibleFromSeq)
      };
    }

    const cursor = await this.pool.query<MessageChannelCursorRow>(
      "SELECT last_seq::int AS cursor, (last_seq + 1)::text AS history_before FROM conversations WHERE id = $1",
      [conversationId]
    );
    const cursorRow = cursor.rows[0];
    if (!cursorRow) throw apiError(404, "CONVERSATION_NOT_FOUND", "Переписка не найдена");
    const before = parsed.before === undefined ? cursorRow.history_before : parsed.before;
    const result = await this.pool.query<MessageRow>(
      `${messageSelect}
       WHERE m.conversation_id = $1 AND m.seq < $2::bigint AND m.deleted_at IS NULL AND m.seq > $4::bigint
       ORDER BY m.seq DESC
       LIMIT $3`,
      [conversationId, before, parsed.limit, visibleFromSeq]
    );
    const rows = result.rows;
    const mentionsByMessage = await this.loadMentions(this.pool, rows.map((row) => row.id));
    const authorRolesByUser = await this.loadAuthorRoles(
      this.pool,
      [...new Set(rows.map((row) => row.author_id))]
    );
    const messages = rows.reverse().map((row) => toMessageView(
      row,
      mentionsByMessage.get(row.id) ?? [],
      authorRolesByUser.get(row.author_id) ?? []
    ));
    return { messages, hasMore: rows.length === parsed.limit, cursor: cursorRow.cursor };
  }

  async edit(principal: AuthPrincipal, channelId: string, messageIdValue: unknown, input: unknown): Promise<MessageView> {
    await this.access.requireChannelPermission(principal, channelId, "VIEW_CHANNEL");
    const messageId = parseMessageId(messageIdValue);
    const parsed = parseEditMessageInput(input);
    if (!messageId || !parsed) throw apiError(400, "INVALID_REQUEST", "Некорректное сообщение");
    const resolvedMentions = await this.mentions.resolveForChannel(channelId, parsed.content);

    let client: PoolClient | undefined;
    let message: MessageView | undefined;
    try {
      client = await this.pool.connect();
      await client.query("BEGIN");
      const permissions = await client.query<EditPermissionRow>(
        `SELECT author_id::text AS author_id,
                created_at < now() - interval '3 days' AS edit_window_expired
         FROM messages
         WHERE id = $1 AND channel_id = $2 AND deleted_at IS NULL
         FOR UPDATE`,
        [messageId, channelId]
      );
      const row = permissions.rows[0];
      if (!row) throw apiError(404, "MESSAGE_NOT_FOUND", "Сообщение не найдено");
      if (row.author_id !== principal.userId) {
        throw apiError(403, "FORBIDDEN", "Недостаточно прав для правки этого сообщения");
      }
      if (row.edit_window_expired) throw apiError(403, "EDIT_WINDOW_EXPIRED", "Срок правки сообщения истёк");

      const sequence = await client.query<{ seq: number }>(
        "UPDATE channels SET last_seq = last_seq + 1, updated_at = now() WHERE id = $1 RETURNING last_seq::int AS seq",
        [channelId]
      );
      const updatedSeq = sequence.rows[0]?.seq;
      if (updatedSeq === undefined) throw apiError(404, "CHANNEL_NOT_FOUND", "Канал не найден");
      await client.query(
        "UPDATE messages SET content = $1, edited_at = now(), updated_seq = $2 WHERE id = $3 AND channel_id = $4",
        [parsed.content, updatedSeq, messageId, channelId]
      );

      await client.query("DELETE FROM message_mentions WHERE message_id = $1", [messageId]);
      await this.mentions.recordMentions(messageId, resolvedMentions, client);

      const updatedRow = await this.loadMessageRow(client, channelId, messageId);
      if (!updatedRow) throw new Error("Updated message was not found");
      const mentionsByMessage = await this.loadMentions(client, [messageId]);
      const authorRolesByUser = await this.loadAuthorRoles(client, [updatedRow.author_id]);
      message = toMessageView(
        updatedRow,
        mentionsByMessage.get(messageId) ?? [],
        authorRolesByUser.get(updatedRow.author_id) ?? []
      );
      await client.query("COMMIT");
      auditMessage("audit.message.update", principal.userId, channelId, messageId, "updated");
    } catch (error) {
      await client?.query("ROLLBACK").catch(() => undefined);
      auditMessage("audit.message.update", principal.userId, channelId, messageId, "failed");
      throw error;
    } finally {
      client?.release();
    }

    if (!message) throw new Error("Updated message was not returned");
    try {
      await this.realtime.emitChannelEvent(channelId, "message:updated", { channelId, message });
    } catch {
      auditMessage("audit.message.update", principal.userId, channelId, message.id, "notification_failed");
    }
    return message;
  }

  async remove(principal: AuthPrincipal, channelId: string, messageIdValue: unknown): Promise<void> {
    await this.access.requireChannelPermission(principal, channelId, "VIEW_CHANNEL");
    const messageId = parseMessageId(messageIdValue);
    if (!messageId) throw apiError(400, "INVALID_REQUEST", "Некорректный идентификатор сообщения");
    const canManageMessages = await this.access.hasChannelPermission(principal, channelId, "MANAGE_MESSAGES");

    let client: PoolClient | undefined;
    let updatedSeq: number | undefined;
    try {
      client = await this.pool.connect();
      await client.query("BEGIN");
      const selected = await client.query<DeletePermissionRow>(
        `SELECT author_id::text AS author_id
         FROM messages
         WHERE id = $1 AND channel_id = $2 AND deleted_at IS NULL
         FOR UPDATE`,
        [messageId, channelId]
      );
      const row = selected.rows[0];
      if (!row) throw apiError(404, "MESSAGE_NOT_FOUND", "Сообщение не найдено");
      if (row.author_id !== principal.userId && !canManageMessages) {
        throw apiError(403, "FORBIDDEN", "Недостаточно прав для удаления этого сообщения");
      }

      const sequence = await client.query<{ seq: number }>(
        "UPDATE channels SET last_seq = last_seq + 1, updated_at = now() WHERE id = $1 RETURNING last_seq::int AS seq",
        [channelId]
      );
      updatedSeq = sequence.rows[0]?.seq;
      if (updatedSeq === undefined) throw apiError(404, "CHANNEL_NOT_FOUND", "Канал не найден");
      await client.query(
        "UPDATE messages SET deleted_at = now(), updated_seq = $2 WHERE id = $1 AND channel_id = $3",
        [messageId, updatedSeq, channelId]
      );
      // Удаление сообщения «мягкое», поэтому ON DELETE CASCADE не сработает:
      // закрепление снимается явной строкой в той же транзакции.
      await client.query("DELETE FROM channel_pins WHERE message_id = $1", [messageId]);
      await client.query("COMMIT");
      auditMessage("audit.message.delete", principal.userId, channelId, messageId, "deleted");
    } catch (error) {
      await client?.query("ROLLBACK").catch(() => undefined);
      auditMessage("audit.message.delete", principal.userId, channelId, messageId, "failed");
      throw error;
    } finally {
      client?.release();
    }

    if (updatedSeq === undefined) throw new Error("Deleted message sequence was not returned");
    try {
      await this.realtime.emitChannelEvent(channelId, "message:deleted", { channelId, messageId, updatedSeq });
    } catch {
      auditMessage("audit.message.delete", principal.userId, channelId, messageId, "notification_failed");
    }
  }

  // Правка сообщения переписки: только автор. Окно правки — те же три
  // дня, что в каналах (допущение A7), а право «Управлять сообщениями» здесь
  // не запрашивается вовсе, поэтому модератор чужое сообщение не правит.
  async editInConversation(
    principal: AuthPrincipal,
    conversationIdValue: string,
    messageIdValue: unknown,
    input: unknown
  ): Promise<MessageView> {
    const conversationId = parseConversationId(conversationIdValue);
    if (!conversationId) throw apiError(400, "INVALID_REQUEST", "Некорректный идентификатор переписки");
    const messageId = parseMessageId(messageIdValue);
    const parsed = parseEditMessageInput(input);
    if (!messageId || !parsed) throw apiError(400, "INVALID_REQUEST", "Некорректное сообщение");
    await this.conversations.assertParticipant(principal, conversationId);
    // Упоминания резолвятся по составу переписки до pool.connect().
    const resolvedMentions = await this.mentions.resolveForConversation(conversationId, parsed.content);

    let client: PoolClient | undefined;
    let message: MessageView | undefined;
    try {
      client = await this.pool.connect();
      await client.query("BEGIN");
      const permissions = await client.query<EditPermissionRow>(
        `SELECT author_id::text AS author_id,
                created_at < now() - interval '3 days' AS edit_window_expired
         FROM messages
         WHERE id = $1 AND conversation_id = $2 AND deleted_at IS NULL
         FOR UPDATE`,
        [messageId, conversationId]
      );
      const row = permissions.rows[0];
      if (!row) throw apiError(404, "MESSAGE_NOT_FOUND", "Сообщение не найдено");
      if (row.author_id !== principal.userId) {
        throw apiError(403, "FORBIDDEN", "Недостаточно прав для правки этого сообщения");
      }
      if (row.edit_window_expired) throw apiError(403, "EDIT_WINDOW_EXPIRED", "Срок правки сообщения истёк");

      const sequence = await client.query<{ seq: number }>(
        "UPDATE conversations SET last_seq = last_seq + 1 WHERE id = $1 RETURNING last_seq::int AS seq",
        [conversationId]
      );
      const updatedSeq = sequence.rows[0]?.seq;
      if (updatedSeq === undefined) throw apiError(404, "CONVERSATION_NOT_FOUND", "Переписка не найдена");
      await client.query(
        "UPDATE messages SET content = $1, edited_at = now(), updated_seq = $2 WHERE id = $3 AND conversation_id = $4",
        [parsed.content, updatedSeq, messageId, conversationId]
      );

      await client.query("DELETE FROM message_mentions WHERE message_id = $1", [messageId]);
      await this.mentions.recordMentions(messageId, resolvedMentions, client);

      const updatedRow = await this.loadConversationMessageRow(client, conversationId, messageId);
      if (!updatedRow) throw new Error("Updated message was not found");
      const mentionsByMessage = await this.loadMentions(client, [messageId]);
      const authorRolesByUser = await this.loadAuthorRoles(client, [updatedRow.author_id]);
      message = toMessageView(
        updatedRow,
        mentionsByMessage.get(messageId) ?? [],
        authorRolesByUser.get(updatedRow.author_id) ?? []
      );
      await client.query("COMMIT");
      auditMessage("audit.message.update", principal.userId, conversationId, messageId, "updated", "conversation");
    } catch (error) {
      await client?.query("ROLLBACK").catch(() => undefined);
      auditMessage("audit.message.update", principal.userId, conversationId, messageId, "failed", "conversation");
      throw error;
    } finally {
      client?.release();
    }

    if (!message) throw new Error("Updated message was not returned");
    // Состав читается после COMMIT: событие не уйдёт тому, кого уже убрали.
    try {
      const participants = await this.conversations.participantIds(conversationId);
      await this.realtime.emitConversationEvent(participants, "conversation:message:updated", {
        conversationId,
        message
      });
    } catch {
      auditMessage(
        "audit.message.update",
        principal.userId,
        conversationId,
        message.id,
        "notification_failed",
        "conversation"
      );
    }
    return message;
  }

  // Удаление сообщения переписки: только автор. Движок прав каналов не
  // вызывается — право «Управлять сообщениями» в переписке не действует, а
  // администратор не вмешивается. Закреплений у переписок нет, поэтому
  // `channel_pins` не трогается.
  async removeInConversation(
    principal: AuthPrincipal,
    conversationIdValue: string,
    messageIdValue: unknown
  ): Promise<void> {
    const conversationId = parseConversationId(conversationIdValue);
    if (!conversationId) throw apiError(400, "INVALID_REQUEST", "Некорректный идентификатор переписки");
    const messageId = parseMessageId(messageIdValue);
    if (!messageId) throw apiError(400, "INVALID_REQUEST", "Некорректный идентификатор сообщения");
    await this.conversations.assertParticipant(principal, conversationId);

    let client: PoolClient | undefined;
    let updatedSeq: number | undefined;
    try {
      client = await this.pool.connect();
      await client.query("BEGIN");
      const selected = await client.query<DeletePermissionRow>(
        `SELECT author_id::text AS author_id
         FROM messages
         WHERE id = $1 AND conversation_id = $2 AND deleted_at IS NULL
         FOR UPDATE`,
        [messageId, conversationId]
      );
      const row = selected.rows[0];
      if (!row) throw apiError(404, "MESSAGE_NOT_FOUND", "Сообщение не найдено");
      if (row.author_id !== principal.userId) {
        throw apiError(403, "FORBIDDEN", "Недостаточно прав для удаления этого сообщения");
      }

      const sequence = await client.query<{ seq: number }>(
        "UPDATE conversations SET last_seq = last_seq + 1 WHERE id = $1 RETURNING last_seq::int AS seq",
        [conversationId]
      );
      updatedSeq = sequence.rows[0]?.seq;
      if (updatedSeq === undefined) throw apiError(404, "CONVERSATION_NOT_FOUND", "Переписка не найдена");
      await client.query(
        "UPDATE messages SET deleted_at = now(), updated_seq = $2 WHERE id = $1 AND conversation_id = $3",
        [messageId, updatedSeq, conversationId]
      );
      await client.query("COMMIT");
      auditMessage("audit.message.delete", principal.userId, conversationId, messageId, "deleted", "conversation");
    } catch (error) {
      await client?.query("ROLLBACK").catch(() => undefined);
      auditMessage("audit.message.delete", principal.userId, conversationId, messageId, "failed", "conversation");
      throw error;
    } finally {
      client?.release();
    }

    if (updatedSeq === undefined) throw new Error("Deleted message sequence was not returned");
    try {
      const participants = await this.conversations.participantIds(conversationId);
      await this.realtime.emitConversationEvent(participants, "conversation:message:deleted", {
        conversationId,
        messageId,
        updatedSeq
      });
    } catch {
      auditMessage(
        "audit.message.delete",
        principal.userId,
        conversationId,
        messageId,
        "notification_failed",
        "conversation"
      );
    }
  }

  // Закрепление сообщения: только участник с правом «Управлять сообщениями»
  //. Автор своего сообщения без этого права закрепить его не может.
  async pinMessage(principal: AuthPrincipal, channelId: string, body: unknown): Promise<void> {
    await this.access.requireChannelPermission(principal, channelId, "VIEW_CHANNEL");
    await this.access.requireChannelPermission(principal, channelId, "MANAGE_MESSAGES");

    const parsed = parsePinMessageInput(body);
    if (!parsed) throw apiError(400, "INVALID_REQUEST", "Некорректное закрепление");

    // Первичная проверка до транзакции: заведомо удалённое сообщение
    // отклоняется сразу. Решающей является проверка под блокировкой внутри
    // транзакции — она отсекает удаление, случившееся между шагами.
    const message = await this.pool.query<{ id: string }>(
      "SELECT id::text AS id FROM messages WHERE id = $1 AND channel_id = $2 AND deleted_at IS NULL",
      [parsed.messageId, channelId]
    );
    if (!message.rows[0]) throw apiError(404, "MESSAGE_NOT_FOUND", "Сообщение не найдено");

    let client: PoolClient | undefined;
    let pinnedAt: string | undefined;
    try {
      client = await this.pool.connect();
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(21471, 901)");
      // Повторное чтение под блокировкой: сообщение не могло быть удалено между
      // проверкой и вставкой закрепления (как при пересылке). FOR SHARE не
      // совместим с блокировкой удаления (FOR UPDATE), поэтому удаление и
      // закрепление одного сообщения не могут пройти одновременно.
      const locked = await client.query<{ id: string }>(
        "SELECT id::text AS id FROM messages WHERE id = $1 AND channel_id = $2 AND deleted_at IS NULL FOR SHARE",
        [parsed.messageId, channelId]
      );
      if (!locked.rows[0]) throw apiError(404, "MESSAGE_NOT_FOUND", "Сообщение не найдено");
      // Повторное закрепление того же сообщения идемпотентно: время закрепления
      // не меняется, новой строки не создаётся.
      await client.query(
        `INSERT INTO channel_pins (message_id, channel_id, pinned_by, pinned_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (message_id) DO NOTHING`,
        [parsed.messageId, channelId, principal.userId]
      );
      const stored = await client.query<{ pinned_at: Date | string }>(
        "SELECT pinned_at FROM channel_pins WHERE message_id = $1",
        [parsed.messageId]
      );
      const storedAt = stored.rows[0]?.pinned_at;
      if (storedAt === undefined) throw new Error("Pinned message was not stored");
      pinnedAt = toIsoString(storedAt);
      await client.query("COMMIT");
      auditMessage("audit.message.pin", principal.userId, channelId, parsed.messageId, "pinned");
    } catch (error) {
      await client?.query("ROLLBACK").catch(() => undefined);
      auditMessage("audit.message.pin", principal.userId, channelId, parsed.messageId, "failed");
      throw error;
    } finally {
      client?.release();
    }

    try {
      await this.realtime.emitChannelEvent(channelId, "message:pinned", {
        channelId,
        messageId: parsed.messageId,
        pinnedAt: pinnedAt ?? null
      });
    } catch {
      auditMessage("audit.message.pin", principal.userId, channelId, parsed.messageId, "notification_failed");
    }
  }

  // Снятие закрепления: участник с правом «Управлять сообщениями» или автор
  // самого закреплённого сообщения.
  async unpinMessage(principal: AuthPrincipal, channelId: string, messageIdValue: unknown): Promise<void> {
    await this.access.requireChannelPermission(principal, channelId, "VIEW_CHANNEL");
    const messageId = parseMessageId(messageIdValue);
    if (!messageId) throw apiError(400, "INVALID_REQUEST", "Некорректный идентификатор сообщения");

    const message = await this.pool.query<{ author_id: string }>(
      "SELECT author_id::text AS author_id FROM messages WHERE id = $1 AND channel_id = $2",
      [messageId, channelId]
    );
    const row = message.rows[0];
    if (!row) throw apiError(404, "MESSAGE_NOT_FOUND", "Сообщение не найдено");

    const canManage = await this.access.hasChannelPermission(principal, channelId, "MANAGE_MESSAGES");
    if (!canManage && row.author_id !== principal.userId) {
      throw apiError(403, "FORBIDDEN", "Недостаточно прав для снятия закрепления");
    }

    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(21471, 901)");
      await client.query("DELETE FROM channel_pins WHERE message_id = $1 AND channel_id = $2", [messageId, channelId]);
      await client.query("COMMIT");
      auditMessage("audit.message.unpin", principal.userId, channelId, messageId, "unpinned");
    } catch (error) {
      await client?.query("ROLLBACK").catch(() => undefined);
      auditMessage("audit.message.unpin", principal.userId, channelId, messageId, "failed");
      throw error;
    } finally {
      client?.release();
    }

    try {
      await this.realtime.emitChannelEvent(channelId, "message:unpinned", { channelId, messageId });
    } catch {
      auditMessage("audit.message.unpin", principal.userId, channelId, messageId, "notification_failed");
    }
  }

  // Список закреплений канала. Доступен только при «VIEW_CHANNEL»: для канала
  // без доступа — 404, код не выдаёт факт существования канала.
  async listPins(principal: AuthPrincipal, channelId: string): Promise<PinnedMessage[]> {
    await this.access.requireChannelPermission(principal, channelId, "VIEW_CHANNEL");
    const result = await this.pool.query<PinnedMessageRow>(
      `SELECT p.message_id::text AS message_id,
              p.channel_id::text AS channel_id,
              p.pinned_at,
              m.id::text AS id,
              m.author_id::text AS author_id,
              u.login AS author_login,
              m.content,
              m.created_at
       FROM channel_pins AS p
       JOIN messages AS m ON m.id = p.message_id
       JOIN users AS u ON u.id = m.author_id
       WHERE p.channel_id = $1 AND m.deleted_at IS NULL
       ORDER BY p.pinned_at DESC`,
      [channelId]
    );
    const rows = result.rows;
    const mentionsByMessage = await this.loadMentions(this.pool, rows.map((row) => row.id));
    const authorRolesByUser = await this.loadAuthorRoles(
      this.pool,
      [...new Set(rows.map((row) => row.author_id))]
    );
    return rows.map((row) => ({
      messageId: row.message_id,
      channelId: row.channel_id,
      authorId: row.author_id,
      authorLogin: row.author_login,
      authorRoles: authorRolesByUser.get(row.author_id) ?? [],
      content: row.content,
      mentions: mentionsByMessage.get(row.id) ?? [],
      createdAt: toIsoString(row.created_at),
      pinnedAt: toIsoString(row.pinned_at)
    }));
  }

  async listMembers(principal: AuthPrincipal, channelId: string): Promise<{
    members: Array<{
      id: string;
      login: string;
      roles: MessageAuthorRole[];
      presence: "online" | "offline";
    }>;
  }> {
    await this.access.requireChannelPermission(principal, channelId, "VIEW_CHANNEL");
    const members = await this.access.listChannelMembers(channelId);
    const onlineUserIds = this.realtime.onlineUserIds();
    return {
      members: members.map((member) => ({
        ...member,
        presence: onlineUserIds.has(member.id) ? "online" : "offline"
      }))
    };
  }

  async listReaders(principal: AuthPrincipal, channelId: string, messageIdValue: unknown): Promise<MessageReader[]> {
    await this.access.requireChannelPermission(principal, channelId, "VIEW_CHANNEL");
    const messageId = parseMessageId(messageIdValue);
    if (!messageId) throw apiError(400, "INVALID_REQUEST", "Некорректный идентификатор сообщения");

    const message = await this.pool.query<MessageAuthorRow>(
      `SELECT id::text AS id,
              channel_id::text AS channel_id,
              seq::int AS seq,
              created_at,
              author_id::text AS author_id
       FROM messages
       WHERE id = $1 AND channel_id = $2 AND deleted_at IS NULL`,
      [messageId, channelId]
    );
    const target = message.rows[0];
    if (!target) throw apiError(404, "MESSAGE_NOT_FOUND", "Сообщение не найдено");
    // Список прочитанных видит только автор сообщения.
    if (target.author_id !== principal.userId) {
      throw apiError(403, "FORBIDDEN", "Список прочитанных доступен только автору сообщения");
    }

    // Срок хранения ограничивает и сам список: прочитанное старше срока не
    // показывается, даже если очистка журнала ещё не выполнялась.
    // При бессрочном хранении срок не задан (NULL) и условие пропускается.
    const retention = await this.pool.query<ReadRetentionRow>(
      "SELECT read_retention_days FROM organization WHERE id = 1"
    );
    const retentionDays = retention.rows[0]?.read_retention_days ?? null;

    // Читатель — участник, чей курсор дошёл до сообщения, при том сообщение
    // возникло после его входа в канал, а доступ к каналу сохранился до сих пор.
    const candidates = await this.pool.query<MessageReaderRow>(
      `SELECT j.user_id::text AS user_id,
              u.login,
              MIN(j.read_at) AS read_at
       FROM channel_read_journal AS j
       JOIN channel_read_bases AS b
         ON b.user_id = j.user_id AND b.channel_id = j.channel_id
       JOIN users AS u ON u.id = j.user_id
       WHERE j.channel_id = $1
         AND j.seq >= $2
         AND $3::timestamptz > b.entry_at
         AND u.active = true
         AND j.user_id <> $4
         AND ($5::int IS NULL OR j.read_at >= now() - make_interval(days => $5::int))
       GROUP BY j.user_id, u.login
       ORDER BY MIN(j.read_at) ASC, u.login ASC`,
      [channelId, target.seq, target.created_at, principal.userId, retentionDays]
    );
    if (candidates.rows.length === 0) return [];

    // Текущий доступ — единственный источник истины: прочитавший, но потерявший
    // доступ к каналу, в списке не появляется.
    const visibleByUser = await this.access.listVisibleChannelsForUsers(
      candidates.rows.map((candidate) => candidate.user_id)
    );
    const readers: MessageReader[] = [];
    for (const candidate of candidates.rows) {
      const visibleChannels = visibleByUser.get(candidate.user_id) ?? [];
      if (!visibleChannels.some((channel) => channel.id === channelId && channel.canView === true)) continue;
      readers.push({
        userId: candidate.user_id,
        login: candidate.login,
        readAt: toIsoString(candidate.read_at)
      });
    }
    return readers;
  }

  async markRead(principal: AuthPrincipal, channelId: string, body: unknown): Promise<void> {
    const seq = isRecord(body) && Object.keys(body).length === 1 ? body.seq : undefined;
    if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0) {
      throw apiError(400, "INVALID_REQUEST", "Некорректная отметка прочитанного");
    }

    await this.access.requireChannelPermission(principal, channelId, "VIEW_CHANNEL");

    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      await client.query("BEGIN");
      const cursor = await client.query<ChannelReadCursorRow>(
        "SELECT COALESCE(max(seq), 0)::int AS max_seq FROM messages WHERE channel_id = $1",
        [channelId]
      );
      const maxSeq = cursor.rows[0]?.max_seq;
      if (maxSeq === undefined) throw new Error("Channel read cursor was not returned");
      // Момент первого входа участника в канал: сообщения, лежавшие в канале до него,
      // прочитанными не считаются.
      await client.query(
        `INSERT INTO channel_read_bases (user_id, channel_id, entry_at)
         VALUES ($1, $2, now())
         ON CONFLICT (user_id, channel_id) DO NOTHING`,
        [principal.userId, channelId]
      );
      // Курсор двигается только вперёд: без условия в DO UPDATE повторный markRead
      // (он вызывается при каждом открытии канала) не отличить от реального продвижения.
      const advanced = await client.query<ChannelReadAdvanceRow>(
        `INSERT INTO channel_reads (user_id, channel_id, last_read_seq)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, channel_id) DO UPDATE
         SET last_read_seq = GREATEST(channel_reads.last_read_seq, EXCLUDED.last_read_seq),
             updated_at = now()
         WHERE channel_reads.last_read_seq < EXCLUDED.last_read_seq
         RETURNING last_read_seq::bigint AS advanced_seq`,
        [principal.userId, channelId, Math.min(seq, maxSeq)]
      );
      const advancedSeq = advanced.rows[0]?.advanced_seq;
      // Журнал пополняется только реальными продвижениями курсора.
      // Ветка DO UPDATE срабатывает лишь когда last_read_seq меньше нового
      // значения, а при первой вставке (строки ещё нет) курсор считается
      // нулевым. Поэтому продвижение произошло тогда и только тогда, когда
      // новое значение больше нуля: отметка прочитанного с seq = 0 (открытие
      // канала) не является продвижением и строкой в журнале не является.
      // Решение принимается здесь: и запись в журнал, и ленивая очистка
      // выполняются только при фактическом продвижении курсора.
      if (advancedSeq !== undefined && Number(advancedSeq) > 0) {
        await client.query(
          `INSERT INTO channel_read_journal (user_id, channel_id, seq, read_at)
           VALUES ($1, $2, $3, now())
           ON CONFLICT (user_id, channel_id, seq) DO NOTHING`,
          [principal.userId, channelId, advancedSeq]
        );
      }
      // Ленивая очистка журнала: старые записи удаляются при открытии канала.
      // Очистка идёт на каждом открытии, а не только при продвижении курсора:
      // иначе в установке, где новых сообщений нет, записи старше срока
      // оставались бы в журнале и показывались бы в «Кто прочитал», хотя
      // срок хранения должен ограничивать журнал. Выборка идёт по
      // индексу по read_at, поэтому удаление дешёвое.
      const retention = await client.query<ReadRetentionRow>(
        "SELECT read_retention_days FROM organization WHERE id = 1"
      );
      const retentionDays = retention.rows[0]?.read_retention_days ?? null;
      if (retentionDays !== null) {
        await client.query(
          "DELETE FROM channel_read_journal WHERE read_at < now() - make_interval(days => $1::int)",
          [retentionDays]
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client?.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client?.release();
    }
  }

  private async loadMessageRow(client: QueryExecutor, channelId: string, messageId: string): Promise<MessageRow | null> {
    const result = await client.query<MessageRow>(
      `${messageSelect}
       WHERE m.channel_id = $1 AND m.id = $2`,
      [channelId, messageId]
    );
    return result.rows[0] ?? null;
  }

  private async loadConversationMessageRow(
    client: QueryExecutor,
    conversationId: string,
    messageId: string
  ): Promise<MessageRow | null> {
    const result = await client.query<MessageRow>(
      `${messageSelect}
       WHERE m.conversation_id = $1 AND m.id = $2`,
      [conversationId, messageId]
    );
    return result.rows[0] ?? null;
  }

  private async loadMentions(
    executor: QueryExecutor,
    messageIds: string[]
  ): Promise<Map<string, Array<{ id: string; login: string }>>> {
    const mentionsByMessage = new Map<string, Array<{ id: string; login: string }>>();
    if (messageIds.length === 0) return mentionsByMessage;
    const result = await executor.query<MessageMentionRow>(
      `SELECT mm.message_id::text AS message_id, mm.user_id::text AS user_id, user_account.login
       FROM message_mentions AS mm
       JOIN users AS user_account ON user_account.id = mm.user_id
       WHERE mm.message_id = ANY($1::uuid[])`,
      [messageIds]
    );
    for (const row of result.rows) {
      const mentions = mentionsByMessage.get(row.message_id) ?? [];
      mentions.push({ id: row.user_id, login: row.login });
      mentionsByMessage.set(row.message_id, mentions);
    }
    return mentionsByMessage;
  }

  private async loadAuthorRoles(
    executor: QueryExecutor,
    authorIds: string[]
  ): Promise<Map<string, MessageAuthorRole[]>> {
    const authorRolesByUser = new Map<string, MessageAuthorRole[]>();
    if (authorIds.length === 0) return authorRolesByUser;
    const result = await executor.query<MessageAuthorRoleRow>(
      `SELECT assignment.user_id::text AS author_id,
              role.id::text AS id,
              role.name,
              role.color,
              role.position
       FROM user_roles AS assignment
       JOIN roles AS role ON role.id = assignment.role_id
       WHERE assignment.user_id = ANY($1::uuid[])
         AND role.system_key IS DISTINCT FROM 'everyone'
       ORDER BY assignment.user_id, role.position DESC, role.id ASC`,
      [authorIds]
    );
    for (const row of result.rows) {
      const roles = authorRolesByUser.get(row.author_id) ?? [];
      roles.push({ id: row.id, name: row.name, color: row.color, position: row.position });
      authorRolesByUser.set(row.author_id, roles);
    }
    return authorRolesByUser;
  }
}
