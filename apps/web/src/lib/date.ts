// Mountain Time date formatting utilities
// Always displays dates in America/Denver timezone

const MOUNTAIN_TIMEZONE = "America/Denver";

/**
 * Format a date to Mountain Time string
 */
export function formatToMountainTime(
  date: Date | string | null | undefined,
  options: Intl.DateTimeFormatOptions = {}
): string {
  if (!date) return "—";

  const d = typeof date === "string" ? new Date(date) : date;

  const defaultOptions: Intl.DateTimeFormatOptions = {
    timeZone: MOUNTAIN_TIMEZONE,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    ...options,
  };

  return d.toLocaleString("en-US", defaultOptions);
}

/**
 * Format a date to Mountain Time date only (no time)
 */
export function formatToMountainDate(
  date: Date | string | null | undefined,
  options: Intl.DateTimeFormatOptions = {}
): string {
  if (!date) return "—";

  const d = typeof date === "string" ? new Date(date) : date;

  const defaultOptions: Intl.DateTimeFormatOptions = {
    timeZone: MOUNTAIN_TIMEZONE,
    month: "short",
    day: "numeric",
    year: "numeric",
    ...options,
  };

  return d.toLocaleDateString("en-US", defaultOptions);
}

/**
 * Format a time to Mountain Time only
 */
export function formatToMountainTimeOnly(
  date: Date | string | null | undefined,
  options: Intl.DateTimeFormatOptions = {}
): string {
  if (!date) return "—";

  const d = typeof date === "string" ? new Date(date) : date;

  const defaultOptions: Intl.DateTimeFormatOptions = {
    timeZone: MOUNTAIN_TIMEZONE,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    ...options,
  };

  return d.toLocaleTimeString("en-US", defaultOptions);
}
