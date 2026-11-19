import { useCallback, useMemo } from "react";
import type { AuthUser } from "../api";

type DateInput = Date | string | number;

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone });
    return true;
  } catch {
    return false;
  }
}

function browserTimeZone(): string {
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof resolved === "string" && isValidTimeZone(resolved) ? resolved : "UTC";
  } catch {
    return "UTC";
  }
}

function validDate(value: DateInput): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function availableTimeZones(): string[] {
  const intlWithSupportedValues = Intl as typeof Intl & {
    supportedValuesOf?: (key: "timeZone") => string[];
  };
  if (typeof intlWithSupportedValues.supportedValuesOf !== "function") return ["UTC"];

  try {
    return ["UTC", ...intlWithSupportedValues.supportedValuesOf("timeZone")];
  } catch {
    return ["UTC"];
  }
}

export function useTimezone(user: AuthUser | null) {
  const timeZone = useMemo(() => {
    const userTimeZone = user?.timezone;
    return userTimeZone && isValidTimeZone(userTimeZone) ? userTimeZone : browserTimeZone();
  }, [user?.timezone]);

  const dayKey = useCallback((value: DateInput): string => {
    const date = validDate(value);
    if (!date) return "";
    try {
      return new Intl.DateTimeFormat("en-CA", { timeZone }).format(date);
    } catch {
      return new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(date);
    }
  }, [timeZone]);

  const formatMessageTime = useCallback((value: DateInput): string => {
    const date = validDate(value);
    if (!date) return "";
    try {
      return new Intl.DateTimeFormat("ru-RU", {
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
        timeZone
      }).format(date);
    } catch {
      return new Intl.DateTimeFormat("ru-RU", {
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
        timeZone: "UTC"
      }).format(date);
    }
  }, [timeZone]);

  const listTimeZones = useCallback(availableTimeZones, []);

  return { timeZone, dayKey, formatMessageTime, listTimeZones };
}
