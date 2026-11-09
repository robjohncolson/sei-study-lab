export function dateLabel(value?: string | null): string {
  if (!value || Number.isNaN(Date.parse(value))) return 'Not recorded';
  // A retrieval calendar date has no recorded time or instant to localize.
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return new Date(value).toLocaleString();
}
