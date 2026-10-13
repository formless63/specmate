import { PathExplanation } from "./PathExplanation";
import { Alert, Button, Card, Checkbox, Group, NativeSelect, Stack, Text, Textarea, TextInput, Title } from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import { scopeLabel } from "../copper/api";
import { createModel, freezeModel, inspectDraft, inspectModel, inspectRoot, interpretModel, reviewModel, updateModel } from "./api";
import type { ConditionDeclaration, Draft, Evidence, Graph, Inspection, Interpretation, Model, Passage } from "./api";

type Props = { projectId: string; canEdit: boolean; canFreeze?: boolean };
const readable = (value: string) => value.replaceAll("_", " ");
const kinds: Passage["kind"][] = ["unknown", "resistor", "capacitor", "diode", "inductor", "transformer", "conditional", "active"];
const newPassage = (index: number): Passage => ({ local_id: `passage-${index}`, from_terminal_id: "", to_terminal_id: "", kind: "unknown", resistance_ohm: null, capacitance_f: null, condition: null, native_candidate_boundary_id: null, basis: "", evidence: { status: "unknown" } });

function nextPassage(existing: Passage[]) {
  const ids = new Set(existing.map((p) => p.local_id));
  let index = 1;
  while (ids.has(`passage-${index}`)) index += 1;
  return newPassage(index);
}

function EvidenceEditor({ label, value, onChange, disabled }: { label: string; value: Evidence; onChange: (e: Evidence) => void; disabled: boolean }) {
  return <Stack gap="xs"><NativeSelect label={`${label} evidence status`} value={value.status} disabled={disabled} data={[{ value: "unknown", label: "Unknown" }, { value: "unverified_citation", label: "Unverified citation" }, { value: "registered_file", label: "Exact registered source file" }]} onChange={(e) => onChange({ status: e.currentTarget.value as Evidence["status"] })} />
    {value.status === "unverified_citation" && <Textarea label={`${label} citation`} value={value.citation ?? ""} disabled={disabled} onChange={(e) => onChange({ ...value, citation: e.currentTarget.value })} />}
    {value.status === "registered_file" && <Group grow><TextInput label={`${label} source bundle revision ID`} value={value.source_bundle_revision_id ?? ""} disabled={disabled} onChange={(e) => onChange({ ...value, source_bundle_revision_id: e.currentTarget.value })} /><TextInput label={`${label} exact source path`} value={value.source_path ?? ""} disabled={disabled} onChange={(e) => onChange({ ...value, source_path: e.currentTarget.value })} /></Group>}
  </Stack>;
}

export function PassivePassagesWorkspace({ projectId, canEdit, canFreeze = false }: Props) {
  const [rootId, setRootId] = useState("");
  const [graph, setGraph] = useState<Graph>();
  const [name, setName] = useState("");
  const [modelBasis, setModelBasis] = useState("");
  const [idealModel, setIdealModel] = useState(false);
  const [passages, setPassages] = useState<Passage[]>([]);
  const [conditions, setConditions] = useState<ConditionDeclaration[]>([]);
  const [conditionAssignments, setConditionAssignments] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<Draft>();
  const [draftId, setDraftId] = useState("");
  const [revisionId, setRevisionId] = useState("");
  const [inspection, setInspection] = useState<Inspection>();
  const [filter, setFilter] = useState("");
  const [boundaryPage, setBoundaryPage] = useState(0);
  const [reviewDecision, setReviewDecision] = useState("needs_evidence");
  const [reviewBasis, setReviewBasis] = useState("");
  const [reviewEvidence, setReviewEvidence] = useState<Evidence>({ status: "unknown" });
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [query, setQuery] = useState("dc_continuity");
  const [copper, setCopper] = useState("unspecified");
  const [frequency, setFrequency] = useState("");
  const [result, setResult] = useState<Interpretation>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const queryGeneration = useRef(0);
  function clear() { generation.current += 1; queryGeneration.current += 1; setRootId(""); setName(""); setModelBasis(""); setIdealModel(false); setReviewBasis(""); setReviewEvidence({ status: "unknown" }); setCopper("unspecified"); setFrequency(""); setGraph(undefined); setInspection(undefined); setResult(undefined); setPassages([]); setConditions([]); setConditionAssignments({}); setDraft(undefined); setFrom(""); setTo(""); setFilter(""); setBoundaryPage(0); setBusy(false); }
  useEffect(() => { clear(); setRootId(""); setDraftId(""); setRevisionId(""); setName(""); setModelBasis(""); setIdealModel(false); setReviewBasis(""); setReviewEvidence({ status: "unknown" }); return () => { generation.current += 1; }; }, [projectId]);
  async function run<T>(request: () => Promise<T>, apply: (value: T) => void) {
    const token = ++generation.current; setBusy(true); setError("");
    try { const value = await request(); if (token === generation.current) apply(value); }
    catch (e) { if (token !== generation.current) return; clear(); setError(e instanceof Error ? e.message : "Request failed."); }
    finally { if (token === generation.current) setBusy(false); }
  }
  function clearQuery() { queryGeneration.current += 1; setResult(undefined); }
  function showModel(value: Inspection, preserve = false) { setInspection(value); setGraph(value.graph); setRootId(value.model.root_revision_id); setResult(undefined); if (!preserve) { setConditionAssignments({}); setReviewBasis(""); setReviewEvidence({ status: "unknown" }); } }
  function showDraft(value: Draft, root: Graph) { setDraft(value); setDraftId(value.draft_id); setGraph(root); setRootId(value.content.passages.root_revision_id); setPassages(value.content.passages.passages); setConditions(value.content.passages.conditions ?? []); setConditionAssignments({}); setIdealModel(true); setModelBasis(value.content.passages.model_basis); setInspection(undefined); setResult(undefined); }
  useEffect(() => {
    const refresh = () => {
      if (inspection) void run(() => inspectModel(inspection.revision_id), (value) => showModel(value, value.state === inspection.state));
      else if (draft) void run(async () => { const value = await inspectDraft(draft.draft_id); const root = await inspectRoot(value.content.passages.root_revision_id); return { value, root }; }, ({ value, root }) => {
        if (value.state !== draft.state) throw new Error("Saved model draft changed; reopen its current state before editing.");
        setGraph(root);
      });
      else if (graph) void run(() => inspectRoot(graph.root_revision_id), setGraph);
    };
    window.addEventListener("focus", refresh); return () => window.removeEventListener("focus", refresh);
  }, [inspection, draft, graph]);
  function submitQuery() {
    if (!inspection) return;
    const token = ++queryGeneration.current;
    void run(() => interpretModel({ revision_id: inspection.revision_id, from_terminal_id: from, to_terminal_id: to, query, copper_assumption: copper, condition_assignments: Object.entries(conditionAssignments).filter(([, state]) => state).map(([condition_id, state]) => ({ condition_id, state })), ...(query === "signal" && frequency ? { frequency_hz: frequency } : {}) }), (value) => { if (token === queryGeneration.current) setResult(value); });
  }
  const activeGraph = inspection?.graph ?? graph;
  const choices = (selected: string) => {
    const rows = activeGraph?.nodes ?? [];
    const search = filter.toLowerCase();
    const matches = rows.filter((n) => `${n.label} ${n.id} ${n.occurrence_path.join("/")}`.toLowerCase().includes(search)).slice(0, 100);
    const current = rows.find((n) => n.id === selected);
    if (current && !matches.some((n) => n.id === selected)) matches.unshift(current);
    return [{ value: "", label: "Select an exact terminal" }, ...matches.map((n) => ({ value: n.id, label: `${scopeLabel(n.occurrence_path)} · ${n.label} · ${n.id}` }))];
  };
  const patch = (index: number, change: Partial<Passage>) => { setResult(undefined); setPassages((prior) => prior.map((p, n) => n === index ? { ...p, ...change } : p)); };
  const model = (): Model => ({ root_revision_id: graph!.root_revision_id, assumptions: "ideal_lumped_components", model_basis: modelBasis, conditions, passages });
  const editable = canEdit && !busy && !inspection;
  const conditionsValid = new Set(conditions.map((c) => c.local_id)).size === conditions.length && conditions.every((c) => c.local_id.trim() && c.basis.trim() && c.states.length >= 2 && c.states.length <= 32 && c.states.every((state) => state.trim()) && new Set(c.states).size === c.states.length);
  const contactsValid = passages.every((p) => !p.conditional_contact || conditions.some((c) => c.local_id === p.conditional_contact!.condition_id && c.states.includes(p.conditional_contact!.state)));
  const savable = conditionsValid && contactsValid && editable && graph && idealModel && modelBasis.trim() && (draft || name.trim()) && passages.every((p) => p.local_id.trim() && p.from_terminal_id && p.to_terminal_id && p.from_terminal_id !== p.to_terminal_id && p.basis.trim());
  const sourceEvidence = (passage: Passage) => inspection?.assertion_evidence?.find((row) => row.local_id === passage.local_id)?.evidence ?? passage.evidence;
  const displayTerminal = (id: string) => { const node = activeGraph?.nodes.find((n) => n.id === id); return node ? `${scopeLabel(node.occurrence_path)} · ${node.label}` : id; };
  return <Stack>
    <Title order={2}>Passive passage interpretation</Title>
    <Text>Declare and review an ideal circuit model for exact terminals. Copper reachability, native component candidates and physical measurements have separate meanings.</Text>
    <Alert color="yellow">Resistor paths are resistive; ideal capacitors block steady-state DC. Declared ideal contacts require explicit exclusive state assignments. Diode operating states, active behavior and transformer models remain unknown. Model review and path reachability establish no physical continuity, signal transfer or qualification.</Alert>
    {error && <Alert color="red">{error} Cached model, graph and query results were cleared. Reload authorized state before continuing.</Alert>}
    <Group align="end"><TextInput label="Exact frozen passive model revision ID" value={revisionId} onChange={(e) => { clear(); setRevisionId(e.currentTarget.value); }} /><Button disabled={busy || !revisionId.trim()} onClick={() => void run(() => inspectModel(revisionId.trim()), showModel)}>Inspect frozen passive model</Button></Group>
    <Group align="end"><TextInput label="Existing passive draft ID" value={draftId} onChange={(e) => { clear(); setDraftId(e.currentTarget.value); }} /><Button disabled={busy || !canEdit || !draftId.trim()} onClick={() => void run(async () => { const value = await inspectDraft(draftId.trim()); const root = await inspectRoot(value.content.passages.root_revision_id); return { value, root }; }, ({ value, root }) => showDraft(value, root))}>Open passive draft</Button></Group>
    {!inspection && <><Group align="end"><TextInput label="Exact copper root revision ID" value={rootId} onChange={(e) => { clear(); setRootId(e.currentTarget.value); }} /><Button disabled={busy || !rootId.trim()} onClick={() => void run(() => inspectRoot(rootId.trim()), (root) => { setGraph(root); setPassages([]); setConditions([]); setConditionAssignments({}); setFrom(""); setTo(""); })}>Inspect model root</Button></Group>
      {graph && <Stack><Text>Root revision: {graph.root_revision_id} · SHA-256 {graph.snapshot_sha256}</Text><TextInput label="New passive model name" value={name} disabled={!editable || !!draft} onChange={(e) => setName(e.currentTarget.value)} />
        <Checkbox label="I am declaring an ideal lumped component model, separate from physical facts" checked={idealModel} disabled={!editable} onChange={(e) => setIdealModel(e.currentTarget.checked)} /><Textarea label="Ideal model assumptions and basis" value={modelBasis} disabled={!editable} onChange={(e) => setModelBasis(e.currentTarget.value)} />
        <TextInput label="Filter exact terminal labels or occurrence paths" value={filter} onChange={(e) => setFilter(e.currentTarget.value)} /><Text size="sm">Selectors show up to 100 matching exact terminals. Narrow the filter to locate a specific occurrence.</Text>
        <Title order={3}>Exclusive condition declarations</Title><Text>One identity describes one switch or fitted option in this model. Its listed states are mutually exclusive. Separate occurrences need separate identities; labels do not establish identity.</Text>
        <Button disabled={!editable || conditions.length >= 64} onClick={() => { const ids = new Set(conditions.map((c) => c.local_id)); let index = 1; while (ids.has(`condition-${index}`)) index += 1; setConditions((prior) => [...prior, { local_id: `condition-${index}`, states: ["open", "closed"], basis: "" }]); }}>Add exclusive condition</Button>
        {conditions.map((c, index) => <Card withBorder key={index}><Stack><TextInput label={`Condition ${index + 1} identity`} value={c.local_id} disabled={!editable} onChange={(e) => { const identity = e.currentTarget.value; setConditions((prior) => prior.map((row, n) => n === index ? { ...row, local_id: identity } : row)); }} /><TextInput label={`Condition ${index + 1} exclusive states (comma separated)`} value={c.states.join(", ")} disabled={!editable} onChange={(e) => { const states = e.currentTarget.value.split(",").map((state) => state.trim()); setConditions((prior) => prior.map((row, n) => n === index ? { ...row, states } : row)); }} /><Textarea label={`Condition ${index + 1} declaration basis`} value={c.basis} disabled={!editable} onChange={(e) => { const basis = e.currentTarget.value; setConditions((prior) => prior.map((row, n) => n === index ? { ...row, basis } : row)); }} /><Button disabled={!editable} onClick={() => setConditions((prior) => prior.filter((_, n) => n !== index))}>Remove condition {index + 1}</Button></Stack></Card>)}
        <Button disabled={!editable} onClick={() => setPassages((p) => [...p, nextPassage(p)])}>Add passage declaration</Button>
        {passages.map((p, index) => <Card withBorder key={index}><Stack><Title order={4}>Passage declaration {index + 1}</Title><Group grow><TextInput label={`Passage ${index + 1} local ID`} value={p.local_id} disabled={!editable} onChange={(e) => patch(index, { local_id: e.currentTarget.value })} /><NativeSelect label={`Passage ${index + 1} kind`} value={p.kind} data={kinds.map((kind) => ({ value: kind, label: readable(kind) }))} disabled={!editable} onChange={(e) => patch(index, { kind: e.currentTarget.value as Passage["kind"], resistance_ohm: null, capacitance_f: null, conditional_contact: null })} /></Group>
          <Group grow><NativeSelect label={`Passage ${index + 1} from terminal`} value={p.from_terminal_id} data={choices(p.from_terminal_id)} disabled={!editable} onChange={(e) => patch(index, { from_terminal_id: e.currentTarget.value })} /><NativeSelect label={`Passage ${index + 1} to terminal`} value={p.to_terminal_id} data={choices(p.to_terminal_id)} disabled={!editable} onChange={(e) => patch(index, { to_terminal_id: e.currentTarget.value })} /></Group>
          {p.kind === "resistor" && <TextInput label={`Passage ${index + 1} resistance in ohms (exact decimal; blank is unknown)`} value={p.resistance_ohm ?? ""} disabled={!editable} onChange={(e) => patch(index, { resistance_ohm: e.currentTarget.value || null })} />}
          {p.kind === "capacitor" && <TextInput label={`Passage ${index + 1} capacitance in farads (exact decimal; blank is unknown)`} value={p.capacitance_f ?? ""} disabled={!editable} onChange={(e) => patch(index, { capacitance_f: e.currentTarget.value || null })} />}
          {p.kind === "conditional" && <Stack><NativeSelect label={`Passage ${index + 1} ideal contact condition identity`} value={p.conditional_contact?.condition_id ?? ""} disabled={!editable} data={[{ value: "", label: "Unspecified behavior: remains unknown" }, ...conditions.filter((c) => c.local_id).map((c) => ({ value: c.local_id, label: c.local_id }))]} onChange={(e) => patch(index, { conditional_contact: e.currentTarget.value ? { condition_id: e.currentTarget.value, state: "", behavior: "ideal_contact" } : null })} />{p.conditional_contact && <NativeSelect label={`Passage ${index + 1} ideal contact closed state`} value={p.conditional_contact.state} disabled={!editable} data={[{ value: "", label: "Select declared closed state" }, ...(conditions.find((c) => c.local_id === p.conditional_contact?.condition_id)?.states ?? []).filter(Boolean).map((state) => ({ value: state, label: state }))]} onChange={(e) => patch(index, { conditional_contact: { ...p.conditional_contact!, state: e.currentTarget.value } })} />}<Text size="sm">The explicitly declared ideal contact has zero model resistance in its closed state and is open in every other declared state. Missing assignments remain unknown.</Text></Stack>}
          <TextInput label={`Passage ${index + 1} unevaluated condition`} value={p.condition ?? ""} disabled={!editable} onChange={(e) => patch(index, { condition: e.currentTarget.value || null })} /><Textarea label={`Passage ${index + 1} declaration basis`} value={p.basis} disabled={!editable} onChange={(e) => patch(index, { basis: e.currentTarget.value })} />
          <EvidenceEditor label={`Passage ${index + 1}`} value={p.evidence} disabled={!editable} onChange={(evidence) => patch(index, { evidence })} />
          {p.native_candidate_boundary_id && <Text size="sm">Native candidate link: {p.native_candidate_boundary_id}. Type and parameters are independent declarations.</Text>}
          <Button color="red" variant="light" disabled={!editable} onClick={() => setPassages((prior) => prior.filter((_, n) => n !== index))}>Remove declaration {index + 1}</Button>
        </Stack></Card>)}
        <Group><Button disabled={!savable} onClick={() => void run(() => draft ? updateModel(draft, model()) : createModel(projectId, name, model()), (value) => { setDraft(value); setDraftId(value.draft_id); })}>{draft ? "Update passive model draft" : "Save new passive model draft"}</Button><Button disabled={busy || !canFreeze || !draft} onClick={() => void run(() => freezeModel(draft!), (value) => { setDraft(value.draft); setRevisionId(value.revision_id); setResult(undefined); })}>Freeze saved passive model</Button></Group>
        {draft && <Text>Saved draft {draft.draft_id} · {draft.state}. Freeze captures saved content; save local edits first. A frozen model still requires its own review.</Text>}
        <Title order={3}>Native and unresolved source boundaries</Title><Text>These are candidates and boundaries. Declaring a linked passage starts with unknown kind and parameters.</Text>
        {graph.boundaries.slice(boundaryPage * 50, boundaryPage * 50 + 50).map((b) => <Card withBorder key={b.id}><Text>{readable(b.kind)} · {readable(b.status)} · {b.reason}</Text><Text size="sm">{b.members.map(displayTerminal).join(" ↔ ")}</Text><Text size="xs">{b.id} · owning revision {b.provenance.revision_id}</Text><Button disabled={!editable || b.members.length !== 2} onClick={() => setPassages((p) => [...p, { ...nextPassage(p), from_terminal_id: b.members[0] ?? "", to_terminal_id: b.members[1] ?? "", native_candidate_boundary_id: b.id }])}>Declare separate passage for {b.kind} candidate</Button></Card>)}
        <Group><Button disabled={boundaryPage === 0} onClick={() => setBoundaryPage((p) => p - 1)}>Previous source boundaries</Button><Button disabled={(boundaryPage + 1) * 50 >= graph.boundaries.length} onClick={() => setBoundaryPage((p) => p + 1)}>Next source boundaries</Button></Group>
      </Stack>}
    </>}
    {inspection && <Stack><Title order={3}>Frozen passive model</Title><Text>Model revision {inspection.revision_id} · SHA-256 {inspection.sha256}</Text><Text>Root revision {inspection.model.root_revision_id} · SHA-256 {inspection.graph.snapshot_sha256}</Text><Text>Ideal assumptions: {inspection.model.model_basis}</Text><Text>Current review: {inspection.decision} · {inspection.state}</Text>
      {(inspection.model.conditions ?? []).map((c) => <Card withBorder key={c.local_id}><Text>Exclusive condition {c.local_id}: {c.states.join(" / ")}</Text><Text>{c.basis}</Text></Card>)}
      {inspection.model.passages.map((p) => <Card withBorder key={p.local_id}><Text fw={600}>{p.local_id} · {readable(p.kind)}</Text><Text>{displayTerminal(p.from_terminal_id)} → {displayTerminal(p.to_terminal_id)}</Text><Text>{p.basis}</Text>{p.kind === "resistor" && <Text>Declared resistance: {p.resistance_ohm ?? "unknown"} Ω</Text>}{p.kind === "capacitor" && <Text>Declared capacitance: {p.capacitance_f ?? "unknown"} F</Text>}{p.conditional_contact && <Text>Declared ideal contact: {p.conditional_contact.condition_id} = {p.conditional_contact.state} closes; other declared states open.</Text>}{p.condition && <Text>Unevaluated condition: {p.condition}</Text>}<Text>Evidence: {sourceEvidence(p).status}{sourceEvidence(p).citation ? ` · ${sourceEvidence(p).citation}` : ""}{sourceEvidence(p).source_path ? ` · ${sourceEvidence(p).source_bundle_revision_id} / ${sourceEvidence(p).source_path}` : ""}{sourceEvidence(p).sha256 ? ` · ${sourceEvidence(p).sha256} · rights ${sourceEvidence(p).rights}` : ""}</Text></Card>)}
      <Title order={3}>Immutable model review history</Title>{inspection.reviews.map((r) => <Card key={r.review_id} withBorder><Text>Review {r.version}: {r.decision} · {r.basis}</Text><Text>Evidence: {r.evidence.status}{r.evidence.citation ? ` · ${r.evidence.citation}` : ""}{r.evidence.source_path ? ` · ${r.evidence.source_bundle_revision_id} / ${r.evidence.source_path}` : ""}{r.evidence.sha256 ? ` · ${r.evidence.sha256} · rights ${r.evidence.rights}` : ""}</Text></Card>)}
      <NativeSelect label="Passive model review decision" value={reviewDecision} disabled={!canEdit || busy} data={[{ value: "needs_evidence", label: "Needs evidence" }, { value: "accepted", label: "Accept declared ideal model" }, { value: "rejected", label: "Reject model" }]} onChange={(e) => setReviewDecision(e.currentTarget.value)} /><Textarea label="Passive model review basis" value={reviewBasis} disabled={!canEdit || busy} onChange={(e) => setReviewBasis(e.currentTarget.value)} /><EvidenceEditor label="Model review" value={reviewEvidence} disabled={!canEdit || busy} onChange={setReviewEvidence} /><Button disabled={!canEdit || busy || !reviewBasis.trim()} onClick={() => void run(() => reviewModel(inspection, reviewDecision, reviewBasis, reviewEvidence), showModel)}>Append passive model review</Button>
      <Title order={3}>Interpret exact modeled paths</Title><TextInput label="Filter query terminal labels or occurrence paths" value={filter} onChange={(e) => setFilter(e.currentTarget.value)} /><Group grow><NativeSelect label="Query from terminal" value={from} data={choices(from)} onChange={(e) => { setFrom(e.currentTarget.value); clearQuery(); }} /><NativeSelect label="Query to terminal" value={to} data={choices(to)} onChange={(e) => { setTo(e.currentTarget.value); clearQuery(); }} /></Group>
      <Group grow><NativeSelect label="Passive query meaning" value={query} data={[{ value: "dc_continuity", label: "Steady-state DC path" }, { value: "shortness", label: "Ideal zero-resistance shortness" }, { value: "resistance", label: "Series path resistance" }, { value: "signal", label: "Signal candidate and series impedance" }]} onChange={(e) => { setQuery(e.currentTarget.value); clearQuery(); }} /><NativeSelect label="Copper model assumption" value={copper} data={[{ value: "unspecified", label: "Unspecified: affected path remains unknown" }, { value: "ideal_zero_resistance", label: "Ideal zero resistance, including reported net membership" }]} onChange={(e) => { setCopper(e.currentTarget.value); clearQuery(); }} /></Group>
      {query === "signal" && <TextInput label="Signal frequency in hertz (exact positive decimal; blank is unknown)" value={frequency} onChange={(e) => { setFrequency(e.currentTarget.value); clearQuery(); }} />}
      {(inspection.model.conditions ?? []).map((c) => <NativeSelect key={c.local_id} label={`Query state for ${c.local_id}`} value={conditionAssignments[c.local_id] ?? ""} data={[{ value: "", label: "Unspecified: affected path remains unknown" }, ...c.states.map((state) => ({ value: state, label: state }))]} onChange={(e) => { const state = e.currentTarget.value; setConditionAssignments((prior) => ({ ...prior, [c.local_id]: state })); clearQuery(); }} />)}
      <Button disabled={busy || !from || !to} onClick={submitQuery}>Interpret reviewed model</Button>
      {result && <PathExplanation result={result} graph={inspection.graph} />}
    </Stack>}
  </Stack>;
}
