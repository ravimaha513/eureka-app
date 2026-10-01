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
export function nameKey(first: string, last: string): string | null {
  // Unicode-aware: Devanagari, Tamil, Arabic... keep their letters (a Latin-only
  // key would collapse every such name to "|" and match them all).
  const k = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const a = k(first);
  const b = k(last);
  return a && b ? `${a}|${b}` : null;
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

/**
 * Assigned North American area codes (US, Canada and the +1 Caribbean). A
 * 10-digit number whose area code is not here (for example an Indian mobile
 * number typed without +91) is not guessed to be American.
 */
const NANP_AREA_CODES = new Set(`
201 202 203 204 205 206 207 208 209 210 212 213 214 215 216 217 218 219 220 223 224 225 226 227 228 229 231 234 236 239
240 242 246 248 249 250 251 252 253 254 256 257 260 262 263 264 267 268 269 270 272 274 276 279 281 283 284 289
301 302 303 304 305 306 307 308 309 310 312 313 314 315 316 317 318 319 320 321 323 325 326 327 330 331 332 334 336 337
339 340 341 343 345 346 347 350 351 352 354 360 361 363 364 365 367 368 380 382 385 386
401 402 403 404 405 406 407 408 409 410 412 413 414 415 416 417 418 419 423 424 425 428 430 431 432 434 435 437 438 440
441 442 443 445 447 448 450 458 463 464 468 469 470 472 473 474 475 478 479 480 484
501 502 503 504 505 506 507 508 509 510 512 513 514 515 516 517 518 519 520 530 531 534 539 540 541 548 551 557 559 561
562 563 564 567 570 571 572 573 574 575 579 580 581 582 584 585 586 587
601 602 603 604 605 606 607 608 609 610 612 613 614 615 616 617 618 619 620 623 626 628 629 630 631 636 639 640 641 645
646 647 649 650 651 656 657 658 659 660 661 662 664 667 669 670 671 672 678 680 681 682 683 684 686 689
701 702 703 704 705 706 707 708 709 712 713 714 715 716 717 718 719 720 721 724 725 726 727 728 730 731 732 734 737 740
742 743 747 753 754 757 758 760 762 763 765 767 769 770 771 772 773 774 775 778 779 780 781 782 784 785 786 787
801 802 803 804 805 806 807 808 809 810 812 813 814 815 816 817 818 819 820 825 826 828 829 830 831 832 835 838 839 840
843 845 847 848 849 850 854 856 857 858 859 860 861 862 863 864 865 867 868 869 870 872 873 876 878 879
901 902 903 904 905 906 907 908 909 910 912 913 914 915 916 917 918 919 920 925 928 929 930 931 934 936 937 938 939 940
941 942 943 945 947 948 949 951 952 954 956 959 970 971 972 973 975 978 979 980 983 984 985 986 989
`.trim().split(/\s+/));

function nanpValid(ten: string): boolean {
  // Assigned area code; exchange starts 2-9 (North American Numbering Plan).
  return /^[2-9][0-9]{2}[2-9][0-9]{6}$/.test(ten) && NANP_AREA_CODES.has(ten.slice(0, 3));
}

/** Countries whose national trunk prefix 0 must not follow the country code. */
const TRUNK_ZERO = ["44", "91", "61", "49", "33", "353", "64", "27", "92", "880", "234", "254"];

function international(digits: string): Norm<string> {
  if (digits.startsWith("1")) return digits.length === 11 && nanpValid(digits.slice(1)) ? ok(`+${digits}`) : fail("invalid_phone");
  if (TRUNK_ZERO.some((cc) => digits.startsWith(`${cc}0`))) return fail("invalid_phone");
  return /^[2-9][0-9]{7,14}$/.test(digits) ? ok(`+${digits}`) : fail("invalid_phone");
}

/**
 * E.164. With region "US", 10 digits (or 11 starting with 1) with an
 * assigned area code are +1. Other countries need an explicit "+" or "00"
 * prefix, without the national trunk 0 ("+44 (0)20 ..." goes to review).
 * With no region every number needs its country code. Extensions are dropped.
 */
export function normalizePhone(s: string | null | undefined, region: "US" | null = "US"): Norm<string | null> {
  let v = clean(s);
  if (!v) return ok(null);
  v = v.replace(/\s*(?:ext\.?|extension|x|#)\s*\d{1,6}$/i, "");
  if (/[^0-9+().\-\s/]/.test(v)) return fail("invalid_phone");
  const plus = v.startsWith("+");
  if (v.indexOf("+") > 0 || (v.match(/\+/g) ?? []).length > 1) return fail("invalid_phone");
  const digits = v.replace(/[^0-9]/g, "");
  if (plus) return international(digits);
  if (digits.startsWith("00")) return international(digits.slice(2));
  if (region !== "US") return fail("phone_needs_country_code");
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
 * row (design B9): with "detect" a part above 12 decides it and a value with
 * both parts 12 or less (and different) goes to review as ambiguous. A column
 * configured as "MDY" or "DMY" resolves those, and a value contradicting it
 * goes to review as date_order_conflict. Two-digit years: <= pivot -> 20xx.
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
    // A configured column order is checked, not overridden, by the value.
    if (a > 12) return order === "MDY" ? fail("date_order_conflict") : isoDate(y, b, a);
    if (b > 12) return order === "DMY" ? fail("date_order_conflict") : isoDate(y, a, b);
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

/** A date of birth is plausible for a candidate aged 16 to 80 on `today` (ISO). */
export function plausibleDob(iso: string, today: string): boolean {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const [ty, tm, td] = today.split("-").map(Number) as [number, number, number];
  const age = ty - y - (tm < m || (tm === m && td < d) ? 1 : 0);
  return age >= 16 && age <= 80;
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
