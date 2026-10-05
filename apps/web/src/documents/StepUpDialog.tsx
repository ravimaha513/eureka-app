import { useId } from "react";
import { useQuery } from "@tanstack/react-query";
import { ApiError } from "../api";
import { Dialog, DialogActions, useSubmit } from "../admin/Dialog";
import { documentKeys, documentsApi, pageNav, returnPath } from "./documentsApi";

function stepUpError(e: unknown): string {
  if (!(e instanceof ApiError)) return e instanceof Error ? e.message : "Something went wrong.";
  if (e.status === 401) return "Your session ended. Sign in again.";
  if (e.status === 429) return "Too many attempts. Wait a few minutes and try again.";
  return e.detail ?? "Could not confirm it's you. Try again.";
}

/**
 * "Confirm it's you" before opening a restricted document (design A6.1
 * step-up). With Google, the browser goes to Google for a fresh sign-in and
 * comes back to this page; in development a button grants it directly.
 * `onConfirmed` runs after a development step-up (Google returns by redirect).
 */
export function StepUpDialog({ onClose, onConfirmed, purpose, logNote }: {
  onClose: () => void; onConfirmed: () => void;
  /** What the confirmation unlocks, e.g. "show utility passwords" (default: restricted documents). */
  purpose?: string;
  logNote?: string;
}) {
  const bodyId = useId();
  const status = useQuery({ queryKey: documentKeys.stepUp, queryFn: documentsApi.stepUpStatus });
  const { busy, error, run } = useSubmit(stepUpError);
  const mode = status.data?.mode;
  const minutes = status.data?.ttlMinutes ?? 10;

  const confirm = () => run(async () => {
    if (mode === "dev") {
      await documentsApi.devStepUp();
      onConfirmed();
    } else {
      const { redirectUrl } = await documentsApi.startStepUp(returnPath());
      pageNav.assign(redirectUrl); // a full-page navigation to Google
    }
  });

  return (
    <Dialog title="Confirm it's you" onClose={onClose} describedBy={bodyId}>
      <form onSubmit={(e) => { e.preventDefault(); void confirm(); }}>
        <div id={bodyId} className="dialogbody">
          <p>{purpose
            ? `Sign in again to ${purpose} for the next ${minutes} minutes.`
            : `This is a restricted document. Sign in again to open restricted documents for the next ${minutes} minutes.`}</p>
          {mode === "dev" && <p className="muted">Development sign-in: no password is asked.</p>}
          <p className="muted">{logNote ?? "Each document you open is recorded in its access log."}</p>
        </div>
        <DialogActions onCancel={onClose} busy={busy || status.isLoading} error={error}
          submitLabel={mode === "dev" ? "Confirm (development)" : "Continue with Google"} />
      </form>
    </Dialog>
  );
}
