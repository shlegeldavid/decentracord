import { isPermission, type Permission } from "../access/permissions.js";

export type ChannelSubject = "everyone" | "role" | "member";
export type OverrideEffect = "allow" | "deny";

export interface OverrideInput {
  subject: ChannelSubject;
  subjectId: string | null;
  permission: Permission;
  effect: OverrideEffect | "unset";
}

interface CreateChannelInput {
  name: string;
  description: string | null;
  categoryId: string | null;
  overrides: OverrideInput[];
}

interface ChannelDetails {
  categoryId?: string | null;
  description?: string | null;
}

interface UpdateChannelInput extends ChannelDetails {
  name?: string;
  visibility?: "hidden" | "known";
}

export interface ChannelOrderGroup {
  categoryId: string | null;
  channelIds: string[];
}

const channelOverridePermissions = new Set<Permission>([
  "VIEW_CHANNEL",
  "SEND_MESSAGES",
  "MANAGE_MESSAGES"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function isCategoryId(value: unknown): value is string | null {
  return value === null || isUuid(value);
}

function parseName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  const length = Array.from(name).length;
  return length < 1 || length > 80 || name.includes("\u0000") ? null : name;
}

function parseOptionalChannelFields(value: Record<string, unknown>): ChannelDetails | null {
  const input: ChannelDetails = {};
  if (Object.hasOwn(value, "categoryId")) {
    if (!isCategoryId(value.categoryId)) return null;
    input.categoryId = value.categoryId;
  }
  if (Object.hasOwn(value, "description")) {
    const description = value.description;
    if (
      description !== null &&
      (typeof description !== "string" || Array.from(description).length > 1024 || description.includes("\u0000"))
    ) return null;
    input.description = description;
  }
  return input;
}

export function parseCategoryNameBody(value: unknown): { name: string } | null {
  if (!isRecord(value) || !Object.hasOwn(value, "name") || Object.keys(value).some((key) => key !== "name")) return null;
  const name = parseName(value.name);
  return name === null ? null : { name };
}

export function parseCreateChannelBody(value: unknown): CreateChannelInput | null {
  if (
    !isRecord(value) ||
    !Object.hasOwn(value, "name") ||
    Object.keys(value).some((key) => !["name", "description", "categoryId", "overrides"].includes(key))
  ) return null;
  const name = parseName(value.name);
  if (name === null) return null;
  const fields = parseOptionalChannelFields(value);
  if (fields === null) return null;

  let overrides: OverrideInput[] = [];
  if (Object.hasOwn(value, "overrides")) {
    const parsed = parseOverrides(value);
    if (!parsed || parsed.some((override) => !channelOverridePermissions.has(override.permission))) return null;
    overrides = parsed;
  }

  return { name, description: fields.description ?? null, categoryId: fields.categoryId ?? null, overrides };
}

export function parseUpdateChannelBody(value: unknown): UpdateChannelInput | null {
  if (
    !isRecord(value) ||
    Object.keys(value).length === 0 ||
    Object.keys(value).some((key) => !["name", "categoryId", "description", "visibility"].includes(key))
  ) return null;

  const input: UpdateChannelInput | null = parseOptionalChannelFields(value);
  if (!input) return null;
  if (Object.hasOwn(value, "name")) {
    const name = parseName(value.name);
    if (name === null) return null;
    input.name = name;
  }
  if (Object.hasOwn(value, "visibility")) {
    if (value.visibility !== "hidden" && value.visibility !== "known") return null;
    input.visibility = value.visibility;
  }
  return input;
}

export function parseReorderCategoriesBody(value: unknown): { categoryIds: string[] } | null {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 1 ||
    Object.keys(value).some((key) => key !== "categoryIds") ||
    !Array.isArray(value.categoryIds) ||
    !value.categoryIds.every(isUuid)
  ) return null;
  return { categoryIds: value.categoryIds };
}

export function parseReorderChannelsBody(value: unknown): { groups: ChannelOrderGroup[] } | null {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, "groups") || !Array.isArray(value.groups)) {
    return null;
  }

  const groups: ChannelOrderGroup[] = [];
  const categoryIds = new Set<string | null>();
  const channelIds = new Set<string>();
  for (const entry of value.groups) {
    if (
      !isRecord(entry) ||
      Object.keys(entry).length !== 2 ||
      !Object.hasOwn(entry, "categoryId") ||
      !Object.hasOwn(entry, "channelIds") ||
      !isCategoryId(entry.categoryId) ||
      !Array.isArray(entry.channelIds) ||
      !entry.channelIds.every(isUuid)
    ) return null;

    if (categoryIds.has(entry.categoryId)) return null;
    categoryIds.add(entry.categoryId);
    for (const channelId of entry.channelIds) {
      if (channelIds.has(channelId)) return null;
      channelIds.add(channelId);
    }
    groups.push({ categoryId: entry.categoryId, channelIds: entry.channelIds });
  }

  return { groups };
}

function parseOverrides(value: Record<string, unknown>): OverrideInput[] | null {
  if (!Object.hasOwn(value, "overrides") || !Array.isArray(value.overrides)) return null;

  const overrides: OverrideInput[] = [];
  for (const candidate of value.overrides) {
    if (
      !isRecord(candidate) ||
      Object.keys(candidate).length !== 4 ||
      Object.keys(candidate).some((key) => !["subject", "subjectId", "permission", "effect"].includes(key)) ||
      !Object.hasOwn(candidate, "subjectId") ||
      !isPermission(candidate.permission) ||
      (candidate.effect !== "allow" && candidate.effect !== "deny" && candidate.effect !== "unset")
    ) return null;

    const subject = candidate.subject;
    if (subject !== "everyone" && subject !== "role" && subject !== "member") return null;
    const subjectId = candidate.subjectId;
    if (subject === "everyone" ? subjectId !== null : !isUuid(subjectId)) return null;
    overrides.push({
      subject,
      subjectId: subject === "everyone" ? null : subjectId as string,
      permission: candidate.permission,
      effect: candidate.effect
    });
  }
  return overrides;
}

export function parseChannelOverridesBody(value: unknown): OverrideInput[] | null {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "overrides")) return null;
  return parseOverrides(value);
}
