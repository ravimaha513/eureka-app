import type { MouseEvent, ReactNode } from "react";
import { navigate } from "../lib/router";
import { screenPath } from "../nav";

/** Record kinds and the screen that opens one at /<screen>/<id>. */
export const RECORD_SCREENS = {
  candidate: "candidates",
  placement: "placements",
  interview: "interviews",
  application: "applications",
  paperwork: "paperwork",
  training: "training",
  // No /<screen>/<id> route yet: these need `onOpen` (e.g. open a drawer); the href is the list screen.
  submission: "submissions",
  job: "jobs",
  employee: "employees",
} as const;
export type RecordKind = keyof typeof RECORD_SCREENS;
const ROUTED: ReadonlySet<RecordKind> = new Set(["candidate", "placement", "interview", "application", "paperwork", "training"]);

/**
 * Cross-record link ("Jane Doe" in a submissions row, a placement in an interview drawer).
 * Renders a real <a href> (so middle-click / Ctrl-click / copy link work) that, on a plain
 * left click, navigates in-app with navigate(), or calls `onOpen(id)` when given (open a drawer
 * on this screen instead). Without permission (`allowed={false}`), or for a kind with no
 * route and no `onOpen`, it renders the plain text: never a link to a 403/404.
 *
 *   <RecordLink kind="candidate" id={s.candidate.id} allowed={caps.includes("candidate:read")}>{s.candidate.name}</RecordLink>
 *   <RecordLink kind="submission" id={s.id} onOpen={setOpenId}>{s.title}</RecordLink>
 *
 * Styling: `.recordlink` (ink link, underline on hover; inherits weight, so wrap in <b> for a name cell).
 */
export function RecordLink({ kind, id, allowed = true, onOpen, children, className, label }: {
  kind: RecordKind;
  id: string | null | undefined;
  /** The viewer may open this record (UI hint only; the API decides). */
  allowed?: boolean;
  /** Open in place instead of navigating (still gets the href for new-tab use). */
  onOpen?: (id: string) => void;
  children: ReactNode;
  className?: string;
  /** Accessible name when the text alone is ambiguous, e.g. "Open placement of Jane Doe". */
  label?: string;
}) {
  const routed = ROUTED.has(kind);
  if (!id || !allowed || (!routed && !onOpen)) return <span className={className}>{children}</span>;
  const href = screenPath(RECORD_SCREENS[kind], routed ? id : null);
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    if (onOpen) onOpen(id);
    else navigate(href);
  };
  return (
    <a href={href} className={["recordlink", className ?? ""].filter(Boolean).join(" ")} aria-label={label} onClick={onClick}>
      {children}
    </a>
  );
}
