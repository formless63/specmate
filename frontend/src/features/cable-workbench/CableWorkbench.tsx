import { ActionIcon, Alert, Button, Group, SegmentedControl, Stack, Text, UnstyledButton } from "@mantine/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Suspense, lazy, useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { sectionLayout, type StockSpecification } from "../../../../packages/section-layout/src";
import { SbUnknown } from "../../components/sb";
import { ReadOnlyNote, usePermission } from "../../lib/permissions";
import { useRevisionLabel } from "../../lib/revision-labels";
import type { Cable } from "../cables/api";
import { declaredLength } from "../cables/CableSummary";
import { LAYER_LABELS, LAYER_ORDER, stackComplete, type ResolvedStack } from "../end-assemblies/api";
import { statusLed } from "../intent-check/IntentCheckPanel";
import { checkPath, read, type IntentCheck, type Status } from "../intent-check/api";
import type { Body } from "../interfaces/api";
import { faceForBody } from "../interfaces/BodyFace";
import { acceptRows, requestProposal, type Proposal } from "../intent-propose/ProposeWiring";
import { CableDrawing } from "./CableDrawing";
import { STOCK_KEY, assignLanding, indexCheck, layoutDrawing, proposedKey, rowKey, splitTermKey, wireKey, type DrawingInput } from "./model";
import { FAMILY_LABELS, STATUS_WORDS, familyColor, signalFamily, type SignalFamily } from "./palette";
import { physicalGraph, relatedKeys } from "./relations";
import { EditorInspector, type InspectorTab } from "../../components/editor";
import { IntentCheckPanel } from "../intent-check/IntentCheckPanel";
import { cableIssues } from "./issues";
import { ProbeDetails } from "./WorkbenchInspector";
import { landingWords } from "./chips";
import "./cable-workbench.css";

const ManualCanvas = lazy(() => import("../manual-canvas/ManualCanvas").then(module => ({default:module.ManualCanvas})));

export type WorkbenchMode = "new" | "draft" | "frozen";
export type WorkbenchProps = {
  mode: WorkbenchMode;
  libraryScope?: {workspaceId:string;principalKey:string;layoutId:string};
  name: string;
  cable: Cable;
  /** Present while the cable is editable in this view (new cable or open draft). */
  onChange?: (cable: Cable) => void;
  stacks: (ResolvedStack | undefined)[];
  bodies?: (Body | null | undefined)[];
  stock?: StockSpecification;
  conductors?: DrawingInput["conductors"];
  draftId?: string | null;
  revisionId?: string | null;
  /** Server state token of the saved draft: a new token rereads its check. */
  checkVersion?: string | null;
  /** Record views share a probe; smaller embeds retain their own local selection. */
  selection?: string | null;
  onSelect?: (key: string | null) => void;
  revision: { value: string; sub: string };
  actions?: ReactNode;
  notices?: ReactNode;
  cableForm?: ReactNode;
  endForms?: ReactNode[];
  /** Writes accepted proposal rows (draft update, or the new cable's value). */
  onAccept?: (cable: Cable) => Promise<void> | void;
  details?: ReactNode;
  /** Record-hosted editor; the same drawing also serves smaller read-only embeds. */
  editor?: { dirty: boolean; notes: ReactNode; recipe?: ReactNode; active?: boolean; onStatus?: (count: number, failed: boolean) => void };
};

type Tab = "probe" | "cable" | `end:${string}`;

function Cell({ label, children, sub, testId }: { label: string; children: ReactNode; sub?: ReactNode; testId?: string }) {
  return <div className="sb-cell" data-testid={testId}><dt className="sb-silk">{label}</dt><dd>{children}</dd>{sub && <p className="cwb-sub">{sub}</p>}</div>;
}

function endSummary(stack: ResolvedStack | undefined): string | null {
  if (!stack) return null;
  return [...stack.layers].sort((a, b) => LAYER_ORDER.indexOf(a.kind) - LAYER_ORDER.indexOf(b.kind))
    .map((l) => l.kind === "connector" ? (l.name ?? "connector") : LAYER_LABELS[l.kind].toLowerCase()).join(" + ");
}

/** The pinned end of a new cable as a proposal input: a frozen end assembly or a complete ad-hoc stack. */
function endChoice(cable: Cable, index: number) {
  const endpoint = cable.endpoints[index];
  if (!endpoint) return null;
  if (endpoint.end_assembly_revision_id) return { end_assembly_revision_id: endpoint.end_assembly_revision_id, label: endpoint.label };
  if (endpoint.stack && stackComplete(endpoint.stack)) return { stack: endpoint.stack, label: endpoint.label };
  return null;
}

/**
 * The cable workbench: the cable drawn from End A's stack through the stock to End B's stack,
 * one fact per header cell, a probe that lights everything related, and an inspector that holds
 * the detail forms. Checks and proposals use the existing read and operations; proposed landings
 * are drawn dashed and reach the draft only when accepted.
 */
export function CableWorkbench(props: WorkbenchProps) {
  const { mode, name, cable, onChange, stacks, bodies, stock, conductors, draftId = null, revisionId = null } = props;
  const editable = !!onChange;
  const [presentation,setPresentation]=useState<"canvas"|"drawing">(props.mode === "new" && props.libraryScope ? "canvas" : "drawing");
  const [canvasVisited,setCanvasVisited]=useState(presentation === "canvas");
  if(presentation === "canvas" && !canvasVisited)setCanvasVisited(true);
  const edit = usePermission("design.edit");
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("issues");
  const [localSelection, setLocalSelection] = useState<string | null>(null);
  const selection = props.selection === undefined ? localSelection : props.selection;
  const [tab, setTab] = useState<Tab>(mode === "new" ? "cable" : "probe");
  const [armed, setArmed] = useState<{ endpointId: string; path: string } | null>(null);
  const [zoom, setZoom] = useState<number | null>(null);
  const [decided, setDecided] = useState<Set<string>>(new Set());

  useEffect(() => { if (!editable || mode === "frozen") setArmed(null); }, [editable, mode]);

  const intentId = cable.intent_revision_id ?? null;
  const target = revisionId ? { revisionId } : draftId ? { draftId } : null;
  const check = useQuery({
    queryKey: ["cable-intent-check", revisionId, draftId, intentId, props.checkVersion ?? null],
    queryFn: () => read<IntentCheck>(checkPath(target!, intentId)),
    enabled: !!intentId && !!target && props.editor?.active !== false, retry: false,
  });
  const checkData = intentId && !check.isError && !props.editor?.dirty ? check.data ?? null : null;

  const proposal = useMutation({
    mutationFn: () => requestProposal(draftId
      ? { intent_revision_id: intentId, draft_id: draftId }
      : { intent_revision_id: intentId, stock_revision_id: cable.stock_revision_id, from_end: endChoice(cable, 0), to_end: endChoice(cable, 1) }),
    onSuccess: () => setDecided(new Set()),
  });
  const canPropose = !check.isError && !!intentId && mode !== "frozen" && (!!draftId || (!!cable.stock_revision_id && !!endChoice(cable, 0) && !!endChoice(cable, 1)));
  const accept = useMutation({
    mutationFn: async (rowId: string) => { await props.onAccept?.(acceptRows(cable, proposal.data!, new Set([rowId]))); return rowId; },
    onSuccess: (rowId) => setDecided((current) => new Set([...current, rowId])),
  });
  const changes = new Map((proposal.data?.diff ?? []).map((d) => [`${d.endpoint_id}\u0000${d.element_path}`, d.change]));
  const pendingRows = (proposal.data?.rows ?? []).filter((row) => row.status === "proposed" && row.assignments.length > 0 && !decided.has(row.row_id)
    && row.assignments.some((a) => changes.get(`${a.endpoint_id}\u0000${a.element_path}`) !== "same"));
  const shownProposal: Pick<Proposal, "rows" | "diff"> | null = proposal.data && !check.isError ? { rows: pendingRows, diff: proposal.data.diff } : null;

  const faces = useMemo(() => (bodies ?? []).map((body) => (body ? faceForBody(body) : null)), [bodies]);
  const drawing = useMemo(() => layoutDrawing({ cable, stacks, stock, conductors, check: checkData, proposal: shownProposal, faces }),
    [cable, stacks, stock, conductors, checkData, proposal.data, decided, faces]);
  const index = useMemo(() => indexCheck(checkData), [checkData]);
  const graph = useMemo(() => physicalGraph(drawing), [drawing]);
  const lit = useMemo(() => relatedKeys(drawing, graph, index, selection), [drawing, graph, index, selection]);
  const section = useMemo(() => { try { return stock ? sectionLayout(stock) : null; } catch { return null; } }, [stock]);

  useEffect(() => {
    if (!armed) return;
    const cancel = (event: KeyboardEvent) => { if (event.key === "Escape") setArmed(null); };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, [armed]);

  const revealSelection = (key: string | null) => {
    if (!key) return;
    if (props.editor) setInspectorTab(key.startsWith("e:") || key.startsWith("p:") ? "part" : key === STOCK_KEY ? "recipe" : "connection");
    if (key.startsWith("e:")) setTab(`end:${key.slice(2)}`);
    else if (key === STOCK_KEY) setTab("cable");
    else setTab("probe");
  };
  useEffect(() => { if (props.selection !== undefined) revealSelection(props.selection); }, [props.selection]);
  const select = (key: string | null) => { setLocalSelection(key); props.onSelect?.(key); revealSelection(key); };
  const land = (terminal: string) => {
    if (!armed || !onChange) return;
    const at = splitTermKey(terminal);
    if (!at || at.endpointId !== armed.endpointId) return;
    onChange(assignLanding(cable, armed.endpointId, armed.path, { layer_id: at.layerId, terminal_id: at.terminalId }));
    setArmed(null);
    select(wireKey(armed.path));
  };

  const length = declaredLength(cable);
  const stockLabel = useRevisionLabel(cable.stock_revision_id || null).data;
  const rows = checkData?.rows ?? [];
  const counts = (s: Status) => rows.filter((r) => r.outcome === s).length;
  const families = [...new Set(drawing.ends.flatMap((e) => e.terminals.map((t) => signalFamily(t.signal?.type))).filter((f) => f !== "unknown"))] as SignalFamily[];
  const armedEndName = armed ? `End ${String.fromCharCode(65 + Math.max(0, cable.endpoints.findIndex((e) => e.local_id === armed.endpointId)))}` : "";

  const tabs = [{ value: "probe", label: "Probe" }, { value: "cable", label: "Cable" },
    ...cable.endpoints.map((e, i) => ({ value: `end:${e.local_id}`, label: `End ${String.fromCharCode(65 + i)}` }))];

  const drawingStage = <>
      <div className="cwb-stage">
        <div className="cwb-viewport">
          <CableDrawing drawing={drawing} lit={lit} selection={selection} onSelect={select} armedEnd={armed?.endpointId ?? null} onLand={land}
            section={section} lengthText={length ? `${length.text} ${length.kind}` : null} showStatus={!!checkData} zoom={zoom}
            onDragArm={editable && mode !== "frozen" ? setArmed : undefined}
            onDragLanding={editable && mode !== "frozen" ? (endpointId, path, terminal) => {
              const at = splitTermKey(terminal);
              if (at && at.endpointId === endpointId) onChange?.(assignLanding(cable, endpointId, path, { layer_id: at.layerId, terminal_id: at.terminalId }));
              select(wireKey(path)); setInspectorTab("connection");
            } : undefined}
            title={`Cable drawing of ${name}: End A stack, stock and End B stack. Click a wire, pin, pad or part to probe it.`} />
        </div>
        {armed && <div className="cwb-armed" role="status">Choose where {armed.path} lands at {armedEndName}: click a pad, pin or lead of that end. <Button size="compact-xs" variant="default" onClick={() => setArmed(null)}>Cancel</Button></div>}
        <div className="cwb-legend" aria-label="Legend">
          {checkData && <>
            <span><span className="sb-led" data-state="pass" aria-hidden="true" />pass</span>
            <span><span className="sb-led" data-state="failed" aria-hidden="true" />fail</span>
            <span><span className="sb-led" data-state="unknown" aria-hidden="true" />unknown</span>
            <span><span className="sb-led" data-state="not-evaluated" aria-hidden="true" />not evaluated</span>
          </>}
          {pendingRows.length > 0 && <span><svg width="18" height="6" aria-hidden="true"><line x1="0" y1="3" x2="18" y2="3" className="cwb-proposal-line" /></svg>proposed</span>}
          {families.map((f) => <span key={f}><span className="cwb-swatch" style={{ background: familyColor(f) }} aria-hidden="true" />{FAMILY_LABELS[f]}</span>)}
          <span><span className="cwb-swatch sb-hatch" aria-hidden="true" />not recorded</span>
          <div className="cwb-stage-tools" role="group" aria-label="Drawing zoom">
          <ActionIcon size="sm" variant="default" aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(0.5, Math.round(((z ?? 0.8) - 0.2) * 10) / 10))}>−</ActionIcon>
          <Button size="compact-xs" variant={zoom === null ? "primary" : "default"} onClick={() => setZoom(null)}>Fit</Button>
          <ActionIcon size="sm" variant="default" aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(2.5, Math.round(((z ?? 0.8) + 0.2) * 10) / 10))}>+</ActionIcon>
        </div>
        </div>
      </div>
  </>;
  const stage = <>
    {props.libraryScope && <Group gap="xs" aria-label="Cable presentation"><Button size="xs" variant={presentation === "canvas" ? "commit" : "quiet"} onClick={()=>setPresentation("canvas")}>Manual canvas</Button><Button size="xs" variant={presentation === "drawing" ? "commit" : "quiet"} onClick={()=>setPresentation("drawing")}>Cable drawing</Button></Group>}
    <div hidden={presentation !== "drawing"}>{drawingStage}</div>
    {props.libraryScope && canvasVisited && <div hidden={presentation !== "canvas"}><Suspense fallback={<Text>Loading manual canvas…</Text>}><ManualCanvas active={props.editor?.active !== false && presentation === "canvas"} disabled={!editable || mode === "frozen"} scope={props.libraryScope} layoutId={props.libraryScope.layoutId} cable={cable} drawing={drawing} section={section} onChange={onChange} creating={mode === "new"}/></Suspense></div>}
  </>;
  const proposalView = <>
      {proposal.isError && <Alert color="red">{proposal.error.message}</Alert>}
      {check.isError && intentId && <Alert color="orange">{check.error.message}</Alert>}
      {proposal.data && !check.isError && <section className="cwb-proposals" aria-label="Proposed wiring">
        <Group justify="space-between" gap="xs"><Text fw={600} size="sm">Proposed wiring</Text>
          <Text size="xs" c="dimmed">{pendingRows.length ? `${pendingRows.length} row${pendingRows.length === 1 ? " differs" : "s differ"} from the ${mode === "draft" ? "draft" : "cable"}. Nothing is saved until you accept.` : "Every proposed row matches or was decided."}</Text></Group>
        {proposal.data.questions.length > 0 && <Alert color="yellow" title={`${proposal.data.questions.length} question${proposal.data.questions.length === 1 ? "" : "s"}`}>
          <Stack gap={2}>{proposal.data.questions.map((q, i) => <Text key={i} size="xs">{q.row_id}: {q.text}{q.options ? ` Options: ${q.options.join(", ")}.` : ""}</Text>)}</Stack></Alert>}
        {pendingRows.map((row) => <div key={row.row_id} className="cwb-proposal-row" data-selected={selection === proposedKey(row.row_id) || undefined}>
          <UnstyledButton onClick={() => select(proposedKey(row.row_id))} style={{ minWidth: 0 }}>
            <Text size="xs" fw={600} className="sb-mono">{row.row_id}</Text>
            {row.assignments.map((a) => <Text key={`${a.endpoint_id}${a.element_path}`} size="xs" title={`${a.element_path} → ${a.layer_id} ${a.terminal_id}`}>End {a.endpoint_id.toUpperCase()}: {landingWords(drawing, a)}</Text>)}
            {row.reason && <Text size="xs" c="dimmed">{row.reason}</Text>}
          </UnstyledButton>
          <Group gap={4} wrap="nowrap">
            <Button size="compact-xs" {...edit.props} disabled={!props.onAccept || edit.props.disabled} loading={accept.isPending && accept.variables === row.row_id} onClick={() => accept.mutate(row.row_id)}>Accept {row.row_id}</Button>
            <Button size="compact-xs" variant="default" onClick={() => setDecided((current) => new Set([...current, row.row_id]))}>Reject</Button>
          </Group>
        </div>)}
        {accept.isError && <Alert color="red">{accept.error.message}</Alert>}
        <ReadOnlyNote permission="design.edit">Accepting into a draft is unavailable.</ReadOnlyNote>
      </section>}
  </>;
  const issues = cableIssues(cable, drawing, checkData, !!props.editor?.dirty, check.isError, stock);
  const failed = issues.some(issue => issue.state === "fail");
  useEffect(() => { props.editor?.onStatus?.(issues.length, failed); }, [issues.length, failed, props.editor?.onStatus]);
  if (props.editor) {
    const endIndex = selection?.startsWith("e:") ? cable.endpoints.findIndex(end => end.local_id === selection.slice(2)) : -1;
    return <div className="engineering-workbench" data-mode={mode}>
      <div className="engineering-build">{props.notices}{stage}</div>
      <EditorInspector active={props.editor.active} tab={inspectorTab} onTab={setInspectorTab} issueCount={issues.length} tabs={{
        issues: <Stack gap={6}><Text size="xs" c="dimmed">Declared landings, stock geometry and the applicable saved intent check. Measured continuity and physical qualification are not evaluated.</Text>{issues.length ? issues.map(issue => <button key={issue.key} type="button" className="engineering-issue" data-state={issue.state} onClick={() => { if (issue.selection) select(issue.selection); }}><span className="sb-led" data-state={issue.state === "fail" ? "failed" : issue.state === "unknown" ? "unknown" : "not-evaluated"} aria-hidden="true" /> {issue.text}</button>) : <Text size="sm">No issues found by the completed applicable checks. Physical qualification is not evaluated.</Text>}</Stack>,
        connection: <ProbeDetails drawing={drawing} selection={selection} onSelect={select} cable={cable} stacks={stacks} check={checkData} index={index}
          onChange={editable && mode !== "frozen" ? onChange : undefined} armed={armed} onArm={setArmed} proposalRows={pendingRows} />,
        part: <Stack gap="xs"><Group>{cable.endpoints.map((end, index) => <Button key={end.local_id} size="compact-xs" variant="quiet" onClick={() => select(`e:${end.local_id}`)}>End {String.fromCharCode(65 + index)}</Button>)}</Group>
          {endIndex >= 0 ? props.endForms?.[endIndex] ?? <Text size="sm">This end is read-only. Its exact stack is drawn.</Text> : <ProbeDetails drawing={drawing} selection={selection} onSelect={select} cable={cable} stacks={stacks} check={checkData} index={index} armed={null} onArm={() => {}} proposalRows={[]} />}</Stack>,
        signals: <Stack gap="xs">{props.editor.dirty && <Alert color="yellow">The check below describes the saved draft. Unsaved working changes have not been checked.</Alert>}<SignalStrip drawing={drawing} checkRows={!check.isError ? check.data?.rows ?? [] : []} lit={lit} selection={selection} onSelect={select} /><IntentCheckPanel revisionId={revisionId} draftId={draftId} intentRevisionId={intentId} checkVersion={props.checkVersion} active={props.editor.active} /></Stack>,
        notes: props.editor.notes,
        recipe: <Stack gap="sm">{props.editor.recipe ?? props.cableForm}<Group><Button size="xs" disabled={!canPropose || (mode === "draft" && props.editor.dirty)} loading={proposal.isPending} onClick={() => proposal.mutate()}>Propose wiring</Button></Group>{proposalView}</Stack>,
      }} />
    </div>;
  }
  return <div className="cwb" data-mode={mode}>
    <div className="cwb-main">
      <div className="cwb-titlebar">
        <h3 className="sb-silk cwb-mode" data-mode={mode}>{mode === "frozen" ? "Frozen cable" : mode === "draft" ? "Edit draft" : "New cable"}</h3>
        <h2>{name}</h2>
        {intentId && checkData && <Text size="xs" c="dimmed">intent: {checkData.intent_name} r{checkData.intent_number}</Text>}
        <span className="cwb-spacer" />
        <Button size="xs" variant="default" disabled={!intentId || !target} title={!intentId ? "Pin an intent to check this cable" : !target ? "Save the cable as a draft to check it" : undefined}
          loading={check.isFetching} onClick={() => void check.refetch()}>Check against intent</Button>
        {mode !== "frozen" && <Button size="xs" variant="default" disabled={!canPropose} title={canPropose ? undefined : "Pin an intent, a stock and both ends first"}
          loading={proposal.isPending} onClick={() => proposal.mutate()}>{proposal.data ? "Propose again" : "Propose wiring"}</Button>}
        {props.actions}
      </div>
      {props.notices}
      <dl className="cwb-cells" aria-label="Cable facts">
        <Cell label="Signals vs intent" testId="cell-signals" sub={checkData ? `${counts("fail")} fail · ${counts("unknown")} unknown · ${counts("not_evaluated")} not evaluated` : intentId ? (check.isError ? "check unavailable" : "saved state") : "pin an intent to check"}>
          {checkData ? <><span className="sb-mono">{counts("pass")}/{rows.length} pass</span>
            <span className="cwb-ticks" role="img" aria-label={`${counts("pass")} of ${rows.length} rows pass`}>{rows.map((r) => <span key={r.row_id} className="cwb-tick" data-status={r.outcome} />)}</span></>
            : intentId ? (check.isLoading ? "Checking…" : <SbUnknown what="check" />) : <span data-unknown="true">No intent</span>}
        </Cell>
        <Cell label="Length" testId="cell-length" sub={length ? (length.kind === "finished" ? "finished length" : "route length") : "not declared"}>{length ? <span className="sb-mono">{length.text}</span> : <SbUnknown />}</Cell>
        <Cell label="Stock" testId="cell-stock" sub={`${drawing.wires.filter((w) => w.inStock).length} conductive elements`}>{stockLabel?.readable ? `${stockLabel.name} r${stockLabel.number}` : cable.stock_revision_id ? "…" : <SbUnknown what="stock" />}</Cell>
        {cable.endpoints.slice(0, 2).map((e, i) => <Cell key={e.local_id} label={`End ${String.fromCharCode(65 + i)}`} testId={`cell-end-${e.local_id}`} sub={e.label?.trim() || `End ${e.local_id.toUpperCase()}`}>
          {endSummary(stacks[i]) ?? <SbUnknown what="stack" />}
        </Cell>)}
        <Cell label="Revision" testId="cell-revision" sub={props.revision.sub}>{props.revision.value}</Cell>
      </dl>
      {stage}
      <SignalStrip drawing={drawing} checkRows={rows} lit={lit} selection={selection} onSelect={select} />
      {proposalView}
      {props.details}
    </div>
    <aside className="cwb-inspector" aria-label="Inspector">
      <SegmentedControl fullWidth size="xs" value={tab} onChange={(v) => setTab(v as Tab)} data={tabs} aria-label="Inspector section" />
      <div className="cwb-inspector-body" hidden={tab !== "probe"} data-tab="probe">
        <ProbeDetails drawing={drawing} selection={selection} onSelect={select} cable={cable} stacks={stacks} check={checkData} index={index}
          onChange={editable && mode !== "frozen" ? onChange : undefined} armed={armed} onArm={setArmed} proposalRows={pendingRows}
          onAcceptRow={props.onAccept ? (id) => accept.mutate(id) : undefined} onRejectRow={(id) => setDecided((current) => new Set([...current, id]))} accepting={accept.isPending} />
      </div>
      <div className="cwb-inspector-body" hidden={tab !== "cable"} data-tab="cable">{props.cableForm ?? <Text size="sm" c="dimmed">Open a draft to edit this cable.</Text>}</div>
      {cable.endpoints.map((e, i) => <div key={e.local_id} className="cwb-inspector-body" hidden={tab !== `end:${e.local_id}`} data-tab={`end:${e.local_id}`}>
        {props.endForms?.[i] ?? <Text size="sm" c="dimmed">Open a draft to edit this end.</Text>}
      </div>)}
    </aside>
  </div>;
}

/** Arrow keys move between tiles (Home/End to the first and last); Enter or Space probes the focused one. */
function moveFocus(event: ReactKeyboardEvent<HTMLDivElement>) {
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
  if (step === undefined && event.key !== "Home" && event.key !== "End") return;
  const tiles = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
  const at = tiles.indexOf(document.activeElement as HTMLButtonElement);
  const next = event.key === "Home" ? 0 : event.key === "End" ? tiles.length - 1 : Math.min(tiles.length - 1, Math.max(0, (at < 0 ? 0 : at) + step!));
  event.preventDefault();
  tiles[next]?.focus();
}

/** One chip per intent row with its outcome, or per stock element when no intent is pinned. */
function SignalStrip({ drawing, checkRows, lit, selection, onSelect }: { drawing: ReturnType<typeof layoutDrawing>; checkRows: IntentCheck["rows"]; lit: Set<string> | null; selection: string | null; onSelect: (key: string | null) => void }) {
  if (checkRows.length) {
    return <div className="cwb-strip" role="group" aria-label="Signals" onKeyDown={moveFocus}>
      {checkRows.map((row) => {
        const key = rowKey(row.row_id);
        return <UnstyledButton key={row.row_id} className="cwb-chip" aria-pressed={selection === key} data-dim={lit && !lit.has(key) ? true : undefined}
          onClick={() => onSelect(selection === key ? null : key)} aria-label={`${row.signal?.name ?? row.row_id}: ${STATUS_WORDS[row.outcome]}`}>
          <span className="sb-led" data-state={statusLed(row.outcome)} aria-hidden="true" />
          <span className="cwb-chip-bar" style={{ background: familyColor(signalFamily(row.signal?.type)) }} aria-hidden="true" />
          <span className="cwb-chip-name">{row.signal?.name ?? "Signal unknown"}</span>
          <span className="cwb-chip-ends">{(row.from_label ?? "none").split(" · ")[0]} → {row.to_labels.map((l) => l.split(" · ")[0]).join(" ") || (row.requirement === "must_not_connect" ? "none" : "?")}</span>
        </UnstyledButton>;
      })}
    </div>;
  }
  return <div className="cwb-strip" role="group" aria-label="Conductive elements" onKeyDown={moveFocus}>
    {drawing.wires.map((w) => {
      const color = w.look && w.look.fillSource !== "unknown" ? w.look.base : null;
      const at = (key: string | null) => { const t = key ? drawing.terminals.get(key) : null; return t ? t.label : "–"; };
      return <UnstyledButton key={w.key} className="cwb-chip" aria-pressed={selection === w.key} data-dim={lit && !lit.has(w.key) ? true : undefined} onClick={() => onSelect(selection === w.key ? null : w.key)}>
        <span className="cwb-swatch" style={color ? { background: color } : { backgroundImage: "repeating-linear-gradient(135deg, var(--sb-hatch) 0 1px, transparent 1px 4px)" }} aria-hidden="true" />
        <span className="cwb-chip-bar" style={{ background: familyColor(signalFamily(w.signal?.type)) }} aria-hidden="true" />
        <span className="cwb-chip-name">{w.display}</span>
        <span className="cwb-chip-ends">A {at(w.aTerminal)} → B {at(w.bTerminal)}</span>
      </UnstyledButton>;
    })}
  </div>;
}

