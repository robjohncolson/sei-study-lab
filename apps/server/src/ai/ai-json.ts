/** Stable JSON binds previews to the exact model and messages sent. */
export function canonicalAiJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalAiJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalAiJson(object[key])}`).join(',')}}`;
}
