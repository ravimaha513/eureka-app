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
  { type: "chat.direct_message", label: "New direct message", description: "Someone wrote to you in Chat and you have not looked at the conversation for 10 minutes.", mandatory: false },
];

export const MANDATORY_NOTIFICATION_TYPES: readonly string[] =
  NOTIFICATION_PREFERENCE_TYPES.filter((t) => t.mandatory).map((t) => t.type);
