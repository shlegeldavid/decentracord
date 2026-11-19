export const up = (pgm) => {
  pgm.sql("ALTER TABLE users ADD COLUMN theme text NOT NULL DEFAULT 'dark' CHECK (theme IN ('dark', 'light'))");
  pgm.sql("ALTER TABLE users ADD COLUMN timezone text NULL");
  pgm.sql("ALTER TABLE roles ADD COLUMN color text NULL CHECK (color IS NULL OR color ~ '^#[0-9A-Fa-f]{6}$')");
};

export const down = (pgm) => {
  pgm.sql("ALTER TABLE roles DROP COLUMN color");
  pgm.sql("ALTER TABLE users DROP COLUMN timezone");
  pgm.sql("ALTER TABLE users DROP COLUMN theme");
};
