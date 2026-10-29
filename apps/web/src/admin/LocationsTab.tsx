import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { adminApi, LOCATION_KINDS, type LocationKind } from "./adminApi";
import { Dialog, DialogActions, useSubmit } from "../ui/Dialog";
import { friendlyError } from "./errors";
import { keys, useAccess } from "./shared";
import { Loading } from "../ui/Loading";
import { QueryError } from "../ui/QueryError";
import { KIND_LABELS, LocationDetailView } from "./LocationDetail";

/** Locations are reference data (org_admin only to create). Teams and roles pick from this list. */
export function LocationsTab() {
  const { announce } = useAccess();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: keys.locations, queryFn: () => adminApi.locations().then((r) => r.items) });
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  const done = (msg: string) => {
    setOpen(false);
    announce(msg);
    void qc.invalidateQueries({ queryKey: keys.meta });
    void qc.invalidateQueries({ queryKey: keys.locations });
  };

  if (selected) return <LocationDetailView id={selected} onBack={() => setSelected(null)} />;

  return (
    <>
      <div className="toolbar">
        <p className="hint">Teams and location-bound roles use these locations. Creating one here does not change anyone's access.</p>
        <button className="btn primary push" onClick={() => setOpen(true)}>New location</button>
      </div>
      {q.isLoading ? <Loading /> : q.error ? <QueryError query={q} message={friendlyError(q.error)} /> : (
        <ul className="teamgrid loccards" aria-label="Locations">
          {q.data!.map((l) => {
            const incharge = l.roleHolders.filter((h) => h.role === "location_incharge");
            return (
              <li key={l.id}>
                <button type="button" className="card loccard" onClick={() => setSelected(l.id)}>
                  <span className="loccardhead"><b>{l.name}</b><span className="chip">{KIND_LABELS[l.kind] ?? l.kind}</span></span>
                  <span className="muted">{[l.state, l.timezone].filter(Boolean).join(" · ")}</span>
                  <span className="loccounts"><span><b>{l.peopleCount}</b> people</span><span><b>{l.teamCount}</b> teams</span></span>
                  {incharge.length
                    ? <span className="muted">Incharge · {incharge.map((h) => h.displayName).join(", ")}</span>
                    : <span className="warntext">No incharge</span>}
                </button>
              </li>
            );
          })}
          {q.data!.length === 0 && <li className="empty">No locations yet.</li>}
        </ul>
      )}

      {open && <CreateLocationDialog onClose={() => setOpen(false)} onDone={done} />}
    </>
  );
}

function CreateLocationDialog({ onClose, onDone }: { onClose: () => void; onDone: (m: string) => void }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<LocationKind>("office");
  const [state, setState] = useState("");
  const [timezone, setTimezone] = useState("");
  const { busy, error, run } = useSubmit((e) => friendlyError(e));
  const trimmedName = name.trim();
  return (
    <Dialog title="New location" onClose={onClose}>
      <form onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await adminApi.createLocation({
            name: trimmedName,
            kind,
            ...(state.trim() ? { state: state.trim() } : {}),
            ...(timezone.trim() ? { timezone: timezone.trim() } : {}),
          });
          onDone(`Created ${trimmedName}.`);
        });
      }}>
        <div className="field"><label htmlFor="nl-name">Location name</label>
          <input id="nl-name" required data-autofocus value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div className="field"><label htmlFor="nl-kind">Kind</label>
          <select id="nl-kind" required value={kind} onChange={(e) => setKind(e.target.value as LocationKind)}>
            {LOCATION_KINDS.map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
          </select></div>
        <div className="field"><label htmlFor="nl-state">State <span className="muted">(optional)</span></label>
          <input id="nl-state" value={state} onChange={(e) => setState(e.target.value)} /></div>
        <div className="field"><label htmlFor="nl-tz">Time zone <span className="muted">(optional, default America/New_York)</span></label>
          <input id="nl-tz" placeholder="America/Chicago" value={timezone} onChange={(e) => setTimezone(e.target.value)} /></div>
        <DialogActions onCancel={onClose} submitLabel="Create location" busy={busy} error={error} disabled={!trimmedName} />
      </form>
    </Dialog>
  );
}
