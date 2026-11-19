import { Module } from "@nestjs/common";
import type { Pool } from "pg";
import { AccessModule } from "../access/access.module.js";
import { AccessService } from "../access/access.service.js";
import { AuthModule } from "../auth/auth.module.js";
import { DATABASE_POOL } from "../auth/session.service.js";
import { RealtimeModule } from "../realtime/realtime.module.js";
import { RealtimeGateway } from "../realtime/realtime.gateway.js";
import { RolesController } from "./roles.controller.js";
import { RolesService } from "./roles.service.js";

const providers = [{
  provide: RolesService,
  useFactory: (pool: Pool, access: AccessService, realtime: RealtimeGateway) => new RolesService(pool, access, realtime),
  inject: [DATABASE_POOL, AccessService, RealtimeGateway]
}];

export class RolesModule {}

Module({
  controllers: [RolesController],
  imports: [AuthModule, AccessModule, RealtimeModule],
  providers,
  exports: [RolesService]
})(RolesModule);
