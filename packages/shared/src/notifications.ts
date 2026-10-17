/**
 * In-app notification types a user can switch off in Settings (interviews-settings,
 * migration 0081). Lists exactly the worker's in-app types (EVENT_SPECS with
 * inApp: true; a test checks it). Mandatory types cannot be switched off: the
 * database refuses such a preference row (eureka.notification_preference_guard,
 * whose list a test compares with this one).
 */
export interface NotificationTypeInfo {
  type: string;
  label: string;
  description: string;
  mandatory: boolean;
}

export const NOTIFICATION_PREFERENCE_TYPES: readonly NotificationTypeInfo[] = [
  { type: "work_authorization.expiring", label: "Work authorization expiring", description: "Expiry notices 90, 60 and 30 days before a work authorization ends.", mandatory: true },
  { type: "checklist.item_overdue", label: "Paperwork item overdue", description: "A paperwork checklist item is past its due date.", mandatory: true },
  { type: "employee.benched", label: "Employee on the bench", description: "An assignment ended and the employee is on the bench.", mandatory: false },
  { type: "employee.exited", label: "Employee exited", description: "An employee left the company.", mandatory: false },
  { type: "assignment.ending_soon", label: "Assignment ending soon", description: "An assignment is close to its planned end date.", mandatory: false },
  { type: "employee.bench_time", label: "Bench-time reminder", description: "A candidate has been on the bench for the configured number of days.", mandatory: false },
  { type: "candidate.assigned", label: "Candidate assigned to a team", description: "A candidate moved to a team you lead.", mandatory: false },
  { type: "application.received", label: "New job application", description: "An applicant applied to a job you manage or to an HR-managed opening.", mandatory: false },
  // interview-alerts package (migrations 0086-0089)
  { type: "interview.requested", label: "Interview requested", description: "An interview was scheduled, rescheduled or cancelled (interview coordinators).", mandatory: false },
  { type: "contract.created", label: "New contract", description: "A contract (MSA, PO, SOW) was added to a placement, so invoicing and the closure documents can start.", mandatory: false },
  { type: "staff.birthdays_today", label: "Staff birthdays", description: "The morning list of staff birthdays (CEO).", mandatory: false },
  // payments (gap L1)
  { type: "payment.first_received", label: "First payment received", description: "Accounts recorded the first payment for a placement of yours.", mandatory: false },
  { type: "payment.delayed", label: "Payment delayed", description: "A vendor payment for a placement of yours is past its expected date.", mandatory: false },
  // performance (migration 0112)
  { type: "performance.below_target", label: "Activity below target", description: "A recruiter's target period ended with activity below target (the recruiter, their lead and manager).", mandatory: false },
  { type: "chat.direct_message", label: "New direct message", description: "Someone wrote to you in Chat and you have not looked at the conversation for 10 minutes.", mandatory: false },
];

export const MANDATORY_NOTIFICATION_TYPES: readonly string[] =
  NOTIFICATION_PREFERENCE_TYPES.filter((t) => t.mandatory).map((t) => t.type);
