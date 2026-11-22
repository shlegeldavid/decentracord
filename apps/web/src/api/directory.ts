import { ApiError, isRecord, jsonWrite, postNoContent, requestJson, requestNoContent } from "./http.js";
import type {
  CreatedMember,
  Member,
  PersonSearchChannel,
  PersonSearchResult,
  PersonSearchRole,
  Role
} from "./types.js";
import { isStringArray } from "./guards.js";

function isRole(value: unknown): value is Role {
  return isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.position === "number" && Number.isInteger(value.position) &&
    isStringArray(value.permissions) &&
    (value.systemKey === null || typeof value.systemKey === "string") &&
    typeof value.ownerEditable === "boolean" &&
    (value.color === null || typeof value.color === "string") &&
    typeof value.editable === "boolean";
}

function isPersonSearchRole(value: unknown): value is PersonSearchRole {
  return isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    (value.color === null || typeof value.color === "string");
}

function isPersonSearchChannel(value: unknown): value is PersonSearchChannel {
  return isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string";
}

export function isPersonSearchResult(value: unknown): value is PersonSearchResult {
  return isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.login === "string" &&
    Array.isArray(value.roles) && value.roles.every(isPersonSearchRole) &&
    Array.isArray(value.commonChannels) && value.commonChannels.every(isPersonSearchChannel) &&
    (value.presence === "online" || value.presence === "offline");
}

export async function getMembers(): Promise<Member[]> {
  const result = await requestJson<{ members?: unknown }>("/api/members");
  if (!Array.isArray(result.members)) {
    throw new ApiError(502, "INVALID_RESPONSE", "Сервер вернул некорректный список участников");
  }

  return result.members.map((value) => {
    if (
      !isRecord(value) ||
      typeof value.id !== "string" ||
      typeof value.login !== "string" ||
      typeof value.active !== "boolean" ||
      !isStringArray(value.roleIds) ||
      !isStringArray(value.roleNames)
    ) {
      throw new ApiError(502, "INVALID_RESPONSE", "Сервер вернул некорректный список участников");
    }
    return {
      id: value.id,
      login: value.login,
      active: value.active,
      roleIds: value.roleIds,
      roleNames: value.roleNames
    };
  });
}

export async function createMember(
  credentials: { login: string; password: string },
  csrfToken: string,
  roleIds: string[]
): Promise<CreatedMember> {
  const result = await requestJson<{ id?: unknown; login?: unknown; active?: unknown }>(
    "/api/members",
    jsonWrite("POST", csrfToken, { ...credentials, roleIds })
  );
  if (typeof result.id !== "string" || typeof result.login !== "string" || typeof result.active !== "boolean") {
    throw new ApiError(502, "INVALID_RESPONSE", "Сервер вернул некорректные данные участника");
  }
  return { id: result.id, login: result.login, active: result.active };
}

function invalidRoleResponse(): ApiError {
  return new ApiError(502, "INVALID_RESPONSE", "Сервер вернул некорректные данные роли");
}

function parseRolePayload(value: unknown): Role {
  if (!isRole(value)) throw invalidRoleResponse();
  return {
    id: value.id,
    name: value.name,
    position: value.position,
    permissions: value.permissions,
    systemKey: value.systemKey,
    ownerEditable: value.ownerEditable,
    color: value.color,
    editable: value.editable
  };
}

export async function getRoles(): Promise<Role[]> {
  const result = await requestJson<{ roles?: unknown }>("/api/roles");
  if (!Array.isArray(result.roles)) {
    throw new ApiError(502, "INVALID_RESPONSE", "Сервер вернул некорректный список ролей");
  }
  return result.roles.map(parseRolePayload);
}

export async function createRole(
  input: { name: string; permissions: string[]; color?: string | null },
  csrfToken: string
): Promise<Role> {
  const result = await requestJson<unknown>("/api/roles", jsonWrite("POST", csrfToken, input));
  return parseRolePayload(result);
}

export async function updateRole(
  roleId: string,
  input: { name?: string; permissions?: string[]; color?: string | null },
  csrfToken: string
): Promise<Role> {
  const result = await requestJson<unknown>(`/api/roles/${encodeURIComponent(roleId)}`, jsonWrite("PATCH", csrfToken, input));
  return parseRolePayload(result);
}

export async function renameRole(roleId: string, name: string, csrfToken: string): Promise<Role> {
  const result = await requestJson<unknown>(`/api/roles/${encodeURIComponent(roleId)}`, jsonWrite("PATCH", csrfToken, { name }));
  return parseRolePayload(result);
}

export async function updateRolePermissions(roleId: string, permissions: string[], csrfToken: string): Promise<Role> {
  const result = await requestJson<unknown>(`/api/roles/${encodeURIComponent(roleId)}`, jsonWrite("PATCH", csrfToken, { permissions }));
  return parseRolePayload(result);
}

export async function searchPeople(query: string): Promise<{ results: PersonSearchResult[]; truncated: boolean }> {
  const params = new URLSearchParams();
  params.set("q", query);
  const result = await requestJson<unknown>(`/api/members/search?${params.toString()}`);
  if (!isRecord(result) ||
      !Array.isArray(result.results) ||
      !result.results.every(isPersonSearchResult) ||
      typeof result.truncated !== "boolean") {
    throw new ApiError(502, "INVALID_RESPONSE", "Сервер вернул некорректные данные поиска");
  }
  return { results: result.results, truncated: result.truncated };
}

export function reorderRoles(roleIds: string[], csrfToken: string): Promise<void> {
  return requestNoContent("/api/roles/order", "PUT", csrfToken, { roleIds });
}

export function assignMemberRoles(memberId: string, roleIds: string[], csrfToken: string): Promise<void> {
  return requestNoContent(`/api/members/${encodeURIComponent(memberId)}/roles`, "PATCH", csrfToken, { roleIds });
}

export function resetMemberPassword(memberId: string, newPassword: string, csrfToken: string): Promise<void> {
  return postNoContent(`/api/members/${encodeURIComponent(memberId)}/reset-password`, csrfToken, { newPassword });
}

export function disableMember(memberId: string, csrfToken: string): Promise<void> {
  return postNoContent(`/api/members/${encodeURIComponent(memberId)}/disable`, csrfToken);
}
