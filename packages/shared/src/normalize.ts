/**
 * Contact normalization shared by the web app and the API (design A6.3: phones
 * are stored as E.164; the duplicate check compares normalized values).
 */

/** E.164: "+", a non-zero country code digit, 8 to 15 digits in all. */
export const E164_RE = /^\+[1-9][0-9]{7,14}$/;

/**
 * Normalizes a typed phone number to E.164, or returns null when it cannot be
 * normalized unambiguously. Spaces, dashes, dots and parentheses are dropped
 * and a leading "00" becomes "+". The country code is required: a bare
 * 10-digit number could be a US or an Indian number, so it is refused rather
 * than guessed.
 */
export function normalizePhoneE164(input: string): string | null {
  let s = input.trim().replace(/[\s().-]/g, "");
  if (s.startsWith("00")) s = `+${s.slice(2)}`;
  return E164_RE.test(s) ? s : null;
}

/** Trimmed, lower-case email (the duplicate check compares case-insensitively). */
export function normalizeEmail(input: string): string {
  return input.trim().toLowerCase();
}
