import cronParser from "cron-parser";

export function isValidDownloadBlacklistRule(value: string): boolean {
  if (!value || !value.trim()) {
    return false;
  }

  const trimmed = value.trim();
  const candidate = trimmed.endsWith("*") ? trimmed.slice(0, -1) : trimmed;
  try {
    // eslint-disable-next-line no-new
    new URL(candidate);
    return true;
  } catch {
    return false;
  }
}

export function normalizeDownloadBlacklistRules(rules: string[] | null | undefined): string[] | undefined {
  if (!rules) {
    return undefined;
  }

  const normalized = new Set<string>();
  for (const rule of rules) {
    const trimmed = rule.trim();
    if (!trimmed) {
      continue;
    }

    const isPrefix = trimmed.endsWith("*");
    const candidate = isPrefix ? trimmed.slice(0, -1) : trimmed;
    try {
      const parsed = new URL(candidate);
      parsed.hash = "";
      if (!isPrefix) {
        parsed.search = "";
      }
      normalized.add(isPrefix ? `${parsed.toString()}*` : parsed.toString());
    } catch {
      // Ignore invalid values
    }
  }

  return Array.from(normalized);
}

export function getNextScheduledAt(scheduleEnabled: boolean, scheduleCron?: string | null): Date | null {
  if (!scheduleEnabled || !scheduleCron) {
    return null;
  }

  try {
    const interval = cronParser.parse(scheduleCron);
    return interval.next().toDate();
  } catch {
    return null;
  }
}
