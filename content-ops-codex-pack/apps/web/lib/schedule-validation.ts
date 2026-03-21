const DEFAULT_SLOT_TIMES = ["09:00", "13:00", "18:00"];

type BuildSchedulePreviewInput = {
  startDate: string;
  timezone: string;
  slotTimes: string[];
  previewCount?: number;
};

export type SchedulePreviewRow = {
  index: number;
  scheduleDate: string;
  slot: string;
  utcIso: string;
};

export function getDefaultSlotTimes() {
  return [...DEFAULT_SLOT_TIMES];
}

export function isValidDateInput(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime());
}

export function isValidTimezone(timezone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function parseSlotTimesWithValidation(input: unknown) {
  const raw = Array.isArray(input)
    ? input
        .map(value => String(value || "").trim())
        .filter(Boolean)
    : String(input || "")
        .split(",")
        .map(value => value.trim())
        .filter(Boolean);

  if (!raw.length) {
    return { slotTimes: getDefaultSlotTimes(), invalid: [] as string[] };
  }

  const valid = raw.filter(value => /^([01]\d|2[0-3]):[0-5]\d$/.test(value));
  const invalid = raw.filter(value => !/^([01]\d|2[0-3]):[0-5]\d$/.test(value));
  return { slotTimes: valid.length ? valid : getDefaultSlotTimes(), invalid };
}

function parseOffsetMs(offsetLabel: string) {
  const match = offsetLabel.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/i);
  if (!match) return 0;
  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number.parseInt(match[2], 10) || 0;
  const minutes = Number.parseInt(match[3] || "0", 10) || 0;
  return sign * (hours * 60 + minutes) * 60 * 1000;
}

function getOffsetMsAt(utcDate: Date, timezone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "longOffset",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  const parts = formatter.formatToParts(utcDate);
  const zone = parts.find(part => part.type === "timeZoneName")?.value || "GMT+00:00";
  return parseOffsetMs(zone);
}

export function zonedDateTimeToUtcIso(dateStr: string, timeStr: string, timezone: string) {
  const [year, month, day] = dateStr.split("-").map(value => Number.parseInt(value, 10));
  const [hour, minute] = timeStr.split(":").map(value => Number.parseInt(value, 10));
  const baseUtc = Date.UTC(year, (month || 1) - 1, day || 1, hour || 0, minute || 0, 0, 0);

  let utcMs = baseUtc;
  for (let i = 0; i < 2; i += 1) {
    const offsetMs = getOffsetMsAt(new Date(utcMs), timezone);
    utcMs = baseUtc - offsetMs;
  }
  return new Date(utcMs).toISOString();
}

export function addDays(dateStr: string, days: number) {
  const [year, month, day] = dateStr.split("-").map(value => Number.parseInt(value, 10));
  const date = new Date(Date.UTC(year, (month || 1) - 1, day || 1));
  date.setUTCDate(date.getUTCDate() + days);
  return [
    String(date.getUTCFullYear()).padStart(4, "0"),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0")
  ].join("-");
}

export function buildUtcSchedulePreview({
  startDate,
  timezone,
  slotTimes,
  previewCount = 6
}: BuildSchedulePreviewInput): SchedulePreviewRow[] {
  const normalizedTimezone = String(timezone || "").trim();
  if (!isValidTimezone(normalizedTimezone)) {
    throw new Error(`invalid_timezone:${timezone}`);
  }
  if (!isValidDateInput(startDate)) {
    throw new Error(`invalid_start_date:${startDate}`);
  }

  const parsedSlots = parseSlotTimesWithValidation(slotTimes);
  if (parsedSlots.invalid.length) {
    throw new Error(`invalid_slot_times:${parsedSlots.invalid.join(",")}`);
  }

  const totalRows = Math.max(1, Math.min(previewCount, 24));
  const rows: SchedulePreviewRow[] = [];
  for (let index = 0; index < totalRows; index += 1) {
    const slot = parsedSlots.slotTimes[index % parsedSlots.slotTimes.length];
    const dayOffset = Math.floor(index / parsedSlots.slotTimes.length);
    const scheduleDate = addDays(startDate, dayOffset);
    rows.push({
      index: index + 1,
      scheduleDate,
      slot,
      utcIso: zonedDateTimeToUtcIso(scheduleDate, slot, normalizedTimezone)
    });
  }
  return rows;
}
