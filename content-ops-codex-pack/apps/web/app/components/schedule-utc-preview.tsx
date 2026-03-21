"use client";

import { useEffect, useId, useMemo, useState } from "react";
import {
  buildUtcSchedulePreview,
  getDefaultSlotTimes,
  isValidDateInput,
  isValidTimezone,
  parseSlotTimesWithValidation
} from "../../lib/schedule-validation";

type ProjectSchedule = {
  timezone: string;
  slotTimes: string[];
};

type ScheduleUtcPreviewProps = {
  title?: string;
  timezoneInputId?: string;
  slotTimesInputId?: string;
  startDateInputId?: string;
  projectSelectId?: string;
  projectSchedules?: Record<string, ProjectSchedule>;
  fixedTimezone?: string;
  fixedSlotTimes?: string[];
  previewCount?: number;
};

type DisplayRow = {
  index: number;
  scheduleDate: string;
  slot: string;
  localText: string;
  utcText: string;
};

function useInputValue(inputId?: string) {
  const [value, setValue] = useState("");

  useEffect(() => {
    if (!inputId) {
      setValue("");
      return;
    }
    const node = document.getElementById(inputId) as
      | HTMLInputElement
      | HTMLSelectElement
      | HTMLTextAreaElement
      | null;
    if (!node) {
      setValue("");
      return;
    }

    const read = () => setValue(node.value || "");
    read();
    node.addEventListener("input", read);
    node.addEventListener("change", read);
    return () => {
      node.removeEventListener("input", read);
      node.removeEventListener("change", read);
    };
  }, [inputId]);

  return value;
}

function formatUtcText(iso: string) {
  return `${iso.slice(0, 16).replace("T", " ")} UTC`;
}

function formatLocalText(iso: string, timezone: string) {
  const date = new Date(iso);
  return (
    new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    })
      .format(date)
      .replace(",", "") + ` ${timezone}`
  );
}

function getTodayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

export function ScheduleUtcPreview({
  title = "UTC schedule preview",
  timezoneInputId,
  slotTimesInputId,
  startDateInputId,
  projectSelectId,
  projectSchedules,
  fixedTimezone,
  fixedSlotTimes,
  previewCount = 6
}: ScheduleUtcPreviewProps) {
  const previewDateId = useId();
  const linkedTimezone = useInputValue(timezoneInputId);
  const linkedSlotTimes = useInputValue(slotTimesInputId);
  const linkedStartDate = useInputValue(startDateInputId);
  const selectedProjectId = useInputValue(projectSelectId);
  const [sampleDate, setSampleDate] = useState(getTodayIsoDate());

  const selectedProjectSchedule = useMemo(() => {
    if (!selectedProjectId || !projectSchedules) return null;
    return projectSchedules[selectedProjectId] || null;
  }, [selectedProjectId, projectSchedules]);

  const timezone = String(
    fixedTimezone || linkedTimezone || selectedProjectSchedule?.timezone || "Europe/Zurich"
  ).trim();
  const slotSource =
    fixedSlotTimes?.join(",") ||
    linkedSlotTimes ||
    selectedProjectSchedule?.slotTimes?.join(",") ||
    getDefaultSlotTimes().join(",");
  const { slotTimes, invalid } = parseSlotTimesWithValidation(slotSource);

  const baseDate = startDateInputId ? linkedStartDate : sampleDate;
  const validDate = isValidDateInput(baseDate) ? baseDate : "";

  const timezoneError = isValidTimezone(timezone) ? "" : `Invalid timezone: ${timezone}`;

  let scheduleError = "";
  let rows: DisplayRow[] = [];
  if (!timezoneError && validDate) {
    try {
      rows = buildUtcSchedulePreview({
        startDate: validDate,
        timezone,
        slotTimes,
        previewCount
      }).map(row => ({
        index: row.index,
        scheduleDate: row.scheduleDate,
        slot: row.slot,
        localText: formatLocalText(row.utcIso, timezone),
        utcText: formatUtcText(row.utcIso)
      }));
    } catch (error: any) {
      scheduleError = String(error?.message || "schedule_preview_failed");
    }
  }

  return (
    <div
      className="field"
      style={{
        border: "1px solid rgba(148, 163, 184, 0.25)",
        borderRadius: 10,
        padding: 12
      }}
    >
      <label>{title}</label>
      {!startDateInputId ? (
        <div style={{ marginTop: 8 }}>
          <label htmlFor={previewDateId} style={{ display: "block" }}>
            Preview date
          </label>
          <input
            id={previewDateId}
            type="date"
            value={sampleDate}
            onChange={event => setSampleDate(event.target.value)}
          />
        </div>
      ) : null}

      {timezoneError ? <p style={{ color: "#b91c1c", marginTop: 8 }}>{timezoneError}</p> : null}
      {scheduleError ? <p style={{ color: "#b91c1c", marginTop: 8 }}>{scheduleError}</p> : null}
      {invalid.length ? (
        <p style={{ color: "#b45309", marginTop: 8 }}>
          Invalid slot values ignored: {invalid.join(", ")}.
        </p>
      ) : null}
      {!validDate ? (
        <p style={{ color: "#b45309", marginTop: 8 }}>Set a valid start date to preview UTC scheduling.</p>
      ) : null}

      {rows.length ? (
        <div style={{ marginTop: 8, display: "grid", gap: 6, fontSize: 13 }}>
          {rows.map(row => (
            <div key={`${row.index}:${row.scheduleDate}:${row.slot}`}>
              #{row.index} {row.localText} ({row.utcText})
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
