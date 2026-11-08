import { HttpException } from "@nestjs/common";
import type { Pool } from "pg";
import type { AuthPrincipal } from "./session.service.js";

export class AuthorizationService {
  constructor(private readonly pool: Pool) {}

  async requireAdministrator(principal: AuthPrincipal): Promise<void> {
    const result = await this.pool.query<{ allowed: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM user_roles AS user_role
         JOIN roles AS role ON role.id = user_role.role_id
         WHERE user_role.user_id = $1
           AND role.system_key = 'administrator'
           AND role.permissions @> '["ADMINISTRATOR"]'::jsonb
       ) AS allowed`,
      [principal.userId]
    );

    if (!result.rows[0]?.allowed) {
      throw new HttpException({ code: "FORBIDDEN", message: "Недостаточно прав" }, 403);
    }
  }
}
