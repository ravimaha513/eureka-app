import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { adminApi, type RequestStatus, type RoleRequest } from "./adminApi";
import { friendlyError } from "./errors";
import { fmtDate, keys, useAccess, useMeta } from "./shared";

/** Why the current admin may not approve this request (AD-3), or null. */
function selfReason(r: RoleRequest, meId: string): string | null {
  if (r.user.id === meId) return "This request is for you. Another admin has to approve it.";
  if (r.requestedBy.id === meId) return "You requested this. Another admin has to approve it.";
  return null;
}

export function ApprovalsTab() {
  const { me, announce } = useAccess();
  const qc = useQueryClient();
  const meta = useMeta();
  const [status, setStatus] = useState<RequestStatus>("pending");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const q = useQuery({ queryKey: [...keys.requests, status], queryFn: () => adminApi.roleRequests(status) });
  const locName = (id: string | null) => (id ? meta.data?.locations.find((l) => l.id === id)?.name ?? "location" : null);

  const decide = async (r: RoleRequest, verdict: "approve" | "reject") => {
    setBusyId(r.id); setError("");
    try {
      await (verdict === "approve" ? adminApi.approve(r.id) : adminApi.reject(r.id));
      announce(verdict === "approve"
        ? `Approved ${r.roleLabel} for ${r.user.displayName}.`
        : `Rejected ${r.roleLabel} for ${r.user.displayName}.`);
      void qc.invalidateQueries({ queryKey: keys.requests });
      void qc.invalidateQueries({ queryKey: keys.users });
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <div className="toolbar">
        <div className="field inline">
          <label htmlFor="rq-status">Show</label>
          <select id="rq-status" value={status} onChange={(e) => setStatus(e.target.value as RequestStatus)}>
            <option value="pending">Pending</option><option value="approved">Approved</option>
            <option value="rejected">Rejected</option><option value="expired">Expired</option>
          </select>
        </div>
        <p className="hint push">Restricted roles need a second admin: not the person who asked, and not the person receiving the role.</p>
      </div>
      {error && <p className="error banner" role="alert">{error}</p>}
      <div className="card">
        {q.isLoading ? <p className="empty">Loading…</p> : q.error ? <p className="empty error" role="alert">{friendlyError(q.error)}</p> : (
          <table aria-label="Role requests">
            <thead><tr><th>Person</th><th>Role</th><th>Requested by</th><th>Requested</th>{status === "pending" ? <th><span className="sr-only">Actions</span></th> : <th>Decided</th>}</tr></thead>
            <tbody>
              {q.data!.items.map((r) => {
                const reason = selfReason(r, me.id);
                const noteId = `rq-note-${r.id}`;
                const loc = locName(r.locationId);
                return (
                  <tr key={r.id}>
                    <td><b>{r.user.displayName}</b>{r.user.id === me.id && <span className="tag">you</span>}<small className="block">{r.user.email}</small></td>
                    <td>{r.roleLabel}{loc && <small className="block">{loc}</small>}</td>
                    <td>{r.requestedBy.displayName}{r.requestedBy.id === me.id && <span className="tag">you</span>}</td>
                    <td>{fmtDate(r.requestedAt)}</td>
                    {status === "pending" ? (
                      <td className="rowactions">
                        <button className="btn sm primary" disabled={!!reason || busyId === r.id} aria-describedby={reason ? noteId : undefined}
                          aria-label={`Approve ${r.roleLabel} for ${r.user.displayName}`} onClick={() => void decide(r, "approve")}>Approve</button>
                        <button className="btn sm danger" disabled={busyId === r.id}
                          aria-label={`Reject ${r.roleLabel} for ${r.user.displayName}`} onClick={() => void decide(r, "reject")}>Reject</button>
                        {reason && <small id={noteId} className="block muted">{reason}</small>}
                      </td>
                    ) : (
                      <td>{r.decidedBy?.displayName ?? "—"}<small className="block">{fmtDate(r.decidedAt)}</small></td>
                    )}
                  </tr>
                );
              })}
              {q.data!.items.length === 0 && <tr><td colSpan={5} className="empty">No {status} requests.</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
