import { Alert, Button, Group, MultiSelect, NumberInput, Select, Stack, Table, Text, Textarea, TextInput, Title } from "@mantine/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { SbProvenance, SbStatus, SbUnknown, type SbLed } from "../../components/sb";
import { InspectionScope, ReadOnlyNote, useCan } from "../../lib/permissions";
import { requestJson } from "../workspace/api";
import { BOUNDARY_PERMISSIONS, MESSAGING_OPERATIONS, listRuns, readPackage, readRun, runCommand, type FieldDiff, type PackageChange, type ReviewPackage, type RunStatus, type RunStep, type RunSummary } from "./api";

type Props = { workspaceId: string; projectId?: string | null; username?: string; principalKey?: string };

const STATUS_LED: Record<RunStatus, { led: SbLed; pulse?: "breathe" }> = {
  active: { led: "active", pulse: "breathe" }, paused: { led: "review" }, exhausted: { led: "stale" },
  expired: { led: "stale" }, completed: { led: "info" }, cancelled: { led: "not-evaluated" },
};
const STATUS_FILTERS = ["all", "active", "paused", "exhausted", "expired", "completed", "cancelled"];
const CURRENT_WORDS: Record<PackageChange["current"], string> = {
  unchanged_since_step: "unchanged since step", changed_since_step: "changed since step", missing: "record missing", unknown: "not evaluated",
};
const when = (iso: string | null) => iso ? new Date(iso).toLocaleString() : null;
const show = (value: unknown) => JSON.stringify(value);
const message = (error: unknown) => error instanceof Error ? error.message : "Request failed.";

/** Bounded agent runs of the workspace: grants, budget, deadline, step log and review packages. */
export function AgentRunsPanel(props: Props) {
  return <Runs key={`${props.workspaceId}:${props.projectId ?? "library"}:${props.principalKey ?? ""}`} {...props} />;
}

function Runs({ workspaceId, projectId = null, username }: Props) {
  const [status, setStatus] = useState<string | null>("all");
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    setError(null);
    void listRuns(workspaceId, projectId, status === "all" ? null : status)
      .then((page) => { if (live) setRuns(page.runs); })
      .catch((reason: unknown) => { if (live) { setRuns([]); setError(message(reason)); } });
    return () => { live = false; };
  }, [workspaceId, projectId, status, tick]);

  return <Stack className="sb-dash">
    <Title order={2}>Agent runs</Title>
    <Text c="dimmed" size="sm">An agent acts only inside a run: through the normal operations, as its sponsor, limited to the granted actions, its budget and its deadline. Freezing, execution, inventory and release stop the run unless granted by name.</Text>
    {error && <Alert color="red" role="alert">{error}</Alert>}
    <Group align="end">
      <Select label="Run status" data={STATUS_FILTERS} value={status} onChange={setStatus} allowDeselect={false} w={180} />
      <Button variant="default" onClick={refresh}>Refresh runs</Button>
    </Group>
    {runs === null ? <Text role="status">Reading runs…</Text> : runs.length === 0 ? <Text>No agent runs{status !== "all" ? ` with status ${status}` : ""}.</Text> :
      <Table highlightOnHover>
        <Table.Thead><Table.Tr><Table.Th>Run</Table.Th><Table.Th>Status</Table.Th><Table.Th>Agent</Table.Th><Table.Th>Sponsor</Table.Th><Table.Th>Actions used</Table.Th><Table.Th>Deadline</Table.Th></Table.Tr></Table.Thead>
        <Table.Tbody>{runs.map((run) => <Table.Tr key={run.run_id} data-selected={run.run_id === selected || undefined}>
          <Table.Td><Button variant="subtle" size="compact-sm" onClick={() => setSelected(run.run_id)} aria-label={`Open run ${run.title}`}>{run.title}</Button></Table.Td>
          <Table.Td><SbStatus dimension="run" value={run.status} {...STATUS_LED[run.status]} /></Table.Td>
          <Table.Td>{run.agent}</Table.Td><Table.Td>{run.sponsor}</Table.Td>
          <Table.Td className="sb-mono">{run.budget.actions_used} of {run.budget.max_actions}</Table.Td>
          <Table.Td>{when(run.deadline)}</Table.Td>
        </Table.Tr>)}</Table.Tbody>
      </Table>}
    {selected && <RunDetail key={`${selected}:${tick}`} runId={selected} username={username} onChanged={refresh} onClose={() => setSelected(null)} />}
    <CreateRun workspaceId={workspaceId} projectId={projectId} onCreated={(id) => { setSelected(id); refresh(); }} />
  </Stack>;
}

type Discovery = { operations: { operation: string; attachments: string[]; async: boolean; access: { kind: string; minimum_workspace_permission: string | null }; availability: { status: string } }[] };

function CreateRun({ workspaceId, projectId, onCreated }: { workspaceId: string; projectId: string | null; onCreated: (runId: string) => void }) {
  const canCreate = useCan("item.create");
  const [catalog, setCatalog] = useState<{ draft: string[]; boundary: string[] } | null>(null);
  const [title, setTitle] = useState(""), [purpose, setPurpose] = useState(""), [agent, setAgent] = useState("");
  const [allowed, setAllowed] = useState<string[]>([]), [boundary, setBoundary] = useState<string[]>([]);
  const [maxActions, setMaxActions] = useState<number | string>(20), [hours, setHours] = useState<number | string>(4), [checkpoint, setCheckpoint] = useState<number | string>("");
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!canCreate) return;
    let live = true;
    void requestJson<Discovery>(`/api/v0/discovery/capabilities?workspace_id=${encodeURIComponent(workspaceId)}`).then((data) => {
      if (!live) return;
      // Offer only workspace operations this account may call; the server classifies again.
      const usable = data.operations.filter((row) => row.access.kind === "workspace" && !row.operation.startsWith("agent_run.")
        && row.attachments.length === 0 && ["available", "degraded"].includes(row.availability.status));
      const isBoundary = (row: (typeof usable)[number]) => row.async || row.operation === "project.delete" || MESSAGING_OPERATIONS.has(row.operation) || BOUNDARY_PERMISSIONS.has(row.access.minimum_workspace_permission ?? "");
      setCatalog({ draft: usable.filter((row) => !isBoundary(row)).map((row) => row.operation), boundary: usable.filter(isBoundary).map((row) => row.operation) });
    }).catch(() => { if (live) setCatalog({ draft: [], boundary: [] }); });
    return () => { live = false; };
  }, [workspaceId, canCreate]);

  async function create() {
    setBusy(true); setError(null);
    try {
      const deadline = new Date(Date.now() + Number(hours) * 3_600_000).toISOString();
      const run = await runCommand("agent_run.create", {
        workspace_id: workspaceId, project_id: projectId, title, purpose, agent_username: agent.trim() || null,
        allowed_actions: allowed, boundary_actions: boundary, max_actions: Number(maxActions), deadline,
        checkpoint_every: checkpoint === "" ? null : Number(checkpoint),
      }, { idempotent: true });
      setTitle(""); setPurpose(""); setAllowed([]); setBoundary([]);
      onCreated(run.run_id);
    } catch (reason) { setError(message(reason)); } finally { setBusy(false); }
  }

  const ready = title.trim() && allowed.length > 0 && Number(maxActions) >= 1 && Number(hours) > 0;
  return <Stack gap="xs">
    <Title order={3}>New run</Title>
    {!canCreate ? <ReadOnlyNote permission="item.create">Starting a run needs contributor access; runs and their review packages stay readable.</ReadOnlyNote> : <InspectionScope permission="item.create">
      {error && <Alert color="red" role="alert">{error}</Alert>}
      <Group grow align="start">
        <TextInput label="Run title" value={title} onChange={(e) => setTitle(e.currentTarget.value)} />
        <TextInput label="Agent account (username)" description="Empty: your own account" value={agent} onChange={(e) => setAgent(e.currentTarget.value)} />
      </Group>
      <Textarea label="Purpose" minRows={2} value={purpose} onChange={(e) => setPurpose(e.currentTarget.value)} />
      <MultiSelect label="Allowed draft actions" searchable data={catalog?.draft ?? []} value={allowed} onChange={setAllowed} placeholder={catalog ? "Choose operations" : "Reading operations…"} />
      <MultiSelect label="Granted boundary actions" description="Freeze, execution, inventory or release operations the run may perform; leave empty to stop before them." searchable data={catalog?.boundary ?? []} value={boundary} onChange={setBoundary} />
      <Group grow>
        <NumberInput label="Action budget" min={1} max={1000} value={maxActions} onChange={setMaxActions} />
        <NumberInput label="Deadline (hours from now)" min={0.25} max={720} step={1} decimalScale={2} value={hours} onChange={setHours} />
        <NumberInput label="Checkpoint every (actions)" min={1} max={1000} value={checkpoint} onChange={setCheckpoint} placeholder="No automatic checkpoint" />
      </Group>
      <Group><Button onClick={() => void create()} loading={busy} disabled={!ready}>Start run</Button></Group>
    </InspectionScope>}
  </Stack>;
}

function RunDetail({ runId, username, onChanged, onClose }: { runId: string; username?: string; onChanged: () => void; onClose: () => void }) {
  const [data, setData] = useState<{ run: RunSummary; steps: RunStep[] } | null>(null);
  const [pkg, setPkg] = useState<ReviewPackage | null>(null);
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const canEdit = useCan("design.edit");
  const isAdmin = useCan("workspace.admin");

  useEffect(() => {
    let live = true;
    void Promise.all([readRun(runId), readPackage(runId)])
      .then(([detail, review]) => { if (live) { setData(detail); setPkg(review); } })
      .catch((reason: unknown) => { if (live) setError(message(reason)); });
    return () => { live = false; };
  }, [runId]);

  async function command(operation: string, payload: object, expectedState?: string) {
    setBusy(true); setError(null);
    try { await runCommand(operation, { run_id: runId, ...payload }, { expectedState }); onChanged(); }
    catch (reason) { setError(message(reason)); } finally { setBusy(false); }
  }

  if (error && !data) return <Alert color="red" role="alert">{error}</Alert>;
  if (!data || !pkg) return <Text role="status">Reading run…</Text>;
  const { run, steps } = data;
  const sponsor = username !== undefined && username === run.sponsor;
  const party = username !== undefined && (username === run.agent || sponsor);
  const live = run.status !== "completed" && run.status !== "cancelled";
  const reviewer = canEdit && !(username === run.agent && run.agent !== run.sponsor);

  return <Stack gap="sm" aria-label={`Run ${run.title}`} role="region">
    <Group justify="space-between"><Title order={3}>{run.title}</Title><Button variant="subtle" size="xs" onClick={onClose}>Close run</Button></Group>
    {error && <Alert color="red" role="alert">{error}</Alert>}
    <dl className="sb-context">
      <div className="sb-cell"><dt className="sb-silk">Status</dt><dd><SbStatus dimension="run" value={run.status} {...STATUS_LED[run.status]} /></dd></div>
      <div className="sb-cell"><dt className="sb-silk">Reason</dt><dd>{run.status_reason || "none"}</dd></div>
      <div className="sb-cell"><dt className="sb-silk">Actions used</dt><dd className="sb-mono">{run.budget.actions_used} of {run.budget.max_actions}</dd></div>
      <div className="sb-cell"><dt className="sb-silk">Deadline</dt><dd>{when(run.deadline)}</dd></div>
      <div className="sb-cell"><dt className="sb-silk">Agent</dt><dd>{run.agent}</dd></div>
      <div className="sb-cell"><dt className="sb-silk">Sponsor</dt><dd>{run.sponsor}</dd></div>
      <div className="sb-cell"><dt className="sb-silk">Checkpoint</dt><dd>{run.budget.checkpoint_every ? `every ${run.budget.checkpoint_every}` : "none set"}</dd></div>
      <div className="sb-cell"><dt className="sb-silk">Review</dt><dd>{run.review.decision ? `${run.review.decision.replace("_", " ")} by ${run.review.reviewed_by}` : "not reviewed"}</dd></div>
    </dl>
    {run.purpose && <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>{run.purpose}</Text>}
    <Text size="sm">Allowed: <span className="sb-mono">{run.grant.allowed_actions.join(", ")}</span></Text>
    <Text size="sm">Granted boundaries: <span className="sb-mono">{run.grant.boundary_actions.join(", ") || "none"}</span></Text>

    <Group>
      {live && party && <Button variant="default" disabled={busy} onClick={() => void command("agent_run.checkpoint", { note: "Paused from the runs view", pause: true })}>Pause at checkpoint</Button>}
      {live && party && <Button variant="default" disabled={busy} onClick={() => void command("agent_run.complete", {})}>Complete run</Button>}
      {live && (sponsor || isAdmin) && <Button color="red" variant="light" disabled={busy} onClick={() => void command("agent_run.cancel", { note: "Cancelled from the runs view" })}>Cancel run</Button>}
    </Group>
    {sponsor && ["paused", "exhausted", "expired"].includes(run.status) && <ResumeForm run={run} steps={steps} busy={busy} onResume={(payload) => void command("agent_run.resume", payload, run.state)} />}

    <Title order={4}>Step log</Title>
    <Table>
      <Table.Thead><Table.Tr><Table.Th>#</Table.Th><Table.Th>Kind</Table.Th><Table.Th>Outcome</Table.Th><Table.Th>Operation</Table.Th><Table.Th>By</Table.Th><Table.Th>Note or error</Table.Th></Table.Tr></Table.Thead>
      <Table.Tbody>{steps.map((step) => <Table.Tr key={step.step_id}>
        <Table.Td className="sb-mono">{step.number}</Table.Td><Table.Td>{step.kind}</Table.Td><Table.Td>{step.outcome}</Table.Td>
        <Table.Td className="sb-mono">{step.operation ?? ""}</Table.Td>
        <Table.Td>{step.actor}{step.on_behalf_of && step.on_behalf_of !== step.actor ? ` for ${step.on_behalf_of}` : ""}</Table.Td>
        <Table.Td>{step.error ? `${step.error.code}: ${step.error.message}` : step.note}</Table.Td>
      </Table.Tr>)}</Table.Tbody>
    </Table>

    <ReviewPackageView pkg={pkg} canRevert={reviewer} busy={busy} onRevert={(change) => void command("agent_run.revert_change", { step_id: change.step_id, record: change.record })} />
    {run.status !== "active" && <ReviewForm canReview={reviewer} busy={busy} onReview={(decision, note) => void command("agent_run.review", { decision, note })} />}
  </Stack>;
}

function ResumeForm({ run, steps, busy, onResume }: { run: RunSummary; steps: RunStep[]; busy: boolean; onResume: (payload: object) => void }) {
  const blocked = useMemo(() => [...new Set(steps.filter((s) => s.kind === "boundary" && s.operation && !run.grant.boundary_actions.includes(s.operation)).map((s) => s.operation as string))], [steps, run]);
  const [addActions, setAddActions] = useState<number | string>(run.budget.actions_remaining > 0 ? 0 : 10);
  const [hours, setHours] = useState<number | string>(run.status === "expired" ? 4 : "");
  const [grant, setGrant] = useState<string[]>([]);
  return <Stack gap="xs" className="sb-dash-side">
    <Text fw={600}>Resume run</Text>
    <Text size="sm">Prior steps and consumed budget stay as recorded; retried step keys return their recorded results.</Text>
    <Group grow align="end">
      <NumberInput label="Add actions" min={0} max={1000} value={addActions} onChange={setAddActions} />
      <NumberInput label="New deadline (hours from now)" min={0.25} max={720} value={hours} onChange={setHours} placeholder="Keep deadline" />
    </Group>
    {blocked.length > 0 && <MultiSelect label="Grant stopped boundaries" description="Explicitly allow the operations this run stopped before." data={blocked} value={grant} onChange={setGrant} />}
    <Group><Button disabled={busy} onClick={() => onResume({
      add_actions: Number(addActions) || 0, grant_boundary_actions: grant,
      deadline: hours === "" ? null : new Date(Date.now() + Number(hours) * 3_600_000).toISOString(),
    })}>Resume run</Button></Group>
  </Stack>;
}

function DiffView({ field, diff }: { field: string; diff: FieldDiff }) {
  if ("added" in diff) {
    const rows = [
      ...Object.entries(diff.changed).map(([key, value]) => [key, "changed", show(value.before), show(value.after)]),
      ...Object.entries(diff.added).map(([key, value]) => [key, "added", "absent", show(value)]),
      ...Object.entries(diff.removed).map(([key, value]) => [key, "removed", show(value), "absent"]),
    ];
    return <Table withTableBorder fz="xs">
      <Table.Thead><Table.Tr><Table.Th>{field}</Table.Th><Table.Th>Change</Table.Th><Table.Th>Before</Table.Th><Table.Th>After</Table.Th></Table.Tr></Table.Thead>
      <Table.Tbody>{rows.map(([key, kind, before, after]) => <Table.Tr key={`${key}:${kind}`}><Table.Td className="sb-mono">{key}</Table.Td><Table.Td>{kind}</Table.Td><Table.Td className="sb-mono">{before}</Table.Td><Table.Td className="sb-mono">{after}</Table.Td></Table.Tr>)}</Table.Tbody>
    </Table>;
  }
  return <Text size="xs" className="sb-mono">{field}: {diff.before === undefined ? "absent" : show(diff.before)} → {diff.after === undefined ? "absent" : show(diff.after)}</Text>;
}

function ReviewPackageView({ pkg, canRevert, busy, onRevert }: { pkg: ReviewPackage; canRevert: boolean; busy: boolean; onRevert: (change: PackageChange) => void }) {
  return <Stack gap="xs">
    <Title order={4}>Review package</Title>
    <Text size="sm">{pkg.counts.applied} applied, {pkg.counts.failed} failed, {pkg.counts.boundary_stops} boundary stops, {pkg.counts.proposals} proposals, {pkg.counts.reverts} reverts; {pkg.counts.changed_records} changed records.</Text>
    <SbProvenance summary="Exact step log" pins={[{ label: "Run ID", value: pkg.run.run_id }, { label: "Log SHA-256", value: pkg.log_sha256 }]} />
    {pkg.changes.length === 0 && <Text size="sm">No recorded record changes.</Text>}
    {pkg.changes.map((change) => <Stack key={`${change.step_id}:${change.record}`} gap={4} className="sb-dash-side">
      <Group justify="space-between">
        <Text size="sm"><span className="sb-mono">#{change.step_number} {change.operation}</span> · {change.action} {change.model}</Text>
        {change.current === "unknown" ? <SbUnknown what="current state" /> : <SbStatus dimension="now" value={change.reverted ? "reverted" : CURRENT_WORDS[change.current]} led={change.current === "unchanged_since_step" ? "info" : "stale"} />}
      </Group>
      {Object.entries(change.diffs).filter(([field]) => field !== "updated_at").map(([field, diff]) => <DiffView key={field} field={field} diff={diff} />)}
      <SbProvenance summary={`${change.provenance.agent} for ${change.provenance.on_behalf_of ?? "unknown sponsor"} · ${when(change.provenance.at)}`}
        pins={[{ label: "Record", value: change.record }, { label: "Step key", value: change.provenance.step_key }, { label: "Request ID", value: change.provenance.request_id }, { label: "Expected state", value: change.provenance.expected_state }]} />
      {change.revertible && (canRevert
        ? <Group><Button size="xs" variant="light" disabled={busy} onClick={() => onRevert(change)}>{change.revert?.kind === "discard" ? "Discard this created draft" : "Revert this draft change"}</Button></Group>
        : <ReadOnlyNote permission="design.edit">Reverting needs editing access by someone other than the agent</ReadOnlyNote>)}
      {!change.reverted && change.revert?.kind === "discard" && change.revert.blockers.length > 0 && <Alert color="yellow" title="Cannot be discarded">
        {change.revert.blockers.map((b) => <Text key={b.model} size="sm">{b.reason}</Text>)}
      </Alert>}
    </Stack>)}
    {pkg.boundary_stops.length > 0 && <><Text fw={600} size="sm">Stopped before</Text>{pkg.boundary_stops.map((s) => <Text key={s.step_id} size="sm"><span className="sb-mono">#{s.number} {s.operation}</span> · {s.note}</Text>)}</>}
    {pkg.proposals.length > 0 && <><Text fw={600} size="sm">Proposals (not executed)</Text>{pkg.proposals.map((s) => <Text key={s.step_id} size="sm" style={{ whiteSpace: "pre-wrap" }}>#{s.number} {s.operation ? `${s.operation}: ` : ""}{s.note}</Text>)}</>}
    {pkg.truncated_steps.length > 0 && <Alert color="yellow">Change capture was truncated for steps {pkg.truncated_steps.join(", ")}.</Alert>}
    {pkg.limitations.map((line) => <Text key={line} size="xs" c="dimmed">{line}</Text>)}
  </Stack>;
}

function ReviewForm({ canReview, busy, onReview }: { canReview: boolean; busy: boolean; onReview: (decision: string, note: string) => void }) {
  const [decision, setDecision] = useState<string | null>("accepted"), [note, setNote] = useState("");
  if (!canReview) return <ReadOnlyNote permission="design.edit">Recording a review decision needs editing access by someone other than the agent</ReadOnlyNote>;
  return <InspectionScope permission="design.edit"><Group align="end">
    <Select label="Review decision" data={[{ value: "accepted", label: "Accept" }, { value: "changes_requested", label: "Request changes" }, { value: "rejected", label: "Reject" }]} value={decision} onChange={setDecision} allowDeselect={false} />
    <TextInput label="Review note" value={note} onChange={(e) => setNote(e.currentTarget.value)} style={{ flex: 1 }} />
    <Button disabled={busy || !decision} onClick={() => decision && onReview(decision, note)}>Record review</Button>
  </Group></InspectionScope>;
}
