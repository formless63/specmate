import { Alert, Badge, Button, Card, Group, Select, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { EvidenceEditor, OperatingNumberInput } from "./declaration-inputs";
import { TemperatureEditor, RatingScopeFacts } from "./InterfaceConditions";
import { randomUUID } from "../../lib/random-id";
import type { Definition, Identity } from "../identity/api";
import { command, initialAssessment, operating, read, unknownEvidence, type Assessment, type AssessmentDraft, type Bond, type Dimension, type Inspection, type Result, type Status } from "./assessment-api";

const dimensions: { id: Dimension; label: string }[] = [
  { id: "mating", label: "Mating" }, { id: "pin_correspondence", label: "Pin correspondence" },
  { id: "polarity", label: "Polarity" }, { id: "levels", label: "Levels" }, { id: "current", label: "Current" }, { id: "protocol", label: "Protocol" },
  { id: "shielding", label: "Shielding" }, { id: "grounding", label: "Grounding" }, { id: "fit", label: "Fit" },
];
const choices = [{ value: "unknown", label: "Unknown" }, { value: "satisfied", label: "Declared satisfied" }, { value: "invalid", label: "Declared conflict" }];

// As with retained drawing identity, object key order is not engineering state.
// Preserve array order and every JSON value when comparing command and JSONB reads.
const canonical = (value: Assessment): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);

/** Mount in the interfaces workspace with the current principal and permissions. */
export function InterfaceAssessmentPanel({ projectId, principalKey, canEdit, canFreeze, active = true }: { projectId: string; principalKey: string; canEdit: boolean; canFreeze: boolean; active?: boolean }) {
  return <Workspace key={`${projectId}:${principalKey}:${canEdit}:${canFreeze}`} projectId={projectId} canEdit={canEdit} canFreeze={canFreeze} isActive={active} />;
}
function Workspace({ projectId, canEdit, canFreeze, isActive }: { projectId: string; canEdit: boolean; canFreeze: boolean; isActive: boolean }) {
  const [scope] = useState(randomUUID);
  const cache = useQueryClient();
  const active = useRef(true);
  const [definition, setDefinition] = useState<string | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [revisionId, setRevisionId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [offset, setOffset] = useState(0);
  const [checkingMutation, setCheckingMutation] = useState(false);
  const [checkingAuthority, setCheckingAuthority] = useState(false);
  const authorityGeneration = useRef(0);
  const refresh = useCallback(async () => {
    const generation = ++authorityGeneration.current;
    setCheckingAuthority(true);
    try { await cache.invalidateQueries({ queryKey: [scope] }); }
    finally { if (active.current && generation === authorityGeneration.current) setCheckingAuthority(false); }
  }, [cache, scope]);
  useEffect(() => {
    if (isActive) void refresh();
    else {
      authorityGeneration.current += 1;
      setCheckingAuthority(true);
      void cache.cancelQueries({ queryKey: [scope] });
    }
  }, [cache, scope, isActive, refresh]);
  const finishMutation = async () => {
    if (!active.current) return;
    try { await refresh(); }
    finally { if (active.current) setCheckingMutation(false); }
  };
  useEffect(() => {
    const focus = () => { if (isActive) void refresh(); };
    window.addEventListener("focus", focus);
    return () => { window.removeEventListener("focus", focus); };
  }, [isActive, refresh]);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; authorityGeneration.current += 1; void cache.cancelQueries({ queryKey: [scope] }); cache.removeQueries({ queryKey: [scope] }); };
  }, [cache, scope]);
  const options = { retry: false as const, staleTime: 0, enabled: isActive };
  const definitions = useQuery({ ...options, queryKey: [scope, "definitions"], queryFn: ({ signal }) => read<Definition[]>(`projects/${projectId}/definitions`, { signal }) });
  const identity = useQuery({ ...options, queryKey: [scope, "identity", definition, offset], queryFn: ({ signal }) => read<Identity>(`catalog/definitions/${definition}?offset=${offset}`, { signal }), enabled: isActive && !!definition });
  const draft = useQuery({ ...options, queryKey: [scope, "draft", draftId], queryFn: ({ signal }) => read<AssessmentDraft>(`interfaces/drafts/${draftId}`, { signal }), enabled: isActive && !!draftId });
  const inspection = useQuery({ ...options, queryKey: [scope, "revision", revisionId], queryFn: ({ signal }) => read<Inspection>(`interfaces/revisions/${revisionId}`, { signal }), enabled: isActive && !!revisionId });
  const queries = [definitions, ...(definition ? [identity] : []), ...(draftId ? [draft] : []), ...(revisionId ? [inspection] : [])];
  const ready = isActive && !checkingAuthority && !checkingMutation && queries.every(q => !!q.data && !q.isFetching && !q.isError);
  const error = queries.find(q => q.isError)?.error;
  return <Stack>
    <Title order={2}>Interface assessments</Title>
    <Text>Keep mating, pin correspondence, electrical limits, protocol, shielding, grounding and fit separate. Results describe declarations and explicit operating assumptions; they do not qualify a physical assembly.</Text>
    <Button disabled={!isActive || checkingMutation} onClick={() => void refresh()}>Refresh assessment authority</Button>
    {error && <Alert color="red">{error.message}</Alert>}
    {!ready && !error && <Text>Checking current assessment authority…</Text>}
    <Select label="Saved assessment" searchable value={ready ? definition : null} data={ready ? (definitions.data ?? []).filter(d => d.kind === "interface_assessment").map(d => ({ value: d.definition_id, label: d.name })) : []} onChange={id => { setDefinition(id); setOffset(0); setDraftId(null); setRevisionId(null); setCreating(false); }} />
    {(definition || creating) && <Button variant="subtle" onClick={() => { setDefinition(null); setDraftId(null); setRevisionId(null); setCreating(false); setOffset(0); }}>Close assessment and discard prepared edits</Button>}
    {ready && identity.data && <Group>
      {canEdit && <Select label="Assessment draft" value={draftId} data={identity.data.drafts.map(d => ({ value: d.draft_id, label: d.state }))} onChange={setDraftId} />}
      <Select label="Frozen assessment revision" value={revisionId} data={identity.data.revisions.map(r => ({ value: r.revision_id, label: `Revision ${r.number}` }))} onChange={setRevisionId} />
      <Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous assessment history</Button>
      <Button disabled={Math.max(identity.data.revisions.length, identity.data.drafts.length) < 50} onClick={() => setOffset(offset + 50)}>Next assessment history</Button>
    </Group>}
    {canEdit && <Button disabled={!ready} onClick={() => { setCreating(true); setDraftId(null); setRevisionId(null); }}>New assessment</Button>}
    {creating && <div hidden={!ready}><Author key="new" projectId={projectId} ready={ready} canFreeze={false} current={() => active.current} onChecking={() => setCheckingMutation(true)} onChecked={finishMutation} onSaved={async saved => { if (!active.current) return; setDefinition(saved.definition_id); setDraftId(saved.draft_id); setCreating(false); await refresh(); }} /></div>}
    {canEdit && draft.data && <div hidden={!ready}><Author key={draft.data.draft_id} projectId={projectId} initial={draft.data} ready={ready} canFreeze={canFreeze} current={() => active.current} onChecking={() => setCheckingMutation(true)} onChecked={finishMutation} onSaved={async () => { if (active.current) await refresh(); }} onFrozen={id => { if (active.current) { setRevisionId(id); void refresh(); } }} /></div>}
    {ready && inspection.data && <><Text>Frozen revision {inspection.data.revision_id} · snapshot {inspection.data.snapshot_id} · SHA-256 {inspection.data.sha256}</Text><AssessmentResults result={inspection.data.assessment} /></>}
  </Stack>;
}

function Author({ projectId, initial, ready, canFreeze, current, onChecking, onChecked, onSaved, onFrozen }: { projectId: string; initial?: AssessmentDraft; ready: boolean; canFreeze: boolean; current: () => boolean; onChecking: () => void; onChecked: () => Promise<void>; onSaved: (saved: AssessmentDraft) => Promise<void>; onFrozen?: (revision: string) => void }) {
  const [value, setValue] = useState(initial?.content.interface ?? initialAssessment);
  const [state, setState] = useState(initial?.state);
  const [name, setName] = useState("");
  const active = useRef(true);
  const intent = useRef<{ fingerprint: string; key: string } | null>(null);
  const freezeIntent = useRef<{ state: string; key: string } | null>(null);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const save = useMutation({ onMutate: onChecking, onSettled: onChecked, mutationFn: () => {
    const operation = initial ? "interface.update" : "interface.create";
    const payload = initial ? { draft_id: initial.draft_id, interface: value } : { project_id: projectId, name, interface: value };
    const fingerprint = JSON.stringify([operation, payload, state]);
    if (intent.current?.fingerprint !== fingerprint) intent.current = { fingerprint, key: randomUUID() };
    const options = { expectedState: state, idempotencyKey: intent.current.key };
    if (initial) return command<Omit<AssessmentDraft, "definition_id">>(operation, payload, options).then(saved => ({ ...saved, definition_id: initial.definition_id }));
    return command<AssessmentDraft>(operation, payload, options);
  }, onSuccess: async saved => { if (!active.current || !current()) return; intent.current = null; setState(saved.state); setValue(saved.content.interface); await onSaved(saved); } });
  const freeze = useMutation({ onMutate: onChecking, onSettled: onChecked, mutationFn: () => {
    if (!freezeIntent.current || freezeIntent.current.state !== state) freezeIntent.current = { state: state!, key: randomUUID() };
    return command<{ revision_id: string; draft: Omit<AssessmentDraft, "definition_id"> }>("interface.freeze", { draft_id: initial!.draft_id }, { expectedState: state, idempotencyKey: freezeIntent.current.key });
  }, onSuccess: saved => { if (!active.current || !current()) return; freezeIntent.current = null; setState(saved.draft.state); onFrozen?.(saved.revision_id); } });
  const unsaved = !!initial && canonical(value) !== canonical(initial.content.interface);
  return <Card withBorder><Stack>
    <Title order={3}>{initial ? "Edit assessment" : "New assessment declaration"}</Title>
    {!initial && <TextInput label="Assessment name" value={name} onChange={e => setName(e.currentTarget.value)} />}
    {initial && <Text>Editing basis {state}</Text>}
    <fieldset disabled={!ready || save.isPending || freeze.isPending} style={{ border: 0, padding: 0, margin: 0 }}><AssessmentEditor value={value} onChange={setValue} /></fieldset>
    <Group><Button disabled={!ready || save.isPending || freeze.isPending || (!initial && !name.trim())} onClick={() => save.mutate()}>{initial ? "Save assessment draft" : "Create assessment draft"}</Button>
      {initial && canFreeze && <Button disabled={!ready || unsaved || save.isPending || freeze.isPending || state !== initial.state} onClick={() => freeze.mutate()}>Freeze assessment revision</Button>}
      {initial && initial.state !== state && <Button disabled={!ready} onClick={() => setState(initial.state)}>Use refreshed draft as editing basis</Button>}
    </Group>
    {unsaved && <Text>Save prepared changes before freezing.</Text>}
    {[save, freeze].map((mutation, i) => mutation.error && <Alert color="red" key={i}>{mutation.error.message}</Alert>)}
  </Stack></Card>;
}

export function AssessmentEditor({ value, onChange }: { value: Assessment; onChange: (value: Assessment) => void }) {
  const [rowId, setRowId] = useState("");
  return <Stack>
    <Group><TextInput label="Left exact pinout revision" value={value.left_pinout_revision_id} onChange={e => onChange({ ...value, left_pinout_revision_id: e.currentTarget.value })} /><TextInput label="Right exact pinout revision" value={value.right_pinout_revision_id} onChange={e => onChange({ ...value, right_pinout_revision_id: e.currentTarget.value })} /></Group>
    {(["mating", "fit"] as const).map(d => <Card key={d} withBorder><Stack><Title order={4}>{d === "mating" ? "Mating declaration" : "Fit declaration"}</Title><Select label={`${d} declaration`} data={choices} value={value[d].status} onChange={status => onChange({ ...value, [d]: { ...value[d], status: status as Status } })} /><TextInput label={`${d} basis`} value={value[d].basis ?? ""} onChange={e => onChange({ ...value, [d]: { ...value[d], basis: e.currentTarget.value || null } })} /><EvidenceEditor label={d} value={value[d].evidence} onChange={evidence => onChange({ ...value, [d]: { ...value[d], evidence } })} /></Stack></Card>)}
    <Title order={4}>Proposed contact correspondence and operating conditions</Title>
    <Text>Missing inputs remain unknown. Demand is an explicit operating input, never copied from a current rating. Protocol names do not establish interoperability.</Text>
    {value.pairs.map((pair, i) => {
      const update = (change: Partial<typeof pair>) => onChange({ ...value, pairs: value.pairs.map((p, j) => j === i ? { ...p, ...change } : p) });
      return <Card key={pair.local_id} withBorder><Stack><Title order={5}>Contact row {pair.local_id}</Title><Group>
        <TextInput label={`${pair.local_id} left contact`} value={pair.left_contact_id} onChange={e => update({ left_contact_id: e.currentTarget.value })} /><TextInput label={`${pair.local_id} right contact`} value={pair.right_contact_id} onChange={e => update({ right_contact_id: e.currentTarget.value })} /><TextInput label={`${pair.local_id} expected signal`} value={pair.expected_signal ?? ""} onChange={e => update({ expected_signal: e.currentTarget.value || null })} />
      </Group><TextInput label={`${pair.local_id} correspondence basis`} value={pair.basis} onChange={e => update({ basis: e.currentTarget.value })} /><EvidenceEditor label={`${pair.local_id} correspondence`} value={pair.evidence} onChange={evidence => update({ evidence })} />
      <Group>{(["voltage_min_v", "voltage_max_v", "demand_a"] as const).map(key => <OperatingNumberInput key={key} label={`${pair.local_id} ${key === "demand_a" ? "current demand A" : key === "voltage_min_v" ? "operating minimum V" : "operating maximum V"} (blank = unknown)`} value={pair.operating[key] ?? ""} min={key === "demand_a" ? 0 : undefined} onChange={n => update({ operating: { ...pair.operating, [key]: n } })} />)}</Group>
      {(["required_protocol", "condition", "basis"] as const).map(key => <TextInput key={key} label={`${pair.local_id} operating ${key.replaceAll("_", " ")}`} value={pair.operating[key] ?? ""} onChange={e => update({ operating: { ...pair.operating, [key]: e.currentTarget.value || null } })} />)}
      <TemperatureEditor label={`${pair.local_id} operating temperature`} value={pair.operating.temperature ?? null} onChange={temperature => update({ operating: { ...pair.operating, temperature } })} />
      <TextInput label={`${pair.local_id} operating mode (blank = unknown)`} value={pair.operating.mode ?? ""} onChange={e => update({ operating: { ...pair.operating, mode: e.currentTarget.value || null } })} />
      <EvidenceEditor label={`${pair.local_id} operating`} value={pair.operating.evidence} onChange={evidence => update({ operating: { ...pair.operating, evidence } })} /><Button variant="subtle" onClick={() => onChange({ ...value, pairs: value.pairs.filter((_, j) => j !== i) })}>Remove row {pair.local_id}</Button></Stack></Card>;
    })}
    <Group><TextInput label="New correspondence row ID" value={rowId} onChange={e => setRowId(e.currentTarget.value)} /><Button disabled={!/^[a-z][a-z0-9_-]{0,79}$/.test(rowId) || value.pairs.some(p => p.local_id === rowId)} onClick={() => { onChange({ ...value, pairs: [...value.pairs, { local_id: rowId, left_contact_id: "", right_contact_id: "", expected_signal: null, basis: "", evidence: unknownEvidence(), operating: operating() }] }); setRowId(""); }}>Add correspondence row</Button></Group>
    {(["shielding", "grounding"] as const).map(d => <Card key={d} withBorder><Stack><Title order={4}>{d === "shielding" ? "Shielding intent" : "Grounding intent"}</Title><Group>
      {(["left_contact_id", "right_contact_id", "basis"] as const).map(key => <TextInput key={key} label={`${d} ${key.replaceAll("_", " ")}`} value={value[d][key] ?? ""} onChange={e => onChange({ ...value, [d]: { ...value[d], [key]: e.currentTarget.value || null } })} />)}
      {(["required", "declared"] as const).map(key => <Select key={key} label={`${d} ${key} connection`} value={value[d][key]} data={["unknown", "bonded", "isolated"]} onChange={v => onChange({ ...value, [d]: { ...value[d], [key]: v as Bond["required"] } })} />)}
    </Group><EvidenceEditor label={d} value={value[d].evidence} onChange={evidence => onChange({ ...value, [d]: { ...value[d], evidence } })} /></Stack></Card>)}
  </Stack>;
}

export function AssessmentResults({ result }: { result: Result }) {
  return <Stack><Title order={3}>Separated assessment results</Title><Text>Exact left pinout {result.left_pinout_revision_id} · exact right pinout {result.right_pinout_revision_id}</Text>
    {dimensions.map(d => <Card key={d.id} withBorder><Stack><Title order={4}>{d.label}</Title>{result.findings.filter(f => f.dimension === d.id).map((f, i) => <Stack gap="xs" key={`${f.pair_id}:${i}`}>
      <Group><Badge color={f.status === "invalid" ? "red" : f.status === "unknown" ? "gray" : "blue"}>{f.status === "satisfied" ? "Satisfied by declarations" : f.status === "invalid" ? "Invalid / conflicting declaration" : "Unknown"}</Badge><Text>{f.pair_id ? `Contact row ${f.pair_id}` : "Exact pinout pair"} · {f.basis.replaceAll("_", " ")}</Text></Group><Text>{f.explanation}</Text>
      {Object.entries(f.facts).filter(([key]) => !["pair", "left", "right", "evidence", "rating_scope"].includes(key)).map(([key, fact]) => <Text size="sm" key={key}>{key.replaceAll("_", " ")}: {fact == null ? "unknown" : String(fact)}</Text>)}
      {f.pair_id && <ContactFacts facts={f.facts} />}
      <RatingScopeFacts value={f.facts.rating_scope} />
      {f.evidence.map((e, j) => <Text size="sm" key={j}>Evidence: {e.status.replaceAll("_", " ")}{e.citation ? ` · ${e.citation}` : ""}{e.source_path ? ` · ${e.source_bundle_revision_id} / ${e.source_path} · SHA-256 ${e.sha256} · rights ${e.rights ?? "unknown"}` : ""}</Text>)}
    </Stack>)}</Stack></Card>)}
    {result.limitations.map(text => <Text key={text}>{text}</Text>)}<Text>Physical qualification: not established.</Text>
  </Stack>;
}
function ContactFacts({ facts }: { facts: Record<string, unknown> }) {
  const pair = facts.pair as { left_contact_id: string; right_contact_id: string; expected_signal: string | null; basis: string; operating: Record<string, unknown> } | undefined;
  return <>{pair && <><Text>{pair.left_contact_id} → {pair.right_contact_id} · expected signal {pair.expected_signal ?? "unknown"} · {pair.basis}</Text><Text>Operating inputs: {Object.entries(pair.operating).filter(([key]) => key !== "evidence").map(([key, value]) => `${key.replaceAll("_", " ")}: ${value == null ? "unknown" : typeof value === "object" ? JSON.stringify(value) : value}`).join(" · ")}</Text></>}
    <Table><Table.Thead><Table.Tr><Table.Th>Retained electrical declaration</Table.Th><Table.Th>Left</Table.Th><Table.Th>Right</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{["signal", "role", "direction", "polarity", "polarity_basis", "voltage_min_v", "voltage_max_v", "current_max_a", "protocol", "condition", "basis"].map(key => <Table.Tr key={key}><Table.Td>{key.replaceAll("_", " ")}</Table.Td>{["left", "right"].map(side => <Table.Td key={side}>{String((facts[side] as Record<string, unknown> | null)?.[key] ?? "unknown")}</Table.Td>)}</Table.Tr>)}</Table.Tbody></Table>
  </>;
}
