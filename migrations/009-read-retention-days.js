export const up = (pgm) => {
  pgm.sql("ALTER TABLE organization ADD COLUMN read_retention_days integer NULL CHECK (read_retention_days IS NULL OR read_retention_days BETWEEN 1 AND 3650)");
  pgm.sql("CREATE INDEX channel_read_journal_read_at_idx ON channel_read_journal (read_at)");
};

export const down = (pgm) => {
  pgm.sql("DROP INDEX IF EXISTS channel_read_journal_read_at_idx");
  pgm.sql("ALTER TABLE organization DROP COLUMN read_retention_days");
};
