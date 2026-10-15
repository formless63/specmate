import { Alert, Badge, Button, Drawer, Group, Menu, Select, Stack, Text, TextInput } from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { EditorFrame, canonicalJson, useEditHistory, type EditorView } from "../../components/editor";
import { InspectionScope, usePermission } from "../../lib/permissions";
import { randomUUID } from "../../lib/random-id";
import { RevisionLabel } from "../../lib/IdentityLabel";
import { CableWorkbench } from "../cable-workbench/CableWorkbench";
import { cableSelection, withCableSelection } from "../cable-workbench/selection";
import { useNavigation } from "../navigation";
import { useProbe } from "../probe";
import type { LibraryRecord } from "../workspace/api";
import { CableFields, EndCard, useBodies, useCableSources } from "./CablePanel";
import { authorityDenied, cableProblems, command, initialCable, read, type Cable, type Definition, type Draft, type Identity, type Inspection } from "./api";

const revisionPageOffset = (number: number) => Math.floor((number - 1) / 50) * 50;
const KnowledgePanel = lazy(() => import("../knowledge/KnowledgePanel").then(module => ({ default: module.KnowledgePanel })));
const Schematic = lazy(() => import("../../components/editor/Schematic").then(module => ({ default: module.Schematic })));
const Documents = lazy(() => import("../../components/editor/Documents").then(module => ({ default: module.Documents })));
export type CableEditorSnapshot = {
  definitionId: string; revisionId: string | null; draftId: string | null;
  working: Cable; saved: Cable | null; dirty: boolean;
};
export type CableEditorViewSlots = Partial<Record<"schematic" | "documents", (snapshot: CableEditorSnapshot) => ReactNode>>;

/** Retains the last routed cable while its rail panel is hidden; project filters are not editor identity. */
export function CableRecordHost({ record, workspaceId, principalKey, active = true, viewSlots }: { principalKey: string; record?: LibraryRecord; workspaceId: string; active?: boolean; viewSlots?: CableEditorViewSlots }) {
  const probe = useProbe()?.probe;
  const [targets, setTargets] = useState<Record<string, { record: LibraryRecord; rev: number | null }>>(() => record ? { [record.record_id]: { record, rev: probe?.rev ?? null } } : {});
  const [selected, setSelected] = useState(record?.record_id ?? null);
  useEffect(() => {
    if (record?.kind === "cable" && probe?.object === record.record_id) {
      setTargets(current => ({ ...current, [record.record_id]: { record, rev: probe.rev } }));
      setSelected(record.record_id);
    }
  }, [record, probe?.object, probe?.rev]);
  if (!selected) return <Text role="status">Open a cable from Designs to inspect it.</Text>;
  const routeUnavailable = !!(active && probe && (!record || record.record_id !== probe.object));
  const currentSelection = active && record && probe && record.record_id === probe.object ? record.record_id : selected;
  return <>{routeUnavailable && <Text role="status">This cable is not available.</Text>}{Object.values(targets).map(target => <div key={target.record.record_id} hidden={target.record.record_id !== currentSelection || routeUnavailable}>
    <CableRecordEditor record={target.record} requestedRevision={target.rev} workspaceId={workspaceId} principalKey={principalKey} active={active && !routeUnavailable && target.record.record_id === currentSelection} viewSlots={viewSlots} />
  </div>)}</>;
}

export function CableRecordEditor({ record, requestedRevision, workspaceId, principalKey, active = true, viewSlots }: {
  record: LibraryRecord; requestedRevision: number | null; workspaceId: string; principalKey: string; active?: boolean; viewSlots?: CableEditorViewSlots;
}) {
  const cache = useQueryClient();
  const navigation = useNavigation();
  const probe = useProbe();
  const editGate = usePermission("design.edit"); const freezeGate = usePermission("design.freeze"); const createGate = usePermission("item.create");
  const number = requestedRevision ?? record.latest_revision;
  const targetPage = number ? revisionPageOffset(number) : 0;
  const [page, setPage] = useState(targetPage);
  const [editing, setEditing] = useState(number === null);
  const enterDraft = useRef(false);
  const [versions, setVersions] = useState(false);
  const [base, setBase] = useState<Draft | null>(null);
  const history = useEditHistory<Cable>(initialCable());
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mutationDenied, setMutationDenied] = useState(false);
  const [sourceDenied, setSourceDenied] = useState(false);
  const [issueStatus, setIssueStatus] = useState({ target: "", count: 1, failed: false });
  const [review, setReview] = useState<Cable["review"]>("unreviewed");
  const [basis, setBasis] = useState("");
  const [confirm, setConfirm] = useState<"revert" | "frozen" | null>(null);
  const [pendingRevision, setPendingRevision] = useState<number | null>(null);
  const [duplicateName, setDuplicateName] = useState<string | null>(null);
  const [compareRevision, setCompareRevision] = useState<string | null>(null);
  const [localSelection, setLocalSelection] = useState<string | null>(null);
  const selectedTarget = active && probe?.probe?.object === record.record_id ? probe.probe : null;
  const selection = selectedTarget ? cableSelection(selectedTarget) : localSelection;
  const select = (key: string | null) => {
    setLocalSelection(key);
    if (active && probe) probe.setProbe(withCableSelection(selectedTarget ?? { object: record.record_id, rev: requestedRevision, path: [] }, key));
  };
  const intents = useRef(new Map<string, string>());
  const view = (navigation?.location.filters?.view ?? "build") as EditorView;
  const [documentsVisited, setDocumentsVisited] = useState(view === "documents");
  useEffect(() => { if (view === "documents") setDocumentsVisited(true); }, [view]);
  const identity = useQuery({ queryKey: ["cable-identity", record.record_id, page], queryFn: () => read<Identity>(`catalog/definitions/${record.record_id}?offset=${page}`), retry: false });
  const newestIdentity = useQuery({ queryKey: ["cable-editor-draft-list", record.record_id], queryFn: () => read<Identity>(`catalog/definitions/${record.record_id}?offset=0`), retry: false });
  const draftId = newestIdentity.data?.drafts.at(-1)?.draft_id ?? null;
  const draft = useQuery({ queryKey: ["cable-draft", draftId], queryFn: () => read<Draft>(`cables/drafts/${draftId}`), enabled: !!draftId, retry: false });
  const targetIdentity = useQuery({ queryKey: ["cable-identity", record.record_id, targetPage], queryFn: () => read<Identity>(`catalog/definitions/${record.record_id}?offset=${targetPage}`), retry: false });
  const revisionId = targetIdentity.data?.revisions.find(revision => revision.number === number)?.revision_id ?? null;
  const frozen = useQuery({ queryKey: ["cable-inspection", revisionId], queryFn: () => read<Inspection>(`cables/revisions/${revisionId}`), enabled: !!revisionId && !editing, retry: false });
  const definitions = useQuery({ queryKey: ["cable-definitions", null], queryFn: () => read<Definition[]>("workspace/definitions"), enabled: editing, retry: false });
  useEffect(() => {
    if (enterDraft.current && requestedRevision === null) { enterDraft.current = false; return; }
    setPage(number ? revisionPageOffset(number) : 0); setEditing(number === null);
  }, [requestedRevision]);
  useEffect(() => {
    if (!base && draft.data?.content.cable) {
      setBase(draft.data); history.load(draft.data.content.cable);
      setReview(draft.data.content.cable.review); setBasis(draft.data.content.cable.review_basis ?? "");
    }
  }, [base, draft.data, history.load]);
  const cable = editing ? history.value : frozen.data?.cable ?? initialCable();
  const dirty = editing && !!base && canonicalJson(history.value) !== canonicalJson(base.content.cable);
  const sources = useCableSources(cable, workspaceId, setSourceDenied);
  const stacks = sources.denied ? [] : sources.resolved.map(result => result.data);
  const bodies = useBodies(stacks);
  const blocked = sources.denied || sourceDenied || mutationDenied || identity.isError || targetIdentity.isError || newestIdentity.isError || (editing ? draft.isError : frozen.isError);
  const snapshot: CableEditorSnapshot = { definitionId: record.record_id, revisionId: editing ? null : revisionId, draftId: editing ? draftId : null, working: cable, saved: base?.content.cable ?? null, dirty };
  const changedOnServer = !!base && !!draft.data && draft.data.state !== base.state;
  const statusTarget = `${editing ? `draft:${base?.state}` : `frozen:${revisionId}`}:${dirty}`;
  const statusChanged = useCallback((count: number, failed: boolean) => setIssueStatus(current => current.target === statusTarget && current.count === count && current.failed === failed ? current : { target: statusTarget, count, failed }), [statusTarget]);
  const operate = async <T,>(operation: string, payload: object, state?: string) => {
    const fingerprint = canonicalJson([operation, payload, state]);
    const key = intents.current.get(fingerprint) ?? randomUUID(); intents.current.set(fingerprint, key);
    const result = await command<T>(operation, payload, state, key);
    intents.current.delete(fingerprint);
    return result;
  };
  // Retained records share the cache; only this viewed state and its exact source
  // closure can decide whether this buffer has recovered its current authority.
  const authorityKeys = canonicalJson([
    ["cable-identity", record.record_id, page], ["cable-identity", record.record_id, targetPage],
    ["cable-editor-draft-list", record.record_id],
    editing ? ["cable-draft", draftId] : ["cable-inspection", revisionId],
    ["cable-stock", cable.stock_revision_id],
    ...cable.endpoints.flatMap(end => [
      ["cable-end-resolve", end.end_assembly_revision_id ? { end_assembly_revision_id: end.end_assembly_revision_id } : { stack: end.stack }],
      ...(end.stack?.layers ?? []).flatMap(layer => layer.kind === "connector" ? [["cable-body", layer.body_revision_id]] : layer.kind === "board" ? [["cable-board", layer.board_revision_id]] : []),
    ]),
    ...sources.resolved.flatMap(result => result.data?.body_revision_id ? [["cable-body", result.data.body_revision_id]] : []),
    ["cable-intent-check", editing ? null : revisionId, editing ? draftId : null, cable.intent_revision_id ?? null, base?.state ?? null],
  ]);
  const assertAuthority = useCallback(async () => {
      const keys = new Set((JSON.parse(authorityKeys) as unknown[][]).map(canonicalJson));
      const queries = cache.getQueryCache().findAll({ type: "active" }).filter(query => keys.has(canonicalJson(query.queryKey)));
      await Promise.all(queries.map(query => cache.fetchQuery({ queryKey: query.queryKey, queryFn: query.options.queryFn, staleTime: 0 })));
  }, [cache, authorityKeys]);
  const refreshAuthority = useCallback(async () => {
    setMessage(null);
    try {
      await assertAuthority();
      setMutationDenied(false);
    } catch { setMessage("Current authority could not be confirmed. Retained edits remain hidden."); }
  }, [assertAuthority]);
  useEffect(() => {
    const refresh = () => { if (active && blocked) void refreshAuthority(); };
    window.addEventListener("focus", refresh); return () => window.removeEventListener("focus", refresh);
  }, [active, blocked, refreshAuthority]);
  const act = async (work: () => Promise<void>) => {
    if (busy || blocked) return;
    setBusy(true); setMessage(null);
    try { await work(); } catch (error) {
      if (authorityDenied(error)) setMutationDenied(true);
      setMessage(error instanceof Error ? error.message : "The operation did not complete.");
    } finally { setBusy(false); }
  };
  const saveContent = async (value = history.value) => {
    if (!base) throw new Error("The saved draft is not available.");
    const missing = cableProblems(value); if (missing.length) throw new Error(missing.join(" "));
    const saved = await operate<Draft>("cable.update", { draft_id: base.draft_id, cable: value }, base.state);
    setBase(saved); cache.setQueryData(["cable-draft", base.draft_id], saved);
    await Promise.all([cache.invalidateQueries({ queryKey: ["workspace", "designs"] }), cache.invalidateQueries({ queryKey: ["cable-intent-check"] })]);
    return saved;
  };
  const editWorking = (next: Cable) => { if (!busy && !blocked && editGate.allowed) history.edit(next); };
  const save = () => act(async () => { await saveContent(); });
  const freeze = () => act(async () => {
    if (!base) return;
    const value = { ...history.value, review, review_basis: basis.trim() || null };
    if (review === "reviewed" && !value.review_basis) throw new Error("A reviewed freeze requires a review basis.");
    const saved = canonicalJson(value) === canonicalJson(base.content.cable) ? base : await saveContent(value);
    history.edit(value);
    const result = await operate<{ revision_id: string; number: number; draft?: Draft }>("cable.freeze", { draft_id: saved.draft_id }, saved.state);
    if (result.draft) { const next = { ...saved, ...result.draft }; setBase(next); cache.setQueryData(["cable-draft", saved.draft_id], next); }
    await cache.invalidateQueries({ queryKey: ["cable-identity", record.record_id] });
    await cache.invalidateQueries({ queryKey: ["cable-editor-draft-list", record.record_id] });
    await cache.invalidateQueries({ queryKey: ["workspace", "designs"] });
    setEditing(false); setVersions(false); setPage(revisionPageOffset(result.number));
    probe?.setProbe({ object: record.record_id, rev: result.number, path: [] });
  });
  const openRevision = (next: number) => { if (dirty) { setPendingRevision(next); setConfirm("frozen"); return; } probe?.setProbe({ object: record.record_id, rev: next, path: [] }); setEditing(false); setPage(revisionPageOffset(next)); };
  const revert = () => act(async () => { const latest = await read<Draft>(`cables/drafts/${draftId}`); setBase(latest); history.load(latest.content.cable ?? initialCable()); cache.setQueryData(["cable-draft", draftId], latest); setConfirm(null); });
  const duplicate = () => act(async () => {
    const next = await operate<Draft>("cable.create", { workspace_id: workspaceId, name: duplicateName!.trim(), cable });
    setDuplicateName(null);
    await cache.invalidateQueries({ queryKey: ["workspace", "designs"] });
    navigation?.navigate({ area: "designs", lens: "cables", probe: { object: next.definition_id, rev: null, path: [] } });
  });
  useEffect(() => {
    if (!active) return;
    const key = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.defaultPrevented) return;
      const input = event.target instanceof Element && event.target.closest("input,textarea,select,[contenteditable=true],[role=dialog]");
      if (event.key.toLowerCase() === "s" && editing && editGate.allowed) { event.preventDefault(); void save(); }
      if (!input && editing && editGate.allowed && event.key.toLowerCase() === "z") { event.preventDefault(); if (event.shiftKey) history.redo(); else history.undo(); }
    };
    window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
  });
  const comparison = useQuery({ queryKey: ["cable-editor-compare", compareRevision], queryFn: () => read<Inspection>(`cables/revisions/${compareRevision}`), enabled: !!compareRevision && versions, retry: false });
  const renderWorkbench = !blocked && (editing ? !!base : !!frozen.data);
  return <EditorFrame name={blocked ? "Cable unavailable" : record.label} view={["build", "schematic", "documents"].includes(view) ? view : "build"} onView={next => navigation?.navigate({ filters: { ...navigation.location.filters, view: next } })}
    revision={<Button size="compact-xs" variant="quiet" aria-label="Cable versions" onClick={() => setVersions(true)}><span className="lg-rev" data-frozen={!editing || undefined}>{editing ? `draft${dirty ? " •" : ""}` : number ? `r${number}` : "No frozen revision"}</span></Button>}
    status={<Badge variant="outline" color={!blocked && renderWorkbench && issueStatus.target === statusTarget && issueStatus.failed ? "red" : "yellow"}>{blocked ? "Checks unavailable" : !renderWorkbench || issueStatus.target !== statusTarget ? "Checks not evaluated" : issueStatus.count ? `${issueStatus.count} issue${issueStatus.count === 1 ? "" : "s"}` : "No issues in evaluated checks"}</Badge>}
    actions={<><Menu position="bottom-end"><Menu.Target><Button size="xs" variant="quiet">Design</Button></Menu.Target><Menu.Dropdown><Menu.Item disabled={!createGate.allowed || blocked || busy} onClick={() => setDuplicateName(`${record.label} copy`)}>Duplicate…</Menu.Item><Menu.Item disabled={!editing || !editGate.allowed || blocked || busy} onClick={() => setConfirm("revert")}>Revert to saved draft…</Menu.Item><Menu.Item onClick={() => setVersions(true)}>Versions</Menu.Item></Menu.Dropdown></Menu>
      {editing && <><Button size="xs" aria-label="Undo cable edit" disabled={!history.past.length || !editGate.allowed || busy || blocked} onClick={history.undo}>Undo</Button><Button size="xs" aria-label="Redo cable edit" disabled={!history.future.length || !editGate.allowed || busy || blocked} onClick={history.redo}>Redo</Button><Button size="xs" {...editGate.props} disabled={!dirty || busy || blocked || !editGate.allowed} onClick={() => void save()}>Save</Button><Button size="xs" {...freezeGate.props} disabled={busy || blocked || !freezeGate.allowed} onClick={() => setVersions(true)}>Freeze…</Button></>}
    </>}>
    {message && <Alert role="alert" color="red">{message}</Alert>}
    {blocked && <Alert color="red">Current access must be confirmed before the cable or its retained edits can be shown. <Button size="xs" onClick={() => void refreshAuthority()}>Refresh cable access</Button></Alert>}
    {changedOnServer && editing && !blocked && <Alert color="yellow">The saved draft changed elsewhere. Your working changes and original save token are retained. Review or revert before retrying.</Alert>}
    {!blocked && !renderWorkbench && <Text role="status">{identity.isPending || frozen.isPending ? "Reading cable state…" : "The requested cable state is not available."}</Text>}
    {renderWorkbench && <div hidden={view !== "build"}><CableWorkbench selection={selection} onSelect={select} mode={editing ? "draft" : "frozen"} name={record.label} cable={cable} onChange={editing && editGate.allowed && !busy ? history.edit : undefined}
      stacks={stacks} bodies={bodies} stock={sources.stock.data} conductors={!editing ? frozen.data?.conductors : undefined} draftId={editing ? draftId : null} revisionId={editing ? null : revisionId} checkVersion={base?.state}
      revision={{ value: editing ? "Draft" : `r${number}`, sub: editing ? "working state" : "frozen · immutable" }} onAccept={editing && editGate.allowed && !busy ? history.edit : undefined}
      editor={{ dirty, active: active && view === "build", onStatus: statusChanged, notes: <Suspense fallback={<Text>Reading attached notes…</Text>}><KnowledgePanel workspaceId={workspaceId} principalKey={principalKey} target={editing ? { kind: "definition", definition_id: record.record_id } : { kind: "revision", revision_id: revisionId! }} /></Suspense> }}
      cableForm={editing ? <fieldset disabled={busy} className="engineering-fields"><InspectionScope permission="design.edit"><CableFields value={cable} onChange={editWorking} definitions={definitions.data ?? []} sources={sources} showReview={false} /></InspectionScope></fieldset> : <Stack gap={4}><Text size="sm">Frozen recipe · exact r{number}</Text><RevisionLabel id={cable.stock_revision_id} /><Text size="sm">Review: {cable.review}</Text><Text size="sm">{cable.review_basis ?? "Review basis not declared."}</Text></Stack>}
      endForms={cable.endpoints.map((_end, index) => editing ? <fieldset disabled={busy} className="engineering-fields" key={index}><InspectionScope permission="design.edit"><EndCard index={index} value={cable} onChange={editWorking} errors={{}} family={sources.family} definitions={definitions.data ?? []} choices={sources.choices} denied={sources.denied} resolved={sources.resolved[index]!} /></InspectionScope></fieldset> : <Stack key={index}>{stacks[index]?.layers.map(layer => <Text key={layer.layer_id} size="sm">{layer.name ?? layer.kind}</Text>)}</Stack>)} /></div>}
    {view === "schematic" && renderWorkbench && (viewSlots?.schematic?.(snapshot) ?? <Suspense fallback={<Text>Reading schematic viewer…</Text>}><Schematic name={record.label} cable={cable} stock={sources.stock.data} stacks={stacks} conductors={editing ? undefined : frozen.data?.conductors}
      selection={selection} onSelect={select} unreleased={editing} state={editing ? dirty ? "Working draft · unsaved changes" : "Saved draft" : `Exact frozen r${number}`} /></Suspense>)}
    {(documentsVisited || view === "documents") && <div hidden={view !== "documents" || !renderWorkbench}>{viewSlots?.documents?.(snapshot) ?? <Suspense fallback={<Text>Reading document viewer…</Text>}><Documents name={record.label} snapshot={snapshot} workspaceId={workspaceId} principalKey={principalKey} active={active && view === "documents" && renderWorkbench} authorizeWorking={assertAuthority} cable={cable} stock={sources.stock.data} stacks={stacks} conductors={editing ? undefined : frozen.data?.conductors} /></Suspense>}</div>}
    <Drawer closeButtonProps={{ "aria-label": "Close cable versions" }} opened={versions && active} onClose={() => setVersions(false)} position="right" title="Cable versions" size="min(420px, 100vw)">{blocked ? <Text>Current access must be confirmed before versions can be shown.</Text> : <Stack gap="sm">
      <Text size="sm">{editing ? "Working draft" : `Viewing frozen r${number}`} · frozen revisions keep their exact pins.</Text>
      {!editing && base && <Button size="xs" {...editGate.props} onClick={() => { enterDraft.current = requestedRevision !== null; setEditing(true); probe?.setProbe({ object: record.record_id, rev: null, path: [] }); }}>Edit current draft</Button>}
      {editing && <><InspectionScope permission="design.freeze"><Select label="Freeze review status" value={review} data={["unreviewed", "reviewed"]} onChange={value => setReview(value as Cable["review"])} /><TextInput label="Freeze review basis" value={basis} onChange={event => setBasis(event.currentTarget.value)} /></InspectionScope><Button {...freezeGate.props} disabled={!freezeGate.allowed || busy || blocked} loading={busy} onClick={() => void freeze()}>Freeze next revision</Button></>}
      {[...(identity.data?.revisions ?? [])].reverse().map(revision => <Group key={revision.revision_id} justify="space-between"><Button size="compact-xs" variant="quiet" onClick={() => openRevision(revision.number)}>Open r{revision.number}</Button>{revisionId && revision.revision_id !== revisionId && <Button size="compact-xs" variant="quiet" onClick={() => setCompareRevision(revision.revision_id)}>Compare r{revision.number} with r{number}</Button>}</Group>)}
      <Group><Button size="compact-xs" disabled={page === 0} onClick={() => setPage(Math.max(0, page - 50))}>Earlier revisions</Button><Button size="compact-xs" disabled={(identity.data?.revisions.length ?? 0) < 50} onClick={() => setPage(page + 50)}>Later revisions</Button></Group>
      {comparison.isError && <Alert color="red">{comparison.error.message}</Alert>}
      {comparison.data && !comparison.isError && frozen.data && <Stack gap={4}><Text fw={600} size="sm">Read-only revision comparison</Text>{(["stock_revision_id", "intent_revision_id", "lengths", "endpoints", "assignments", "review", "review_basis"] as const).map(field => <Text key={field} size="xs">{({ stock_revision_id: "Stock", intent_revision_id: "Intent", lengths: "Lengths", endpoints: "Ends", assignments: "Landings", review: "Review", review_basis: "Review basis" })[field]}: {canonicalJson(comparison.data.cable[field]) === canonicalJson(frozen.data!.cable[field]) ? "unchanged" : "differs"}</Text>)}</Stack>}
      {!editing && revisionId && <RevisionLabel id={revisionId} />}
    </Stack>}</Drawer>
    <Drawer closeButtonProps={{ "aria-label": "Close unsaved changes review" }} opened={confirm !== null && active && !blocked} onClose={() => setConfirm(null)} position="right" title="Review unsaved changes"><Stack><Text>{confirm === "revert" ? "Reload the saved draft and discard local working changes?" : "Open this frozen revision? Your working draft buffer stays retained."}</Text><Button onClick={() => { if (confirm === "revert") void revert(); else if (pendingRevision !== null) { setConfirm(null); setEditing(false); probe?.setProbe({ object: record.record_id, rev: pendingRevision, path: [] }); setPage(revisionPageOffset(pendingRevision)); } }}>Continue</Button><Button variant="quiet" onClick={() => setConfirm(null)}>Keep editing</Button></Stack></Drawer>
    <Drawer closeButtonProps={{ "aria-label": "Close duplicate cable" }} opened={duplicateName !== null && active && !blocked} onClose={() => setDuplicateName(null)} position="right" title="Duplicate cable"><Stack><TextInput label="New cable name" value={duplicateName ?? ""} onChange={event => setDuplicateName(event.currentTarget.value)} /><Text size="xs">Copies the viewed design into a new draft with its exact pins. The original is retained.</Text><Button {...createGate.props} disabled={!duplicateName?.trim() || busy || blocked || !createGate.allowed} loading={busy} onClick={() => void duplicate()}>Create duplicate</Button></Stack></Drawer>
  </EditorFrame>;
}
