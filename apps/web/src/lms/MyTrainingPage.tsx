import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fmtDate } from "../sales/ui";
import { fmtMinutes, lmsApi, lmsError, lmsKeys, type MyModule } from "./lmsApi";
import { BatchStatusChip, ProgressBar } from "./ui";

/** My Training: the learner's own batches, with a per-module progress control. */
export function MyTrainingPage() {
  const [openId, setOpenId] = useState<string | null>(null);
  const q = useQuery({ queryKey: lmsKeys.mine, queryFn: () => lmsApi.myTrainings() });
  if (openId) return <MyBatch id={openId} onBack={() => setOpenId(null)} />;
  const items = q.data?.items ?? [];
  return (
    <>
      <div>
        <h1 tabIndex={-1}>My Training</h1>
        <p className="sub">The training batches you are enrolled in. Open one to update your progress.</p>
      </div>
      {q.isLoading ? <p className="empty">Loading…</p> : q.error ? (
        <p className="empty error" role="alert">{lmsError(q.error)} <button type="button" className="btn sm" onClick={() => void q.refetch()}>Retry</button></p>
      ) : items.length === 0 ? <p className="empty card">You aren't enrolled in any training batch yet.</p> : (
        <ul className="lmsgrid" aria-label="My training batches">
          {items.map((b) => (
            <li key={b.batchId} className="card lmscard">
              <div className="lmscardbody">
                <div><BatchStatusChip status={b.status} /></div>
                <h2>{b.name}</h2>
                <p className="muted">{fmtDate(b.startDate)} – {fmtDate(b.endDate)} · {b.courseCount} {b.courseCount === 1 ? "course" : "courses"}</p>
                <ProgressBar percent={b.percent} label={`${b.name} progress`} />
                <button type="button" className="btn sm lmsopen" onClick={() => setOpenId(b.batchId)} aria-label={`Open ${b.name}`}>Open</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function MyBatch({ id, onBack }: { id: string; onBack: () => void }) {
  const q = useQuery({ queryKey: lmsKeys.myBatch(id), queryFn: () => lmsApi.myTraining(id) });
  const b = q.data;
  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb">
        <button type="button" className="linkbtn" onClick={onBack}>My Training</button>
        <span aria-hidden="true">/</span><span aria-current="page">{b?.name ?? "Batch"}</span>
      </nav>
      {q.isLoading ? <p className="empty">Loading…</p> : !b ? (
        <p className="empty error" role="alert">{lmsError(q.error)}</p>
      ) : (
        <>
          <div>
            <h1 tabIndex={-1}>{b.name}</h1>
            <p className="sub"><BatchStatusChip status={b.status} /> {fmtDate(b.startDate)} – {fmtDate(b.endDate)}</p>
          </div>
          <ProgressBar percent={b.percent} label="Overall progress" />
          {b.courses.length === 0 && <p className="empty card">No courses have been assigned to this batch yet.</p>}
          {b.courses.map((c) => (
            <section key={c.id} className="card" aria-label={c.title}>
              <div className="lmsrow"><b style={{ flex: "1 1 200px" }}>{c.title}</b><ProgressBar percent={c.percent} label={`${c.title} progress`} /></div>
              <ul className="lmslist">
                {c.modules.map((m) => <ModuleRow key={m.moduleId} batchId={id} m={m} />)}
              </ul>
            </section>
          ))}
        </>
      )}
    </>
  );
}

function ModuleRow({ batchId, m }: { batchId: string; m: MyModule }) {
  const qc = useQueryClient();
  const [value, setValue] = useState(String(m.percent));
  const [err, setErr] = useState("");
  const [saved, setSaved] = useState("");
  const save = useMutation({
    mutationFn: (p: number) => lmsApi.setMyProgress(batchId, m.moduleId, p),
    onSuccess: (_d, p) => {
      setValue(String(p)); setSaved(p === 100 ? "Marked complete." : `Saved ${p}%.`);
      void qc.invalidateQueries({ queryKey: lmsKeys.all });
    },
    onError: (e) => { setSaved(""); setErr(lmsError(e)); },
  });
  const go = (p: number) => { setErr(""); setSaved(""); save.mutate(p); };
  const n = Number(value);
  const valid = value.trim() !== "" && Number.isInteger(n) && n >= 0 && n <= 100;
  return (
    <li className="lmsrow" aria-label={m.title}>
      <span style={{ flex: "1 1 200px" }}>{m.title}<small className="block muted">{fmtMinutes(m.durationMinutes)}{m.completedAt ? ` · completed ${fmtDate(m.completedAt)}` : ""}</small></span>
      <ProgressBar percent={m.percent} label={`${m.title} progress`} small />
      <form className="lmsmine" noValidate onSubmit={(e) => { e.preventDefault(); if (!valid) { setErr("Enter a whole number from 0 to 100."); return; } go(n); }}>
        <label className="sr-only" htmlFor={`pct-${m.moduleId}`}>{`Percent complete for ${m.title}`}</label>
        <input id={`pct-${m.moduleId}`} type="number" min={0} max={100} value={value} aria-invalid={err ? true : undefined}
          onChange={(e) => { setValue(e.target.value); setErr(""); }} />
        <button type="submit" className="btn sm" disabled={save.isPending} aria-label={`Set progress for ${m.title}`}>Set</button>
        <button type="button" className="btn sm primary" disabled={save.isPending || m.percent === 100} aria-label={`Mark ${m.title} complete`} onClick={() => go(100)}>Mark complete</button>
        <span role="status" aria-live="polite" className="muted">{saved}</span>
        {err && <span role="alert" className="error">{err}</span>}
      </form>
    </li>
  );
}
