// Личные переписки: переписка на двоих и группа — одна сущность с полем
// `kind`. Сообщения переписок живут в существующей таблице `messages`:
// `channel_id` становится необязательным, появляется `conversation_id`, и
// ограничение `messages_scope_exactly_one` требует ровно одной привязки.
export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE conversations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      kind text NOT NULL,
      created_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      dm_key text NULL,
      last_seq bigint NOT NULL DEFAULT 0,
      last_message_at timestamptz NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT conversations_kind_allowed CHECK (kind IN ('direct','group')),
      CONSTRAINT conversations_dm_key_matches_kind CHECK ((kind = 'direct') = (dm_key IS NOT NULL))
    )
  `);
  // Уникальность пары участников: ключ собирается из двух uuid, отсортированных
  // по возрастанию. NULL-ы в PostgreSQL различны, поэтому группы не конфликтуют.
  pgm.sql('CREATE UNIQUE INDEX conversations_dm_key_idx ON conversations (dm_key)');
  pgm.sql('CREATE INDEX conversations_last_message_at_idx ON conversations (last_message_at DESC NULLS LAST, id DESC)');
  pgm.sql(`
    CREATE TABLE conversation_participants (
      conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      is_creator boolean NOT NULL DEFAULT false,
      can_add_participants boolean NOT NULL DEFAULT false,
      visible_from_seq bigint NOT NULL DEFAULT 0 CHECK (visible_from_seq >= 0),
      last_read_seq bigint NOT NULL DEFAULT 0 CHECK (last_read_seq >= 0),
      closed_at timestamptz NULL,
      joined_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (conversation_id, user_id)
    )
  `);
  pgm.sql('CREATE INDEX conversation_participants_user_idx ON conversation_participants (user_id, conversation_id)');

  // Область сообщения: канал или переписка. Снятие NOT NULL — только метаданные,
  // таблица не перезаписывается.
  pgm.sql('ALTER TABLE messages ALTER COLUMN channel_id DROP NOT NULL');
  pgm.sql('ALTER TABLE messages ADD COLUMN conversation_id uuid NULL REFERENCES conversations(id) ON DELETE CASCADE');
  pgm.sql('ALTER TABLE messages ADD COLUMN forwarded_from_conversation_id uuid NULL REFERENCES conversations(id) ON DELETE SET NULL');

  // `NOT VALID` + отдельный `VALIDATE CONSTRAINT` вместо одной команды:
  // `ADD CONSTRAINT … CHECK` со сканом берёт ACCESS EXCLUSIVE, а
  // `VALIDATE CONSTRAINT` — только SHARE UPDATE EXCLUSIVE.
  pgm.sql(
    'ALTER TABLE messages ADD CONSTRAINT messages_scope_exactly_one CHECK ((channel_id IS NULL) <> (conversation_id IS NULL)) NOT VALID'
  );
  pgm.sql('ALTER TABLE messages VALIDATE CONSTRAINT messages_scope_exactly_one');

  // Канальные индексы не трогаются: NULL-ы в уникальном индексе различны,
  // канальные строки проверяются как раньше. `CREATE INDEX CONCURRENTLY`
  // невозможен — node-pg-migrate оборачивает миграцию в транзакцию.
  pgm.sql('CREATE UNIQUE INDEX messages_conversation_seq_idx ON messages (conversation_id, seq) WHERE conversation_id IS NOT NULL');
  pgm.sql(
    'CREATE UNIQUE INDEX messages_conversation_idempotency_idx ON messages (conversation_id, author_id, client_request_id) WHERE conversation_id IS NOT NULL'
  );
  pgm.sql('CREATE INDEX messages_conversation_updated_seq_idx ON messages (conversation_id, updated_seq) WHERE conversation_id IS NOT NULL');
  pgm.sql('CREATE INDEX messages_forwarded_from_conversation_idx ON messages (forwarded_from_conversation_id)');
};

export const down = (pgm) => {
  pgm.sql('DROP INDEX IF EXISTS messages_forwarded_from_conversation_idx');
  pgm.sql('DROP INDEX IF EXISTS messages_conversation_updated_seq_idx');
  pgm.sql('DROP INDEX IF EXISTS messages_conversation_idempotency_idx');
  pgm.sql('DROP INDEX IF EXISTS messages_conversation_seq_idx');
  pgm.sql('ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_scope_exactly_one');
  // Сообщения переписок удаляются: без этого `SET NOT NULL` упадёт на
  // существующих строках. История переписок исчезает вместе с фазой — это
  // допустимо, канальные сообщения не затрагиваются.
  pgm.sql('DELETE FROM messages WHERE conversation_id IS NOT NULL');
  pgm.sql('ALTER TABLE messages DROP COLUMN forwarded_from_conversation_id');
  pgm.sql('ALTER TABLE messages DROP COLUMN conversation_id');
  pgm.sql('ALTER TABLE messages ALTER COLUMN channel_id SET NOT NULL');
  pgm.sql('DROP TABLE IF EXISTS conversation_participants');
  pgm.sql('DROP TABLE IF EXISTS conversations');
};
