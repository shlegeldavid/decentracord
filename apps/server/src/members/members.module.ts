import { Module } from "@nestjs/common";
import type { Pool } from "pg";
import { AccessModule } from "../access/access.module.js";
import { AccessService } from "../access/access.service.js";
import { AuthModule } from "../auth/auth.module.js";
import { AuthorizationService } from "../auth/authorization.service.js";
import { PasswordService } from "../auth/password.service.js";
import { DATABASE_POOL, SessionService } from "../auth/session.service.js";
import { SessionRevocationService } from "../auth/session-revocation.service.js";
import { RealtimeModule } from "../realtime/realtime.module.js";
import { RealtimeGateway } from "../realtime/realtime.gateway.js";
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
      sessions: SessionService,
      access: AccessService,
      realtime: RealtimeGateway
    ) => new MembersService(pool, authorization, passwords, revocations, sessions, access, realtime),
    inject: [DATABASE_POOL, AuthorizationService, PasswordService, SessionRevocationService, SessionService, AccessService, RealtimeGateway]
  }
];

export class MembersModule {}

Module({
  controllers: [MembersController],
  imports: [AuthModule, AccessModule, RealtimeModule],
  providers
})(MembersModule);
