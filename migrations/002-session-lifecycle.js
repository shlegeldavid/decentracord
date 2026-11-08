export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE session_revocations (
      sid varchar NOT NULL PRIMARY KEY,
      revoked_at timestamptz NOT NULL DEFAULT now()
    )
  `);
};

export const down = (pgm) => {
  pgm.sql("DROP TABLE IF EXISTS session_revocations");
};
