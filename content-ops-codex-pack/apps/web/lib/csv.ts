import Papa from "papaparse";

export type CsvRow = Record<string, string>;

export function parseCsv(text: string): CsvRow[] {
  const parsed = Papa.parse<CsvRow>(text, {
    header: true,
    skipEmptyLines: "greedy",
    dynamicTyping: false
  });

  if (parsed.errors?.length) {
    const first = parsed.errors[0];
    throw new Error(`csv_parse_error:${first.message}`);
  }

  const rows = (parsed.data || [])
    .map(row => {
      const out: CsvRow = {};
      for (const [key, value] of Object.entries(row || {})) {
        if (!key) continue;
        out[String(key).trim()] = String(value ?? "").trim();
      }
      return out;
    })
    .filter(row => Object.values(row).some(v => String(v).length > 0));

  return rows;
}

export function getSlideColumnIndexes(headers: string[]): number[] {
  const indexes = new Set<number>();
  for (const header of headers) {
    const match = header.toLowerCase().match(/^slide_(\d+)(?:_json)?$/);
    if (!match) continue;
    const index = Number(match[1]);
    if (Number.isInteger(index) && index > 0) indexes.add(index);
  }
  return Array.from(indexes).sort((a, b) => a - b);
}

export function parseHashtags(input: string): string[] {
  const raw = (input || "").trim();
  if (!raw) return [];

  const tokens = raw.includes(",") ? raw.split(",") : raw.split(/\s+/);
  const normalized = tokens
    .map(t => t.trim())
    .filter(Boolean)
    .map(t => (t.startsWith("#") ? t : `#${t}`))
    .map(t => t.replace(/^##+/, "#"))
    .filter(t => t.length > 1);

  return Array.from(new Set(normalized));
}
