import { Inject, Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module.js";
import { AccessService } from "../access/access.service.js";
import { AuthModule } from "../auth/auth.module.js";
import { SessionRevocationService } from "../auth/session-revocation.service.js";
import { SessionService } from "../auth/session.service.js";
import { RealtimeGateway } from "./realtime.gateway.js";

export class RealtimeModule {}

Module({
  imports: [AuthModule, AccessModule],
  providers: [RealtimeGateway],
  exports: [RealtimeGateway]
})(RealtimeModule);
Inject(SessionService)(RealtimeGateway, undefined, 0);
Inject(SessionRevocationService)(RealtimeGateway, undefined, 1);
Inject(AccessService)(RealtimeGateway, undefined, 2);
