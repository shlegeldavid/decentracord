import { Module } from "@nestjs/common";
import type { Pool } from "pg";
import { AccessModule } from "../access/access.module.js";
import { AccessService } from "../access/access.service.js";
import { AuthModule } from "../auth/auth.module.js";
import { DATABASE_POOL } from "../auth/session.service.js";
import { RealtimeModule } from "../realtime/realtime.module.js";
import { RealtimeGateway } from "../realtime/realtime.gateway.js";
import { ChannelsController } from "./channels.controller.js";
import { ChannelsService } from "./channels.service.js";

export class ChannelsModule {}

Module({
  controllers: [ChannelsController],
  imports: [AuthModule, AccessModule, RealtimeModule],
  providers: [{
    provide: ChannelsService,
    useFactory: (pool: Pool, access: AccessService, realtime: RealtimeGateway) => new ChannelsService(pool, access, realtime),
    inject: [DATABASE_POOL, AccessService, RealtimeGateway]
  }],
  exports: [ChannelsService]
})(ChannelsModule);
