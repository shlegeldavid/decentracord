export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE channel_read_journal (
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      seq bigint NOT NULL,
      read_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, channel_id, seq)
    )
  `);
  pgm.sql('CREATE INDEX channel_read_journal_channel_user_seq_idx ON channel_read_journal (channel_id, user_id, seq)');
  pgm.sql(`
    CREATE TABLE channel_read_bases (
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      entry_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, channel_id)
    )
  `);
};

export const down = (pgm) => {
  pgm.sql('DROP TABLE IF EXISTS channel_read_bases');
  pgm.sql('DROP TABLE IF EXISTS channel_read_journal');
};
