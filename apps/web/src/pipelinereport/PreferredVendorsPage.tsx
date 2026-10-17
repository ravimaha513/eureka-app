import { useId, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { ConfirmDialog, Dialog, DialogActions, useSubmit } from "../ui/Dialog";
import { useLookups } from "../lookups";
import { Field } from "../sales/ui";
import { pvApi, pvError, pvKeys, type PreferredVendor, type PreferredVendorInput } from "./pipelineReportApi";
import { QueryError } from "../ui/QueryError";

/**
 * Preferred vendors (PV-9..PV-12): recruiters keep the vendors they prefer; only
 * they and their superiors (lead, manager, associate director, CEO) see them.
 */
export function PreferredVendorsPage() {
  const id = useId();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [archived, setArchived] = useState(false);
  const [modal, setModal] = useState<{ kind: "edit"; vendor: PreferredVendor | null } | { kind: "archive"; vendor: PreferredVendor } | null>(null);
  const [message, setMessage] = useState("");
  const f = { q: search.trim() || undefined, ownerId: ownerId || undefined, archived: archived || undefined };
  const q = useQuery({ queryKey: pvKeys.vendorList({ q: search.trim(), ownerId, archived }), queryFn: () => pvApi.vendors(f), placeholderData: keepPreviousData });
  const d = q.data;
  const refresh = () => void qc.invalidateQueries({ queryKey: pvKeys.vendors });

  return (
    <>
      <div className="pagehead">
        <div>
          <h1 tabIndex={-1}>Preferred vendors</h1>
          <p className="sub">Vendors recruiters prefer to work with. Each entry is visible only to the recruiter who added it and their superiors.</p>
        </div>
        {d?.actions.create && <button type="button" className="btn primary" onClick={() => setModal({ kind: "edit", vendor: null })}>Add vendor</button>}
      </div>

      <form className="filters" aria-label="Vendor filters" onSubmit={(e) => e.preventDefault()}>
        <div className="toolbar">
          <div className="field inline">
            <label htmlFor={`${id}-q`}>Search</label>
            <input id={`${id}-q`} type="search" value={search} maxLength={100} placeholder="Vendor, contact or client" onChange={(e) => setSearch(e.target.value)} />
          </div>
          {(d?.owners.length ?? 0) > 1 && (
            <div className="field inline">
              <label htmlFor={`${id}-owner`}>Recruiter</label>
              <select id={`${id}-owner`} value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
                <option value="">All</option>
                {d!.owners.map((o) => <option key={o.id} value={o.id}>{o.name ?? "Unnamed"}</option>)}
              </select>
            </div>
          )}
          <label className="check"><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Archived</label>
        </div>
      </form>

      <p role="status" aria-live="polite" className="livemsg">{message}</p>
      {q.isLoading ? <p className="empty">Loading…</p> : q.error ? (
        <QueryError query={q} message={pvError(q.error)} />
      ) : d ? (
        <div className="card tablewrap" aria-busy={q.isFetching || undefined}>
          <table aria-label="Preferred vendors">
            <thead><tr><th>Vendor</th><th>Contact</th><th>Technology</th><th>Clients</th><th>Added by</th><th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {d.items.map((v) => (
                <tr key={v.id}>
                  <td><b>{v.vendorName}</b>{v.notes && <span className="block muted">{v.notes}</span>}</td>
                  <td>{v.contactName ?? "—"}
                    {v.contactEmail && <span className="block"><a href={`mailto:${v.contactEmail}`}>{v.contactEmail}</a></span>}
                    {v.contactPhone && <span className="block muted">{v.contactPhone}</span>}</td>
                  <td>{v.technology?.name ?? "—"}</td>
                  <td>{v.clients ?? "—"}</td>
                  <td>{v.owner.name ?? "—"}</td>
                  <td>
                    {v.actions.edit && <button type="button" className="btn sm" onClick={() => setModal({ kind: "edit", vendor: v })} aria-label={`Edit ${v.vendorName}`}>Edit</button>}
                    {v.actions.archive && <button type="button" className="btn sm danger" onClick={() => setModal({ kind: "archive", vendor: v })} aria-label={`Archive ${v.vendorName}`}>Archive</button>}
                  </td>
                </tr>
              ))}
              {d.items.length === 0 && <tr><td colSpan={6} className="empty">{archived ? "No archived vendors." : "No preferred vendors yet."}</td></tr>}
            </tbody>
          </table>
        </div>
      ) : null}

      {modal?.kind === "edit" && (
        <VendorDialog vendor={modal.vendor} onClose={() => setModal(null)}
          onSaved={(name) => { setModal(null); setMessage(`Saved ${name}.`); refresh(); }} />
      )}
      {modal?.kind === "archive" && (
        <ConfirmDialog title={`Archive ${modal.vendor.vendorName}?`} confirmLabel="Archive" danger formatError={pvError}
          action={() => pvApi.archiveVendor(modal.vendor.id)} onClose={() => setModal(null)}
          onDone={() => { setModal(null); setMessage("Vendor archived."); refresh(); }}>
          <p>The entry moves to the archived list. It cannot be edited afterwards.</p>
        </ConfirmDialog>
      )}
    </>
  );
}

function VendorDialog({ vendor, onClose, onSaved }: { vendor: PreferredVendor | null; onClose: () => void; onSaved: (name: string) => void }) {
  const lookups = useLookups();
  const [v, setV] = useState<PreferredVendorInput>({
    vendorName: vendor?.vendorName ?? "", vendorId: vendor?.vendor?.id ?? null, contactName: vendor?.contactName ?? null,
    contactEmail: vendor?.contactEmail ?? null, contactPhone: vendor?.contactPhone ?? null, technologyId: vendor?.technology?.id ?? null,
    clients: vendor?.clients ?? null, notes: vendor?.notes ?? null,
  });
  const { busy, error, run } = useSubmit(pvError);
  const set = <K extends keyof PreferredVendorInput>(k: K, val: string) =>
    setV((o) => ({ ...o, [k]: k === "vendorName" ? val : val.trim() === "" ? null : val }));
  const vendors = lookups.data?.vendors ?? [];

  return (
    <Dialog title={vendor ? `Edit ${vendor.vendorName}` : "Add preferred vendor"} onClose={onClose} wide>
      <form onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          const saved = vendor ? await pvApi.updateVendor(vendor, v) : await pvApi.createVendor(v);
          onSaved(saved.vendorName);
        });
      }}>
        <Field label="Vendor name">{(p) => <input {...p} data-autofocus required maxLength={200} value={v.vendorName} onChange={(e) => set("vendorName", e.target.value)} />}</Field>
        {vendors.length > 0 && (
          <Field label="Vendor on file (optional)">{(p) => (
            <select {...p} value={v.vendorId ?? ""} onChange={(e) => set("vendorId", e.target.value)}>
              <option value="">None</option>
              {vendors.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          )}</Field>
        )}
        <Field label="Contact name (optional)">{(p) => <input {...p} maxLength={120} value={v.contactName ?? ""} onChange={(e) => set("contactName", e.target.value)} />}</Field>
        <Field label="Contact email (optional)">{(p) => <input {...p} type="email" maxLength={254} value={v.contactEmail ?? ""} onChange={(e) => set("contactEmail", e.target.value)} />}</Field>
        <Field label="Contact phone (optional)" hint="International format, for example +14695550100">{(p) => (
          <input {...p} type="tel" pattern="\+[1-9][0-9]{7,14}" value={v.contactPhone ?? ""} onChange={(e) => set("contactPhone", e.target.value)} />
        )}</Field>
        <Field label="Technology (optional)">{(p) => (
          <select {...p} value={v.technologyId ?? ""} onChange={(e) => set("technologyId", e.target.value)}>
            <option value="">Any</option>
            {(lookups.data?.technologies ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        )}</Field>
        <Field label="Clients they work with (optional)">{(p) => <input {...p} maxLength={500} value={v.clients ?? ""} onChange={(e) => set("clients", e.target.value)} />}</Field>
        <Field label="Notes (optional)">{(p) => <textarea {...p} maxLength={2000} rows={3} value={v.notes ?? ""} onChange={(e) => set("notes", e.target.value)} />}</Field>
        <DialogActions onCancel={onClose} submitLabel={vendor ? "Save" : "Add vendor"} busy={busy} error={error} disabled={!v.vendorName.trim()} />
      </form>
    </Dialog>
  );
}
