import Papa from "papaparse";
import { getSlideColumnIndexes, parseCsv } from "./csv";
import { buildGoogleSheetCsvUrls, describeGoogleSheetLink } from "./sheets";

export type SheetValidationIssue = {
  severity: "error" | "warning";
  code: string;
  message: string;
  row?: number;
  column?: string;
  sample?: string;
};

export type SheetValidationResult = {
  ok: boolean;
  linkKind: string;
  fetchedUrl: string | null;
  rowCount: number;
  headers: string[];
  slideIndexes: number[];
  errorCount: number;
  warningCount: number;
  issues: SheetValidationIssue[];
};

function safeSample(value: string, maxLen = 180) {
  const clean = String(value || "").replace(/\s+/g, " ").trim();
  if (clean.length <= maxLen) return clean;
  return `${clean.slice(0, maxLen - 1)}…`;
}

function getRowValueCaseInsensitive(row: Record<string, string>, key: string) {
  if (key in row) return row[key];
  const lowered = key.toLowerCase();
  for (const [k, v] of Object.entries(row)) {
    if (k.toLowerCase() === lowered) return v;
  }
  return "";
}

function parseCsvHeaderRow(csvText: string) {
  const parsed = Papa.parse<string[]>(csvText, {
    header: false,
    dynamicTyping: false,
    skipEmptyLines: false,
    preview: 1
  });
  if (parsed.errors?.length) return [];
  const first = Array.isArray(parsed.data?.[0]) ? parsed.data[0] : [];
  return first.map(cell => String(cell ?? "").trim());
}

export async function validateGoogleSheetFormat(sheetUrl: string): Promise<SheetValidationResult> {
  const linkKind = describeGoogleSheetLink(sheetUrl);
  const issues: SheetValidationIssue[] = [];

  const urls = buildGoogleSheetCsvUrls(sheetUrl);
  const fetchStatuses: string[] = [];
  let csvText: string | null = null;
  let fetchedUrl: string | null = null;
  for (const url of urls) {
    try {
      const response = await fetch(url, { redirect: "follow" });
      fetchStatuses.push(`${url} -> ${response.status}`);
      if (!response.ok) continue;
      csvText = await response.text();
      fetchedUrl = url;
      break;
    } catch (err: any) {
      fetchStatuses.push(`${url} -> fetch_error:${String(err?.message || err || "unknown")}`);
    }
  }

  if (!csvText) {
    issues.push({
      severity: "error",
      code: "sheets_fetch_failed",
      message: `Unable to fetch CSV from this sheet link (${linkKind}). Tried: ${fetchStatuses.join("; ")}`
    });
    return {
      ok: false,
      linkKind,
      fetchedUrl,
      rowCount: 0,
      headers: [],
      slideIndexes: [],
      errorCount: 1,
      warningCount: 0,
      issues
    };
  }

  const lowered = csvText.slice(0, 2000).toLowerCase();
  if (lowered.includes("<!doctype html") || lowered.includes("<html")) {
    issues.push({
      severity: "error",
      code: "sheets_not_csv",
      message: `Fetched HTML instead of CSV (${linkKind}). Use a published CSV-capable link.`
    });
    return {
      ok: false,
      linkKind,
      fetchedUrl,
      rowCount: 0,
      headers: [],
      slideIndexes: [],
      errorCount: 1,
      warningCount: 0,
      issues
    };
  }

  let rows: Record<string, string>[] = [];
  try {
    rows = parseCsv(csvText);
  } catch (err: any) {
    issues.push({
      severity: "error",
      code: "csv_parse_error",
      message: String(err?.message || err || "csv_parse_error")
    });
    return {
      ok: false,
      linkKind,
      fetchedUrl,
      rowCount: 0,
      headers: [],
      slideIndexes: [],
      errorCount: 1,
      warningCount: 0,
      issues
    };
  }

  if (!rows.length) {
    issues.push({
      severity: "error",
      code: "csv_empty",
      message: "CSV has no data rows."
    });
    return {
      ok: false,
      linkKind,
      fetchedUrl,
      rowCount: 0,
      headers: [],
      slideIndexes: [],
      errorCount: 1,
      warningCount: 0,
      issues
    };
  }

  const headers = Object.keys(rows[0] || {});
  const rawHeaders = parseCsvHeaderRow(csvText);
  const slideIndexes = getSlideColumnIndexes(headers);

  if (!headers.some(header => header.toLowerCase() === "pillar")) {
    issues.push({
      severity: "error",
      code: "missing_column_pillar",
      message: "Missing required column: pillar."
    });
  }
  if (!slideIndexes.length) {
    issues.push({
      severity: "error",
      code: "missing_slide_columns",
      message: "No slide columns found. Expected slide_1_json...slide_n_json (or slide_1...slide_n)."
    });
  }

  const blankHeaderCount = rawHeaders.filter(header => !header).length;
  if (blankHeaderCount > 0) {
    issues.push({
      severity: "warning",
      code: "blank_headers",
      message: `Found ${blankHeaderCount} blank header column(s). Remove trailing empty columns.`
    });
  }

  const autoRenamedHeaders = headers.filter(header => /^_\d+$/.test(header));
  if (autoRenamedHeaders.length > 0) {
    issues.push({
      severity: "warning",
      code: "auto_renamed_headers",
      message: `Detected parser-renamed duplicate/blank headers: ${autoRenamedHeaders.join(", ")}.`
    });
  }

  const headerCounts = new Map<string, number>();
  for (const header of rawHeaders) {
    const key = header.toLowerCase();
    headerCounts.set(key, (headerCounts.get(key) || 0) + 1);
  }
  const duplicateHeaders = Array.from(headerCounts.entries())
    .filter(([key, count]) => key && count > 1)
    .map(([key, count]) => `${key} (x${count})`);
  if (duplicateHeaders.length) {
    issues.push({
      severity: "warning",
      code: "duplicate_headers",
      message: `Duplicate headers found: ${duplicateHeaders.join(", ")}.`
    });
  }

  const jsonSlideColumns = headers.filter(header => /^slide_\d+_json$/i.test(header));
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const rowNumber = index + 2;
    const pillar = getRowValueCaseInsensitive(row, "pillar").trim();
    if (!pillar) {
      issues.push({
        severity: "error",
        code: "row_missing_pillar",
        row: rowNumber,
        column: "pillar",
        message: "Pillar is empty."
      });
    }

    for (const column of jsonSlideColumns) {
      const rawValue = String(row[column] || "").trim();
      if (!rawValue) continue;
      try {
        const parsed = JSON.parse(rawValue);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          issues.push({
            severity: "error",
            code: "slide_json_not_object",
            row: rowNumber,
            column,
            message: "JSON value must be an object.",
            sample: safeSample(rawValue)
          });
        }
      } catch {
        issues.push({
          severity: "error",
          code: "slide_json_parse_error",
          row: rowNumber,
          column,
          message: "Invalid JSON syntax (often caused by unescaped double quotes).",
          sample: safeSample(rawValue)
        });
      }
    }
  }

  const errorCount = issues.filter(issue => issue.severity === "error").length;
  const warningCount = issues.filter(issue => issue.severity === "warning").length;
  return {
    ok: errorCount === 0,
    linkKind,
    fetchedUrl,
    rowCount: rows.length,
    headers,
    slideIndexes,
    errorCount,
    warningCount,
    issues
  };
}

