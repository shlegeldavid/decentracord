export const up = (pgm) => {
  pgm.sql("ALTER TABLE organization ADD COLUMN logo bytea NULL");
  pgm.sql("ALTER TABLE organization ADD COLUMN logo_updated_at timestamptz NULL");
};

export const down = (pgm) => {
  pgm.sql("ALTER TABLE organization DROP COLUMN logo_updated_at");
  pgm.sql("ALTER TABLE organization DROP COLUMN logo");
};
