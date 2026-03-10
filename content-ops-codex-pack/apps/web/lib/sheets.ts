export type GoogleSheetRef =
  | { kind: "edit"; spreadsheetId: string; gid?: string }
  | { kind: "published"; publishedId: string; gid?: string };

export function parseGoogleSheetLink(input: string): GoogleSheetRef {
  const url = new URL(input);
  if (!url.hostname.includes("docs.google.com")) {
    throw new Error("sheets_invalid_host");
  }

  const gid = url.hash?.match(/gid=([0-9]+)/)?.[1] ?? url.searchParams.get("gid") ?? undefined;

  const publishedMatch = url.pathname.match(/\/spreadsheets\/d\/e\/([^/]+)/);
  if (publishedMatch) {
    const publishedId = publishedMatch[1]!;
    return { kind: "published", publishedId, gid: gid || undefined };
  }

  const match = url.pathname.match(/\/spreadsheets\/(?:u\/\d+\/)?d\/([^/]+)/);
  if (!match) throw new Error("sheets_invalid_url");

  const spreadsheetId = match[1]!;
  return { kind: "edit", spreadsheetId, gid: gid || undefined };
}

export function buildGoogleSheetCsvUrls(input: string): string[] {
  const sheetRef = parseGoogleSheetLink(input);

  if (sheetRef.kind === "edit") {
    const exportUrl = new URL(`https://docs.google.com/spreadsheets/d/${sheetRef.spreadsheetId}/export`);
    exportUrl.searchParams.set("format", "csv");
    if (sheetRef.gid) exportUrl.searchParams.set("gid", sheetRef.gid);

    const gvizUrl = new URL(`https://docs.google.com/spreadsheets/d/${sheetRef.spreadsheetId}/gviz/tq`);
    gvizUrl.searchParams.set("tqx", "out:csv");
    if (sheetRef.gid) gvizUrl.searchParams.set("gid", sheetRef.gid);

    return [exportUrl.toString(), gvizUrl.toString()];
  }

  const pubUrl = new URL(`https://docs.google.com/spreadsheets/d/e/${sheetRef.publishedId}/pub`);
  pubUrl.searchParams.set("output", "csv");
  if (sheetRef.gid) pubUrl.searchParams.set("gid", sheetRef.gid);
  pubUrl.searchParams.set("single", "true");

  const pubHtmlUrl = new URL(`https://docs.google.com/spreadsheets/d/e/${sheetRef.publishedId}/pubhtml`);
  pubHtmlUrl.searchParams.set("output", "csv");
  if (sheetRef.gid) pubHtmlUrl.searchParams.set("gid", sheetRef.gid);
  pubHtmlUrl.searchParams.set("single", "true");

  const fallbackPubUrl = new URL(`https://docs.google.com/spreadsheets/d/e/${sheetRef.publishedId}/pub`);
  fallbackPubUrl.searchParams.set("output", "csv");
  fallbackPubUrl.searchParams.set("single", "true");

  const fallbackPubHtmlUrl = new URL(`https://docs.google.com/spreadsheets/d/e/${sheetRef.publishedId}/pubhtml`);
  fallbackPubHtmlUrl.searchParams.set("output", "csv");
  fallbackPubHtmlUrl.searchParams.set("single", "true");

  return [pubUrl.toString(), pubHtmlUrl.toString(), fallbackPubUrl.toString(), fallbackPubHtmlUrl.toString()];
}

export function describeGoogleSheetLink(input: string) {
  const ref = parseGoogleSheetLink(input);
  if (ref.kind === "edit") return `edit link (${ref.spreadsheetId}${ref.gid ? ` gid=${ref.gid}` : ""})`;
  return `published link (${ref.publishedId}${ref.gid ? ` gid=${ref.gid}` : ""})`;
}
