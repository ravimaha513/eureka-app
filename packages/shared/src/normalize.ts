/**
 * Contact normalization shared by the web app and the API (design A6.3: phones
 * are stored as E.164; the duplicate check compares normalized values).
 */

/** E.164: "+", a non-zero country code digit, 8 to 15 digits in all. */
export const E164_RE = /^\+[1-9][0-9]{7,14}$/;

/**
 * Country codes whose national numbers use a trunk prefix "0" that is dropped
 * in international format and never starts the national significant number.
 * A "0" right after one of these codes is a typing mistake ("+91 098765 43210").
 * Countries where an international number can start with 0 (Italy +39, Côte
 * d'Ivoire +225, ...) are deliberately not listed. E.164 codes are prefix-free,
 * so a prefix match is unambiguous.
 */
export const TRUNK_ZERO_COUNTRY_CODES: readonly string[] = [
  "20", "27", "31", "32", "33", "34", "36", "41", "43", "44", "46", "47", "48", "49",
  "60", "61", "62", "63", "64", "66", "81", "82", "84", "86", "90", "91", "92", "94",
  "234", "254", "353", "880", "966", "971", "977",
];

/** "00" becomes "+", a bracketed "(0)" after the country code goes ("+44 (0)20 ..."), then formatting. */
function clean(input: string): string {
  let s = input.trim();
  if (s.startsWith("00")) s = `+${s.slice(2)}`;
  s = s.replace(/^(\+\d{1,3})[\s.-]*\(0\)/, "$1");
  return s.replace(/[\s().-]/g, "");
}

export type PhoneProblem = "missing_country_code" | "trunk_zero" | "invalid";

/** Why a typed phone number cannot be normalized, or null when it can. */
export function phoneProblem(input: string): PhoneProblem | null {
  const s = clean(input);
  if (!s.startsWith("+")) return /^\d{6,}$/.test(s) ? "missing_country_code" : "invalid";
  if (!E164_RE.test(s)) return "invalid";
  const digits = s.slice(1);
  if (TRUNK_ZERO_COUNTRY_CODES.some((cc) => digits.startsWith(`${cc}0`))) return "trunk_zero";
  return null;
}

/** User-facing explanation for a phone problem. */
export const PHONE_PROBLEM_MESSAGES: Record<PhoneProblem, string> = {
  missing_country_code: "Include the country code, e.g. +1 469 555 0142 or +91 98765 43210.",
  trunk_zero: "Leave out the national 0 after the country code, e.g. +91 98765 43210, not +91 098765 43210.",
  invalid: "Enter a phone number in international format, e.g. +1 469 555 0142.",
};

/**
 * Normalizes a typed phone number to E.164, or returns null when it cannot be
 * normalized unambiguously (see phoneProblem for why). Spaces, dashes, dots
 * and parentheses are dropped, a leading "00" becomes "+" and a bracketed
 * "(0)" after the country code is removed. The country code is required: a
 * bare 10-digit number could be a US or an Indian number, so it is refused
 * rather than guessed. A "0" right after a trunk-prefix country code is
 * refused too, rather than silently dropped.
 */
export function normalizePhoneE164(input: string): string | null {
  return phoneProblem(input) === null ? clean(input) : null;
}

/** Trimmed, lower-case email (the duplicate check compares case-insensitively). */
export function normalizeEmail(input: string): string {
  return input.trim().toLowerCase();
}
