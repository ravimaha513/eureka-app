import { Dialog, DialogActions, useSubmit } from "../ui/Dialog";

/**
 * Confirm taking someone out of a team (docs/admin-api.md AD-14). Used by the
 * Users & Access team drawer and by My team; `remove` calls the matching endpoint.
 */
export function RemoveMemberDialog({ teamName, leadName, member, remove, errorText, onClose, onDone }: {
  teamName: string; leadName: string; member: { displayName: string };
  remove: () => Promise<{ movedCandidates: number }>; errorText: (e: unknown) => string;
  onClose: () => void; onDone: (msg: string) => void;
}) {
  const { busy, error, run } = useSubmit(errorText);
  return (
    <Dialog title={`Remove ${member.displayName} from ${teamName}?`} onClose={onClose}>
      <form onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          const { movedCandidates: n } = await remove();
          onDone(`Removed ${member.displayName} from ${teamName}.`
            + (n ? ` ${n} candidate${n === 1 ? "" : "s"} reassigned to ${leadName}.` : ""));
        });
      }}>
        <p>{member.displayName} will have no team. You can add them to a team again later.</p>
        <p className="hint">Their candidates stay with <b>{teamName}</b> and go to its lead, <b>{leadName}</b>.</p>
        <DialogActions onCancel={onClose} submitLabel="Remove" busy={busy} error={error} danger />
      </form>
    </Dialog>
  );
}
