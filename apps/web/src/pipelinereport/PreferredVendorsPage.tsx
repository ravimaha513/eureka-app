import { useId, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { ConfirmDialog, Dialog, DialogActions, useSubmit } from "../ui/Dialog";
import { useLookups } from "../lookups";
import { Field } from "../sales/ui";
import { useSearchParams } from "../lib/router";
import { FilterBar } from "../ui/FilterBar";
import { Menu } from "../ui/Menu";
import { useDebouncedParam } from "../pipeline/ui";
import "../pipeline/pipeline.css";
import "./pipelinereport.css";
import { pvApi, pvError, pvKeys, type PreferredVendor, type PreferredVendorInput } from "./pipelineReportApi";
import { QueryError } from "../ui/QueryError";
import { Loading } from "../ui/Loading";

/**
 * Preferred vendors (PV-9..PV-12): recruiters keep the vendors they prefer; only
 * they and their superiors (lead, manager, associate director, CEO) see them.
 * Search (debounced), recruiter and the Active / Archived list are in the URL.
 */
export function PreferredVendorsPage() {
  const id = useId();
  const qc = useQueryClient();
  const [searchInput, setSearchInput, search] = useDebouncedParam("q");
  const [url, setUrl] = useSearchParams(["ownerId", "archived"] as const);
  const ownerId = url.ownerId;
  const archived = url.archived === "true";
  const [modal, setModal] = useState<{ kind: "edit"; vendor: PreferredVendor | null } | { kind: "archive"; vendor: PreferredVendor } | null>(null);
  const [message, setMessage] = useState("");
  const f = { q: search || undefined, ownerId: ownerId || undefined, archived: archived || undefined };
  const q = useQuery({ queryKey: pvKeys.vendorList({ q: search, ownerId, archived }), queryFn: () => pvApi.vendors(f), placeholderData: keepPreviousData });
  const d = q.data;
  const refresh = () => void qc.invalidateQueries({ queryKey: pvKeys.vendors });
  const canAdd = Boolean(d?.actions.create);
  const hasFilters = Boolean(search || ownerId);
  const add = () => setModal({ kind: "edit", vendor: null });

  return (
    <section className="panel pr-page">
      <div className="pagehead">
        <div>
          <h1 tabIndex={-1}>Preferred vendors{d && <span className="h1count" aria-hidden="true">{d.total}</span>}</h1>
          <p className="sub">Vendors recruiters prefer to work with. Each entry is visible only to the recruiter who added it and their superiors.</p>
        </div>
        {canAdd && <div className="rowactions push"><button type="button" className="btn primary" onClick={add}>Add vendor</button></div>}
      </div>

      <FilterBar label="Vendor filters" hasFilters={hasFilters} onClear={() => { setSearchInput(""); setUrl({ ownerId: "" }); }}
        activeCount={[search, ownerId].filter(Boolean).length} moreCount={0}
        search={
          <div className="field inline fb-search">
            <label htmlFor={`${id}-q`}>Search</label>
            <input id={`${id}-q`} type="search" value={searchInput} maxLength={100} placeholder="Vendor, contact or client" onChange={(e) => setSearchInput(e.target.value)} />
          </div>
        }
        primary={
          (d?.owners.length ?? 0) > 1 ? (
            <div className="field inline">
              <label htmlFor={`${id}-owner`}>Recruiter</label>
              <select id={`${id}-owner`} value={ownerId} onChange={(e) => setUrl({ ownerId: e.target.value })}>
                <option value="">All</option>
                {d!.owners.map((o) => <option key={o.id} value={o.id}>{o.name ?? "Unnamed"}</option>)}
              </select>
            </div>
          ) : null
        }
        summaryEnd={
          <div className="pr-seg" role="group" aria-label="Which vendors">
            <button type="button" aria-pressed={!archived} onClick={() => setUrl({ archived: "" })}>Active</button>
            <button type="button" aria-pressed={archived} onClick={() => setUrl({ archived: "true" })}>Archived</button>
          </div>
        }
      />

      <p role="status" aria-live="polite" className="livemsg">{message}</p>
      {q.isLoading ? <Loading /> : q.error ? (
        <QueryError query={q} message={pvError(q.error)} />
      ) : d ? (
        <div className="card tablewrap listcard" aria-busy={q.isFetching || undefined}>
          <table className="dtable pv-table" aria-label="Preferred vendors">
            <thead><tr><th>Vendor</th><th>Contact</th><th>Clients</th><th className="p2">Added by</th><th className="c-act"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {d.items.map((v) => (
                <tr key={v.id}>
                  <td className="c-primary">
                    <b>{v.vendorName}</b>{v.technology?.name && <span className="pv-tag">{v.technology.name}</span>}
                    {v.notes && <small className="block muted pv-notes" title={v.notes}>{v.notes}</small>}
                  </td>
                  <td data-label="Contact"><span>{v.contactName ?? "—"}
                    {v.contactEmail && <small className="block"><a href={`mailto:${v.contactEmail}`}>{v.contactEmail}</a></small>}
                    {v.contactPhone && <small className="block"><a href={`tel:${v.contactPhone}`}>{v.contactPhone}</a></small>}</span></td>
                  <td data-label="Clients">{v.clients ?? <span className="muted">—</span>}</td>
                  <td className="p2" data-label="Added by">{v.owner.name ?? "—"}</td>
                  <td className="c-act">
                    <div className="pl-act">
                      {v.actions.edit && <button type="button" className="btn sm" onClick={() => setModal({ kind: "edit", vendor: v })} aria-label={`Edit ${v.vendorName}`}>Edit</button>}
                      <Menu label={`More actions for ${v.vendorName}`} items={[
                        v.actions.archive && { label: "Archive…", danger: true, onSelect: () => setModal({ kind: "archive", vendor: v }) },
                      ]} />
                    </div>
                  </td>
                </tr>
              ))}
              {d.items.length === 0 && (
                <tr><td colSpan={5} className="empty">
                  {archived ? "No archived vendors." : hasFilters ? "No vendors match this search." : "No preferred vendors yet."}
                  {!archived && !hasFilters && canAdd && <div className="pv-emptyact"><button type="button" className="btn" onClick={add}>Add your first vendor</button></div>}
                </td></tr>
              )}
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
    </section>
  );
}

/** The form's starting values (an existing entry, or blank). */
const v0 = (vendor: PreferredVendor | null): PreferredVendorInput => ({
  vendorName: vendor?.vendorName ?? "", vendorId: vendor?.vendor?.id ?? null, contactName: vendor?.contactName ?? null,
  contactEmail: vendor?.contactEmail ?? null, contactPhone: vendor?.contactPhone ?? null, technologyId: vendor?.technology?.id ?? null,
  clients: vendor?.clients ?? null, notes: vendor?.notes ?? null,
});

function VendorDialog({ vendor, onClose, onSaved }: { vendor: PreferredVendor | null; onClose: () => void; onSaved: (name: string) => void }) {
  const lookups = useLookups();
  const [v, setV] = useState<PreferredVendorInput>(() => v0(vendor));
  const { busy, error, run } = useSubmit(pvError);
  const set = <K extends keyof PreferredVendorInput>(k: K, val: string) =>
    setV((o) => ({ ...o, [k]: k === "vendorName" ? val : val.trim() === "" ? null : val }));
  const vendors = lookups.data?.vendors ?? [];
  const initial = JSON.stringify(v0(vendor));

  return (
    <Dialog title={vendor ? `Edit ${vendor.vendorName}` : "Add preferred vendor"} onClose={onClose} wide dirty={JSON.stringify(v) !== initial}>
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
