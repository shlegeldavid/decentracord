export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE channel_categories (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name varchar(80) NOT NULL,
      position integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK (length(btrim(name)) BETWEEN 1 AND 80)
    )
  `);
  pgm.sql('ALTER TABLE channels ADD COLUMN category_id uuid NULL REFERENCES channel_categories(id) ON DELETE SET NULL');
  pgm.sql('CREATE INDEX channels_category_position_idx ON channels (category_id, position)');
  pgm.sql('CREATE UNIQUE INDEX channel_categories_name_case_insensitive_unique ON channel_categories (lower(name))');
};

export const down = (pgm) => {
  pgm.sql('DROP INDEX IF EXISTS channels_category_position_idx');
  pgm.sql('DROP INDEX IF EXISTS channel_categories_name_case_insensitive_unique');
  pgm.sql('ALTER TABLE channels DROP COLUMN category_id');
  pgm.sql('DROP TABLE IF EXISTS channel_categories');
};
