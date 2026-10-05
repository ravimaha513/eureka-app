/**
 * iCalendar (RFC 5545) file for one scheduled interview (IS-7). Text values
 * are escaped (backslash, semicolon, comma, newlines), control characters
 * dropped and lines folded at 75 octets. Attendees are the panel's work
 * emails only; nothing else in the file names an email address.
 */
import { INTERVIEW_TYPE_LABELS, type InterviewType } from "@eureka/shared";

export interface IcsInput {
  id: string;
  round: string;
  candidateName: string | null;
  startsAt: Date;
  endsAt: Date;
  interviewType: string | null;
  meetingUrl: string | null;
  updatedAt: Date;
  attendees: { name: string; email: string; lead: boolean }[];
}

/** UTC basic format: 20300107T140000Z. */
export const icsTime = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** TEXT value escaping (RFC 5545 3.3.11); control characters other than newline are dropped. */
export function icsText(v: string): string {
  return v
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

/** Parameter value (CN): quoted, without quotes or control characters. */
const icsParam = (v: string) => `"${v.replace(/["\u0000-\u001f\u007f]/g, "")}"`;

/** Folds a content line at 75 octets without splitting a UTF-8 sequence. */
export function foldLine(line: string): string {
  const out: string[] = [];
  let cur = "";
  let bytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    const limit = out.length === 0 ? 75 : 74; // continuation lines start with a space
    if (bytes + n > limit) { out.push(cur); cur = ""; bytes = 0; }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join("\r\n ");
}

/** Only plain https links without whitespace become URL/LOCATION values. */
const safeUrl = (u: string | null) => (u && /^https:\/\/[^\s]+$/.test(u) ? u : null);
/** mailto addresses: a conservative shape check, anything else is left out. */
const safeEmail = (e: string) => /^[^\s"<>(),;:\\@]+@[^\s"<>(),;:\\@]+$/.test(e);

export function interviewIcs(i: IcsInput, now = new Date()): string {
  const type = i.interviewType ? INTERVIEW_TYPE_LABELS[i.interviewType as InterviewType] ?? null : null;
  const url = safeUrl(i.meetingUrl);
  const summary = `Interview: ${i.round}${i.candidateName ? ` with ${i.candidateName}` : ""}`;
  const description = [`Round: ${i.round}`, type ? `Type: ${type}` : null, url ? `Meeting link: ${url}` : null]
    .filter((x): x is string => x !== null).join("\n");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Eureka//Interviews//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:interview-${i.id}@eureka`,
    `DTSTAMP:${icsTime(now)}`,
    `LAST-MODIFIED:${icsTime(i.updatedAt)}`,
    `DTSTART:${icsTime(i.startsAt)}`,
    `DTEND:${icsTime(i.endsAt)}`,
    `SUMMARY:${icsText(summary)}`,
    `DESCRIPTION:${icsText(description)}`,
    ...(url ? [`LOCATION:${icsText(url)}`, `URL:${url}`] : type ? [`LOCATION:${icsText(type)}`] : []),
    ...i.attendees.filter((a) => safeEmail(a.email)).map((a) =>
      `ATTENDEE;CN=${icsParam(a.name)};ROLE=${a.lead ? "CHAIR" : "REQ-PARTICIPANT"}:mailto:${a.email}`),
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}
