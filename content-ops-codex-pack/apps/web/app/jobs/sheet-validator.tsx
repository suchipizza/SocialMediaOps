"use client";

import { useMemo, useState } from "react";

type ValidationIssue = {
  severity: "error" | "warning";
  code: string;
  message: string;
  row?: number;
  column?: string;
  sample?: string;
};

type ValidationResult = {
  ok: boolean;
  linkKind?: string;
  fetchedUrl?: string | null;
  rowCount?: number;
  headers?: string[];
  slideIndexes?: number[];
  errorCount?: number;
  warningCount?: number;
  issues?: ValidationIssue[];
  error?: string;
};

function summarizeIssue(issue: ValidationIssue) {
  const row = typeof issue.row === "number" ? `row ${issue.row}` : "";
  const column = issue.column ? `col ${issue.column}` : "";
  const location = [row, column].filter(Boolean).join(", ");
  return location ? `${location}: ${issue.message}` : issue.message;
}

export function SheetValidator() {
  const [sheetUrl, setSheetUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ValidationResult | null>(null);

  const topIssues = useMemo(() => {
    const all = Array.isArray(result?.issues) ? result!.issues! : [];
    return all.slice(0, 40);
  }, [result]);

  async function onValidate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const url = sheetUrl.trim();
    if (!url) {
      setResult({ ok: false, error: "sheet_url_required" });
      return;
    }
    setLoading(true);
    setResult(null);
    try {
      const response = await fetch("/api/sheets/validate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sheet_url: url })
      });
      const data = (await response.json()) as ValidationResult;
      if (!response.ok) {
        setResult({
          ok: false,
          error: data?.error || "sheet_validation_failed"
        });
      } else {
        setResult(data);
      }
    } catch (err: any) {
      setResult({
        ok: false,
        error: String(err?.message || err || "network_error")
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card" style={{ marginTop: 18 }}>
      <h3>Validate sheet format</h3>
      <form className="form" onSubmit={onValidate}>
        <div className="field">
          <label htmlFor="sheet_validate_url">Google Sheets link</label>
          <input
            id="sheet_validate_url"
            name="sheet_validate_url"
            placeholder="https://docs.google.com/spreadsheets/d/.../edit#gid=0"
            value={sheetUrl}
            onChange={event => setSheetUrl(event.target.value)}
            required
          />
        </div>
        <button type="submit" disabled={loading}>
          {loading ? "Validating..." : "Validate sheet format"}
        </button>
      </form>

      {result ? (
        <div style={{ marginTop: 14 }}>
          {"error" in result && result.error ? (
            <div className="empty">Validation failed: {result.error}</div>
          ) : (
            <>
              <p>
                {result.ok ? "Sheet format looks valid." : "Sheet format has issues."} Rows: {result.rowCount || 0},
                slide columns: {result.slideIndexes?.length || 0}, errors: {result.errorCount || 0}, warnings:{" "}
                {result.warningCount || 0}.
              </p>
              <p>
                Source: {result.linkKind || "—"}
                {result.fetchedUrl ? ` (${result.fetchedUrl})` : ""}
              </p>
              {!topIssues.length ? (
                <div className="empty">No row/column issues detected.</div>
              ) : (
                <div className="table-scroll">
                  <table className="table table-wide">
                    <thead>
                      <tr>
                        <th>Severity</th>
                        <th>Code</th>
                        <th>Details</th>
                        <th>Sample</th>
                      </tr>
                    </thead>
                    <tbody>
                      {topIssues.map((issue, index) => (
                        <tr key={`${issue.code}:${issue.row || "x"}:${issue.column || "x"}:${index}`}>
                          <td>
                            <span className="chip">{issue.severity.toUpperCase()}</span>
                          </td>
                          <td>{issue.code}</td>
                          <td>{summarizeIssue(issue)}</td>
                          <td>{issue.sample || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {(result.issues?.length || 0) > topIssues.length ? (
                <p>Showing first {topIssues.length} issues.</p>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

