import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PHONE_PROBLEM_MESSAGES, normalizePhoneE164, phoneProblem } from "@eureka/shared";
import { ApiError } from "../api";
import { DialogActions } from "../ui/Dialog";
import { LookupPicker, useLookups, type Named } from "../lookups";
import { fieldErrors, salesError, UUID_RE } from "./errors";
import { OPEN_BATCH_STATUSES, salesApi, salesKeys, type CreateCandidate } from "./salesApi";
import { useCreateTeam } from "./useCreateTeam";
import { Field } from "./ui";

/**
 * Rows per run. Every add runs the duplicate check, which allows 20 per user
 * per minute (DUPLICATE_CHECKS_PER_MINUTE, design N11); more would be refused.
 */
export const MAX_BULK_ROWS = 20;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FIELDS = ["firstName", "lastName", "phone", "email", "technologyId", "locationId", "batchId", "teamId"] as const;

interface Row {
  key: number;
  firstName: string; lastName: string; phone: string; email: string;
  /** "" = the default chosen above the table. */
  technologyId: string; locationId: string;
  error?: string;
}
type RowField = "firstName" | "lastName" | "phone" | "email" | "technologyId" | "locationId";

let nextKey = 1;
const blankRow = (): Row => ({ key: nextKey++, firstName: "", lastName: "", phone: "", email: "", technologyId: "", locationId: "" });
const isBlank = (r: Row) => !r.firstName.trim() && !r.lastName.trim() && !r.phone.trim() && !r.email.trim();

/** Splits one CSV line, honouring double quotes ("a, b" and "" escapes). */
function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Lines pasted from a spreadsheet (tab-separated) or a CSV file: First name,
 * Last name, Phone, Email, then optionally Technology and Location by name.
 * A header row (first cell mentioning "first" or "name") is skipped.
 */
export function parseRows(text: string, lookups: { technologies: Named[]; locations: Named[] }): Row[] {
  const byName = (list: Named[], name: string) => list.find((x) => x.name.toLowerCase() === name.trim().toLowerCase())?.id;
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  return lines.flatMap((line, i) => {
    const cells = (line.includes("\t") ? line.split("\t") : splitCsv(line)).map((c) => c.trim());
    if (i === 0 && /first|name/i.test(cells[0] ?? "") && !/@/.test(line)) return [];
    const [firstName = "", lastName = "", phone = "", email = "", tech = "", loc = ""] = cells;
    const technologyId = tech ? byName(lookups.technologies, tech) ?? "" : "";
    const locationId = loc ? byName(lookups.locations, loc) ?? "" : "";
    const unknown = [tech && !technologyId && `technology “${tech}”`, loc && !locationId && `location “${loc}”`].filter(Boolean);
    return [{
      ...blankRow(), firstName, lastName, phone, email, technologyId, locationId,
      ...(unknown.length ? { error: `Unknown ${unknown.join(" and ")}: choose from the list.` } : {}),
    }];
  });
}

/**
 * New candidate, several at once: one team and batch (and a default
 * technology and location) for every row, rows typed in or pasted from a
 * spreadsheet / CSV. Each row is POST /api/v1/candidates in turn, so the server
 * applies the same checks as a single add (CA-6 unique contact, team scope,
 * batch location). Rows that went through leave the table; the rest stay with
 * their reason.
 */
export function BulkCandidatesForm({ locations, canAddTechnology, onCancel, onCreated }: {
  locations: Named[]; canAddTechnology: boolean; onCancel: () => void;
  onCreated: (count: number, done: boolean) => void;
}) {
  const lookups = useLookups();
  const techs = lookups.data?.technologies ?? [];
  const locs = lookups.data?.locations?.length ? lookups.data.locations : locations;
  const team = useCreateTeam();
  const [defaults, setDefaults] = useState({ technologyId: "", locationId: "", batchId: "" });
  const [rows, setRows] = useState<Row[]>(() => [blankRow(), blankRow(), blankRow()]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState("");
  const formRef = useRef<HTMLFormElement>(null);

  const batches = useQuery({ queryKey: salesKeys.batches, queryFn: () => salesApi.batches(), staleTime: 0 });
  const openBatches = (batches.data?.items ?? []).filter((b) => OPEN_BATCH_STATUSES.includes(b.status)
    && (!defaults.locationId || b.location.id === defaults.locationId));
  const batch = openBatches.find((b) => b.id === defaults.batchId);
  const pickBatch = (batchId: string) => {
    const b = openBatches.find((x) => x.id === batchId);
    setDefaults((s) => ({ ...s, batchId, ...(b ? { locationId: b.location.id, technologyId: s.technologyId || b.technology.id } : {}) }));
  };

  const setCell = (key: number, f: RowField, value: string) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, [f]: value, error: undefined } : r)));
  const addRows = (more: Row[]) => {
    const kept = rows.filter((r) => !isBlank(r));
    const room = MAX_BULK_ROWS - kept.length;
    const next = [...kept, ...more.slice(0, Math.max(room, 0))];
    setRows(next.length ? next : [blankRow()]);
    setNote(more.length > room ? `Only ${MAX_BULK_ROWS} candidates at a time: ${more.length - Math.max(room, 0)} left out. Add them after this run.` : "");
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) setPasted(await f.text());
    e.target.value = "";
  };
  const applyPaste = () => {
    const parsed = parseRows(pasted, { technologies: techs, locations: locs });
    if (!parsed.length) { setNote("Nothing to add: paste one candidate per line."); return; }
    addRows(parsed);
    setPasted(""); setPasting(false);
  };

  const effective = (r: Row) => ({ technologyId: r.technologyId || defaults.technologyId, locationId: r.locationId || defaults.locationId });

  /** Row problems found before sending (blank rows are ignored). */
  const check = (filled: Row[]): Row[] => {
    const seen = new Map<string, number>();
    return filled.map((r, i) => {
      const problems: string[] = [];
      if (!r.firstName.trim()) problems.push("first name");
      if (!r.lastName.trim()) problems.push("last name");
      const pp = r.phone.trim() ? phoneProblem(r.phone) : "missing";
      if (!r.email.trim() || !EMAIL.test(r.email.trim())) problems.push("a valid email");
      const eff = effective(r);
      if (!UUID_RE.test(eff.technologyId)) problems.push("technology");
      if (!UUID_RE.test(eff.locationId)) problems.push("location");
      let error = problems.length ? `Needs ${problems.join(", ")}.` : undefined;
      if (pp) error = [pp === "missing" ? "Enter a phone number." : PHONE_PROBLEM_MESSAGES[pp], error].filter(Boolean).join(" ");
      for (const [kind, v] of [["phone", pp ? "" : normalizePhoneE164(r.phone) ?? ""], ["email", r.email.trim().toLowerCase()]] as const) {
        if (!v) continue;
        const prev = seen.get(`${kind}:${v}`);
        if (prev !== undefined) error = [error, `Same ${kind} as row ${prev + 1}.`].filter(Boolean).join(" ");
        else seen.set(`${kind}:${v}`, i);
      }
      if (!error && batch && eff.locationId !== batch.location.id) error = `The batch is at ${batch.location.name}; this row's location differs.`;
      return { ...r, error };
    });
  };

  const rowError = (err: unknown): string => {
    if (err instanceof ApiError && err.status === 409 && err.detail === "duplicate_contact") {
      return "Already a candidate with this email or phone.";
    }
    const fe = fieldErrors(err, FIELDS);
    const { _form, ...perField } = fe;
    const parts = Object.values(perField);
    if (_form) parts.push(_form);
    return parts.length ? parts.join(" ") : salesError(err, "create");
  };

  const submit = async (ev: React.FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    setFormError(""); setNote("");
    const e: Record<string, string> = {};
    if (team.problem) e.teamId = team.problem;
    setErrors(e);
    const filled = rows.filter((r) => !isBlank(r));
    if (!filled.length) {
      setFormError("Add at least one candidate.");
      return;
    }
    const checked = check(filled);
    setRows(checked);
    if (e.teamId || checked.some((r) => r.error)) {
      setFormError("Some rows need attention.");
      requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>("[aria-invalid='true']")?.focus());
      return;
    }

    setBusy(true);
    let created = 0;
    const left: Row[] = [];
    let stopped = false;
    for (const r of checked) {
      if (stopped) { left.push({ ...r, error: "Not sent: too many adds in a minute. Try again shortly." }); continue; }
      const eff = effective(r);
      const body: CreateCandidate = {
        firstName: r.firstName.trim(), lastName: r.lastName.trim(),
        phone: normalizePhoneE164(r.phone)!, email: r.email.trim(),
        technologyId: eff.technologyId, locationId: eff.locationId,
        ...(batch ? { batchId: batch.id } : {}),
        ...(team.teamId ? { teamId: team.teamId } : {}),
      };
      try {
        await salesApi.create(body);
        created++;
      } catch (err) {
        if (err instanceof ApiError && err.status === 429) {
          stopped = true;
          left.push({ ...r, error: "Not sent: too many adds in a minute. Try again shortly." });
          continue;
        }
        // Team scope or permission refusals apply to every row: stop there.
        if (err instanceof ApiError && (err.status === 403 || err.status === 401)) {
          setFormError(salesError(err, "create"));
          left.push(r, ...checked.slice(checked.indexOf(r) + 1));
          break;
        }
        left.push({ ...r, error: rowError(err) });
      }
    }
    setBusy(false);
    if (created) onCreated(created, left.length === 0);
    if (left.length) {
      setRows(left);
      setFormError((f) => f || `${created ? `${created} added. ` : ""}${left.length} ${left.length === 1 ? "row needs" : "rows need"} attention.`);
      requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>(".formerr")?.focus());
    }
  };

  const filledCount = rows.filter((r) => !isBlank(r)).length;
  const cell = (r: Row, i: number, f: "firstName" | "lastName" | "phone" | "email", label: string, type = "text") => (
    <td>
      <input type={type} autoComplete="off" aria-label={`${label}, row ${i + 1}`} value={r[f]}
        aria-invalid={r.error ? true : undefined} aria-describedby={r.error ? `bulk-err-${r.key}` : undefined}
        onChange={(e) => setCell(r.key, f, e.target.value)} />
    </td>
  );
  const pick = (r: Row, i: number, f: "technologyId" | "locationId", label: string, list: Named[], fallback: string) => (
    <td>
      <select aria-label={`${label}, row ${i + 1}`} value={r[f]} onChange={(e) => setCell(r.key, f, e.target.value)}>
        <option value="">{fallback ? `Default (${fallback})` : "Default"}</option>
        {list.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
      </select>
    </td>
  );
  const techName = techs.find((t) => t.id === defaults.technologyId)?.name ?? "";
  const locName = locs.find((l) => l.id === defaults.locationId)?.name ?? "";

  return (
    <form ref={formRef} onSubmit={submit} noValidate>
      {team.field(errors.teamId)}
      <div className="grid2">
        <LookupPicker kind="technologies" label="Technology" value={defaults.technologyId} canAdd={canAddTechnology}
          placeholder="Choose per row…" onChange={(id) => setDefaults((s) => ({ ...s, technologyId: id }))} />
        <LookupPicker kind="locations" label="Location" value={defaults.locationId} fallback={locations}
          placeholder="Choose per row…" onChange={(id) => setDefaults((s) => ({ ...s, locationId: id, batchId: "" }))} />
      </div>
      <Field label="Batch (optional)" hint={batch ? `Every row joins this batch; rows must be at ${batch.location.name}.` : "Choosing a batch also fills in its location."}>
        {(p) => (
          <select {...p} value={defaults.batchId} onChange={(e) => pickBatch(e.target.value)}>
            <option value="">No batch</option>
            {openBatches.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
          </select>
        )}
      </Field>
      <p className="hint">Technology and location above apply to every row left on “Default”. Up to {MAX_BULK_ROWS} candidates at a time; phone and email must be unique.</p>

      <div className="bulkrows-wrap">
        <table className="mini bulkrows">
          <thead>
            <tr><th>#</th><th>First name</th><th>Last name</th><th>Phone</th><th>Personal email</th><th>Technology</th><th>Location</th><th><span className="sr-only">Remove</span></th></tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <RowView key={r.key} r={r} i={i}>
                {cell(r, i, "firstName", "First name")}
                {cell(r, i, "lastName", "Last name")}
                {cell(r, i, "phone", "Phone", "tel")}
                {cell(r, i, "email", "Personal email", "email")}
                {pick(r, i, "technologyId", "Technology", techs, techName)}
                {pick(r, i, "locationId", "Location", locs, locName)}
                <td>
                  <button type="button" className="btn sm" aria-label={`Remove row ${i + 1}`} disabled={rows.length === 1}
                    onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>✕</button>
                </td>
              </RowView>
            ))}
          </tbody>
        </table>
      </div>
      <div className="bulkrows-tools">
        <button type="button" className="btn sm" disabled={rows.length >= MAX_BULK_ROWS} onClick={() => setRows((rs) => [...rs, blankRow()])}>Add row</button>
        <button type="button" className="btn sm" aria-expanded={pasting} onClick={() => setPasting((x) => !x)}>Paste from spreadsheet</button>
      </div>
      {pasting && (
        <div className="bulkpaste">
          <Field label="Rows to paste" hint="One candidate per line: First name, Last name, Phone, Email, then optionally Technology and Location. Tab-separated (copied from a sheet) or comma-separated; a header row is skipped.">
            {(p) => <textarea {...p} rows={5} value={pasted} onChange={(e) => setPasted(e.target.value)} />}
          </Field>
          <div className="bulkrows-tools">
            <label className="btn sm">
              Upload CSV
              <input type="file" accept=".csv,text/csv,text/plain" className="sr-only" onChange={(e) => void onFile(e)} />
            </label>
            <button type="button" className="btn sm primary" disabled={!pasted.trim()} onClick={applyPaste}>Add these rows</button>
          </div>
        </div>
      )}
      {note && <p className="note warn" role="status">{note}</p>}
      <DialogActions onCancel={onCancel} busy={busy} error={formError}
        submitLabel={filledCount > 1 ? `Create ${filledCount} candidates` : "Create candidates"} />
    </form>
  );
}

function RowView({ r, i, children }: { r: Row; i: number; children: React.ReactNode }) {
  return (
    <>
      <tr className={r.error ? "has-error" : undefined}>
        <td className="muted">{i + 1}</td>
        {children}
      </tr>
      {r.error && (
        <tr className="bulkrow-err"><td /><td colSpan={7}><small id={`bulk-err-${r.key}`} className="error">{r.error}</small></td></tr>
      )}
    </>
  );
}
