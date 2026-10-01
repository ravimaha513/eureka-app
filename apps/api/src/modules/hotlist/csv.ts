/**
 * RFC 4180 CSV with spreadsheet formula injection neutralized: a cell starting
 * with =, +, -, @, tab or carriage return is prefixed with an apostrophe so
 * Excel and Sheets show it as text (OWASP "CSV injection").
 */
export function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "";
  let s = String(v);
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Header row plus rows, CRLF line endings, UTF-8 byte order mark for Excel. */
export function toCsv(header: readonly string[], rows: readonly (readonly (string | number | null | undefined)[])[]): string {
  const lines = [header, ...rows].map((r) => r.map(csvCell).join(","));
  return `﻿${lines.join("\r\n")}\r\n`;
}
