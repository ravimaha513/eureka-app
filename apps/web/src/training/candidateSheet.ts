import { readUserSheet } from "../admin/xlsx";
import type { BulkCandidateRow } from "./trainingApi";

/** Headers of the batch candidates template (apps/api/.../candidate-import-template.ts), lower-case. */
const HEADERS: Record<string, keyof BulkCandidateRow> = {
  "first name": "firstName",
  "last name": "lastName",
  phone: "phone",
  "personal email": "email",
  email: "email",
};

/** The file's rows; blank rows are skipped. Throws a message for the user when the columns are wrong. */
export async function readCandidateSheet(file: File): Promise<BulkCandidateRow[]> {
  const table = await readUserSheet(file, "Candidates");
  const [head, ...body] = table.filter((r) => r.some((c) => c.trim() !== ""));
  if (!head) throw new Error("The file is empty.");
  const cols = head.map((h) => HEADERS[h.trim().toLowerCase()]);
  if (["firstName", "lastName", "phone", "email"].some((k) => !cols.includes(k as keyof BulkCandidateRow))) {
    throw new Error("The first row must be a header with the columns First Name, Last Name, Phone and Personal Email. Use the template.");
  }
  return body.map((cells) => {
    const r: BulkCandidateRow = { firstName: "", lastName: "", phone: "", email: "" };
    cols.forEach((key, i) => { if (key) r[key] = (cells[i] ?? "").trim(); });
    return r;
  });
}
