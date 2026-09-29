import { useEffect, useId, useRef, useState, type ReactNode } from "react";

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Modal dialog: moves focus inside on open, traps Tab, closes on Escape and
 * returns focus to the element that opened it.
 */
export function Dialog({ title, onClose, children, describedBy }: {
  title: string; onClose: () => void; children: ReactNode; describedBy?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const node = ref.current!;
    const first = node.querySelector<HTMLElement>("[data-autofocus]") ?? node.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? node).focus();
    // Escape works even when focus fell to <body> (e.g. the submit button was
    // disabled while busy), and focus that escapes the dialog is pulled back.
    const onDocKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); onCloseRef.current(); }
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
    <div className="backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}
        aria-describedby={describedBy} tabIndex={-1} onKeyDown={onKeyDown}>
        <h2 id={titleId}>{title}</h2>
        {children}
      </div>
    </div>
  );
}

/** Footer with Cancel + primary action; the error (if any) is announced. */
export function DialogActions({ onCancel, submitLabel, busy, disabled, error, danger }: {
  onCancel: () => void; submitLabel: string; busy?: boolean; disabled?: boolean; error?: string; danger?: boolean;
}) {
  return (
    <>
      {error && <p className="error formerr" role="alert">{error}</p>}
      <div className="actions">
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
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
