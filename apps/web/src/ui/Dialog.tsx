import { useEffect, useId, useRef, useState, type ReactNode } from "react";

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Modal dialog: moves focus inside on open, traps Tab, closes on Escape and
 * returns focus to the element that opened it.
 *
 * `dirty`: while the form has unsaved input, Escape and a backdrop click do not close; they show
 * an inline "Discard unsaved changes?" bar (Keep editing / Discard) with focus on Keep editing.
 * Escape again keeps editing. Explicit Cancel/close buttons still call `onClose` directly.
 * The last `.actions` footer (DialogActions) sticks to the bottom while the dialog scrolls.
 */
export function Dialog({ title, onClose, children, describedBy, className, wide = false, dirty = false }: {
  title: string; onClose: () => void; children: ReactNode; describedBy?: string; wide?: boolean;
  /** Extra classes on the dialog box. */
  className?: string;
  /** Unsaved changes: confirm before Escape / backdrop click discard them. */
  dirty?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const confirmId = useId();
  const [confirming, setConfirming] = useState(false);
  const keepBtn = useRef<HTMLButtonElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const keepEditing = () => {
    setConfirming(false);
    const back = returnTo.current;
    requestAnimationFrame(() => (back && ref.current?.contains(back) ? back : ref.current)?.focus());
  };
  /** Escape / backdrop: close, or ask first while dirty (Escape while asking keeps editing). */
  const requestClose = () => {
    if (!dirtyRef.current) { onCloseRef.current(); return; }
    if (confirmingRef.current) { keepEditing(); return; }
    returnTo.current = document.activeElement as HTMLElement | null;
    setConfirming(true);
  };
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const confirmingRef = useRef(confirming);
  confirmingRef.current = confirming;
  const requestCloseRef = useRef(requestClose);
  requestCloseRef.current = requestClose;
  useEffect(() => { if (confirming) keepBtn.current?.focus(); }, [confirming]);
  useEffect(() => { if (!dirty) setConfirming(false); }, [dirty]);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const node = ref.current!;
    const first = node.querySelector<HTMLElement>("[data-autofocus]") ?? node.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? node).focus();
    // Escape works even when focus fell to <body> (e.g. the submit button was
    // disabled while busy), and focus that escapes the dialog is pulled back.
    const onDocKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); requestCloseRef.current(); }
    };
    const onFocusIn = (e: FocusEvent) => {
      if (!node.contains(e.target as Node)) node.focus();
    };
    document.addEventListener("keydown", onDocKey);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("keydown", onDocKey);
      document.removeEventListener("focusin", onFocusIn);
      if (opener && document.contains(opener)) opener.focus();
    };
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") return; // handled on document
    if (e.key !== "Tab") return;
    const items = [...ref.current!.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (items.length === 0) { e.preventDefault(); return; }
    const first = items[0]!, last = items[items.length - 1]!;
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  return (
    <div className="backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) requestClose(); }}>
      <div ref={ref} className={["dialog", wide ? "wide" : "", className ?? ""].filter(Boolean).join(" ")} role="dialog" aria-modal="true" aria-labelledby={titleId}
        aria-describedby={describedBy} tabIndex={-1} onKeyDown={onKeyDown}>
        <h2 id={titleId}>{title}</h2>
        {children}
        {confirming && (
          <div className="dialog-discard" role="group" aria-labelledby={confirmId}>
            <p id={confirmId} role="alert">Discard unsaved changes?</p>
            <button ref={keepBtn} type="button" className="btn" onClick={keepEditing}>Keep editing</button>
            <button type="button" className="btn danger" onClick={() => onCloseRef.current()}>Discard</button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Footer with Cancel + primary action; the error (if any) is announced. */
export function DialogActions({ onCancel, cancelLabel = "Cancel", submitLabel, busy, disabled, error, danger }: {
  onCancel: () => void; cancelLabel?: string; submitLabel: string; busy?: boolean; disabled?: boolean; error?: string; danger?: boolean;
}) {
  return (
    <>
      {/* tabIndex -1: a form can move focus here after a failed submit with no field to point at. */}
      {error && <p className="error formerr" role="alert" tabIndex={-1}>{error}</p>}
      <div className="actions">
        <button type="button" className="btn" onClick={onCancel}>{cancelLabel}</button>
        <button type="submit" className={`btn ${danger ? "danger" : "primary"}`} disabled={busy || disabled} aria-busy={busy || undefined}>
          {busy ? "Working…" : submitLabel}
        </button>
      </div>
    </>
  );
}

/** Runs an async submit with busy/error state; errors are formatted for display. */
export function useSubmit(formatError: (e: unknown) => string) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await fn(); } catch (err) { setError(formatError(err)); } finally { setBusy(false); }
  };
  return { busy, error, setError, run };
}

/** Yes/no confirmation that runs `action` and closes on success; server errors stay in the dialog. */
export function ConfirmDialog({ title, children, confirmLabel, danger, action, onClose, onDone, formatError }: {
  title: string; children: ReactNode; confirmLabel: string; danger?: boolean;
  action: () => Promise<unknown>; onClose: () => void; onDone: () => void; formatError: (e: unknown) => string;
}) {
  const { busy, error, run } = useSubmit(formatError);
  const bodyId = useId();
  return (
    <Dialog title={title} onClose={onClose} describedBy={bodyId}>
      <form onSubmit={(e) => { e.preventDefault(); void run(async () => { await action(); onDone(); }); }}>
        <div id={bodyId} className="dialogbody">{children}</div>
        <DialogActions onCancel={onClose} submitLabel={confirmLabel} busy={busy} error={error} danger={danger} />
      </form>
    </Dialog>
  );
}
