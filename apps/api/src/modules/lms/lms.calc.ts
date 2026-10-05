/** Derived progress (docs/lms-api.md "Derived at read time"). All inputs are percents 0..100; outputs are unrounded. */
export interface ModuleLite { id: string; durationMinutes: number }

/** Duration-weighted mean over modules; plain mean when every duration is 0; 0 without modules. */
export function coursePercent(modules: ModuleLite[], percentOf: (moduleId: string) => number): number {
  if (modules.length === 0) return 0;
  const total = modules.reduce((s, m) => s + m.durationMinutes, 0);
  if (total === 0) return modules.reduce((s, m) => s + percentOf(m.id), 0) / modules.length;
  return modules.reduce((s, m) => s + m.durationMinutes * percentOf(m.id), 0) / total;
}

/** Mean of the course percents; 0 without courses. */
export function studentPercent(coursePercents: number[]): number {
  return coursePercents.length === 0 ? 0 : coursePercents.reduce((s, p) => s + p, 0) / coursePercents.length;
}

export const round = (n: number): number => Math.round(n);

/** Batch status from dates and progress (docs/lms-api.md). `allDone`: every student finished every module. */
export function batchStatus(today: string, start: string, end: string, allDone: boolean): "not_started" | "in_progress" | "completed" {
  if (today < start) return "not_started";
  return today > end || allDone ? "completed" : "in_progress";
}
