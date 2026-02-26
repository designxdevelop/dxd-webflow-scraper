export type ScheduleFrequency = "daily" | "weekly" | "monthly";

export const WEEKDAYS = [
  { label: "Sun", value: "0" },
  { label: "Mon", value: "1" },
  { label: "Tue", value: "2" },
  { label: "Wed", value: "3" },
  { label: "Thu", value: "4" },
  { label: "Fri", value: "5" },
  { label: "Sat", value: "6" },
] as const;

export function toCronExpression(
  frequency: ScheduleFrequency,
  time: string,
  days: string[],
  monthlyDay?: string
): string | null {
  const [hourString, minuteString] = time.split(":");
  const hour = Number.parseInt(hourString, 10);
  const minute = Number.parseInt(minuteString, 10);

  if (Number.isNaN(hour) || Number.isNaN(minute)) {
    return null;
  }

  const utcHour = (hour + 7) % 24;

  if (frequency === "daily") {
    return `${minute} ${utcHour} * * *`;
  }

  if (frequency === "monthly") {
    const dayOfMonth = monthlyDay || "1";
    return `${minute} ${utcHour} ${dayOfMonth} * *`;
  }

  const dayList = days.length > 0 ? days.join(",") : "1";
  return `${minute} ${utcHour} * * ${dayList}`;
}

export function parseCron(cron: string | null): {
  frequency: ScheduleFrequency;
  time: string;
  days: string[];
  monthlyDay: string;
} {
  if (!cron) {
    return { frequency: "daily", time: "05:00", days: ["1"], monthlyDay: "1" };
  }

  const parts = cron.split(" ");
  if (parts.length < 5) {
    return { frequency: "daily", time: "05:00", days: ["1"], monthlyDay: "1" };
  }

  const [minute, hourStr, dayOfMonth, , dayOfWeek] = parts;
  const utcHour = Number.parseInt(hourStr, 10);
  const mtHour = (utcHour - 7 + 24) % 24;
  const time = `${String(mtHour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

  if (dayOfMonth !== "*" && dayOfWeek === "*") {
    return { frequency: "monthly", time, days: ["1"], monthlyDay: dayOfMonth };
  }

  if (dayOfWeek === "*") {
    return { frequency: "daily", time, days: ["1"], monthlyDay: "1" };
  }

  const days = dayOfWeek.split(",").filter(Boolean);
  return { frequency: "weekly", time, days: days.length > 0 ? days : ["1"], monthlyDay: "1" };
}
