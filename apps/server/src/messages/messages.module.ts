import { Module } from "@nestjs/common";
import type { Pool } from "pg";
import { AccessModule } from "../access/access.module.js";
import { AccessService } from "../access/access.service.js";
import { AuthModule } from "../auth/auth.module.js";
import { DATABASE_POOL } from "../auth/session.service.js";
import { ConversationsModule } from "../conversations/conversations.module.js";
import { ConversationsService } from "../conversations/conversations.service.js";
import { RealtimeModule } from "../realtime/realtime.module.js";
import { RealtimeGateway } from "../realtime/realtime.gateway.js";
import { ConversationMessagesController } from "./conversation-messages.controller.js";
import { MessagesController } from "./messages.controller.js";
import { MessagesService } from "./messages.service.js";
import { MentionsService } from "./mentions.service.js";

export class MessagesModule {}

Module({
  controllers: [MessagesController, ConversationMessagesController],
  imports: [AuthModule, AccessModule, RealtimeModule, ConversationsModule],
  providers: [
    {
      provide: MessagesService,
      useFactory: (
        pool: Pool,
        access: AccessService,
        realtime: RealtimeGateway,
        mentions: MentionsService,
        conversations: ConversationsService
      ) => new MessagesService(pool, access, realtime, mentions, conversations),
      inject: [DATABASE_POOL, AccessService, RealtimeGateway, MentionsService, ConversationsService]
    },
    {
      provide: MentionsService,
      useFactory: (pool: Pool, access: AccessService) => new MentionsService(pool, access),
      inject: [DATABASE_POOL, AccessService]
    }
  ],
  exports: [MessagesService]
})(MessagesModule);
