/**
 * Template substitution (skeleton).
 * Loads a template.html and replaces tokens like {{headline}}, {{body}}, etc.
 * TODO: add per-slide mapping and box-fitting logic driven by manifest.
 */
export function applyPlaceholders(html, values) {
  let out = html;
  for (const [k, v] of Object.entries(values)) {
    out = out.replaceAll(`{{${k}}}`, String(v ?? ""));
  }
  return out;
}
