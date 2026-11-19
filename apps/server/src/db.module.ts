import { Module } from "@nestjs/common";
import type { Pool } from "pg";
import { createDatabasePool } from "./db.js";
import { DATABASE_POOL } from "./auth/session.service.js";

class DatabasePoolLifecycle {
  constructor(private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

export class DbModule {}

Module({
  providers: [
    { provide: DATABASE_POOL, useFactory: createDatabasePool },
    {
      provide: DatabasePoolLifecycle,
      useFactory: (pool: Pool) => new DatabasePoolLifecycle(pool),
      inject: [DATABASE_POOL]
    }
  ],
  exports: [DATABASE_POOL]
})(DbModule);
