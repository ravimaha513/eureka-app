import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bath, BedDouble, Building2, CalendarDays, Globe2, Mail, MapPin, Phone, Ruler, UserRound } from "lucide-react";
import type { Me } from "../api";
import { Dialog, useSubmit } from "../admin/Dialog";
import { useLookups } from "../lookups";
import { Field, useFocusAfterFailure } from "../sales/ui";
import {
  EMAIL_RE, FEE_LABELS, MONEY_RE, siteKeys, sitesApi, sitesError, toMoney,
  type FacilityDetail, type FeeFrequency, type SiteDetail, type SiteKind, type SiteStatus,
} from "./sitesApi";
import { IconInput, KIND } from "./ui";

type Values = {
  locationId: string; name: string; street: string; city: string; state: string; zip: string; country: string; notes: string; status: SiteStatus;
  ownerName: string; ownerEmail: string; ownerPhone: string; rent: string; feeFrequency: FeeFrequency | ""; capacity: string; beds: string; baths: string;
  startDate: string; endDate: string;
};
type Errors = Partial<Record<keyof Values, string>>;

const str = (v: string | number | null | undefined) => (v === null || v === undefined ? "" : String(v));

function initialValues(record: SiteDetail | null, locationId: string): Values {
  const f = record as Partial<FacilityDetail> | null;
  return {
    locationId: record?.location.id ?? locationId, name: str(record?.name), street: str(record?.street), city: str(record?.city),
    state: str(record?.state), zip: str(record?.zip), country: record ? str(record.country) : "USA", notes: str(record?.notes),
    status: record?.status ?? "active",
    ownerName: str(f?.ownerName), ownerEmail: str(f?.ownerEmail), ownerPhone: str(f?.ownerPhone),
    rent: f?.rent === null || f?.rent === undefined ? "" : String(f.rent), feeFrequency: f?.feeFrequency ?? (record ? "" : "monthly"),
    capacity: str(f?.capacity), beds: str(f?.beds), baths: f?.baths === null || f?.baths === undefined ? "" : String(Number(f.baths)),
    startDate: str(f?.startDate), endDate: str(f?.endDate),
  };
}

const INT_RE = /^\d{1,6}$/;
const BATHS_RE = /^\d{1,2}(\.\d)?$/;

export function validateSite(kind: SiteKind, v: Values): Errors {
  const e: Errors = {};
  if (!v.locationId) e.locationId = "Choose the location.";
  if (!v.name.trim()) e.name = `Enter the ${KIND[kind].one} name.`;
  else if (v.name.trim().length > 200) e.name = "Use at most 200 characters.";
  if (kind === "facilities") {
    if (v.ownerEmail.trim() && !EMAIL_RE.test(v.ownerEmail.trim())) e.ownerEmail = "Enter an email address like name@example.com.";
    if (v.rent.trim() && !MONEY_RE.test(v.rent.trim())) e.rent = "Enter an amount of 0 or more, with up to 2 decimals.";
    if (v.capacity.trim() && !INT_RE.test(v.capacity.trim())) e.capacity = "Enter a whole number of 0 or more.";
    if (v.beds.trim() && !INT_RE.test(v.beds.trim())) e.beds = "Enter a whole number of 0 or more.";
    if (v.baths.trim() && !BATHS_RE.test(v.baths.trim())) e.baths = "Enter a number like 2 or 2.5.";
    if (v.startDate && v.endDate && v.endDate < v.startDate) e.endDate = "The end date can't be before the start date.";
  }
  return e;
}

/** Request body: empty fields are left out on create and cleared (null) on edit. */
function toBody(kind: SiteKind, v: Values, editing: boolean): Record<string, unknown> {
  const empty = editing ? null : undefined;
  const t = (s: string) => (s.trim() ? s.trim() : empty);
  const body: Record<string, unknown> = {
    locationId: v.locationId, name: v.name.trim(), street: t(v.street), city: t(v.city), state: t(v.state), zip: t(v.zip),
    country: t(v.country), notes: t(v.notes),
  };
  if (editing) body.status = v.status;
  if (kind === "facilities") {
    Object.assign(body, {
      ownerName: t(v.ownerName), ownerEmail: t(v.ownerEmail), ownerPhone: t(v.ownerPhone),
      rent: v.rent.trim() ? toMoney(v.rent.trim()) : empty, feeFrequency: v.feeFrequency || empty,
      capacity: v.capacity.trim() ? Number(v.capacity) : empty, beds: v.beds.trim() ? Number(v.beds) : empty,
      baths: v.baths.trim() ? Number(v.baths) : empty, startDate: v.startDate || empty, endDate: v.endDate || empty,
    });
  }
  return Object.fromEntries(Object.entries(body).filter(([, x]) => x !== undefined));
}

/** The locations this user manages (their role grants), else every location. */
function useLocationChoices(me: Pick<Me, "roles">) {
  const lookups = useLookups();
  const mine = new Set(me.roles.map((r) => r.locationId).filter(Boolean) as string[]);
  const all = lookups.data?.locations ?? [];
  const list = mine.size ? all.filter((l) => mine.has(l.id)) : all;
  return { list: list.length ? list : all, loading: lookups.isLoading };
}

/**
 * "Add company" / "Add facility" and their edit forms. Facilities use a 3-column grid
 * with icons inside the inputs; the grid collapses to one column on phones.
 */
export function SiteFormDialog({ kind, me, record, onClose, onSaved }: {
  kind: SiteKind; me: Pick<Me, "roles">; record: SiteDetail | null; onClose: () => void; onSaved: (message: string, id: string) => void;
}) {
  const k = KIND[kind];
  const locations = useLocationChoices(me);
  const defaultLocation = locations.list.length === 1 ? locations.list[0]!.id : "";
  const [v, setV] = useState<Values>(() => initialValues(record, defaultLocation));
  const [errors, setErrors] = useState<Errors>({});
  const formRef = useRef<HTMLFormElement>(null);
  const failed = useFocusAfterFailure(formRef);
  const { busy, error, setError, run } = useSubmit((e) => sitesError(e, k.one));
  // The single location arrives with the lookups; pick it once loaded.
  if (!v.locationId && defaultLocation) setV((x) => ({ ...x, locationId: defaultLocation }));

  const set = <K extends keyof Values>(key: K) => (e: { target: { value: string } }) => {
    setV((x) => ({ ...x, [key]: e.target.value }));
    if (errors[key]) setErrors((x) => ({ ...x, [key]: undefined }));
  };
  const reset = () => { setV(initialValues(record, defaultLocation)); setErrors({}); setError(""); };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const errs = validateSite(kind, v);
    setErrors(errs);
    if (Object.keys(errs).length) { setError(""); failed(); return; }
    void run(async () => {
      try {
        if (record) {
          await sitesApi.update(kind, record.id, record.rowVersion, toBody(kind, v, true));
          onSaved(`${v.name.trim()} saved.`, record.id);
        } else {
          const created = await sitesApi.create(kind, toBody(kind, v, false) as never);
          onSaved(`${v.name.trim()} added.`, created?.id ?? "");
        }
      } catch (err) {
        failed();
        throw err;
      }
    });
  };

  const text = (key: keyof Values, label: string, icon?: typeof MapPin, extra: Record<string, unknown> = {}) => (
    <Field label={label} error={errors[key]}>
      {(p) => (
        <IconInput icon={icon}>
          <input {...p} value={v[key]} onChange={set(key)} {...extra} />
        </IconInput>
      )}
    </Field>
  );

  const facility = kind === "facilities";
  const location = (
    <Field label="Location" error={errors.locationId}>
      {(p) => (
        <select {...p} value={v.locationId} onChange={set("locationId")} disabled={locations.loading}>
          <option value="">{locations.loading ? "Loading…" : "Choose…"}</option>
          {locations.list.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      )}
    </Field>
  );
  const status = record ? (
    <Field label="Status">
      {(p) => (
        <select {...p} value={v.status} onChange={set("status")}>
          <option value="active">Active</option><option value="inactive">Inactive</option>
        </select>
      )}
    </Field>
  ) : null;
  return (
    <Dialog title={record ? `Edit ${k.one}` : `Add ${k.one}`} onClose={onClose} className={facility ? "xwide" : "wide"}>
      <form ref={formRef} onSubmit={submit} noValidate>
        <div className={facility ? "formgrid cols3" : "formgrid cols2"}>
          {text("name", `${k.One} name`, Building2, { maxLength: 200, "data-autofocus": true, autoComplete: "organization" })}
          {!facility && location}
          {text("street", "Street", MapPin, { maxLength: 200, autoComplete: "street-address" })}
          {text("zip", "Zip code", MapPin, { maxLength: 20, autoComplete: "postal-code", inputMode: "numeric" })}
          {text("city", "City", MapPin, { maxLength: 100, autoComplete: "address-level2" })}
          {text("state", "State", MapPin, { maxLength: 100, autoComplete: "address-level1" })}
          {text("country", "Country", Globe2, { maxLength: 100, autoComplete: "country-name" })}
          {!facility && status}
          {facility && (
            <>
              {text("ownerName", "Owner name", UserRound, { maxLength: 200 })}
              {text("ownerEmail", "Owner email", Mail, { type: "email", maxLength: 254 })}
              {text("ownerPhone", "Owner phone", Phone, { type: "tel", maxLength: 40 })}
              <Field label="Rent" error={errors.rent}>
                {(p) => <IconInput prefix="$"><input {...p} value={v.rent} onChange={set("rent")} inputMode="decimal" placeholder="0.00" /></IconInput>}
              </Field>
              <Field label="Fee frequency">
                {(p) => (
                  <select {...p} value={v.feeFrequency} onChange={set("feeFrequency")}>
                    <option value="">Not set</option>
                    {(Object.keys(FEE_LABELS) as FeeFrequency[]).map((f) => <option key={f} value={f}>{FEE_LABELS[f]}</option>)}
                  </select>
                )}
              </Field>
              {text("capacity", "Capacity", Ruler, { inputMode: "numeric", placeholder: "People" })}
              {text("beds", "Beds", BedDouble, { inputMode: "numeric" })}
              {text("baths", "Baths", Bath, { inputMode: "decimal" })}
              {location}
            </>
          )}
          <div className="spanall">
            <Field label="Notes">
              {(p) => <textarea {...p} rows={3} maxLength={2000} value={v.notes} onChange={set("notes")} />}
            </Field>
          </div>
          {facility && (
            <>
              {text("startDate", "Lease start", CalendarDays, { type: "date" })}
              {text("endDate", "Lease end", CalendarDays, { type: "date" })}
              {status}
            </>
          )}
        </div>
        {error && <p className="error formerr" role="alert" tabIndex={-1}>{error}</p>}
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn" onClick={reset}>Reset</button>
          <button type="submit" className="btn primary" disabled={busy} aria-busy={busy || undefined}>
            {busy ? "Working…" : record ? "Save changes" : `Add ${k.one}`}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** Edit from the list: loads the full record (notes, owner contact, row version) first. */
export function EditSiteDialog({ kind, id, me, onClose, onSaved }: {
  kind: SiteKind; id: string; me: Pick<Me, "roles">; onClose: () => void; onSaved: (message: string, id: string) => void;
}) {
  const q = useQuery({ queryKey: siteKeys.detail(kind, id), queryFn: () => sitesApi.get(kind, id) });
  if (q.data) return <SiteFormDialog kind={kind} me={me} record={q.data} onClose={onClose} onSaved={onSaved} />;
  return (
    <Dialog title={`Edit ${KIND[kind].one}`} onClose={onClose}>
      {q.error ? <p className="error" role="alert">{sitesError(q.error, KIND[kind].one)}</p> : <p className="muted">Loading…</p>}
      <div className="actions"><button type="button" className="btn" onClick={onClose}>Cancel</button></div>
    </Dialog>
  );
}
