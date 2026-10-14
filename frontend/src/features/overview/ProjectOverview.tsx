import { Alert, Button, Text, Title } from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import { describeAccess, isReadOnly } from "../shell/areas";
import { readProjectWork, type ProjectWork, type WorkRead } from "./work";

type Props = {
  projectId: string;
  projectName: string;
  permissions: string[];
  /** True while the overview is the visible tool; becoming visible again refreshes it. */
  active: boolean;
  /** Opens a tool through the shell's tool setter. */
  onOpenTool: (toolId: string) => void;
  /** Called when every read is denied, so the owner can re-read the authorized project list. */
  onAccessLost?: () => Promise<void> | void;
};

/** Independent starting points; each opens the tool that owns the work. */
export const START_POINTS: { tool: string; title: string; hint: string }[] = [
  { tool: "wire-stock", title: "Stock record", hint: "Wire, cable stock, tubing. Usable on its own." },
  { tool: "cables", title: "Cable", hint: "Ends, conductors, preparation. No device needed." },
  { tool: "pcb", title: "Board", hint: "From a native KiCad bundle or by hand." },
  { tool: "assemblies", title: "Assembly", hint: "Compose exact revisions; repeat uses kept apart." },
  { tool: "sources", title: "Import source", hint: "Original files are preserved; edits make derivatives." },
  { tool: "physical-units", title: "Physical unit", hint: "Register something actually made or obtained." },
];

function value<T>(read: WorkRead<T> | undefined): T | null {
  return read && read.status === "ok" ? read.value : null;
}

export function ProjectOverview({ projectId, projectName, permissions, active, onOpenTool, onAccessLost }: Props) {
  const [work, setWork] = useState<ProjectWork | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const seenActive = useRef(active);
  const permissionKey = permissions.join(",");
  const onLost = useRef(onAccessLost);
  onLost.current = onAccessLost;

  // Refresh each time the overview is shown again, because other tools change what is waiting.
  useEffect(() => {
    if (active && !seenActive.current) setTick((current) => current + 1);
    seenActive.current = active;
  }, [active]);

  useEffect(() => {
    let current = true;
    setLoading(true); setFailed(null);
    readProjectWork(projectId, permissionKey ? permissionKey.split(",") : []).then((result) => {
      if (!current) return;
      setWork(result); setLoading(false);
      const reads = [result.records, result.unread, result.reviews];
      if (reads.every((read) => read.status === "unavailable" && read.denied)) {
        setWork(null);
        setFailed("This project is no longer available to you.");
        void onLost.current?.();
      }
    }).catch((reason: unknown) => {
      if (!current) return;
      setWork(null); setLoading(false);
      setFailed(reason instanceof Error ? reason.message : "Overview unavailable.");
    });
    return () => { current = false; };
  }, [projectId, permissionKey, tick]);

  const access = describeAccess(permissions);
  const readOnly = isReadOnly(permissions);
  const records = value(work?.records);
  const unread = value(work?.unread);
  const reviews = value(work?.reviews);
  const members = work ? value(work.members) : null;
  const more = (flag: boolean | undefined) => flag ? "+" : "";
  const waiting = (unread?.rows.length ?? 0) + (reviews?.open.length ?? 0);
  const unavailable = (read: WorkRead<unknown> | undefined) => !loading && !!read && read.status === "unavailable";

  return <div className="sb-dash" aria-busy={loading}>
    <Title order={2} className="sb-dash-title">Overview</Title>
    {failed && <Alert color="red" role="alert" title="Overview unavailable">{failed}</Alert>}
    <section aria-label="Project summary"><dl className="sb-context sb-context-4">
      <Cell label="Records" value={records ? String(records.total) : loading ? "Loading" : "Not reported"} unknown={!records}
        title={records ? `${records.kinds.map((k) => `${k.count} ${k.kind}`).join(", ") || "no records yet"}` : undefined} />
      <Cell label="Members" value={members ? String(members.count) : "Not reported"} unknown={!members}
        title={members ? undefined : "Member counts are shown to project administrators."} />
      <Cell label="Unread notifications" value={unread ? `${unread.rows.length}${more(unread.more)}` : loading ? "Loading" : "Not reported"} unknown={!unread} />
      <Cell label="Open reviews" value={reviews ? `${reviews.open.length}${more(reviews.more)}` : loading ? "Loading" : "Not reported"} unknown={!reviews} />
    </dl></section>

    <div className="sb-dash-grid">
      <div className="sb-dash-main">
        <h3 className="sb-dash-h">Continue where you left off <span className="sb-silk">notifications and reviews only</span></h3>
        <div className="sb-dash-list" role="group" aria-label="Open work">
          {unread?.rows.map((row) => <WorkRow key={row.notification_id} led="review" title={row.title}
            detail={`Notification · ${row.action} · unread`} action="Open notification" onOpen={() => onOpenTool("knowledge")} />)}
          {reviews?.open.map((row) => <WorkRow key={row.review_id} led="active" title={row.title}
            detail="Team review · open" action="Open review" onOpen={() => onOpenTool("knowledge")} />)}
          {!loading && work && waiting === 0 && <div className="sb-dash-empty" role="status">
            <Text>Nothing is waiting on you in this project.</Text>
            <Text className="sb-silk">Drafts and builds are not listed here; open a tool to find them.</Text></div>}
          {loading && <div className="sb-dash-empty" role="status"><Text className="sb-silk">Loading open work</Text></div>}
          {unavailable(work?.unread) && <div className="sb-dash-empty sb-hatch" role="status"><Text>Notifications are unavailable right now.</Text></div>}
          {unavailable(work?.reviews) && <div className="sb-dash-empty sb-hatch" role="status"><Text>Reviews are unavailable right now.</Text></div>}
        </div>

        <h3 className="sb-dash-h">Start something on its own <span className="sb-silk">no complete device required</span></h3>
        <div className="sb-dash-start" role="group" aria-label="Start something">
          {START_POINTS.map((point) => <button key={point.tool} type="button" className="sb-dash-card"
            aria-label={`Start: ${point.title}`} onClick={() => onOpenTool(point.tool)}>
            <span className="sb-dash-card-head"><b>{point.title}</b><span className="sb-mono" aria-hidden="true" style={{ color: "var(--sb-accent)" }}>+</span></span>
            <span className="sb-dash-note">{point.hint}</span>
          </button>)}
        </div>
        {readOnly && <Text className="sb-dash-note" mt="xs">You have read-only access here: these tools open for inspection and do not create records.</Text>}
      </div>

      <aside className="sb-dash-side" aria-label="Project access">
        <h3 className="sb-dash-h">Your access</h3>
        <dl className="sb-kv">
          <dt className="sb-silk">Project</dt><dd>{projectName}</dd>
          <dt className="sb-silk">Role</dt><dd data-unknown={!access.known}>{access.label}{readOnly && <> <span className="sb-tag">read-only</span></>}</dd>
          <dt className="sb-silk">Grants</dt><dd className="sb-mono">{access.grants === 0 ? "not reported" : permissions.join(", ")}</dd>
        </dl>
        <Button variant="quiet" size="xs" onClick={() => onOpenTool("access")}>Members and roles</Button>
      </aside>
    </div>
  </div>;
}

function Cell({ label, value, unknown = false, title }: { label: string; value: string; unknown?: boolean; title?: string }) {
  return <div className={`sb-cell${unknown ? " sb-hatch" : ""}`}>
    <dt className="sb-silk">{label}</dt>
    <dd data-unknown={unknown} title={title ?? value}>{value}</dd>
  </div>;
}

function WorkRow({ led, title, detail, action, onOpen }: { led: "review" | "active"; title: string; detail: string; action: string; onOpen: () => void }) {
  return <div className="sb-dash-row">
    <span className="sb-led" data-state={led} aria-hidden="true" />
    <span className="sb-dash-row-title" title={title}>{title}</span>
    <Button variant="quiet" size="xs" aria-label={`${action}: ${title}`} onClick={onOpen}>{action}</Button>
    <span />
    <span className="sb-dash-note">{detail}</span>
  </div>;
}
