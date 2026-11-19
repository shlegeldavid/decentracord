import { HttpException } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import type { Socket } from "socket.io";
import type { AuthPrincipal } from "../auth/session.service.js";
import type { SocketPrincipalData } from "../auth/session-revocation.service.js";
import type { RealtimeGateway } from "../realtime/realtime.gateway.js";
import {
  parseAddParticipantInput,
  parseConversationId,
  parseCreateConversationInput,
  parseParticipantRightInput,
  parseReadConversationBody,
  type ConversationKind,
  type ConversationParticipant,
  type ConversationView
} from "./conversations.dto.js";

interface ConversationRow {
  id: string;
  kind: ConversationKind;
  is_creator: boolean;
  can_add_participants: boolean;
  last_read_seq: number;
  visible_from_seq: number;
  created_at: Date | string;
  last_message_at: Date | string | null;
}

interface ParticipantRow {
  conversation_id: string;
  id: string;
  login: string;
  can_add_participants: boolean;
}

interface UnreadCountRow {
  conversation_id: string;
  unread_count: number;
}

interface ReadCursorRow {
  last_read_seq: number;
}

interface MembershipRow {
  kind: ConversationKind;
  last_seq: number;
  is_creator: boolean;
  can_add_participants: boolean;
}

// Предел группы — 10 человек включая создателя.
const MAX_GROUP_PARTICIPANTS = 10;

// Предел группы — 10 человек включая создателя, поэтому в теле запроса может
// быть не больше девяти участников.
const MAX_INVITED_PARTICIPANTS = 9;

// Скрытие переписки на двоих с отключённым собеседником — условие
// списка, а не запрет API: доступ к истории у активного участника остаётся.
// Группа не скрывается никогда: отключение одного не должно ломать общение
// остальных (допущение A2 исследования).
const DIRECT_PEER_ACTIVE_FILTER = `AND NOT (
    c.kind = 'direct'
    AND EXISTS (
      SELECT 1
      FROM conversation_participants AS peer
      JOIN users AS peer_user ON peer_user.id = peer.user_id
      WHERE peer.conversation_id = c.id AND peer.user_id <> $1 AND peer_user.active = false
    )
  )`;

function apiError(status: number, code: string, message: string): HttpException {
  return new HttpException({ code, message }, status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toIsoString(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid conversation timestamp");
  return date.toISOString();
}

export class ConversationsService {
  constructor(
    private readonly pool: Pool,
    private readonly realtime: RealtimeGateway
  ) {
    // Гейтвей не знает о переписках: проверку участия подключает сервис, иначе
    // граф модулей замкнулся бы через обратный импорт `RealtimeModule`.
    this.realtime.registerConversationTypingHandler((socket, payload) => this.handleTyping(socket, payload));
  }

  // Единственная точка проверки доступа к переписке: доступ даёт строка
  // в `conversation_participants`. Движок прав каналов здесь не вызывается —
  // право ADMINISTRATOR открыло бы администратору чужую переписку. Отказ
  // отдаётся кодом 404, чтобы не подтверждать существование переписки.
  async assertParticipant(principal: AuthPrincipal, conversationId: string): Promise<void> {
    const result = await this.pool.query(
      "SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2",
      [conversationId, principal.userId]
    );
    if (result.rows.length === 0) throw apiError(404, "CONVERSATION_NOT_FOUND", "Переписка не найдена");
  }

  async participantIds(conversationId: string): Promise<string[]> {
    const result = await this.pool.query<{ user_id: string }>(
      "SELECT user_id::text AS user_id FROM conversation_participants WHERE conversation_id = $1",
      [conversationId]
    );
    return result.rows.map((row) => row.user_id);
  }

  // Транспорт «печатает…»: сервер не хранит состояние набора —
  // он проверяет участие, берёт логин из базы и пересылает событие остальным
  // участникам в их комнаты `user:<id>`. Ответа клиенту нет: набор эфемерен, и
  // любая ошибка стала бы оракулом существования переписки.
  private async handleTyping(socket: Socket, payload: unknown): Promise<void> {
    const conversationId = isRecord(payload) && typeof payload.conversationId === "string"
      ? payload.conversationId
      : null;
    if (!conversationId) return;

    const principal = (socket.data as SocketPrincipalData | undefined)?.principal;
    if (!principal) return;

    try {
      await this.assertParticipant(principal, conversationId);
    } catch {
      // Посторонний не отличается от несуществующей переписки: молчание.
      return;
    }

    try {
      const participants = await this.participantIds(conversationId);
      // Логин берётся только из базы: клиентский payload содержит ровно
      // `conversationId`, подделать отображаемое имя нельзя.
      const author = await this.pool.query<{ login: string }>(
        "SELECT login FROM users WHERE id = $1 AND active = true",
        [principal.userId]
      );
      const login = author.rows[0]?.login;
      if (!login) return;
      const recipients = participants.filter((userId) => userId !== principal.userId);
      if (recipients.length === 0) return;
      await this.realtime.emitConversationEvent(recipients, "conversation:typing", {
        conversationId,
        userId: principal.userId,
        login
      });
    } catch {
      // Набор эфемерен: сбой рассылки не влияет на диалог и не логируется как ошибка.
    }
  }

  async create(principal: AuthPrincipal, body: unknown): Promise<ConversationView> {
    const parsed = parseCreateConversationInput(body);
    if (!parsed) throw apiError(400, "INVALID_REQUEST", "Некорректный состав переписки");
    const { participantIds } = parsed;

    // Себе самому писать нельзя. Проверка серверная: недоступность пути
    // в интерфейсе защитой не считается.
    if (participantIds.includes(principal.userId)) {
      throw apiError(400, "SELF_CONVERSATION", "Нельзя начать переписку с самим собой");
    }

    // Все проверки — до pool.connect(): пул соединений ограничен одним.
    const active = await this.pool.query<{ id: string }>(
      "SELECT id::text AS id FROM users WHERE id = ANY($1::uuid[]) AND active = true",
      [participantIds]
    );
    if (active.rows.length !== participantIds.length) {
      throw apiError(404, "PARTICIPANT_NOT_FOUND", "Участник не найден");
    }

    if (participantIds.length > MAX_INVITED_PARTICIPANTS) {
      throw apiError(409, "TOO_MANY_PARTICIPANTS", "Слишком много участников");
    }

    let client: PoolClient | undefined;
    let conversationId: string | null = null;
    try {
      client = await this.pool.connect();
      await client.query("BEGIN");
      // Отдельный ключ фазы: (21471, 901) занят сообщениями, участниками,
      // ролями и каналами. Два ключа в одной транзакции не берутся.
      await client.query("SELECT pg_advisory_xact_lock(21471, 902)");

      if (participantIds.length === 1) {
        const peerId = participantIds[0]!;
        // `dm_key` — отсортированная пара: повторное создание с тем же
        // человеком возвращает существующую переписку, а не вторую.
        const dmKey = [principal.userId, peerId].sort().join(":");
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO conversations (kind, created_by, dm_key)
           VALUES ('direct', $1, $2)
           ON CONFLICT (dm_key) DO NOTHING
           RETURNING id::text AS id`,
          [principal.userId, dmKey]
        );
        const createdId = inserted.rows[0]?.id;
        if (createdId === undefined) {
          const existing = await client.query<{ id: string }>(
            "SELECT id::text AS id FROM conversations WHERE dm_key = $1",
            [dmKey]
          );
          conversationId = existing.rows[0]?.id ?? null;
        } else {
          conversationId = createdId;
        }
        if (!conversationId) throw new Error("Direct conversation was not returned");
        await client.query(
          `INSERT INTO conversation_participants (conversation_id, user_id, is_creator, visible_from_seq, last_read_seq)
           SELECT $1, participant.user_id, false, 0, 0
           FROM unnest($2::uuid[]) AS participant(user_id)
           ON CONFLICT (conversation_id, user_id) DO NOTHING`,
          [conversationId, [principal.userId, peerId]]
        );
      } else {
        const inserted = await client.query<{ id: string }>(
          "INSERT INTO conversations (kind, created_by) VALUES ('group', $1) RETURNING id::text AS id",
          [principal.userId]
        );
        conversationId = inserted.rows[0]?.id ?? null;
        if (!conversationId) throw new Error("Group conversation was not returned");
        // История новой группы пуста: у всех участников нулевые курсоры.
        await client.query(
          `INSERT INTO conversation_participants (conversation_id, user_id, is_creator, visible_from_seq, last_read_seq)
           SELECT $1, participant.user_id, participant.user_id = $2, 0, 0
           FROM unnest($3::uuid[]) AS participant(user_id)`,
          [conversationId, principal.userId, [principal.userId, ...participantIds]]
        );
      }

      await client.query("COMMIT");
    } catch (error) {
      await client?.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client?.release();
    }

    const views = await this.loadViews(principal.userId, [conversationId]);
    const view = views[0];
    if (!view) throw new Error("Conversation was not returned");
    return view;
  }

  async list(principal: AuthPrincipal): Promise<{ conversations: ConversationView[] }> {
    return this.listFor(principal.userId);
  }

  // Список строк участника без фиктивного principal: нужен адресной рассылке
  // `conversations:sync` из `notifyConversationsChanged`.
  async listFor(userId: string): Promise<{ conversations: ConversationView[] }> {
    // Один запрос на строки участника с последним видимым сообщением через
    // LATERAL — без N+1 при пуле max: 1. Закрытая у себя переписка в список не
    // попадает, но `get` и история её по-прежнему отдают.
    const rows = await this.pool.query<ConversationRow>(
      conversationRowsSelect(`AND p.closed_at IS NULL ${DIRECT_PEER_ACTIVE_FILTER}`),
      [userId]
    );
    const conversations = await this.buildViews(userId, rows.rows);
    return { conversations };
  }

  // Отметка прочтения. Курсор живёт на строке участника: отдельного
  // журнала прочтений в переписке нет. `LEAST` не даёт «прочитать» ещё
  // не существующие сообщения, `GREATEST` не даёт откатить курсор назад.
  async markRead(principal: AuthPrincipal, conversationIdValue: unknown, body: unknown): Promise<void> {
    const conversationId = parseConversationId(conversationIdValue);
    if (!conversationId) throw apiError(400, "INVALID_REQUEST", "Некорректный идентификатор переписки");
    const parsed = parseReadConversationBody(body);
    if (!parsed) throw apiError(400, "INVALID_REQUEST", "Некорректная отметка прочитанного");
    // Участие проверяется до pool.connect(): пул соединений ограничен одним.
    await this.assertParticipant(principal, conversationId);

    let client: PoolClient | undefined;
    let lastReadSeq = 0;
    try {
      client = await this.pool.connect();
      await client.query("BEGIN");
      const updated = await client.query<ReadCursorRow>(
        `UPDATE conversation_participants AS p
         SET last_read_seq = GREATEST(p.last_read_seq, LEAST($3::bigint, (SELECT c.last_seq FROM conversations AS c WHERE c.id = $2)))
         WHERE p.conversation_id = $2 AND p.user_id = $1
         RETURNING p.last_read_seq::int AS last_read_seq`,
        [principal.userId, conversationId, parsed.seq]
      );
      const row = updated.rows[0];
      if (!row) throw apiError(404, "CONVERSATION_NOT_FOUND", "Переписка не найдена");
      lastReadSeq = row.last_read_seq;
      await client.query("COMMIT");
    } catch (error) {
      await client?.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client?.release();
    }

    // Событие нужно второму устройству того же участника; ошибка рассылки не
    // ломает ответ, потому что курсор уже сохранён.
    try {
      await this.realtime.emitUserEvent(principal.userId, "conversation:read", { conversationId, lastReadSeq });
    } catch {
      // Рассылка не является частью результата отметки прочтения.
    }
  }

  // Закрытие «у себя»: строка исчезает только у вызвавшего, история
  // остаётся, `assertParticipant` его не учитывает.
  async close(principal: AuthPrincipal, conversationIdValue: unknown): Promise<void> {
    const conversationId = parseConversationId(conversationIdValue);
    if (!conversationId) throw apiError(400, "INVALID_REQUEST", "Некорректный идентификатор переписки");
    await this.assertParticipant(principal, conversationId);

    await this.pool.query(
      "UPDATE conversation_participants SET closed_at = now() WHERE conversation_id = $1 AND user_id = $2",
      [conversationId, principal.userId]
    );
    await this.notifyConversationsChanged([principal.userId]);
  }

  // Состав группы меняет только носитель права: создатель всегда, остальные —
  // если создатель выдал право. Проверки идут до pool.connect(), внутри
  // транзакции только client.query, события — после release().
  async addParticipant(principal: AuthPrincipal, conversationIdValue: unknown, body: unknown): Promise<void> {
    const conversationId = parseConversationId(conversationIdValue);
    if (!conversationId) throw apiError(400, "INVALID_REQUEST", "Некорректный идентификатор переписки");
    const parsed = parseAddParticipantInput(body);
    if (!parsed) throw apiError(400, "INVALID_REQUEST", "Некорректное добавление участника");
    await this.assertParticipant(principal, conversationId);

    const membership = await this.pool.query<MembershipRow>(
      `SELECT c.kind, c.last_seq::int AS last_seq, p.is_creator, p.can_add_participants
       FROM conversations AS c
       JOIN conversation_participants AS p ON p.conversation_id = c.id AND p.user_id = $2
       WHERE c.id = $1`,
      [conversationId, principal.userId]
    );
    const membershipRow = membership.rows[0];
    if (!membershipRow) throw apiError(404, "CONVERSATION_NOT_FOUND", "Переписка не найдена");
    this.assertMayManageMembers(membershipRow);

    const active = await this.pool.query<{ id: string }>(
      "SELECT id::text AS id FROM users WHERE id = $1 AND active = true",
      [parsed.userId]
    );
    if (active.rows.length === 0) throw apiError(404, "PARTICIPANT_NOT_FOUND", "Участник не найден");

    const composition = await this.pool.query<{ count: number; already: boolean | null }>(
      `SELECT count(*)::int AS count, bool_or(user_id = $2) AS already
       FROM conversation_participants
       WHERE conversation_id = $1`,
      [conversationId, parsed.userId]
    );
    const compositionRow = composition.rows[0];
    if (compositionRow?.already === true) throw apiError(409, "ALREADY_PARTICIPANT", "Участник уже в переписке");
    if ((compositionRow?.count ?? 0) >= MAX_GROUP_PARTICIPANTS) {
      throw apiError(409, "TOO_MANY_PARTICIPANTS", "Слишком много участников");
    }

    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      await client.query("BEGIN");
      // Ключ фазы (21471, 902): состав, `last_seq` и `dm_key` переписок.
      await client.query("SELECT pg_advisory_xact_lock(21471, 902)");
      // Под блокировкой перечитываются и границы видимости, и предел состава:
      // два параллельных добавления не должны перешагнуть десять человек.
      const current = await client.query<{ kind: ConversationKind; last_seq: number }>(
        "SELECT kind, last_seq::int AS last_seq FROM conversations WHERE id = $1 FOR SHARE",
        [conversationId]
      );
      const currentRow = current.rows[0];
      if (!currentRow) throw apiError(404, "CONVERSATION_NOT_FOUND", "Переписка не найдена");
      if (currentRow.kind !== "group") {
        throw apiError(409, "CONVERSATION_NOT_GROUP", "Переписку на двоих нельзя расширить");
      }
      const lockedComposition = await client.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM conversation_participants WHERE conversation_id = $1",
        [conversationId]
      );
      if ((lockedComposition.rows[0]?.count ?? 0) >= MAX_GROUP_PARTICIPANTS) {
        throw apiError(409, "TOO_MANY_PARTICIPANTS", "Слишком много участников");
      }
      // Снятый флажок истории скрывает всё, что отправлено до добавления:
      // граница видимости — текущий `last_seq`. `last_read_seq` равен ему
      // в обоих случаях: история либо видна, либо нет, но непрочитанной она не
      // считается — иначе новый участник получал бы бейдж на всю переписку.
      await client.query(
        `INSERT INTO conversation_participants (conversation_id, user_id, visible_from_seq, last_read_seq)
         VALUES ($1, $2, CASE WHEN $3 THEN 0 ELSE $4 END, $4)
         ON CONFLICT (conversation_id, user_id) DO NOTHING`,
        [conversationId, parsed.userId, parsed.showHistory, currentRow.last_seq]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client?.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client?.release();
    }

    // Состав читается после мутации: новый участник получает список с этой
    // перепиской, остальные — обновлённый состав.
    await this.notifyConversationsChanged(await this.participantIds(conversationId));
  }

  // Удаление участника: сообщения принадлежат переписке, а не участнику, и
  // остаются у остальных.
  async removeParticipant(principal: AuthPrincipal, conversationIdValue: unknown, participantIdValue: unknown): Promise<void> {
    const conversationId = parseConversationId(conversationIdValue);
    if (!conversationId) throw apiError(400, "INVALID_REQUEST", "Некорректный идентификатор переписки");
    const participantId = parseConversationId(participantIdValue);
    if (!participantId) throw apiError(400, "INVALID_REQUEST", "Некорректный идентификатор участника");
    await this.assertParticipant(principal, conversationId);

    const membership = await this.pool.query<MembershipRow>(
      `SELECT c.kind, c.last_seq::int AS last_seq, p.is_creator, p.can_add_participants
       FROM conversations AS c
       JOIN conversation_participants AS p ON p.conversation_id = c.id AND p.user_id = $2
       WHERE c.id = $1`,
      [conversationId, principal.userId]
    );
    const membershipRow = membership.rows[0];
    if (!membershipRow) throw apiError(404, "CONVERSATION_NOT_FOUND", "Переписка не найдена");
    this.assertMayManageMembers(membershipRow);

    const target = await this.pool.query<{ is_creator: boolean }>(
      "SELECT is_creator FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2",
      [conversationId, participantId]
    );
    const targetRow = target.rows[0];
    if (!targetRow) throw apiError(404, "PARTICIPANT_NOT_FOUND", "Участник не найден");
    if (targetRow.is_creator) throw apiError(409, "CREATOR_CANNOT_BE_REMOVED", "Создателя переписки нельзя убрать");

    await this.pool.query(
      "DELETE FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2",
      [conversationId, participantId]
    );

    // удалённый получает список уже без этой переписки, иначе он
    // успел бы увидеть одно событие по составу, из которого его убрали.
    try {
      const removedViews = (await this.listFor(participantId)).conversations;
      await this.realtime.emitUserEvent(participantId, "conversations:sync", { conversations: removedViews });
    } catch {
      // Ошибка рассылки не ломает удаление: строка участника уже удалена.
    }
    await this.notifyConversationsChanged(await this.participantIds(conversationId));
  }

  // Выдача и отзыв права добавлять. Доступно только создателю: носитель
  // права пользуется им, но не передаёт дальше — иначе право расползалось бы
  // по цепочке.
  async setParticipantRight(
    principal: AuthPrincipal,
    conversationIdValue: unknown,
    participantIdValue: unknown,
    body: unknown
  ): Promise<void> {
    const conversationId = parseConversationId(conversationIdValue);
    if (!conversationId) throw apiError(400, "INVALID_REQUEST", "Некорректный идентификатор переписки");
    const participantId = parseConversationId(participantIdValue);
    if (!participantId) throw apiError(400, "INVALID_REQUEST", "Некорректный идентификатор участника");
    const parsed = parseParticipantRightInput(body);
    if (!parsed) throw apiError(400, "INVALID_REQUEST", "Некорректное значение права");
    await this.assertParticipant(principal, conversationId);

    const caller = await this.pool.query<{ is_creator: boolean }>(
      "SELECT is_creator FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2",
      [conversationId, principal.userId]
    );
    if (caller.rows[0]?.is_creator !== true) {
      throw apiError(403, "FORBIDDEN", "Выдавать право может только создатель переписки");
    }

    const updated = await this.pool.query(
      "UPDATE conversation_participants SET can_add_participants = $3 WHERE conversation_id = $1 AND user_id = $2",
      [conversationId, participantId, parsed.canAddParticipants]
    );
    if (updated.rowCount === 0) throw apiError(404, "PARTICIPANT_NOT_FOUND", "Участник не найден");

    await this.notifyConversationsChanged(await this.participantIds(conversationId));
  }

  // Граница видимости истории участника. Живёт здесь, чтобы SQL
  // членства не дублировался в сервисе сообщений: история, догон и счётчик
  // обязаны считать её одинаково.
  async visibleFromSeq(userId: string, conversationId: string): Promise<number> {
    const result = await this.pool.query<{ visible_from_seq: number }>(
      "SELECT visible_from_seq::int AS visible_from_seq FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2",
      [conversationId, userId]
    );
    return result.rows[0]?.visible_from_seq ?? 0;
  }

  private assertMayManageMembers(row: MembershipRow): void {
    if (row.kind !== "group") throw apiError(409, "CONVERSATION_NOT_GROUP", "Переписку на двоих нельзя расширить");
    if (!row.is_creator && !row.can_add_participants) {
      throw apiError(403, "CANNOT_ADD_PARTICIPANTS", "Нет права управлять составом переписки");
    }
  }

  // Полный список уходит каждому адресату отдельно: состав и счётчики у
  // участников разные. Рассылается только на изменение состава, закрытие и
  // отключение участника — не на каждое сообщение.
  async notifyConversationsChanged(userIds: string[]): Promise<void> {
    for (const userId of userIds) {
      try {
        const conversations = (await this.listFor(userId)).conversations;
        await this.realtime.emitUserEvent(userId, "conversations:sync", { conversations });
      } catch {
        // Ошибка рассылки не ломает действие, которое её вызвало.
      }
    }
  }

  async get(principal: AuthPrincipal, conversationIdValue: unknown): Promise<ConversationView> {
    const conversationId = parseConversationId(conversationIdValue);
    if (!conversationId) throw apiError(400, "INVALID_REQUEST", "Некорректный идентификатор переписки");
    await this.assertParticipant(principal, conversationId);
    const views = await this.loadViews(principal.userId, [conversationId]);
    const view = views[0];
    if (!view) throw apiError(404, "CONVERSATION_NOT_FOUND", "Переписка не найдена");
    return view;
  }

  private async loadViews(userId: string, conversationIds: string[]): Promise<ConversationView[]> {
    const rows = await this.pool.query<ConversationRow>(conversationRowsSelect("AND p.conversation_id = ANY($2::uuid[])"), [
      userId,
      conversationIds
    ]);
    return this.buildViews(userId, rows.rows);
  }

  // Общий код запросов состава и счётчиков: ровно два запроса на любой список
  // переписок, без запросов внутри циклов.
  private async buildViews(userId: string, rows: ConversationRow[]): Promise<ConversationView[]> {
    if (rows.length === 0) return [];
    const conversationIds = rows.map((row) => row.id);

    const participants = await this.pool.query<ParticipantRow>(
      `SELECT cp.conversation_id::text AS conversation_id, u.id::text AS id, u.login, cp.can_add_participants
       FROM conversation_participants AS cp
       JOIN users AS u ON u.id = cp.user_id
       WHERE cp.conversation_id = ANY($1::uuid[]) AND u.active = true
       ORDER BY cp.conversation_id, u.login`,
      [conversationIds]
    );
    const unreadCounts = await this.pool.query<UnreadCountRow>(
      `SELECT p.conversation_id::text AS conversation_id, count(m.id)::int AS unread_count
       FROM conversation_participants AS p
       JOIN messages AS m
         ON m.conversation_id = p.conversation_id
        AND m.seq > GREATEST(p.last_read_seq, p.visible_from_seq)
        AND m.author_id <> p.user_id
        AND m.deleted_at IS NULL
       WHERE p.user_id = $1 AND p.conversation_id = ANY($2::uuid[])
       GROUP BY p.conversation_id`,
      [userId, conversationIds]
    );

    const participantsByConversation = new Map<string, ConversationParticipant[]>();
    // Присутствие считается по множеству в памяти гейтвея: один вызов на весь
    // список, без запросов к БД.
    const onlineUserIds = this.realtime.onlineUserIds();
    for (const row of participants.rows) {
      const list = participantsByConversation.get(row.conversation_id) ?? [];
      list.push({
        id: row.id,
        login: row.login,
        presence: onlineUserIds.has(row.id) ? "online" : "offline",
        canAddParticipants: row.can_add_participants
      });
      participantsByConversation.set(row.conversation_id, list);
    }
    const unreadByConversation = new Map<string, number>();
    for (const row of unreadCounts.rows) {
      unreadByConversation.set(row.conversation_id, row.unread_count);
    }

    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      participants: participantsByConversation.get(row.id) ?? [],
      lastMessageAt: row.last_message_at === null ? null : toIsoString(row.last_message_at),
      createdAt: toIsoString(row.created_at),
      unreadCount: unreadByConversation.get(row.id) ?? 0,
      canManageMembers: row.is_creator || row.can_add_participants,
      isCreator: row.is_creator
    }));
  }
}

// Сортировка списка — по времени последнего сообщения, при его отсутствии по
// времени создания; свежие сверху.
function conversationRowsSelect(extraWhere: string): string {
  return `SELECT c.id::text AS id,
         c.kind,
         p.is_creator,
         p.can_add_participants,
         p.last_read_seq::int AS last_read_seq,
         p.visible_from_seq::int AS visible_from_seq,
         c.created_at,
         lm.created_at AS last_message_at
  FROM conversation_participants AS p
  JOIN conversations AS c ON c.id = p.conversation_id
  LEFT JOIN LATERAL (
    SELECT m.created_at
    FROM messages AS m
    WHERE m.conversation_id = c.id
      AND m.seq > p.visible_from_seq
      AND m.deleted_at IS NULL
    ORDER BY m.seq DESC
    LIMIT 1
  ) AS lm ON true
  WHERE p.user_id = $1 ${extraWhere}
  ORDER BY COALESCE(lm.created_at, c.created_at) DESC, c.id DESC
  LIMIT 200`;
}
