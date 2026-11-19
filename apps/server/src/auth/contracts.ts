import { isPermission, PERMISSIONS, type Permission } from "../access/permissions.js";

export interface UpdateOrganizationInput {
  name: string;
}

export interface CreateMemberInput {
  login: string;
  password: string;
  roleIds: string[];
}

export interface ChangePasswordInput {
  currentPassword: string;
  newPassword: string;
}

export interface UpdatePreferencesInput {
  theme?: "dark" | "light";
  timezone?: string | null;
}

export interface ResetMemberPasswordInput {
  newPassword: string;
}

export interface MemberSummary {
  id: string;
  login: string;
  active: boolean;
}

export interface MemberWithRoles extends MemberSummary {
  roleIds: string[];
  roleNames: string[];
}

export interface RoleSummary {
  id: string;
  name: string;
  position: number;
  permissions: Permission[];
  systemKey: string | null;
  ownerEditable: boolean;
  color: string | null;
  editable: boolean;
}

export interface CreateRoleInput {
  name: string;
  permissions: Permission[];
  color: string | null;
}

export interface UpdateRoleInput {
  name?: string;
  permissions?: Permission[];
  color?: string | null;
}

export interface ReorderRolesInput {
  roleIds: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseUpdatePreferences(value: unknown): UpdatePreferencesInput | null {
  if (
    !isRecord(value) ||
    Object.keys(value).length === 0 ||
    Object.keys(value).some((key) => key !== "theme" && key !== "timezone")
  ) {
    return null;
  }

  const input: UpdatePreferencesInput = {};
  if (Object.hasOwn(value, "theme")) {
    if (value.theme !== "dark" && value.theme !== "light") return null;
    input.theme = value.theme;
  }
  if (Object.hasOwn(value, "timezone")) {
    if (value.timezone === null) {
      input.timezone = null;
    } else if (typeof value.timezone === "string") {
      try {
        new Intl.DateTimeFormat("en", { timeZone: value.timezone });
      } catch {
        return null;
      }
      input.timezone = value.timezone;
    } else {
      return null;
    }
  }
  return input;
}

function parseRoleName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  const length = Array.from(name).length;
  if (length < 1 || length > 80 || name.includes("\u0000")) return null;
  return name;
}

function parseRolePermissions(value: unknown): Permission[] | null {
  if (!Array.isArray(value) || value.some((permission) => !isPermission(permission))) return null;
  const requested = new Set(value as Permission[]);
  return PERMISSIONS.filter((permission) => requested.has(permission));
}

export function parseRoleColor(value: unknown): string | null {
  if (value === null) return null;
  return typeof value === "string" && /^#[0-9A-Fa-f]{6}$/u.test(value) ? value : null;
}

export function parseCreateRole(value: unknown): CreateRoleInput | null {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => key !== "name" && key !== "permissions" && key !== "color") ||
    !Object.hasOwn(value, "name") ||
    !Object.hasOwn(value, "permissions")
  ) {
    return null;
  }
  const name = parseRoleName(value.name);
  const permissions = parseRolePermissions(value.permissions);
  const color = Object.hasOwn(value, "color") ? parseRoleColor(value.color) : null;
  if (
    name === null ||
    permissions === null ||
    (Object.hasOwn(value, "color") && value.color !== null && color === null)
  ) {
    return null;
  }
  return { name, permissions, color };
}

export function parseUpdateRole(value: unknown): UpdateRoleInput | null {
  if (
    !isRecord(value) ||
    Object.keys(value).length === 0 ||
    Object.keys(value).some((key) => key !== "name" && key !== "permissions" && key !== "color")
  ) {
    return null;
  }
  const input: UpdateRoleInput = {};
  if (Object.hasOwn(value, "name")) {
    const name = parseRoleName(value.name);
    if (name === null) return null;
    input.name = name;
  }
  if (Object.hasOwn(value, "permissions")) {
    const permissions = parseRolePermissions(value.permissions);
    if (permissions === null) return null;
    input.permissions = permissions;
  }
  if (Object.hasOwn(value, "color")) {
    const color = parseRoleColor(value.color);
    if (value.color !== null && color === null) return null;
    input.color = color;
  }
  return input;
}

export function parseReorderRoles(value: unknown): ReorderRolesInput | null {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 1 ||
    !Object.hasOwn(value, "roleIds") ||
    !Array.isArray(value.roleIds) ||
    value.roleIds.some((roleId) => typeof roleId !== "string")
  ) {
    return null;
  }
  return { roleIds: value.roleIds as string[] };
}

export function parseOrganizationName(value: unknown): string | null {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "name") || typeof value.name !== "string") {
    return null;
  }

  const name = value.name.trim();
  const length = Array.from(name).length;
  if (length < 1 || length > 100 || name.includes("\u0000")) return null;
  return name;
}

export function normalizeMemberLogin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const login = value.trim().toLowerCase();
  return /^[a-z0-9_.-]{3,64}$/u.test(login) ? login : null;
}

export function validMemberPassword(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const length = Array.from(value).length;
  return length >= 12 && length <= 128;
}

function isRoleId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function parseRoleIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((roleId) => !isRoleId(roleId))) return null;
  return [...new Set(value as string[])];
}

export function parseCreateMember(value: unknown): CreateMemberInput | null {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => key !== "login" && key !== "password" && key !== "roleIds")
  ) {
    return null;
  }

  const login = normalizeMemberLogin(value.login);
  if (!login || !validMemberPassword(value.password)) return null;
  const roleIds = Object.hasOwn(value, "roleIds") ? parseRoleIds(value.roleIds) : [];
  if (roleIds === null) return null;
  return { login, password: value.password, roleIds };
}

export function parseMemberRoleIds(value: unknown): string[] | null {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, "roleIds")) return null;
  return parseRoleIds(value.roleIds);
}

export function parsePasswordChange(value: unknown): ChangePasswordInput | null {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => key !== "currentPassword" && key !== "newPassword") ||
    !validMemberPassword(value.currentPassword) ||
    !validMemberPassword(value.newPassword)
  ) {
    return null;
  }
  return { currentPassword: value.currentPassword, newPassword: value.newPassword };
}

export function parseResetMemberPassword(value: unknown): ResetMemberPasswordInput | null {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => key !== "newPassword") ||
    !validMemberPassword(value.newPassword)
  ) {
    return null;
  }
  return { newPassword: value.newPassword };
}
