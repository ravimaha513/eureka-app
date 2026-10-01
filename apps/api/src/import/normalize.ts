/**
 * Pure normalizers for sheet cells (design B9 step 2). Each returns either a
 * value or a review reason; none of them guesses. Reasons are stable codes
 * listed in docs/import.md.
 */
export type Norm<T> = { ok: true; value: T } | { ok: false; reason: string };
const ok = <T>(value: T): Norm<T> => ({ ok: true, value });
const fail = <T>(reason: string): Norm<T> => ({ ok: false, reason });

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;

/** Trims, removes control characters and collapses inner whitespace. */
export function clean(s: string | null | undefined): string {
  return (s ?? "").replace(CONTROL, " ").replace(/\s+/g, " ").trim();
}

function titleWord(w: string): string {
  // Capitalise after spaces, hyphens and apostrophes: "o'brien-smith" -> "O'Brien-Smith".
  return w.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toUpperCase());
}

/**
 * A person-name part. All-caps or all-lowercase cells are title-cased; mixed
 * case is kept as typed (McDonald, DeSouza). Must contain a letter.
 */
export function normalizeName(s: string | null | undefined): Norm<string | null> {
  const v = clean(s).replace(/^[.,;]+|[.,;]+$/g, "").trim();
  if (!v) return ok(null);
  if (!/\p{L}/u.test(v) || /[0-9@]/.test(v) || v.length > 80) return fail("invalid_name");
  const lettersOnly = v.replace(/[^\p{L}]/gu, "");
  const fixCase = lettersOnly === lettersOnly.toUpperCase() || lettersOnly === lettersOnly.toLowerCase();
  return ok(fixCase ? titleWord(v) : v);
}

/**
 * Splits a single "Name" cell: "Last, First" or "First [Middle] Last" (the
 * last word is the last name). A single word is incomplete.
 */
export function splitFullName(s: string | null | undefined): Norm<{ first: string; last: string } | null> {
  const v = clean(s);
  if (!v) return ok(null);
  let first: string;
  let last: string;
  const comma = v.split(",");
  if (comma.length === 2) {
    last = comma[0]!.trim();
    first = comma[1]!.trim();
  } else if (comma.length > 2) {
    return fail("invalid_name");
  } else {
    const parts = v.split(" ");
    if (parts.length < 2) return fail("incomplete_name");
    last = parts.pop()!;
    first = parts.join(" ");
  }
  const f = normalizeName(first);
  const l = normalizeName(last);
  if (!f.ok) return f;
  if (!l.ok) return l;
  if (!f.value || !l.value) return fail("incomplete_name");
  return ok({ first: f.value, last: l.value });
}

/** Matching key for a name: case, accents, punctuation and spacing ignored. */
export function nameKey(first: string, last: string): string {
  const k = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z]/g, "");
  return `${k(first)}|${k(last)}`;
}

const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,}$/;

/** Lower-cased, "mailto:" and angle brackets removed. Several addresses in one cell go to review. */
export function normalizeEmail(s: string | null | undefined): Norm<string | null> {
  let v = clean(s).toLowerCase();
  if (!v) return ok(null);
  v = v.replace(/^mailto:/, "").replace(/^<|>$/g, "").trim();
  if (/[,;\s]/.test(v) && (v.match(/@/g) ?? []).length > 1) return fail("multiple_emails");
  if (v.length > 254 || !EMAIL.test(v) || v.includes("..")) return fail("invalid_email");
  return ok(v);
}

function nanpValid(ten: string): boolean {
  // Area code and exchange both start 2-9 (North American Numbering Plan).
  return /^[2-9][0-9]{2}[2-9][0-9]{6}$/.test(ten);
}

/**
 * E.164. Default region is the US/Canada (+1): 10 digits, or 11 starting
 * with 1. Other countries need an explicit "+" or "00" prefix; anything else
 * (letters, wrong length, invalid area code) goes to review. Extensions
 * ("x123", "ext. 4") are dropped.
 */
export function normalizePhone(s: string | null | undefined): Norm<string | null> {
  let v = clean(s);
  if (!v) return ok(null);
  v = v.replace(/\s*(?:ext\.?|extension|x|#)\s*\d{1,6}$/i, "");
  if (/[^0-9+().\-\s/]/.test(v)) return fail("invalid_phone");
  const plus = v.startsWith("+");
  if (v.indexOf("+") > 0 || (v.match(/\+/g) ?? []).length > 1) return fail("invalid_phone");
  let digits = v.replace(/[^0-9]/g, "");
  if (plus) {
    if (digits.startsWith("1")) return digits.length === 11 && nanpValid(digits.slice(1)) ? ok(`+${digits}`) : fail("invalid_phone");
    return /^[2-9][0-9]{7,14}$/.test(digits) ? ok(`+${digits}`) : fail("invalid_phone");
  }
  if (digits.startsWith("00")) {
    digits = digits.slice(2);
    if (digits.startsWith("1")) return digits.length === 11 && nanpValid(digits.slice(1)) ? ok(`+${digits}`) : fail("invalid_phone");
    return /^[2-9][0-9]{7,14}$/.test(digits) ? ok(`+${digits}`) : fail("invalid_phone");
  }
  if (digits.length === 10 && nanpValid(digits)) return ok(`+1${digits}`);
  if (digits.length === 11 && digits.startsWith("1") && nanpValid(digits.slice(1))) return ok(`+${digits}`);
  return fail("invalid_phone");
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};

export type DateOrder = "detect" | "MDY" | "DMY";

function isoDate(y: number, m: number, d: number): Norm<string> {
  if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return fail("invalid_date");
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return fail("invalid_date");
  return ok(`${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
}

function fullYear(y: string, pivot: number): number {
  if (y.length === 4) return Number(y);
  const n = Number(y);
  return n <= pivot ? 2000 + n : 1900 + n;
}

/**
 * Dates in mixed formats to ISO (YYYY-MM-DD): ISO, D/M/Y or M/D/Y with "/",
 * "-" or ".", "5-Jan-2026", "Jan 5, 2026", "5 January 2026", and Sheets
 * serial numbers (days since 1899-12-30). Day/month order is detected per
 * row (design B9): a part above 12 decides it; when both parts are 12 or
 * less and differ, the configured order breaks the tie, and with "detect"
 * the value goes to review as ambiguous. Two-digit years: <= pivot -> 20xx.
 */
export function parseDate(s: string | null | undefined, order: DateOrder = "detect", pivot = 30): Norm<string | null> {
  const v = clean(s).replace(/(?:[T ]\d{1,2}:\d{2}(?::\d{2})?(?:\s*[ap]\.?m\.?)?)$/i, "").trim();
  if (!v) return ok(null);
  let m: RegExpMatchArray | null;
  if ((m = v.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) return isoDate(Number(m[1]), Number(m[2]), Number(m[3]));
  if ((m = v.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/))) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const y = fullYear(m[3]!, pivot);
    if (a > 12 && b > 12) return fail("invalid_date");
    if (a > 12) return isoDate(y, b, a);
    if (b > 12) return isoDate(y, a, b);
    if (a === b) return isoDate(y, a, b);
    if (order === "MDY") return isoDate(y, a, b);
    if (order === "DMY") return isoDate(y, b, a);
    return fail("ambiguous_date");
  }
  if ((m = v.match(/^(\d{1,2})[\s-]+([a-z]{3,9})\.?[\s,-]+(\d{2}|\d{4})$/i))) {
    const mon = MONTHS[m[2]!.toLowerCase()];
    return mon ? isoDate(fullYear(m[3]!, pivot), mon, Number(m[1])) : fail("invalid_date");
  }
  if ((m = v.match(/^(?:[a-z]{3,9},?\s+)?([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/i))) {
    const mon = MONTHS[m[1]!.toLowerCase()];
    return mon ? isoDate(Number(m[3]), mon, Number(m[2])) : fail("invalid_date");
  }
  if ((m = v.match(/^(\d{5})(?:\.0+)?$/))) {
    const n = Number(m[1]);
    if (n < 1 || n > 80000) return fail("invalid_date");
    const dt = new Date(Date.UTC(1899, 11, 30) + n * 86_400_000);
    return isoDate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  }
  return fail("invalid_date");
}

/** "10:00 AM", "10am", "2:30 p.m.", "14:30", "10.30" -> "HH:MM" (24 h). */
export function parseTime(s: string | null | undefined): Norm<string | null> {
  const v = clean(s).toLowerCase().replace(/(\d)\.(\d)/g, "$1:$2").replace(/\./g, "").replace(/\s+/g, " ");
  if (!v) return ok(null);
  const m = v.match(/^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*(am|pm|a|p)?$/);
  if (!m) return fail("invalid_time");
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ap = m[3];
  if (!ap && !m[2]) return fail("invalid_time"); // "10" alone: no minutes, no am/pm
  if (min > 59) return fail("invalid_time");
  if (ap) {
    if (h < 1 || h > 12) return fail("invalid_time");
    if (ap.startsWith("p") && h !== 12) h += 12;
    if (ap.startsWith("a") && h === 12) h = 0;
  } else if (h > 23) return fail("invalid_time");
  return ok(`${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`);
}

/** True if the IANA time zone is known to this runtime. */
export function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Lookup key for status text and other mapped labels: lower case, single
 * spaces, no spaces around "/" or "-": "Active / All Teams" -> "active/all teams".
 */
export function labelKey(s: string | null | undefined): string {
  return clean(s).toLowerCase().replace(/\s*([/-])\s*/g, "$1");
}

/** Row colour as exported by the colour helper column: "#RRGGBB" lower case, or a colour name. */
export function normalizeColor(s: string | null | undefined): Norm<string | null> {
  const v = clean(s).toLowerCase();
  if (!v || v === "#ffffff" || v === "white" || v === "none") return ok(null);
  let m: RegExpMatchArray | null;
  if ((m = v.match(/^#?([0-9a-f]{6})$/))) return ok(`#${m[1]}`);
  if ((m = v.match(/^#?([0-9a-f])([0-9a-f])([0-9a-f])$/))) return ok(`#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}`);
  if (/^[a-z][a-z ]{1,30}$/.test(v)) return ok(v);
  return fail("invalid_row_color");
}

/** Mapped label lookup: placeholder entries are null (awaiting a product answer). */
export type Mapped<T> = { kind: "empty" } | { kind: "mapped"; value: T } | { kind: "placeholder" } | { kind: "unmapped" };
export function lookupLabel<T>(map: Record<string, T | null>, raw: string | null | undefined): Mapped<T> {
  const k = labelKey(raw);
  if (!k) return { kind: "empty" };
  if (!Object.prototype.hasOwnProperty.call(map, k)) return { kind: "unmapped" };
  const v = map[k];
  return v === null || v === undefined ? { kind: "placeholder" } : { kind: "mapped", value: v };
}

/** Hourly rate: "$65/hr", "65.00", "65 per hour". Annual or out-of-range values go to review. */
export function parseRate(s: string | null | undefined): Norm<number | null> {
  const v = clean(s).toLowerCase();
  if (!v) return ok(null);
  const m = v.match(/^\$?\s*(\d{1,4}(?:\.\d{1,2})?)\s*(?:usd)?\s*(?:\/\s*(?:hr|hour|h)|per\s+hour|ph|an hour)?$/);
  if (!m) return fail("invalid_rate");
  const n = Number(m[1]);
  if (!(n > 0 && n <= 1000)) return fail("invalid_rate");
  return ok(n);
}

const PLACEMENT_TYPES: Record<string, "c2c" | "w2" | "1099"> = {
  c2c: "c2c", "corp to corp": "c2c", "corp-to-corp": "c2c", "corp2corp": "c2c",
  w2: "w2", "w-2": "w2", "w 2": "w2", "1099": "1099",
};
export function normalizePlacementType(s: string | null | undefined): Norm<"c2c" | "w2" | "1099" | null> {
  const k = labelKey(s);
  if (!k) return ok(null);
  const t = PLACEMENT_TYPES[k];
  return t ? ok(t) : fail("invalid_placement_type");
}

const WORK_MODES: Record<string, "onsite" | "remote" | "hybrid"> = {
  onsite: "onsite", "on-site": "onsite", "on site": "onsite", office: "onsite", "in office": "onsite",
  remote: "remote", wfh: "remote", "work from home": "remote", hybrid: "hybrid",
};
export function normalizeWorkMode(s: string | null | undefined): Norm<"onsite" | "remote" | "hybrid" | null> {
  const k = labelKey(s);
  if (!k) return ok(null);
  const t = WORK_MODES[k];
  return t ? ok(t) : fail("invalid_work_mode");
}

const US_STATES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT",
  delaware: "DE", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI",
  minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY", "north carolina": "NC",
  "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI",
  "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
  "district of columbia": "DC",
};
const STATE_CODES = new Set(Object.values(US_STATES));
/** US state as its two-letter code; anything else goes to review. */
export function normalizeState(s: string | null | undefined): Norm<string | null> {
  const v = clean(s).replace(/\.$/, "");
  if (!v) return ok(null);
  if (/^[a-z]{2}$/i.test(v) && STATE_CODES.has(v.toUpperCase())) return ok(v.toUpperCase());
  const code = US_STATES[v.toLowerCase()];
  return code ? ok(code) : fail("invalid_state");
}

/** Free text such as a city or job title: cleaned, bounded, no control characters. */
export function normalizeText(s: string | null | undefined, max: number): Norm<string | null> {
  const v = clean(s);
  if (!v) return ok(null);
  return v.length > max ? fail("text_too_long") : ok(v);
}
