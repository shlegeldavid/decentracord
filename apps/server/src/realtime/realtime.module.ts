import { Inject, Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { SessionRevocationService } from "../auth/session-revocation.service.js";
import { SessionService } from "../auth/session.service.js";
import { RealtimeGateway } from "./realtime.gateway.js";

export class RealtimeModule {}

Module({
  imports: [AuthModule],
  providers: [RealtimeGateway]
})(RealtimeModule);
Inject(SessionService)(RealtimeGateway, undefined, 0);
Inject(SessionRevocationService)(RealtimeGateway, undefined, 1);
