import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { OrganizationController } from "./organization.controller.js";

export class OrganizationModule {}

Module({
  controllers: [OrganizationController],
  imports: [AuthModule]
})(OrganizationModule);
