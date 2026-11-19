export const up = (pgm) => {
  pgm.sql('ALTER TABLE messages ADD COLUMN forwarded_from_message_id uuid NULL REFERENCES messages(id) ON DELETE SET NULL');
  pgm.sql('ALTER TABLE messages ADD COLUMN forwarded_from_channel_id uuid NULL REFERENCES channels(id) ON DELETE SET NULL');
  pgm.sql('CREATE INDEX messages_forwarded_from_idx ON messages (forwarded_from_message_id)');
};

export const down = (pgm) => {
  pgm.sql('DROP INDEX IF EXISTS messages_forwarded_from_idx');
  pgm.sql('ALTER TABLE messages DROP COLUMN forwarded_from_channel_id');
  pgm.sql('ALTER TABLE messages DROP COLUMN forwarded_from_message_id');
};
