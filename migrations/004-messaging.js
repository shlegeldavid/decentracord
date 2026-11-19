export const up = (pgm) => {
  pgm.sql('ALTER TABLE channels ADD COLUMN last_seq bigint NOT NULL DEFAULT 0');
  pgm.sql(`
    CREATE TABLE messages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      author_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      seq bigint NOT NULL,
      updated_seq bigint NOT NULL,
      content text NOT NULL,
      client_request_id uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      edited_at timestamptz,
      deleted_at timestamptz,
      CONSTRAINT messages_content_length CHECK (char_length(content) BETWEEN 1 AND 2000)
    )
  `);
  pgm.sql(`
    CREATE TABLE message_mentions (
      message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (message_id, user_id)
    )
  `);
  pgm.sql(`
    CREATE TABLE channel_reads (
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      last_read_seq bigint NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, channel_id)
    )
  `);
  pgm.sql('CREATE UNIQUE INDEX messages_channel_seq_idx ON messages (channel_id, seq)');
  pgm.sql('CREATE UNIQUE INDEX messages_idempotency_idx ON messages (channel_id, author_id, client_request_id)');
  pgm.sql('CREATE INDEX messages_channel_updated_seq_idx ON messages (channel_id, updated_seq)');
  pgm.sql('CREATE INDEX message_mentions_user_idx ON message_mentions (user_id)');
};

export const down = (pgm) => {
  pgm.sql('DROP TABLE IF EXISTS channel_reads');
  pgm.sql('DROP TABLE IF EXISTS message_mentions');
  pgm.sql('DROP TABLE IF EXISTS messages');
  pgm.sql('ALTER TABLE channels DROP COLUMN last_seq');
};
