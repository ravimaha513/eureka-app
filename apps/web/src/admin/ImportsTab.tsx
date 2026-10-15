import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, apiFetch } from "../api";
import { friendlyError } from "./errors";
import { fmtDate, useAccess } from "./shared";

/** Team workbook import (docs/import.md "Upload page"): upload, review, approve, load. Staging and local only. */
const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const SHEETS = ["sales", "submissions", "interviews", "placements"] as const;
const SHEET_LABEL: Record<string, string> = { sales: "People", submissions: "Submissions", interviews: "Interviews", placements: "Placements" };
const STATES = ["clean", "held", "review", "rejected", "skipped", "committed"] as const;

interface BatchItem { id: string; status: string; createdAt: string; operator: string; asOf: string | null }
interface SheetTotals extends Record<(typeof STATES)[number], number> {
  in: number;
  reasons: Record<"review" | "held" | "rejected" | "skipped", Record<string, number>>;
}
interface Report {
  batchId: string; status: string; balanced: boolean; sheets: Record<string, SheetTotals>;
  load: { running: boolean; startedAt: string; finishedAt?: string; error?: string;
    result?: { loaded: Record<string, number>; failures: { rows: string[]; error: string }[]; remainingClean: number } } | null;
}
interface ReviewItem { sheet: string; rowNo: number; state: string; reasons: string[]; approvable: boolean }
interface Preview {
  digest: string; problems: { sheet: string; rowNo: number; problem: string }[];
  perOwner: { owner: string | null; candidates: number; submissions: number; interviews: number }[];
  newReferences: { clients: string[]; vendors: string[]; partners: string[] };
}

const REASON_TEXT: Record<string, string> = {
  "missing:client": "no client (the sheet doesn't say, or it's confidential)",
  inferred_client: "client suggested from the recruiter's submissions (approve to load)",
  "unknown_owner:owner": "recruiter isn't a user here",
  "unknown_technology:technology": "technology isn't in the list",
  candidate_not_loadable: "waits for its candidate",
  placements_commit_disabled: "placement loading is off",
  "missing:placementType": "no placement type (C2C/W2) in the sheet",
  "missing:workMode": "no work mode in the sheet",
};
const reasonText = (r: string) => REASON_TEXT[r] ?? r;

export function ImportsTab() {
  const { announce } = useAccess();
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [asOf, setAsOf] = useState(() => new Date().toISOString().slice(0, 10));
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  const list = useQuery({ queryKey: ["imports", "list"], queryFn: () => api<{ enabled: boolean; items: BatchItem[] }>("/api/v1/import-workbooks") });
  const report = useQuery({
    queryKey: ["imports", "report", selected], enabled: !!selected,
    queryFn: () => api<Report>(`/api/v1/import-workbooks/${selected}`),
    refetchInterval: (q) => (q.state.data?.load?.running ? 3000 : false),
  });
  const review = useQuery({
    queryKey: ["imports", "review", selected], enabled: !!selected,
    queryFn: () => api<{ items: ReviewItem[] }>(`/api/v1/imports/${selected}/review`),
  });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["imports"] }); };

  const run = async (label: string, fn: () => Promise<string | void>) => {
    setBusy(label); setError("");
    try {
      const msg = await fn();
      if (msg) announce(msg);
      refresh();
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy("");
    }
  };

  const upload = () => run("upload", async () => {
    if (!file) return;
    const res = await apiFetch(`/api/v1/import-workbooks?asOf=${encodeURIComponent(asOf)}`,
      { method: "POST", body: file, headers: { "content-type": XLSX_TYPE } });
    const out = (await res.json()) as { batchId: string; created: boolean; workbook: { tabs: unknown[]; candidates: number } };
    setSelected(out.batchId);
    return `${out.created ? "Staged" : "Re-analysed"} ${out.workbook.tabs.length} tabs, ${out.workbook.candidates} candidates. Nothing is loaded yet.`;
  });

  const approvable = (review.data?.items ?? []).filter((r) => r.approvable && r.state === "review");
  const approveSuggested = () => run("decide", async () => {
    for (const r of approvable) {
      await api(`/api/v1/imports/${selected}/decisions`, { method: "POST", body: JSON.stringify({ sheet: r.sheet, rowNo: r.rowNo, action: "approve" }) });
    }
    await api(`/api/v1/import-workbooks/${selected}/reanalyse`, { method: "POST" });
    return `Approved ${approvable.length} rows and re-analysed.`;
  });
  const reanalyse = () => run("reanalyse", async () => {
    await api(`/api/v1/import-workbooks/${selected}/reanalyse`, { method: "POST" });
    return "Re-analysed with the current users, technologies and decisions.";
  });

  const [preview, setPreview] = useState<Preview | null>(null);
  const loadPreview = () => run("preview", async () => { setPreview(await api<Preview>(`/api/v1/imports/${selected}/preview`)); });
  const approveBatch = () => run("approve", async () => {
    if (!preview) return;
    await api(`/api/v1/imports/${selected}/approve`, { method: "POST", body: JSON.stringify({ digest: preview.digest }) });
    setPreview(null);
    return "Batch approved. Load it to write the data.";
  });
  const load = () => run("load", async () => {
    await api(`/api/v1/import-workbooks/${selected}/load`, { method: "POST" });
    return "Loading started. This page updates when it finishes.";
  });

  if (list.isLoading) return <p className="empty">Loading…</p>;
  if (list.error) return <p className="empty error" role="alert">{friendlyError(list.error)}</p>;
  if (!list.data?.enabled) return <p className="empty">Workbook upload is not enabled in this environment (staging only).</p>;
  const rep = report.data;
  const status = rep?.status;

  return (
    <>
      <div className="card">
        <h2>Upload a team workbook</h2>
        <p className="hint">The manager's .xlsx with Submissions, Interviews and Placements tabs per team. Staging only: nothing is written to the app until you approve and load it.</p>
        <div className="toolbar">
          <div className="field inline">
            <label htmlFor="imp-file">Workbook</label>
            <input id="imp-file" type="file" accept=".xlsx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </div>
          <div className="field inline">
            <label htmlFor="imp-asof">Data as of</label>
            <input id="imp-asof" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          </div>
          <button className="btn primary" disabled={!file || !!busy} onClick={() => void upload()}>{busy === "upload" ? "Reading…" : "Upload and stage"}</button>
        </div>
      </div>
      {error && <p className="error banner" role="alert">{error}</p>}

      <div className="card">
        <h2>Batches</h2>
        <div className="tablewrap"><table aria-label="Import batches">
          <thead><tr><th>Staged</th><th>Data as of</th><th>By</th><th>Status</th><th><span className="sr-only">Open</span></th></tr></thead>
          <tbody>
            {list.data.items.map((b) => (
              <tr key={b.id} aria-current={b.id === selected ? "true" : undefined}>
                <td>{fmtDate(b.createdAt)}</td><td>{b.asOf ?? "—"}</td><td>{b.operator}</td><td>{b.status}</td>
                <td><button className="btn sm" onClick={() => { setSelected(b.id); setPreview(null); }}>Open</button></td>
              </tr>
            ))}
            {list.data.items.length === 0 && <tr><td colSpan={5} className="empty">No batches yet.</td></tr>}
          </tbody>
        </table></div>
      </div>

      {selected && (
        <div className="card">
          <h2>Batch <small className="muted">{selected}</small></h2>
          {report.isLoading ? <p className="empty">Loading…</p> : report.error ? <p className="error" role="alert">{friendlyError(report.error)}</p> : rep && (
            <>
              <p>Status: <b>{status}</b>{rep.load?.running && " · loading…"}</p>
              <div className="tablewrap"><table aria-label="Rows per sheet and state">
                <thead><tr><th>Sheet</th><th>In</th><th>Ready</th><th>Loaded</th><th>Review</th><th>Held</th><th>Skipped</th><th>Rejected</th></tr></thead>
                <tbody>
                  {SHEETS.filter((s) => rep.sheets[s]?.in).map((s) => {
                    const t = rep.sheets[s]!;
                    return <tr key={s}><td>{SHEET_LABEL[s]}</td><td>{t.in}</td><td>{t.clean}</td><td>{t.committed}</td><td>{t.review}</td><td>{t.held}</td><td>{t.skipped}</td><td>{t.rejected}</td></tr>;
                  })}
                </tbody>
              </table></div>
              <details>
                <summary>Why rows wait</summary>
                <ul>
                  {SHEETS.flatMap((s) => (["review", "held"] as const).flatMap((st) =>
                    Object.entries(rep.sheets[s]?.reasons[st] ?? {}).map(([r, n]) => (
                      <li key={`${s}-${st}-${r}`}>{SHEET_LABEL[s]}: {n} × {reasonText(r)}</li>
                    ))))}
                </ul>
              </details>
              {rep.load?.result && (
                <p>Last load: {Object.entries(rep.load.result.loaded).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(", ") || "nothing"}
                  {rep.load.result.failures.length > 0 && `, ${rep.load.result.failures.length} people failed`}.</p>
              )}
              {rep.load?.error && <p className="error" role="alert">Load failed: {rep.load.error}</p>}

              {status === "staged" && (
                <div className="toolbar">
                  <button className="btn" disabled={!!busy || approvable.length === 0} onClick={() => void approveSuggested()}>
                    Approve {approvable.length} suggested rows
                  </button>
                  <button className="btn" disabled={!!busy} onClick={() => void reanalyse()}>Re-analyse</button>
                  <button className="btn primary" disabled={!!busy} onClick={() => void loadPreview()}>Review what would load…</button>
                </div>
              )}
              {preview && status === "staged" && (
                <div className="card inset">
                  <p>Loads {preview.perOwner.reduce((a, o) => a + o.candidates, 0)} candidates and {preview.perOwner.reduce((a, o) => a + o.submissions, 0)} submissions
                    for {preview.perOwner.length} recruiters. Adds {preview.newReferences.clients.length} clients and {preview.newReferences.vendors.length} vendors.</p>
                  {preview.problems.length > 0
                    ? <p className="error" role="alert">{preview.problems.length} verification problems: re-analyse first.</p>
                    : <button className="btn primary" disabled={!!busy} onClick={() => void approveBatch()}>Approve batch</button>}
                </div>
              )}
              {status === "approved" && (
                <button className="btn primary" disabled={!!busy || !!rep.load?.running} onClick={() => void load()}>
                  {rep.load?.running ? "Loading…" : "Load into the app"}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </>
  );
}
