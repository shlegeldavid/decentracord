import { isRecord } from "./http.js";
import type { RoleSummary } from "./types.js";

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

export function isRoleSummary(value: unknown): value is RoleSummary {
  return isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    (value.color === null || typeof value.color === "string") &&
    typeof value.position === "number" && Number.isInteger(value.position);
}
