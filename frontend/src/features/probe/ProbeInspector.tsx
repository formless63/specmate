import { Button, Text } from "@mantine/core";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ApiError, requestJson, type LibraryRecord } from "../workspace/api";
import { useProbe, useRelated } from "./ProbeProvider";

/** One workspace record by id. The server answers 404 alike for missing and unreadable records. */
export function readLibraryRecord(recordId: string, projectId: string | null): Promise<LibraryRecord> {
  const search = projectId ? `?project_id=${encodeURIComponent(projectId)}` : "";
  return requestJson(`/api/v0/workspace/library/${encodeURIComponent(recordId)}${search}`);
}

/** Statuses after which a probe target is treated as access-lost, never as "empty". */
const LOST = new Set([401, 403, 404, 422]);

/**
 * The inspector's header for the probe: what is selected, at which revision and path, and how
 * many related targets the open lenses know about. An unreadable or malformed target renders
 * access-lost without naming it; the URL alone never reveals or grants anything.
 */
export function ProbeInspector({ principalKey, projectId, malformed = false }: { principalKey: string; projectId: string | null; malformed?: boolean }) {
  const shared = useProbe();
  const related = useRelated();
  const probe = shared?.probe ?? null;
  const record = useQuery({
    queryKey: ["workspace", "library-record", principalKey, probe?.object ?? null, projectId],
    queryFn: () => readLibraryRecord(probe!.object, projectId),
    enabled: !!probe,
    retry: false,
  });
  if (!shared) return null;
  const clear = <Button variant="quiet" size="xs" onClick={() => shared.setProbe(null)}>Clear selection</Button>;
  if (malformed && !probe) return <AccessLost onClear={clear} />;
  if (!probe) return null;
  if (record.isPending) return <section className="sb-probe" aria-label="Selection"><Text role="status" className="sb-dash-note">Reading the selected item…</Text></section>;
  if (record.isError) {
    if (record.error instanceof ApiError && LOST.has(record.error.status)) return <AccessLost onClear={clear} />;
    return <section className="sb-probe" aria-label="Selection" role="alert">
      <Text className="sb-dash-note">The selected item could not be read. Nothing about it is shown until it can.</Text>
      <Button variant="quiet" size="xs" onClick={() => void record.refetch()}>Retry</Button>{clear}
    </section>;
  }
  const item = record.data;
  // Revision numbers are contiguous from 1; a higher number than the latest frozen one is not known here.
  const revisionKnown = probe.rev === null || (item.latest_revision !== null && probe.rev <= item.latest_revision);
  const revision = probe.rev !== null ? `r${probe.rev} exact` : item.latest_revision !== null ? `latest r${item.latest_revision}` : "draft only";
  return <section className="sb-probe" aria-label="Selection">
    <dl className="sb-context sb-probe-cells">
      <Cell label="Selected" value={item.label} selected />
      <Cell label="Kind" value={item.kind ? item.kind.replaceAll("_", " ") : "Not reported"} unknown={!item.kind} />
      <Cell label="Revision" value={revisionKnown ? revision : `r${probe.rev} not available`} unknown={!revisionKnown || (probe.rev === null && item.latest_revision === null)} />
      <Cell label="Path" value={probe.path.length ? probe.path.join(" / ") : "Whole item"} unknown={!probe.path.length} />
      <Cell label="Used in" value={!item.referenceable ? "Not referenceable" : `${item.used_in_total} project${item.used_in_total === 1 ? "" : "s"}`} unknown={!item.referenceable} />
      <Cell label="Related" value={related.length ? `${related.length} in open views` : "None known"} unknown={!related.length} />
    </dl>
    {clear}
  </section>;
}

function AccessLost({ onClear }: { onClear: ReactNode }) {
  return <section className="sb-probe sb-hatch" aria-label="Selection" role="alert" data-state="access-lost">
    <Text className="sb-dash-row-title">Selection not available</Text>
    <Text className="sb-dash-note">This link points to something you cannot open here. It may have been removed, or your access may have changed. Nothing about it is shown.</Text>
    {onClear}
  </section>;
}

function Cell({ label, value, selected = false, unknown = false }: { label: string; value: string; selected?: boolean; unknown?: boolean }) {
  return <div className="sb-cell" data-selected={selected}>
    <dt className="sb-silk">{label}</dt>
    <dd data-unknown={unknown} title={value}>{value}</dd>
  </div>;
}
