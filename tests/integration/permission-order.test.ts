import { describe, expect, it } from "vitest";
import {
  evaluateChannelAccess,
  isPermission,
  PERMISSIONS,
  type AccessFacts,
  type Permission,
  type OverrideFact
} from "../../apps/server/src/access/permissions.js";

const memberId = "member-1";

function facts(overrides: Partial<AccessFacts> = {}): AccessFacts {
  return {
    memberId,
    basePermissions: ["VIEW_CHANNEL", "SEND_MESSAGES"],
    hasAdministrator: false,
    memberRoleIds: [],
    overrides: [],
    ...overrides
  };
}

function override(
  subject: OverrideFact["subject"],
  subjectId: string | null,
  permission: Permission,
  effect: OverrideFact["effect"]
): OverrideFact {
  return { subject, subjectId, permission, effect };
}

const cases: Array<{ name: string; facts: AccessFacts; expected: Permission[] }> = [
  {
    name: "keeps base permissions when there are no overrides",
    facts: facts(),
    expected: ["VIEW_CHANNEL", "SEND_MESSAGES"]
  },
  {
    name: "applies an everyone deny to a base permission",
    facts: facts({ overrides: [override("everyone", null, "VIEW_CHANNEL", "deny")] }),
    expected: ["SEND_MESSAGES"]
  },
  {
    name: "lets an everyone allow win over an everyone deny",
    facts: facts({
      overrides: [
        override("everyone", null, "VIEW_CHANNEL", "allow"),
        override("everyone", null, "VIEW_CHANNEL", "deny")
      ]
    }),
    expected: ["VIEW_CHANNEL", "SEND_MESSAGES"]
  },
  {
    name: "lets a role allow win over another member role deny",
    facts: facts({
      memberRoleIds: ["role-deny", "role-allow"],
      overrides: [
        override("role", "role-allow", "VIEW_CHANNEL", "allow"),
        override("role", "role-deny", "VIEW_CHANNEL", "deny")
      ]
    }),
    expected: ["VIEW_CHANNEL", "SEND_MESSAGES"]
  },
  {
    name: "applies a member deny after a role allow",
    facts: facts({
      memberRoleIds: ["role-allow"],
      overrides: [
        override("role", "role-allow", "VIEW_CHANNEL", "allow"),
        override("member", memberId, "VIEW_CHANNEL", "deny")
      ]
    }),
    expected: ["SEND_MESSAGES"]
  },
  {
    name: "applies a member allow after a role deny",
    facts: facts({
      memberRoleIds: ["role-deny"],
      overrides: [
        override("role", "role-deny", "VIEW_CHANNEL", "deny"),
        override("member", memberId, "VIEW_CHANNEL", "allow")
      ]
    }),
    expected: ["VIEW_CHANNEL", "SEND_MESSAGES"]
  },
  {
    name: "does not reduce base permissions when the member has administrator",
    facts: facts({
      hasAdministrator: true,
      overrides: [
        override("everyone", null, "VIEW_CHANNEL", "deny"),
        override("role", "role-deny", "SEND_MESSAGES", "deny"),
        override("member", memberId, "VIEW_CHANNEL", "deny")
      ]
    }),
    expected: ["VIEW_CHANNEL", "SEND_MESSAGES"]
  },
  {
    name: "inherits base permissions when an override is not present",
    facts: facts({ basePermissions: ["VIEW_CHANNEL"] }),
    expected: ["VIEW_CHANNEL"]
  },
  {
    name: "does not apply the everyone override a second time as a role override",
    facts: facts({
      memberRoleIds: ["@everyone"],
      overrides: [
        override("everyone", null, "VIEW_CHANNEL", "allow"),
        override("everyone", null, "VIEW_CHANNEL", "deny")
      ]
    }),
    expected: ["VIEW_CHANNEL", "SEND_MESSAGES"]
  }
];

describe("evaluateChannelAccess permission order", () => {
  it.each(cases)("$name", ({ facts: input, expected }) => {
    expect([...evaluateChannelAccess(input)].sort()).toEqual([...expected].sort());
  });

  it("exposes exactly the supported permission catalog", () => {
    expect(PERMISSIONS).toEqual([
      "ADMINISTRATOR",
      "MANAGE_ROLES",
      "MANAGE_CHANNELS",
      "MANAGE_MESSAGES",
      "VIEW_CHANNEL",
      "SEND_MESSAGES"
    ]);
    expect(isPermission("VIEW_CHANNEL")).toBe(true);
    expect(isPermission("DELETE_MESSAGES")).toBe(false);
    expect(isPermission(null)).toBe(false);
  });

  it("ignores an everyone fact that has a non-null subject id", () => {
    const result = evaluateChannelAccess(facts({
      overrides: [
        override("everyone", null, "VIEW_CHANNEL", "deny"),
        override("everyone", "role-1", "VIEW_CHANNEL", "allow")
      ]
    }));
    expect(result.has("VIEW_CHANNEL")).toBe(false);
  });

  it("does not grant message management without a role or channel permission", () => {
    const result = evaluateChannelAccess(facts({ basePermissions: ["VIEW_CHANNEL", "SEND_MESSAGES"] }));
    expect(result.has("MANAGE_MESSAGES")).toBe(false);
  });

  it("accepts message management in the permission catalog", () => {
    expect(PERMISSIONS).toContain("MANAGE_MESSAGES");
    expect(isPermission("MANAGE_MESSAGES")).toBe(true);
  });

  it("applies a channel override for message management", () => {
    const result = evaluateChannelAccess(facts({
      overrides: [override("everyone", null, "MANAGE_MESSAGES", "allow")]
    }));
    expect(result.has("MANAGE_MESSAGES")).toBe(true);
  });
});
