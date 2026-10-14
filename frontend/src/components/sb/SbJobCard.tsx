import type { ReactNode } from "react";
import { SbStatus, type SbLed } from "./SbStatus";
import "./sb-components.css";

export type JobState = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "review";

export const JOB_LED: Record<JobState, { led: SbLed; pulse?: "breathe" | "blink" }> = {
  queued: { led: "active", pulse: "breathe" }, running: { led: "active", pulse: "blink" },
  succeeded: { led: "info" }, failed: { led: "failed" }, cancelled: { led: "not-evaluated" }, review: { led: "review" },
};

/**
 * One job. Progress is shown only as "step n of m" when the runner reported both
 * numbers; there is no percentage and no invented step list.
 */
export function SbJobCard({ title, state, stateWords, dimension = "job", step, detail, actions }: {
  title: string; state: JobState; stateWords: string; dimension?: string;
  step?: { done: number; total: number } | null; detail?: ReactNode; actions?: ReactNode;
}) {
  const known = step && Number.isFinite(step.done) && Number.isFinite(step.total) && step.total > 0 ? step : null;
  const words = known && state === "running" ? `${stateWords} · step ${known.done} of ${known.total}` : stateWords;
  return <div className="sb-job" data-state={state}>
    <span className="sb-job-title">{title}</span>
    <SbStatus dimension={dimension} value={words} {...JOB_LED[state]} />
    {detail && <span className="sb-job-detail">{detail}</span>}
    {actions && <span className="sb-job-actions">{actions}</span>}
  </div>;
}
