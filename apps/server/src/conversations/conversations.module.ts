import { Module } from "@nestjs/common";
import type { Pool } from "pg";
import { AuthModule } from "../auth/auth.module.js";
import { DATABASE_POOL } from "../auth/session.service.js";
import { RealtimeGateway } from "../realtime/realtime.gateway.js";
import { RealtimeModule } from "../realtime/realtime.module.js";
import { ConversationsController } from "./conversations.controller.js";
import { ConversationsService } from "./conversations.service.js";

// AccessModule не импортируется: доступ к переписке проверяется строкой
// участия, а не движком прав каналов.
export class ConversationsModule {}

Module({
  controllers: [ConversationsController],
  imports: [AuthModule, RealtimeModule],
  providers: [
    {
      provide: ConversationsService,
      useFactory: (pool: Pool, realtime: RealtimeGateway) => new ConversationsService(pool, realtime),
      inject: [DATABASE_POOL, RealtimeGateway]
    }
  ],
  exports: [ConversationsService]
})(ConversationsModule);
