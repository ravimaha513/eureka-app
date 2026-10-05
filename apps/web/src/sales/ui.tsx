import { useCallback, useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { X } from "lucide-react";
import type { Candidate } from "../api";
import { statusLabel } from "./salesApi";

/** Phone cell content: masked numbers get a visually hidden explanation for screen readers. */
export function Phone({ c }: { c: Pick<Candidate, "phone" | "phoneMasked"> }) {
  if (!c.phone) return <span className="muted">—</span>;
  if (!c.phoneMasked) return <span>{c.phone}</span>;
  return (
    <span className="maskedphone" title="Masked: not your team's candidate">
      <span className="masked" aria-hidden="true">{c.phone}</span>
      <span className="sr-only">Phone hidden, ends in {c.phone.replace(/\D/g, "").slice(-2)}. Not your team's candidate.</span>
    </span>
  );
}

export const StatusBadge = ({ status }: { status: string }) => <span className={`badge ${status}`}>{statusLabel(status)}</span>;

export const OpenToAllBadge = () => <span className="badge all_teams">Open to all teams</span>;

export const Priority = ({ p }: { p: string }) => <span className={`prio ${p}`}>{p}</span>;

export const fmtDate = (iso: string | null | undefined) =>
  iso ? new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { dateStyle: "medium" }) : "—";

/** A labelled form control with an announced, programmatically linked error message. */
export function Field({ label, error, hint, children }: {
  label: string; error?: string; hint?: string;
  children: (p: { id: string; "aria-invalid"?: true; "aria-describedby"?: string }) => ReactNode;
}) {
  const id = useId();
  const errId = `${id}-err`, hintId = `${id}-hint`;
  const describedBy = [hint && hintId, error && errId].filter(Boolean).join(" ") || undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children({ id, "aria-invalid": error ? true : undefined, "aria-describedby": describedBy })}
      {hint && <small id={hintId} className="hint fieldhint">{hint}</small>}
      {error && <small id={errId} className="error fielderr">{error}</small>}
    </div>
  );
}

/**
 * Focus after a failed submit (validation or API error): once React has
 * committed this round's errors, focus the first invalid field, or else the
 * announced form error (role="alert" from DialogActions). Returns the trigger
 * to call on every failure. Running in an effect means stale marks from an
 * earlier attempt and the busy-disabled submit button never win.
 */
export function useFocusAfterFailure(formRef: RefObject<HTMLFormElement>) {
  const [failures, setFailures] = useState(0);
  useEffect(() => {
    if (failures === 0) return;
    const form = formRef.current;
    (form?.querySelector<HTMLElement>("[aria-invalid='true']") ?? form?.querySelector<HTMLElement>(".formerr"))?.focus();
  }, [failures, formRef]);
  return useCallback(() => setFailures((n) => n + 1), []);
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Side drawer (modal): focus moves in on open, Tab is trapped, Escape and the
 * backdrop close it, and focus returns to the opener. Same contract as admin/Dialog.
 */
export function Drawer({ title, onClose, children, suspended = false, wide = false, closeLabel = "Close quick view", isSuspended }: {
  title: string; onClose: () => void; children: ReactNode;
  /** True while a dialog opened from the drawer is on top: the drawer then leaves Escape and focus to it. */
  suspended?: boolean;
  wide?: boolean;
  closeLabel?: string;
  /**
   * Checked at event time in addition to `suspended`, for dialogs that open from deep inside
   * the drawer (portaled to the body) before the drawer has re-rendered.
   */
  isSuspended?: () => boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const suspendedProp = useRef(suspended);
  suspendedProp.current = suspended;
  const isSuspendedRef = useRef(isSuspended);
  isSuspendedRef.current = isSuspended;
  const suspendedRef = { get current() { return suspendedProp.current || Boolean(isSuspendedRef.current?.()); } };

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const node = ref.current!;
    (node.querySelector<HTMLElement>("[data-autofocus]") ?? node).focus();
    const onKey = (e: KeyboardEvent) => {
      if (suspendedRef.current) return;
      if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); onCloseRef.current(); }
    };
    const onFocusIn = (e: FocusEvent) => { if (!suspendedRef.current && !node.contains(e.target as Node)) node.focus(); };
    document.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", onFocusIn);
      if (opener && document.contains(opener)) opener.focus();
    };
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const items = [...ref.current!.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (items.length === 0) { e.preventDefault(); return; }
    const first = items[0]!, last = items[items.length - 1]!;
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  return (
    <div className="backdrop drawerback" onMouseDown={(e) => { if (e.target === e.currentTarget && !suspendedRef.current) onClose(); }}>
      <div ref={ref} className={`drawer${wide ? " wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={onKeyDown}
        aria-hidden={suspended || undefined}>
        <header className="drawerhead">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="iconbtn" onClick={onClose} aria-label={closeLabel}><X size={18} aria-hidden="true" /></button>
        </header>
        {children}
      </div>
    </div>
  );
}
