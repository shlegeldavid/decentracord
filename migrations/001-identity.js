export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE organization (
      id smallint PRIMARY KEY CHECK (id = 1),
      name varchar(120) NOT NULL DEFAULT 'Организация',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK (length(btrim(name)) BETWEEN 1 AND 120)
    )
  `);
  pgm.sql(`
    CREATE TABLE users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      login varchar(64) NOT NULL,
      login_normalized varchar(64) NOT NULL UNIQUE,
      password_hash text NOT NULL,
      active boolean NOT NULL DEFAULT true,
      auth_version integer NOT NULL DEFAULT 0 CHECK (auth_version >= 0),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK (login_normalized ~ '^[a-z0-9_.-]{3,64}$')
    )
  `);
  pgm.sql(`
    CREATE TABLE roles (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      system_key varchar(32) UNIQUE,
      name varchar(80) NOT NULL,
      position integer NOT NULL DEFAULT 0,
      permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK (system_key IS NULL OR system_key IN ('everyone', 'administrator')),
      CHECK (jsonb_typeof(permissions) = 'array')
    )
  `);
  pgm.sql("CREATE UNIQUE INDEX roles_name_case_insensitive_unique ON roles (lower(name))");
  pgm.sql(`
    CREATE TABLE user_roles (
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, role_id)
    )
  `);
  pgm.sql(`
    CREATE TABLE "session" (
      sid varchar NOT NULL COLLATE "default",
      sess json NOT NULL,
      expire timestamp(6) NOT NULL,
      CONSTRAINT "session_pkey" PRIMARY KEY (sid)
    )
  `);
  pgm.sql('CREATE INDEX "IDX_session_expire" ON "session" (expire)');
};

export const down = (pgm) => {
  pgm.sql('DROP TABLE IF EXISTS "session"');
  pgm.sql("DROP TABLE IF EXISTS user_roles");
  pgm.sql("DROP TABLE IF EXISTS roles");
  pgm.sql("DROP TABLE IF EXISTS users");
  pgm.sql("DROP TABLE IF EXISTS organization");
};
