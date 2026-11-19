export const up = (pgm) => {
  pgm.sql("ALTER TABLE channels ADD COLUMN description text NULL");
  pgm.sql("ALTER TABLE channels ADD COLUMN visibility text NOT NULL DEFAULT 'hidden' CHECK (visibility IN ('hidden','known'))");
};

export const down = (pgm) => {
  pgm.sql("ALTER TABLE channels DROP COLUMN visibility");
  pgm.sql("ALTER TABLE channels DROP COLUMN description");
};
