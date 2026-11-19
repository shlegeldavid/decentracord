import { Module } from "@nestjs/common";
import { AccessModule } from "./access/access.module.js";
import { AuthModule } from "./auth/auth.module.js";
import { ChannelsModule } from "./channels/channels.module.js";
import { ConversationsModule } from "./conversations/conversations.module.js";
import { DbModule } from "./db.module.js";
import { MembersModule } from "./members/members.module.js";
import { MessagesModule } from "./messages/messages.module.js";
import { OrganizationModule } from "./organization/organization.module.js";
import { RealtimeModule } from "./realtime/realtime.module.js";
import { RolesModule } from "./roles/roles.module.js";

export class AppModule {}

Module({
  imports: [DbModule, AccessModule, AuthModule, ChannelsModule, ConversationsModule, MessagesModule, MembersModule, OrganizationModule, RealtimeModule, RolesModule]
})(AppModule);
