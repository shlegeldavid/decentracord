export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE channels (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name varchar(80) NOT NULL,
      position integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK (length(btrim(name)) BETWEEN 1 AND 80)
    )
  `);
  pgm.sql('CREATE UNIQUE INDEX channels_name_case_insensitive_unique ON channels (lower(name))');
  pgm.sql(`
    CREATE TABLE channel_role_overrides (
      channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      permission text NOT NULL,
      effect text NOT NULL CHECK (effect IN ('allow', 'deny')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (channel_id, role_id, permission)
    )
  `);
  pgm.sql(`
    CREATE TABLE channel_member_overrides (
      channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      permission text NOT NULL,
      effect text NOT NULL CHECK (effect IN ('allow', 'deny')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (channel_id, user_id, permission)
    )
  `);
  pgm.sql('ALTER TABLE users ADD COLUMN is_owner boolean NOT NULL DEFAULT false');
  pgm.sql('CREATE UNIQUE INDEX users_single_owner ON users ((is_owner)) WHERE is_owner');
  pgm.sql("UPDATE roles SET position = 1000000 WHERE system_key = 'administrator'");
  pgm.sql(`
    UPDATE users SET is_owner = true
    WHERE id = (
      SELECT min(users.id::text)::uuid FROM users
      JOIN user_roles ON user_roles.user_id = users.id
      JOIN roles ON roles.id = user_roles.role_id
      WHERE roles.system_key = 'administrator'
      HAVING count(*) = 1
    ) AND NOT EXISTS (SELECT 1 FROM users WHERE is_owner)
  `);
};

export const down = (pgm) => {
  pgm.sql('DROP TABLE IF EXISTS channel_member_overrides');
  pgm.sql('DROP TABLE IF EXISTS channel_role_overrides');
  pgm.sql('DROP TABLE IF EXISTS channels');
  pgm.sql("UPDATE roles SET position = 1 WHERE system_key = 'administrator'");
  pgm.sql('ALTER TABLE users DROP COLUMN is_owner');
};
