import { Module } from "@nestjs/common";
import { AuthModule } from "./auth/auth.module.js";
import { MembersModule } from "./members/members.module.js";
import { OrganizationModule } from "./organization/organization.module.js";
import { RealtimeModule } from "./realtime/realtime.module.js";

export class AppModule {}

Module({
  imports: [AuthModule, MembersModule, OrganizationModule, RealtimeModule]
})(AppModule);
