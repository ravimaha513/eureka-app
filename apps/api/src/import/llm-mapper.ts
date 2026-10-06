/**
 * LLM-assisted column mapping. People build their sheets from different
 * templates ("Cand. Name", "Mobile #", "Tech Stack"), so instead of one fixed
 * header list an LLM PROPOSES which header is which field; an admin confirms
 * it, and the confirmed result is an ordinary mapping file (mapping.ts), so
 * stage, review, digest and two-person approval are unchanged.
 *
 * Privacy (docs/import.md): the model never receives rows. It gets headers,
 * and per column up to SAMPLES values:
 *  - shape-masked ("Asha Rao" -> "Aaaa Aaa", "5/1/24" -> "9/9/99") by default;
 *  - raw only for columns that look like a small vocabulary (few distinct
 *    values, each repeated) and contain nothing email-, phone- or id-like.
 * Day/month order is detected locally from all rows, never by the model.
 * The model's answer is validated against the real headers and the field
 * catalog; anything it invents is dropped and reported, never applied.
 * Status and row-colour meanings are NOT proposed (SRS Q6: nothing is guessed).
 */
import { z } from "zod";
import { InterviewColumns, PlacementColumns, SalesColumns, SHEETS, parseMapping, type Sheet } from "./mapping.js";

const SAMPLES = 5;
const RAW_MAX_DISTINCT = 12;
const RAW_MIN_REPEAT = 3;
const CELL_MAX = 24;

const SCHEMAS = { sales: SalesColumns, interviews: InterviewColumns, placements: PlacementColumns } as const;

/** What each canonical field means, for the model. Keys must equal the mapping schema's (tested). */
export const FIELD_DOCS: Record<Sheet, Record<string, string>> = {
  sales: {
    firstName: "Candidate first name", lastName: "Candidate last name", fullName: "Single candidate name cell (use instead of first/last)",
    personalEmail: "Candidate personal email", marketingEmail: "Email used for marketing the candidate", phone: "Candidate phone",
    dob: "Date of birth", technology: "Primary technology / skill / stack", location: "Marketing or current location",
    owner: "Email of the recruiter (or lead) who owns the row", status: "Marketing status text", rowColor: "Row colour label column",
    priority: "Priority", marketingStartDate: "Date marketing started",
  },
  interviews: {
    firstName: "Candidate first name", lastName: "Candidate last name", fullName: "Candidate full name", email: "Candidate email",
    phone: "Candidate phone", dob: "Date of birth", owner: "Recruiter email", client: "End client", vendor: "Vendor / prime vendor",
    jobTitle: "Job title / role", round: "Interview round", date: "Interview date", startTime: "Interview start time",
    endTime: "Interview end time", durationMinutes: "Duration in minutes", timeZone: "Time zone", callStatus: "Interview/call status",
    rowColor: "Row colour label column",
  },
  placements: {
    firstName: "Candidate first name", lastName: "Candidate last name", fullName: "Candidate full name", email: "Candidate email",
    phone: "Candidate phone", dob: "Date of birth", owner: "Recruiter email", client: "End client", vendor: "Vendor",
    implementationPartner: "Implementation partner", jobTitle: "Job title / role", placementType: "Placement type (C2C, W2, FTE...)",
    rate: "Pay / bill rate", workMode: "Remote / hybrid / onsite", projectCity: "Project city", projectState: "Project state",
    tentativeStart: "Tentative or actual start date", status: "Placement status", statusReason: "Reason for status",
    rowColor: "Row colour label column",
  },
};

export function requiredFields(kind: Sheet): string[] {
  return Object.entries(SCHEMAS[kind].shape).filter(([, s]) => !s.isOptional()).map(([k]) => k);
}

export interface ColumnProfile {
  header: string;
  nonEmpty: number;
  distinct: number;
  /** "values": raw vocabulary column; "shape": masked. */
  sampleKind: "values" | "shape";
  samples: string[];
  /** Set only when all rows agree on one reading of slash/dash dates. */
  dateOrder?: "DMY" | "MDY";
}

/** Letters -> A/a, digits -> 9, other characters kept; runs over 3 are cut so length does not leak names. */
export function shapeMask(value: string): string {
  const s = value.trim().slice(0, CELL_MAX).replace(/[A-Z]/g, "A").replace(/[a-z]/g, "a").replace(/[0-9]/g, "9");
  return s.replace(/(.)\1{3,}/g, "$1$1$1");
}

const IDENTIFYING = /@|\d{7,}|\d{3}[-. )]+\d{3}[-. ]+\d{4}/;

/** Day/month order when every slash/dash date in the column proves the same one, else undefined (the default "detect" stays). */
export function detectDateOrder(values: string[]): "DMY" | "MDY" | undefined {
  let first13 = false, second13 = false, any = false;
  for (const v of values) {
    const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(v.trim());
    if (!m) continue;
    any = true;
    if (Number(m[1]) > 12) first13 = true;
    if (Number(m[2]) > 12) second13 = true;
  }
  if (!any || first13 === second13) return undefined;
  return first13 ? "DMY" : "MDY";
}

export function profileColumns(headers: string[], rows: string[][]): ColumnProfile[] {
  return headers.map((header, j) => {
    const col = rows.map((r) => (r[j] ?? "").trim()).filter((v) => v !== "");
    const counts = new Map<string, number>();
    for (const v of col) counts.set(v, (counts.get(v) ?? 0) + 1);
    const vocabulary = counts.size > 0 && counts.size <= RAW_MAX_DISTINCT
      && col.length >= RAW_MIN_REPEAT * counts.size
      && col.every((v) => v.length <= 40 && !IDENTIFYING.test(v));
    const samples = vocabulary
      ? [...counts.keys()].slice(0, RAW_MAX_DISTINCT)
      : [...counts.keys()].slice(0, SAMPLES).map(shapeMask);
    const dateOrder = detectDateOrder(col);
    return { header, nonEmpty: col.length, distinct: counts.size, sampleKind: vocabulary ? "values" : "shape", samples, ...(dateOrder ? { dateOrder } : {}) };
  });
}

export const Proposal = z.object({
  sheetKind: z.enum([...SHEETS, "unknown"]),
  kindConfidence: z.number().min(0).max(1),
  columns: z.array(z.object({ field: z.string(), header: z.string().nullable(), confidence: z.number().min(0).max(1) })).max(60),
  notes: z.array(z.string().max(300)).max(10).default([]),
});

export interface MappingProposal {
  kind: Sheet | "unknown";
  kindConfidence: number;
  columns: Record<string, string>;
  confidence: Record<string, number>;
  dateOrders: Record<string, "DMY" | "MDY">;
  /** Required fields (or a name) with no header; the sheet cannot be staged until these are mapped by hand. */
  missing: string[];
  /** Headers no field uses (extra template columns, ignored by the import). */
  unmapped: string[];
  /** Model answers dropped because they named an unknown field or header, or reused a header. */
  rejected: { field: string; header: string | null; reason: string }[];
  notes: string[];
}

/** Provider seam: tests and other providers implement this; the answer is validated by proposeMapping. */
export interface LlmClient {
  callTool(req: { system: string; user: string; toolName: string; inputSchema: Record<string, unknown> }): Promise<unknown>;
}

const TOOL = "propose_mapping";
const INPUT_SCHEMA = {
  type: "object",
  properties: {
    sheetKind: { type: "string", enum: [...SHEETS, "unknown"] },
    kindConfidence: { type: "number", minimum: 0, maximum: 1 },
    columns: {
      type: "array",
      description: "One entry per canonical field you can place. header must be copied exactly from the header list, or null when absent.",
      items: {
        type: "object",
        properties: { field: { type: "string" }, header: { type: ["string", "null"] }, confidence: { type: "number", minimum: 0, maximum: 1 } },
        required: ["field", "header", "confidence"],
      },
    },
    notes: { type: "array", items: { type: "string" } },
  },
  required: ["sheetKind", "kindConfidence", "columns"],
};

const SYSTEM = [
  "You map spreadsheet columns to the canonical fields of a recruiting-operations import.",
  "You see column headers and a few masked samples per column. Masked samples use A/a for letters and 9 for digits;",
  "columns marked values show real vocabulary values. Never ask for data; decide from headers and shapes.",
  "Use each header at most once. If a field has no clear column, leave it out (do not guess).",
  "Copy headers exactly as given. Call the propose_mapping tool once.",
].join(" ");

export function buildPrompt(kind: Sheet | undefined, headers: string[], profiles: ColumnProfile[]): string {
  const kinds = kind ? [kind] : [...SHEETS];
  const catalog = kinds.map((k) => `Sheet kind "${k}" fields:\n${Object.entries(FIELD_DOCS[k]).map(([f, d]) => `- ${f}: ${d}`).join("\n")}`).join("\n\n");
  const cols = profiles.map((p) => `- ${JSON.stringify(p.header)} (${p.nonEmpty} filled, ${p.distinct} distinct) ${p.sampleKind}: ${JSON.stringify(p.samples)}`).join("\n");
  return `${kind ? `The sheet is a "${kind}" sheet.` : `Decide whether this is a ${SHEETS.join(", ")} sheet, or unknown.`}\n\n${catalog}\n\nHeaders (${headers.length}):\n${cols}`;
}

export async function proposeMapping(
  llm: LlmClient, table: { headers: string[]; rows: string[][] }, opts: { kind?: Sheet } = {},
): Promise<MappingProposal> {
  const profiles = profileColumns(table.headers, table.rows);
  const raw = await llm.callTool({
    system: SYSTEM, user: buildPrompt(opts.kind, table.headers, profiles), toolName: TOOL, inputSchema: INPUT_SCHEMA,
  });
  const parsed = Proposal.safeParse(raw);
  if (!parsed.success) throw new Error(`LLM answer did not match the expected shape: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  const p = parsed.data;
  const kind = opts.kind ?? p.sheetKind;
  const out: MappingProposal = {
    kind, kindConfidence: opts.kind ? 1 : p.kindConfidence, columns: {}, confidence: {}, dateOrders: {},
    missing: [], unmapped: [], rejected: [], notes: p.notes,
  };
  if (kind === "unknown") return out;

  const headerSet = new Set(table.headers.filter((h) => h !== ""));
  const owner = new Map<string, string>(); // header -> field that holds it
  // Highest confidence first so a clash keeps the better claim.
  for (const c of [...p.columns].sort((a, b) => b.confidence - a.confidence)) {
    if (c.header === null) continue;
    if (!(c.field in FIELD_DOCS[kind])) { out.rejected.push({ field: c.field, header: c.header, reason: "unknown field" }); continue; }
    if (!headerSet.has(c.header)) { out.rejected.push({ field: c.field, header: c.header, reason: "header not in sheet" }); continue; }
    if (c.field in out.columns) { out.rejected.push({ field: c.field, header: c.header, reason: "field already mapped" }); continue; }
    if (owner.has(c.header)) { out.rejected.push({ field: c.field, header: c.header, reason: `header already used for ${owner.get(c.header)}` }); continue; }
    out.columns[c.field] = c.header;
    out.confidence[c.field] = c.confidence;
    owner.set(c.header, c.field);
  }
  // fullName and first+last are alternatives: keep the pair the model was surer of, never both.
  if (out.columns.fullName && out.columns.firstName && out.columns.lastName) {
    const pair = Math.min(out.confidence.firstName!, out.confidence.lastName!);
    const drop = out.confidence.fullName! >= pair ? ["firstName", "lastName"] : ["fullName"];
    for (const f of drop) { out.rejected.push({ field: f, header: out.columns[f]!, reason: "name given twice" }); delete out.columns[f]; delete out.confidence[f]; }
  }
  for (const f of requiredFields(kind)) if (!out.columns[f]) out.missing.push(f);
  if (!out.columns.fullName && !(out.columns.firstName && out.columns.lastName)) out.missing.push("name (fullName, or firstName and lastName)");
  out.unmapped = table.headers.filter((h) => h !== "" && !owner.has(h));
  for (const p2 of profiles) {
    const field = owner.get(p2.header);
    if (field && p2.dateOrder && /date|dob|start/i.test(field)) out.dateOrders[field] = p2.dateOrder;
  }
  return out;
}

/**
 * Proposal merged into a base mapping (the default mapping file's JSON) as a
 * new mapping JSON for `stage --mapping`. Parsed through parseMapping, so
 * anything the real loader would refuse (e.g. a sheet still missing required
 * columns) is refused here too. Status labels stay as the base has them.
 */
export function applyProposal(base: unknown, proposal: MappingProposal): unknown {
  if (proposal.kind === "unknown") throw new Error("Sheet kind is unknown; choose sales, interviews or placements");
  const next = structuredClone(base) as { sheets: Record<string, { columns: Record<string, string>; dateOrders: Record<string, string> }> };
  next.sheets[proposal.kind] = { columns: { ...proposal.columns }, dateOrders: { ...proposal.dateOrders } };
  parseMapping(next);
  return next;
}

export interface AnthropicOptions { apiKey: string; model?: string; baseUrl?: string; fetchFn?: typeof fetch; timeoutMs?: number }

/** Messages API with a forced tool call, so the answer is structured JSON. No SDK: one request, no new dependency. */
export class AnthropicClient implements LlmClient {
  constructor(private readonly o: AnthropicOptions) {
    if (!o.apiKey) throw new Error("ANTHROPIC_API_KEY is required for LLM mapping");
  }
  async callTool(req: Parameters<LlmClient["callTool"]>[0]): Promise<unknown> {
    const res = await (this.o.fetchFn ?? fetch)(`${this.o.baseUrl ?? "https://api.anthropic.com"}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": this.o.apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: this.o.model ?? "claude-sonnet-5-5",
        max_tokens: 2000,
        system: req.system,
        messages: [{ role: "user", content: req.user }],
        tools: [{ name: req.toolName, description: "Report the column mapping.", input_schema: req.inputSchema }],
        tool_choice: { type: "tool", name: req.toolName },
      }),
      signal: AbortSignal.timeout(this.o.timeoutMs ?? 60_000),
    });
    // Never echo the body: it can quote the prompt.
    if (!res.ok) throw new Error(`Anthropic API returned ${res.status}`);
    const body = (await res.json()) as { content?: { type: string; name?: string; input?: unknown }[] };
    const block = body.content?.find((b) => b.type === "tool_use" && b.name === req.toolName);
    if (!block) throw new Error("Anthropic API answered without the mapping tool call");
    return block.input;
  }
}
