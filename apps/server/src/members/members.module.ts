import { Module } from "@nestjs/common";
import type { Pool } from "pg";
import { AuthModule } from "../auth/auth.module.js";
import { AuthorizationService } from "../auth/authorization.service.js";
import { PasswordService } from "../auth/password.service.js";
import { DATABASE_POOL, SessionService } from "../auth/session.service.js";
import { SessionRevocationService } from "../auth/session-revocation.service.js";
import { MembersController } from "./members.controller.js";
import { MembersService } from "./members.service.js";

const providers = [
  { provide: PasswordService, useFactory: () => new PasswordService() },
  {
    provide: MembersService,
    useFactory: (
      pool: Pool,
      authorization: AuthorizationService,
      passwords: PasswordService,
      revocations: SessionRevocationService,
      sessions: SessionService
    ) => new MembersService(pool, authorization, passwords, revocations, sessions),
    inject: [DATABASE_POOL, AuthorizationService, PasswordService, SessionRevocationService, SessionService]
  }
];

export class MembersModule {}

Module({
  controllers: [MembersController],
  imports: [AuthModule],
  providers
})(MembersModule);
