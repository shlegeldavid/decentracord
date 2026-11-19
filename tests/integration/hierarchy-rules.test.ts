import { HttpException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import {
  assertCanEditRolePermissions,
  assertCanGrantRoles,
  canActOnMember,
  canManageRole,
  highestRole
} from "../../apps/server/src/access/hierarchy.service.js";
import type { Permission } from "../../apps/server/src/access/permissions.js";

type GrantInput = Parameters<typeof assertCanGrantRoles>[0];

function expectForbidden(action: () => void, code: string): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(HttpException);
  if (!(thrown instanceof HttpException)) return;
  expect(thrown.getStatus()).toBe(403);
  expect(thrown.getResponse()).toEqual({ code, message: "Недостаточно прав" });
}

function grantInput(overrides: Partial<GrantInput> = {}): GrantInput {
  return {
    actorPermissions: new Set<Permission>(["MANAGE_ROLES", "VIEW_CHANNEL"]),
    actorHighest: 10,
    actorIsOwner: false,
    requestedRoleIds: ["role-1"],
    actorUserId: "actor-1",
    targetUserId: "target-1",
    roles: [{ id: "role-1", position: 9, permissions: ["MANAGE_ROLES"] }],
    ...overrides
  };
}

describe("role hierarchy comparisons", () => {
  it("returns zero for no roles and the maximum position otherwise", () => {
    expect(highestRole([])).toBe(0);
    expect(highestRole([3, 10, 7])).toBe(10);
  });

  it.each([
    { name: "a lower role", target: 9, allowed: true },
    { name: "an equal role", target: 10, allowed: false },
    { name: "a higher role", target: 11, allowed: false }
  ])("canManageRole rejects $name", ({ target, allowed }) => {
    expect(canManageRole(10, target)).toBe(allowed);
  });

  it.each([
    { name: "a lower member", target: 9, allowed: true },
    { name: "an equal member", target: 10, allowed: false }
  ])("canActOnMember rejects $name", ({ target, allowed }) => {
    expect(canActOnMember(10, target)).toBe(allowed);
  });
});

describe("assertCanEditRolePermissions", () => {
  it("rejects editing a role at the actor's highest position with HIERARCHY", () => {
    expectForbidden(() => assertCanEditRolePermissions({
      actorPermissions: new Set(["MANAGE_ROLES"]),
      actorHighest: 10,
      targetPosition: 10,
      requested: ["MANAGE_ROLES"]
    }), "HIERARCHY");
  });

  it("rejects a permission outside the actor's set with MISSING_PERMISSION", () => {
    expectForbidden(() => assertCanEditRolePermissions({
      actorPermissions: new Set(["MANAGE_ROLES"]),
      actorHighest: 10,
      targetPosition: 9,
      requested: ["VIEW_CHANNEL"]
    }), "MISSING_PERMISSION");
  });

  it("lets an administrator request permissions outside its current set", () => {
    expect(() => assertCanEditRolePermissions({
      actorPermissions: new Set(["ADMINISTRATOR"]),
      actorHighest: 10,
      targetPosition: 9,
      requested: ["MANAGE_CHANNELS", "SEND_MESSAGES"]
    })).not.toThrow();
  });

  it("does not let administrator bypass role hierarchy", () => {
    expectForbidden(() => assertCanEditRolePermissions({
      actorPermissions: new Set(["ADMINISTRATOR"]),
      actorHighest: 10,
      targetPosition: 10,
      requested: ["MANAGE_CHANNELS"]
    }), "HIERARCHY");
  });
});

describe("assertCanGrantRoles", () => {
  it("accepts a covered role below the actor and a distinct target user", () => {
    expect(() => assertCanGrantRoles(grantInput({
      actorUserId: "actor-1",
      targetUserId: "target-2"
    }))).not.toThrow();
  });

  it("rejects assigning a role to the actor with HIERARCHY", () => {
    expectForbidden(() => assertCanGrantRoles(grantInput({ targetUserId: "actor-1" })), "HIERARCHY");
  });

  it("rejects a role at the actor's highest position with HIERARCHY", () => {
    expectForbidden(() => assertCanGrantRoles(grantInput({
      roles: [{ id: "role-1", position: 10, permissions: ["MANAGE_ROLES"] }]
    })), "HIERARCHY");
  });

  it("rejects a role whose permissions are not covered with MISSING_PERMISSION", () => {
    expectForbidden(() => assertCanGrantRoles(grantInput({
      roles: [{ id: "role-1", position: 9, permissions: ["MANAGE_ROLES", "MANAGE_CHANNELS"] }]
    })), "MISSING_PERMISSION");
  });

  it("rejects granting ADMINISTRATOR to a non-owner with FORBIDDEN", () => {
    expectForbidden(() => assertCanGrantRoles(grantInput({
      actorPermissions: new Set<Permission>(["ADMINISTRATOR", "MANAGE_ROLES"]),
      roles: [{ id: "role-1", position: 9, permissions: ["ADMINISTRATOR"] }]
    })), "FORBIDDEN");
  });

  it("allows the owner to grant an administrator role below their hierarchy", () => {
    expect(() => assertCanGrantRoles(grantInput({
      actorPermissions: new Set<Permission>(["ADMINISTRATOR", "MANAGE_ROLES"]),
      actorIsOwner: true,
      roles: [{ id: "role-1", position: 9, permissions: ["ADMINISTRATOR", "MANAGE_ROLES"] }]
    }))).not.toThrow();
  });
});
