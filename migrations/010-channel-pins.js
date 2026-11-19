export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE channel_pins (
      message_id uuid PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
      channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      pinned_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      pinned_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  pgm.sql('CREATE INDEX channel_pins_channel_pinned_at_idx ON channel_pins (channel_id, pinned_at DESC)');
};

export const down = (pgm) => {
  pgm.sql('DROP INDEX IF EXISTS channel_pins_channel_pinned_at_idx');
  pgm.sql('DROP TABLE IF EXISTS channel_pins');
};
