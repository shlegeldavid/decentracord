import type { Pool, PoolClient } from "pg";
import type { AccessService } from "../access/access.service.js";
import { resolveMentions } from "./mention-tokens.js";

export class MentionsService {
  constructor(
    private readonly pool: Pool,
    private readonly access: AccessService
  ) {}

  async resolveForChannel(channelId: string, text: string): Promise<Array<{ id: string; login: string }>> {
    const members = await this.access.listChannelMembers(channelId);
    const membersByLogin = new Map(members.map((member) => [member.login.toLowerCase(), member]));
    const resolvedLogins = resolveMentions(text, members.map((member) => member.login));
    return resolvedLogins.flatMap((login) => {
      const member = membersByLogin.get(login);
      return member ? [{ id: member.id, login: member.login }] : [];
    });
  }

  // Упоминания в переписке резолвятся только по её составу: логин
  // человека вне переписки остаётся текстом и строки в `message_mentions` не
  // создаёт. Отключённые участники не считаются — как и в канальном резолве.
  async resolveForConversation(conversationId: string, text: string): Promise<Array<{ id: string; login: string }>> {
    const participants = await this.pool.query<{ id: string; login: string }>(
      `SELECT u.id::text AS id, u.login
       FROM conversation_participants AS cp
       JOIN users AS u ON u.id = cp.user_id
       WHERE cp.conversation_id = $1 AND u.active = true
       ORDER BY u.login`,
      [conversationId]
    );
    const byLogin = new Map(participants.rows.map((participant) => [participant.login.toLowerCase(), participant]));
    const resolvedLogins = resolveMentions(text, participants.rows.map((participant) => participant.login));
    return resolvedLogins.flatMap((login) => {
      const participant = byLogin.get(login);
      return participant ? [{ id: participant.id, login: participant.login }] : [];
    });
  }

  async recordMentions(messageId: string, mentions: Array<{ id: string }>, client?: PoolClient): Promise<void> {
    const executor = client ?? this.pool;
    for (const mention of mentions) {
      await executor.query(
        "INSERT INTO message_mentions (message_id, user_id) VALUES ($1, $2) ON CONFLICT (message_id, user_id) DO NOTHING",
        [messageId, mention.id]
      );
    }
  }
}
