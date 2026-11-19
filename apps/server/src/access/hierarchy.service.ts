import { HttpException } from "@nestjs/common";
import type { Permission } from "./permissions.js";

function apiError(status: number, code: string, message: string): HttpException {
  return new HttpException({ code, message }, status);
}

export function highestRole(positions: number[]): number {
  if (positions.length === 0) return 0;
  return positions.reduce((highest, position) => Math.max(highest, position), positions[0] ?? 0);
}

export function canManageRole(actorHighest: number, targetPosition: number): boolean {
  return targetPosition < actorHighest;
}

export function canActOnMember(actorHighest: number, targetHighest: number): boolean {
  return targetHighest < actorHighest;
}

export function assertCanEditRolePermissions(input: {
  actorPermissions: Set<Permission>;
  actorHighest: number;
  targetPosition: number;
  requested: Permission[];
}): void {
  if (!canManageRole(input.actorHighest, input.targetPosition)) {
    throw apiError(403, "HIERARCHY", "Недостаточно прав");
  }

  if (input.actorPermissions.has("ADMINISTRATOR")) return;
  for (const permission of input.requested) {
    if (!input.actorPermissions.has(permission)) {
      throw apiError(403, "MISSING_PERMISSION", "Недостаточно прав");
    }
  }
}

export function assertCanGrantRoles(input: {
  actorPermissions: Set<Permission>;
  actorHighest: number;
  actorIsOwner: boolean;
  requestedRoleIds: string[];
  actorUserId: string;
  targetUserId: string;
  roles: Array<{ id: string; position: number; permissions: Permission[] }>;
}): void {
  if (input.targetUserId === input.actorUserId) {
    throw apiError(403, "HIERARCHY", "Недостаточно прав");
  }

  const requestedRoles = input.roles.filter((role) => input.requestedRoleIds.includes(role.id));
  for (const role of requestedRoles) {
    if (!canManageRole(input.actorHighest, role.position)) {
      throw apiError(403, "HIERARCHY", "Недостаточно прав");
    }
  }

  for (const role of requestedRoles) {
    if (role.permissions.includes("ADMINISTRATOR") && !input.actorIsOwner) {
      throw apiError(403, "FORBIDDEN", "Недостаточно прав");
    }
  }

  if (input.actorPermissions.has("ADMINISTRATOR")) return;
  for (const role of requestedRoles) {
    for (const permission of role.permissions) {
      if (!input.actorPermissions.has(permission)) {
        throw apiError(403, "MISSING_PERMISSION", "Недостаточно прав");
      }
    }
  }
}
