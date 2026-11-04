import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PHONE_PROBLEM_MESSAGES } from "@eureka/shared";
import { isXlsx } from "../admin/xlsx";
import { saveBlob } from "../lib/download";
import { salesApi } from "../sales/salesApi";
import { NO_TEAM } from "../sales/useCreateTeam";
import { Field } from "../sales/ui";
import { Dialog, DialogActions, useSubmit } from "../ui/Dialog";
import { readCandidateSheet } from "./candidateSheet";
import { trainingApi, trainingError, type BulkCandidateReport, type BulkCandidateRow } from "./trainingApi";

const ROW_ERRORS: Record<string, string> = {
  ...PHONE_PROBLEM_MESSAGES,
  invalid_first_name: "Enter a first name of at most 80 characters.",
  invalid_last_name: "Enter a last name of at most 80 characters.",
  invalid_email: "Enter a valid email address.",
  duplicate_in_file: "The same email or phone is on another row of this file.",
  duplicate_email: "Another candidate already has this email.",
  duplicate_phone: "Another candidate already has this phone.",
};

const plural = (n: number) => `${n} candidate${n === 1 ? "" : "s"}`;

/**
 * New candidates for a batch from the Excel template (POST /api/v1/batches/:id/candidates/bulk).
 * Choosing a file previews it; nothing is created unless every row is valid. The team is
 * optional: "No team yet" (the default, `teamId: null`, assigned later from each profile)
 * or one of the caller's candidate:create teams.
 */
export function BulkCandidatesDialog({ batch, cancelLabel, onClose, onDone }: {
  batch: { id: string; name: string }; cancelLabel?: string; onClose: () => void; onDone: (created: number) => void;
}) {
  const [rows, setRows] = useState<BulkCandidateRow[] | null>(null);
  const [report, setReport] = useState<BulkCandidateReport | null>(null);
  const [fileError, setFileError] = useState<string | undefined>();
  const [checking, setChecking] = useState(false);
  const { busy, error, setError, run } = useSubmit(trainingError);

  const teams = useQuery({ queryKey: ["candidate-create-teams"], queryFn: () => salesApi.createTeams(), staleTime: 300_000 });
  const teamItems = teams.data?.items ?? [];
  const [picked, setPicked] = useState(NO_TEAM);
  const teamId = teamItems.some((t) => t.id === picked) ? picked : null;

  async function preview(parsed: BulkCandidateRow[], team: string | null) {
    setReport(null); setFileError(undefined);
    setChecking(true);
    try {
      setReport(await trainingApi.bulkAddCandidates(batch.id, { dryRun: true, teamId: team, rows: parsed }));
    } catch (e) {
      setFileError(trainingError(e));
    } finally {
      setChecking(false);
    }
  }

  async function onFile(file: File | undefined) {
    setRows(null); setReport(null); setFileError(undefined);
    if (!file) return;
    let parsed: BulkCandidateRow[];
    try {
      if (!isXlsx(file)) throw new Error("Choose an Excel file (.xlsx). Use the template.");
      parsed = await readCandidateSheet(file);
      if (parsed.length === 0) throw new Error("The file has a header but no candidates.");
      if (parsed.length > 500) throw new Error("A file can have at most 500 candidates. Split it and upload it in parts.");
    } catch (e) {
      setFileError(trainingError(e));
      return;
    }
    setRows(parsed);
    await preview(parsed, teamId);
  }

  /** A new team re-checks the chosen file, so Create always matches what was previewed. */
  const pickTeam = (v: string) => {
    setPicked(v);
    if (rows) void preview(rows, teamItems.some((t) => t.id === v) ? v : null);
  };

  const downloadTemplate = () => {
    setError("");
    trainingApi.candidateTemplate().then((b) => saveBlob(b, "batch-candidates-template.xlsx"), (e) => setError(trainingError(e)));
  };

  const ready = !!report && report.failed === 0;
  return (
    <Dialog title={`Add candidates to ${batch.name}`} onClose={onClose} className="xwide">
      <form onSubmit={(e) => {
        e.preventDefault();
        if (!rows || !ready) return;
        void run(async () => {
          const res = await trainingApi.bulkAddCandidates(batch.id, { dryRun: false, teamId, rows });
          if (res.committed) onDone(res.created);
          else setReport(res); // the data changed since the preview
        });
      }}>
        <p className="hint">
          <button type="button" className="linkbtn" onClick={downloadTemplate}>Download the Excel template</button>,
          fill in one new candidate per row (<b>first name</b>, <b>last name</b>, <b>phone</b> and <b>personal email</b>), then choose the file.
          Technology and location come from the batch. Nothing is created unless every row is valid.
        </p>
        {teamItems.length > 0 && (
          <Field label="Team" hint={teamId === null ? "Optional. You can assign the team later from each candidate's profile." : undefined}>
            {(p) => (
              <select {...p} value={teamId ?? NO_TEAM} onChange={(e) => pickTeam(e.target.value)}>
                <option value={NO_TEAM}>No team yet</option>
                {teamItems.map((t) => <option key={t.id} value={t.id}>{t.lead ? `${t.name} (${t.lead})` : t.name}</option>)}
              </select>
            )}
          </Field>
        )}
        <div className="field"><label htmlFor="batch-file">Excel file</label>
          <input id="batch-file" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            data-autofocus disabled={teams.isPending} onChange={(e) => void onFile(e.target.files?.[0])} /></div>
        {fileError && <p className="error" role="alert">{fileError}</p>}
        {checking && <p className="muted" role="status">Checking {rows?.length} rows…</p>}
        {report && (
          <>
            <p role="status">
              {report.failed === 0
                ? <>All {report.rows.length} rows are valid and ready to add.</>
                : <><b>{report.failed}</b> of {report.rows.length} rows have problems. Fix the file and choose it again; nothing has been created.</>}
            </p>
            <div className="tablewrap" style={{ maxHeight: "40vh", overflow: "auto" }}>
              <table aria-label="Candidates preview">
                <thead><tr><th>Excel row</th><th>First name</th><th>Last name</th><th>Phone</th><th>Personal email</th><th>Result</th></tr></thead>
                <tbody>
                  {report.rows.map((r) => (
                    <tr key={r.row}>
                      <td>{r.row + 1}</td><td>{r.firstName || "—"}</td><td>{r.lastName || "—"}</td><td>{r.phone || "—"}</td><td>{r.email || "—"}</td>
                      <td>{r.status === "ok" ? "OK" : <span className="error">{ROW_ERRORS[r.error!] ?? r.error}</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        <DialogActions onCancel={onClose} cancelLabel={cancelLabel} submitLabel={ready ? `Create ${plural(report!.rows.length)}` : "Create candidates"}
          busy={busy} error={error} disabled={!ready || checking} />
      </form>
    </Dialog>
  );
}
