export interface UpdateOrganizationInput {
  name: string;
}

export interface CreateMemberInput {
  login: string;
  password: string;
}

export interface ChangePasswordInput {
  currentPassword: string;
  newPassword: string;
}

export interface ResetMemberPasswordInput {
  newPassword: string;
}

export interface MemberSummary {
  id: string;
  login: string;
  active: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

export function parseCreateMember(value: unknown): CreateMemberInput | null {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => key !== "login" && key !== "password")
  ) {
    return null;
  }

  const login = normalizeMemberLogin(value.login);
  if (!login || !validMemberPassword(value.password)) return null;
  return { login, password: value.password };
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
