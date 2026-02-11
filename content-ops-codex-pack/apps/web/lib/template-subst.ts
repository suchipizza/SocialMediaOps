export function applyPlaceholders(html: string, values: Record<string, unknown>) {
  let out = html;
  for (const [key, value] of Object.entries(values)) {
    out = out.replaceAll(`{{${key}}}`, String(value ?? ""));
  }
  return out;
}

