import { Module } from "@nestjs/common";
import type { Pool } from "pg";
import { DATABASE_POOL } from "../auth/session.service.js";
import { DbModule } from "../db.module.js";
import { AccessService } from "./access.service.js";

export class AccessModule {}

Module({
  imports: [DbModule],
  providers: [{ provide: AccessService, useFactory: (pool: Pool) => new AccessService(pool), inject: [DATABASE_POOL] }],
  exports: [AccessService]
})(AccessModule);
