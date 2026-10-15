import { useEffect, useState } from "react";
import { readWorkspaceStatus, summarize, type WorkspaceStatus } from "./status";

const REFRESH_MS = 15000;

type Props = {
  workspaceId: string;
  /** Opens the diagnostics tool. */
  onOpen: () => void;
  /** Bumped by tools that change work, so the bar refreshes without waiting for the timer. */
  refreshKey?: number;
};

/** Top-bar job status: LED plus words from the scoped status read; never a bare color. */
export function StatusIndicator({ workspaceId, onOpen, refreshKey = 0 }: Props) {
  const [status, setStatus] = useState<WorkspaceStatus | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    const controller = new AbortController();
    setStatus(null); setFailure(null);
    async function load() {
      if (document.visibilityState === "hidden") return;
      try {
        const next = await readWorkspaceStatus(workspaceId, controller.signal);
        if (current) { setStatus(next); setFailure(null); }
      } catch (reason) {
        // A failed read is unknown, never carried over as the last good state.
        if (current && !controller.signal.aborted) { setStatus(null); setFailure(reason instanceof Error ? reason.message : "Unavailable."); }
      }
    }
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => { current = false; controller.abort(); window.clearInterval(timer); };
  }, [workspaceId, refreshKey]);

  const headline = summarize(status, failure);
  return <span className="sb-status" role="status" aria-label="Job status">
    <span className="sb-led" data-state={headline.led} aria-hidden="true" />
    <button type="button" className="sb-search" style={{ width: "auto", maxWidth: "none", marginLeft: 0, borderBottom: 0, color: "inherit" }}
      title={failure ?? "Open status and recovery"} aria-label={`${headline.words}. Open status and recovery`} onClick={onOpen}>
      <span className="sb-silk">{headline.words}</span>
    </button>
  </span>;
}
