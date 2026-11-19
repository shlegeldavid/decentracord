export const PERMISSIONS = ["ADMINISTRATOR", "MANAGE_ROLES", "MANAGE_CHANNELS", "MANAGE_MESSAGES", "VIEW_CHANNEL", "SEND_MESSAGES"] as const;

export type Permission = (typeof PERMISSIONS)[number];

export interface OverrideFact {
  subject: "everyone" | "role" | "member";
  subjectId: string | null;
  permission: Permission;
  effect: "allow" | "deny";
}

export interface AccessFacts {
  memberId: string;
  basePermissions: Permission[];
  hasAdministrator: boolean;
  memberRoleIds: string[];
  overrides: OverrideFact[];
}

export function isPermission(value: unknown): value is Permission {
  return typeof value === "string" && PERMISSIONS.some((permission) => permission === value);
}

function applyOverrides(
  permissions: Set<Permission>,
  overrides: OverrideFact[],
  effect: OverrideFact["effect"]
): void {
  for (const override of overrides) {
    if (effect === "deny") permissions.delete(override.permission);
    else permissions.add(override.permission);
  }
}

export function evaluateChannelAccess(facts: AccessFacts): Set<Permission> {
  const permissions = new Set(facts.basePermissions);
  if (facts.hasAdministrator) return permissions;

  const everyoneOverrides = facts.overrides.filter(
    (override) => override.subject === "everyone" && override.subjectId === null
  );
  applyOverrides(permissions, everyoneOverrides.filter((override) => override.effect === "deny"), "deny");
  applyOverrides(permissions, everyoneOverrides.filter((override) => override.effect === "allow"), "allow");

  const roleOverrides = facts.overrides.filter(
    (override) =>
      override.subject === "role" &&
      override.subjectId !== null &&
      facts.memberRoleIds.includes(override.subjectId)
  );
  applyOverrides(permissions, roleOverrides.filter((override) => override.effect === "deny"), "deny");
  applyOverrides(permissions, roleOverrides.filter((override) => override.effect === "allow"), "allow");

  const memberOverrides = facts.overrides.filter(
    (override) => override.subject === "member" && override.subjectId === facts.memberId
  );
  applyOverrides(permissions, memberOverrides.filter((override) => override.effect === "deny"), "deny");
  applyOverrides(permissions, memberOverrides.filter((override) => override.effect === "allow"), "allow");

  return permissions;
}
