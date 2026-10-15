/** Staff birthdays (interview-alerts package, migration 0087): month and day only, never the year. */
export interface Birthday { month: number; day: number }

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** A real calendar day (29 February allowed: it is celebrated on 28 February in other years). */
export function isValidBirthday(b: { month: number; day: number }): boolean {
  return Number.isInteger(b.month) && Number.isInteger(b.day) && b.month >= 1 && b.month <= 12
    && b.day >= 1 && b.day <= (DAYS_IN_MONTH[b.month - 1] ?? 0);
}

export const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "14 March" */
export function formatBirthday(b: Birthday | null | undefined): string {
  return b ? `${b.day} ${MONTH_NAMES[b.month - 1]}` : "";
}
