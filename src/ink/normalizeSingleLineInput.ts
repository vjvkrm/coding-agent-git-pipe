export function normalizeSingleLineInput(value: string): string {
  if (!/[\r\n]/.test(value)) {
    return value;
  }

  let normalized = value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]*\n+[ \t]*/g, " ");

  if (/^[\r\n]/.test(value)) {
    normalized = normalized.replace(/^ /, "");
  }

  if (/[\r\n]$/.test(value)) {
    normalized = normalized.replace(/ $/, "");
  }

  return normalized;
}
