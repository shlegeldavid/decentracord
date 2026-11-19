import { AccessService } from "../access/access.service.js";
import type { Permission } from "../access/permissions.js";
import type { AuthPrincipal } from "./session.service.js";

export class AuthorizationService {
  constructor(private readonly access: AccessService) {}

  async requireAdministrator(principal: AuthPrincipal): Promise<void> {
    await this.requirePermission(principal, "ADMINISTRATOR");
  }

  async requirePermission(principal: AuthPrincipal, permission: Permission): Promise<void> {
    await this.access.requirePermission(principal, permission);
  }

  async requireOwner(principal: AuthPrincipal): Promise<void> {
    await this.access.requireOwner(principal);
  }
}
