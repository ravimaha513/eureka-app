import { ApiError, commonProblem } from "../api";

/** Friendly text for the RFC 9457 `detail` codes of the pipeline API (submissions, interviews, placements). */
export const PIPELINE_ERRORS: Record<string, string> = {
  submission_not_selected: "A placement can only be created from a submission marked Selected. Move the submission to Selected first.",
  placement_exists: "This submission already has an active placement. Open it from Placements instead of creating another.",
  invalid_transition: "That status change isn't allowed from the current status. Refresh to see the latest status.",
  reason_required: "Give a reason for this status change.",
  rejection_reason_required: "Give a rejection reason.",
  rejection_reason_not_allowed: "A rejection reason can only be given when rejecting.",
  candidate_not_available: "This candidate can't be placed in their current status (for example on hold or already placed). Move them to Active first.",
  candidate_on_assignment: "The candidate already joined through another placement. Back this placement out, or end the other assignment first.",
  round_rejected: "Another round of this submission was rejected. Reset that round to pending first if the client is moving ahead anyway.",
  interview_not_held: "This round was cancelled or never got an invite, so it can't be cleared.",
  submission_closed: "This submission is closed (selected, rejected or withdrawn) and can't be changed.",
  idempotency_key_required: "The request was missing its safety key. Close the dialog and try again.",
  // 409: the first request with this key already committed; only POST /placements sends a key.
  idempotency_key_reused: "This placement was already created. Refresh the list to see it.",
  not_permitted: "You don't have permission to do that for this record.",
  interview_conflict: "This interview overlaps another interview for the candidate. Pick a different time.",
  consent_required: "Recording links need captured consent.",
  field_not_permitted: "You can't change one of these fields.",
  submission_placed: "A placement is in progress from this submission, so its details are held by the placement. Correct them in Placements.",
  client_locked: "Interviews were booked with this client, so the client can't change. Log a new submission for the other client.",
  invalid_job_title: "Enter a job title of up to 160 characters.",
  invalid_rate: "Enter an hourly rate between 0 and 1000.",
  invalid_submitted_at: "The submitted time can't be in the future.",
  client_not_found: "That client no longer exists. Pick another one.",
  vendor_not_found: "That vendor no longer exists. Pick another one.",
  job_not_found: "That job isn't available to you any more. Pick another job or none.",
  job_client_mismatch: "That job belongs to a different client. Pick a job of this client, or none.",
  job_not_open: "That job is no longer open. Pick an open job or none.",
  server_managed_field: "One of these fields is set by the system and can't be changed.",
};

export type PipelineContext = "submission" | "placement" | "interview" | "createPlacement" | "generic";

export function pipelineError(e: unknown, ctx: PipelineContext = "generic"): string {
  if (!(e instanceof ApiError)) return e instanceof Error ? e.message : "Something went wrong.";
  const common = commonProblem(e);
  if (common) return common;
  if (e.detail && PIPELINE_ERRORS[e.detail]) return PIPELINE_ERRORS[e.detail]!;
  switch (e.status) {
    case 401: return "Your session ended. Sign in again.";
    case 403: return "You don't have permission to do that for this record.";
    case 404: return ctx === "placement" ? "This placement doesn't exist or is outside your scope."
      : ctx === "interview" ? "That submission isn't available from your account."
      : "This submission doesn't exist or is outside your scope.";
    case 409: return ctx === "createPlacement" ? PIPELINE_ERRORS.placement_exists!
      : ctx === "interview" ? PIPELINE_ERRORS.interview_conflict!
      : "A conflicting change was made. Refresh and try again.";
    case 422:
      if (e.errors?.length) return "Some fields need attention. Check the highlighted fields.";
      return "The server rejected this change. Check the values and try again.";
    case 429: return e.message;
    default: return e.detail ?? e.title ?? e.message ?? "Something went wrong.";
  }
}
