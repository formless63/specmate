import { Alert, Button, Card, Fieldset, Group, Select, Stack, Table, Text, TextInput, Textarea, Title } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import { randomUUID } from '../../lib/random-id';
import type { Definition } from '../identity/api';
import { ApiError, authority, references, download, emptyConfiguration, generate, receipt, requestJson, review, saveFile, type Binding, type Configuration, type ContextPin, type Manifest, type Output, type Receipt, type Review } from './api';
import { RevisionChoice } from './RevisionChoice';
import { svgSize } from './svg-size';
import { RevisionLabel } from "../../lib/IdentityLabel";

type Props = { projectId?: string | null; principalKey: string; canGenerate: boolean; active?: boolean; onAccessLost?: () => void };
export function PreparationDocumentsPanel(props: Props) { return <Workspace key={`${props.projectId ?? 'library'}:${props.principalKey}`} {...props} />; }
function Workspace({ canGenerate, active = true, onAccessLost }: Props) {
  const [config, setConfig] = useState<Configuration>(emptyConfiguration), [quantity, setQuantity] = useState('1');
  const [definitions, setDefinitions] = useState<Definition[]>([]), [history, setHistory] = useState<Receipt[]>([]);
  const [reviewed, setReviewed] = useState<Review | null>(null), [retained, setRetained] = useState<Receipt | null>(null), [selectedId, setSelectedId] = useState<string | null>(null);
  const [scopes, setScopes] = useState<ContextPin[]>([]), [subjects, setSubjects] = useState<string[]>([]);
  const [focused, setFocused] = useState(true), [fenced, setFenced] = useState(true), [reviewVisible, setReviewVisible] = useState(false);
  const [choicePending, setChoicePending] = useState(0), [refreshTick, setRefreshTick] = useState(0);
  const [busy, setBusy] = useState(false), [blocked, setBlocked] = useState(false), [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ svg: string; width: number; height: number } | null>(null);
  const alive = useRef(false), epoch = useRef(0), accessEpoch = useRef(0), needsRefresh = useRef(true);
  const activeRef = useRef(active), focusedRef = useRef(focused); activeRef.current = active; focusedRef.current = focused;
  const derivedBasis = useRef<Review | null>(null);
  const pending = useRef<{ config: Configuration; state: string; key: string } | null>(null);
  useEffect(() => { alive.current = true; needsRefresh.current = true; setBusy(false); return () => { alive.current = false; epoch.current += 1; accessEpoch.current += 1; }; }, []);
  const list = () => Promise.all([requestJson<Definition[]>('/api/v0/workspace/definitions'), requestJson<{ document_sets: Receipt[] }>('/api/v0/preparation-documents/workspace')]);
  const sameReferences = (a: Configuration, b: Configuration) => a.root_revision_id === b.root_revision_id && JSON.stringify(references(a)) === JSON.stringify(references(b));
  const sameConfig = (a: Configuration, b: Configuration) => JSON.stringify(a) === JSON.stringify(b);
  const denied = (e: unknown) => e instanceof ApiError && [401, 403, 404].includes(e.status);
  function fail(e: unknown) { setFenced(true); needsRefresh.current = false; if (denied(e)) { setBlocked(true); setDefinitions([]); setHistory([]); onAccessLost?.(); } setError(e instanceof Error ? e.message : 'Document set unavailable.'); }
  async function protect(fresh?: Review, selected = selectedId, freshReceipt?: Receipt) {
    const [defs, sets] = await list();
    if (config.root_revision_id) await authority(config);
    let oldProof: Review | null = null;
    if (reviewed) oldProof = fresh && sameConfig(fresh.manifest.inputs.configuration, reviewed.manifest.inputs.configuration) ? fresh : await review(reviewed.manifest.inputs.configuration);
    // A clean new config never authorizes a selected historical receipt or its SVG.
    if (selected && freshReceipt?.document_set_id !== selected) await receipt(selected);
    let currentProof = fresh ?? (oldProof && sameConfig(config, oldProof.manifest.inputs.configuration) ? oldProof : null);
    if (config.root_revision_id && !currentProof) {
      try { currentProof = await review(config); }
      catch (e) { if (!(e instanceof ApiError && e.status === 422)) throw e; }
    }
    // Unknown flags refresh physical editor context only, without replacing any
    // prepared quantity, mapping, declaration, reviewed token or retry key.
    const editorProof = currentProof ?? (config.root_revision_id ? await review({ ...emptyConfiguration(), root_revision_id: config.root_revision_id }) : null);
    let rights: string[] = [];
    if (currentProof) rights = currentProof.manifest.inputs.rights_reviews.map(r => r.subject);
    else if (derivedBasis.current && sameReferences(config, derivedBasis.current.manifest.inputs.configuration)) {
      try { const basis = await review(derivedBasis.current.manifest.inputs.configuration); rights = basis.manifest.inputs.rights_reviews.map(r => r.subject); }
      catch { /* Obsolete derived labels remain withheld; values survive privately. */ }
    }
    return { defs, sets, scopes: editorProof?.manifest.context_pins ?? [], rights, currentProof, oldVisible: !!reviewed && oldProof?.state === reviewed.state };
  }
  function acceptProof(proof: Awaited<ReturnType<typeof protect>>) { setDefinitions(proof.defs); setHistory(proof.sets.document_sets); setScopes(proof.scopes); setSubjects(proof.rights); if (proof.currentProof) derivedBasis.current = proof.currentProof; setReviewVisible(proof.oldVisible); setBlocked(false); setFenced(false); needsRefresh.current = false; }
  async function action<T>(work: () => Promise<T>, accept: (result: T) => void, kind?: 'review' | 'receipt' | 'generate') {
    const current = epoch.current, access = ++accessEpoch.current;
    setFenced(true); setBusy(true); setError(null); needsRefresh.current = false;
    try {
      const value = await work();
      if (!alive.current || current !== epoch.current) return;
      accept(value); // Preserve an actual committed result privately across tab/focus changes.
      if (access !== accessEpoch.current || !activeRef.current || !focusedRef.current) { needsRefresh.current = true; return; }
      const fresh = kind === 'review' ? value as Review : undefined;
      const selected = kind === 'receipt' || kind === 'generate' ? (value as Receipt).document_set_id : selectedId;
      const proof = await protect(fresh, selected, kind === 'receipt' ? value as Receipt : undefined);
      if (alive.current && current === epoch.current && access === accessEpoch.current && activeRef.current && focusedRef.current) { acceptProof(proof); if (fresh) setReviewVisible(true); }
    } catch (e) {
      if (!alive.current || current !== epoch.current) return;
      if (!denied(e) && access === accessEpoch.current && activeRef.current && focusedRef.current) {
        try { const proof = await protect(); if (alive.current && current === epoch.current && access === accessEpoch.current) { acceptProof(proof); setError(e instanceof Error ? e.message : 'Document operation failed.'); } }
        catch (accessError) { if (alive.current && current === epoch.current) fail(accessError); }
      } else if (access === accessEpoch.current) fail(e);
    } finally { if (alive.current && current === epoch.current) setBusy(false); }
  }
  async function refreshAccess() {
    if (!activeRef.current || !focusedRef.current) return;
    const current = epoch.current, access = ++accessEpoch.current;
    needsRefresh.current = false; setFenced(true); setBusy(true); setError(null);
    try { const proof = await protect(); if (alive.current && current === epoch.current && access === accessEpoch.current && activeRef.current && focusedRef.current) acceptProof(proof); }
    catch (e) { if (alive.current && current === epoch.current && access === accessEpoch.current) fail(e); }
    finally { if (alive.current && current === epoch.current) setBusy(false); }
  }
  const refreshRef = useRef(refreshAccess); refreshRef.current = refreshAccess;
  useEffect(() => {
    const blur = () => { focusedRef.current = false; setFocused(false); setFenced(true); accessEpoch.current += 1; needsRefresh.current = true; };
    const focus = () => { focusedRef.current = true; setFocused(true); needsRefresh.current = true; };
    window.addEventListener('blur', blur); window.addEventListener('focus', focus);
    return () => { window.removeEventListener('blur', blur); window.removeEventListener('focus', focus); };
  }, []);
  useEffect(() => {
    if (!active || !focused) { setFenced(true); accessEpoch.current += 1; needsRefresh.current = true; return; }
    if (!busy && choicePending === 0 && needsRefresh.current) void refreshRef.current();
  }, [active, focused, busy, choicePending, refreshTick]);
  function choiceActivity(started: boolean) { setChoicePending(n => Math.max(0, n + (started ? 1 : -1))); setFenced(true); accessEpoch.current += 1; needsRefresh.current = true; }
  function change(next: Configuration) { epoch.current += 1; pending.current = null; setConfig(next); setReviewed(null); setReviewVisible(false); setPreview(null); setError(null); }
  function rootChange(id: string | null) { change({ ...config, root_revision_id: id ?? '', bom_plan_revision_id: null, bindings: [], rights_reviews: [] }); setScopes([]); setSubjects([]); derivedBasis.current = null; setRetained(null); setSelectedId(null); }
  function discard() { epoch.current += 1; accessEpoch.current += 1; pending.current = null; derivedBasis.current = null; setConfig(emptyConfiguration()); setQuantity('1'); setReviewed(null); setRetained(null); setSelectedId(null); setScopes([]); setSubjects([]); setPreview(null); setBlocked(false); setBusy(false); setFenced(true); needsRefresh.current = true; setRefreshTick(n => n + 1); }
  function closeReceipt() { epoch.current += 1; accessEpoch.current += 1; setSelectedId(null); setRetained(null); setPreview(null); setFenced(true); needsRefresh.current = true; setBusy(false); setRefreshTick(n => n + 1); }
  const quantityValid = quantity === '' || /^\d+$/.test(quantity) && Number(quantity) >= 1 && Number(quantity) <= 1000000;
  async function check() { await action(() => review(config), r => { if (pending.current && pending.current.state !== r.state) pending.current = null; setReviewed(r); derivedBasis.current = r; }, 'review'); }
  async function retain() {
    if (!reviewed || !reviewVisible) return;
    pending.current ??= { config: structuredClone(config), state: reviewed.state, key: randomUUID() };
    const submitted = pending.current;
    await action(() => generate(submitted.config, submitted.state, submitted.key), r => { setRetained(r); setSelectedId(r.document_set_id); }, 'generate');
  }
  function chooseSet(id: string | null) { epoch.current += 1; setSelectedId(id); setRetained(null); setPreview(null); setError(null); if (id) void action(() => receipt(id), setRetained, 'receipt'); }
  async function getFile(output: Output, asPreview = false) {
    if (!retained) return;
    await action(async () => { const blob = await download(retained.document_set_id, output); if (!asPreview) return { blob, svg: null }; const svg = await blob.text(), size = svgSize(svg); if (!size) throw new Error('Generated schematic viewBox is unavailable.'); return { blob, svg: { svg, ...size } }; }, r => { if (r.svg) setPreview(r.svg); else saveFile(r.blob, output.filename); });
  }
  const visible = active && focused && !fenced && !blocked && !busy && choicePending === 0;
  function replaceBinding(index: number, value: Binding) { change({ ...config, bindings: config.bindings.map((b, i) => i === index ? value : b) }); }
  return <Stack><Title order={2}>Coordinated documents</Title><Text>Produce specifications, declared schematics, cut and preparation lists, build sheets, terminations and test intent from one exact frozen revision. Missing bindings stay unknown. Physical tests, continuity and fit remain unevaluated.</Text>
    <Button disabled={busy || !active || !focused || choicePending > 0} onClick={() => void refreshAccess()}>Refresh document access and choices</Button>
    {error && <Alert color="red">{error}</Alert>}
    {blocked && <Alert color="red">Document metadata and staged fields are hidden until current input access is restored. Prepared declarations, reviewed token and retry key are retained.</Alert>}
    {!visible && <Alert>Document display is fenced until current input and selected receipt access is freshly checked.</Alert>}
    <Group><Button variant="subtle" onClick={discard}>Discard prepared document selection</Button>{selectedId && <Button variant="subtle" onClick={closeReceipt}>Close selected historic document</Button>}</Group>
    <Fieldset legend="Exact document inputs" disabled={!visible} inert={!visible} aria-hidden={!visible} style={{ display: visible ? undefined : 'none' }}><Stack>
        <RevisionChoice label="Document root" kinds={definitions.map(d => d.kind)} definitions={definitions} value={config.root_revision_id || null} onChange={rootChange} onDenied={fail} disabled={!visible} active={active && focused} onActivity={choiceActivity} />
        <TextInput label="Document quantity (blank means unknown)" value={quantity} error={!quantityValid ? 'Enter an integer from 1 to 1000000, or leave unknown.' : undefined} onChange={e => { const value = e.currentTarget.value; setQuantity(value); change({ ...config, quantity: value === '' ? null : Number(value) }); }} />
        <RevisionChoice label="Frozen procurement BOM" kinds={['bom_plan']} definitions={definitions} value={config.bom_plan_revision_id} onChange={id => change({ ...config, bom_plan_revision_id: id })} onDenied={fail} disabled={!visible} active={active && focused} onActivity={choiceActivity} />
        <Select label="Standalone workshop disposition" value={config.standalone_decision} data={['unknown', 'make', 'buy']} onChange={v => change({ ...config, standalone_decision: (v ?? 'unknown') as Configuration['standalone_decision'] })} />
        <Textarea label="Standalone disposition basis" value={config.standalone_basis ?? ''} onChange={e => change({ ...config, standalone_basis: e.currentTarget.value || null })} />
        <Text size="sm">Assembly workshop boundaries come from its exact frozen BOM. Bought contents retain technical declarations; missing policies leave workshop quantities unknown.</Text>
        <Select label="Document purpose" value={config.purpose} data={[{ value: 'authorized_review', label: 'Authorized internal review' }, { value: 'distribution', label: 'Reviewed distribution rights' }]} onChange={v => change({ ...config, purpose: v as Configuration['purpose'] })} />
        <TextInput label="Generated output rights" value={config.output_rights} onChange={e => change({ ...config, output_rights: e.currentTarget.value })} />
        <Textarea label="Generated output rights basis" value={config.output_rights_basis ?? ''} onChange={e => change({ ...config, output_rights_basis: e.currentTarget.value || null })} />
        {subjects.map(subject => { const row = config.rights_reviews.find(r => r.subject === subject); const update = (decision: 'unknown' | 'permitted' | 'withheld', basis: string) => change({ ...config, rights_reviews: [...config.rights_reviews.filter(r => r.subject !== subject), { subject, decision, basis }] }); return <Card key={subject} withBorder><Text>{subject}</Text><Select label={`Rights for ${subject}`} data={['unknown', 'permitted', 'withheld']} value={row?.decision ?? 'unknown'} onChange={d => update((d ?? 'unknown') as 'unknown' | 'permitted' | 'withheld', row?.basis ?? '')} /><Textarea label={`Rights basis for ${subject}`} value={row?.basis ?? ''} onChange={e => update(row?.decision ?? 'unknown', e.currentTarget.value)} /></Card>; })}
        <Text>Review first to obtain current authorized wiring contexts and exact rights subjects.</Text>
        {scopes.filter(s => !config.bindings.some(b => JSON.stringify(b.occurrence_path) === JSON.stringify(s.address.path))).map(s => <Button key={JSON.stringify(s.address.path)} onClick={() => change({ ...config, bindings: [...config.bindings, { occurrence_path: s.address.path, cut_profiles: [], end_profiles: [], test_plan_revision_id: null }] })}>Bind {s.address.path.join('/') || 'standalone'} · {s.kind}</Button>)}
        {config.bindings.map((b, i) => <BindingEditor key={JSON.stringify(b.occurrence_path)} value={b} context={scopes.find(s => JSON.stringify(s.address.path) === JSON.stringify(b.occurrence_path))} definitions={definitions} onChange={v => replaceBinding(i, v)} onDenied={fail} active={active && focused} disabled={!visible} onActivity={choiceActivity} onRemove={() => change({ ...config, bindings: config.bindings.filter((_, n) => n !== i) })} />)}
        <Group><Button disabled={!config.root_revision_id || !quantityValid} onClick={() => void check()}>Review coordinated documents</Button><Button disabled={!canGenerate || !reviewed || !reviewVisible || !quantityValid} onClick={() => void retain()}>Generate reviewed document set</Button></Group>
        {!canGenerate && <Text>Read-only access: review and retained downloads are available; generation requires engineering edit authority.</Text>}
      </Stack></Fieldset>
    {visible && <>
      <Select label="Retained document history" searchable clearable disabled={busy} value={selectedId} data={history.map(r => ({ value: r.document_set_id, label: `${r.manifest.inputs.root.name} · ${r.created_at} · ${r.document_set_id}` }))} onChange={chooseSet} />
      {reviewed && reviewVisible && <ManifestView manifest={reviewed.manifest} heading="Current reviewed document inputs" />}
      {retained && <ManifestView manifest={retained.manifest} heading="Retained coordinated provenance" />}
      {retained && <Card withBorder><Stack><Title order={3}>Retained immutable document set</Title><Text>Set {retained.document_set_id} · input SHA-256 {retained.sha256}</Text><Text>History bytes are retained; current inputs are freshly authorized before each download.</Text>{retained.manifest.outputs.map(output => <Group key={output.filename}><Button disabled={busy} onClick={() => void getFile(output)}>Download {output.filename}</Button><Text size="sm">{output.sha256} · {output.size} bytes · rights {output.rights}</Text>{output.filename === 'schematic.svg' && <Button disabled={busy} variant="light" onClick={() => void getFile(output, true)}>Preview declared schematic</Button>}</Group>)}</Stack></Card>}
      {preview && <><Button onClick={() => setPreview(null)}>Close declared schematic</Button><iframe title="Declared schematic preview" sandbox="" srcDoc={preview.svg} style={{ width: '100%', aspectRatio: `${preview.width} / ${preview.height}`, minHeight: 300, maxHeight: 700, border: '1px solid #ddd' }} /></>}
    </>}
  </Stack>;
}

function BindingEditor({ value, context, definitions, onChange, onDenied, active, disabled, onActivity, onRemove }: { value: Binding; context?: ContextPin; definitions: Definition[]; onChange: (v: Binding) => void; onDenied: (e: unknown) => void; active: boolean; disabled: boolean; onActivity: (v: boolean) => void; onRemove: () => void }) {
  return <Card withBorder><Stack><Title order={3}>Binding {value.occurrence_path.join('/') || 'standalone'}</Title><Text>Exact revision: {context?.address.revision_id ?? 'unknown until current review'} · disposition {context?.disposition ?? 'unknown'}</Text>
    {(context?.sections ?? []).map(s => { const cut = value.cut_profiles.find(p => p.section_id === s.section_id), end = value.end_profiles.find(p => p.section_id === s.section_id); const label = s.section_id ?? 'stock piece'; const updateEnd = (changes: Partial<NonNullable<typeof end>>) => { if (end) onChange({ ...value, end_profiles: value.end_profiles.map(p => p.section_id === s.section_id ? { ...p, ...changes } : p) }); }; return <Fieldset key={label} legend={`Physical section ${label}`}><Stack><Text size="sm"><RevisionLabel id={s.stock_revision_id} role="stock" />. Logical segments add no stock pieces.</Text>
      <RevisionChoice label={`Cut profile ${label}`} kinds={['preparation_profile']} definitions={definitions} value={cut?.profile_revision_id ?? null} onDenied={onDenied} active={active} disabled={disabled} onActivity={onActivity} onChange={id => onChange({ ...value, cut_profiles: [...value.cut_profiles.filter(p => p.section_id !== s.section_id), ...(id ? [{ section_id: s.section_id, profile_revision_id: id }] : [])] })} />
      <RevisionChoice label={`End profile ${label}`} kinds={['end_preparation_profile']} definitions={definitions} value={end?.profile_revision_id ?? null} onDenied={onDenied} active={active} disabled={disabled} onActivity={onActivity} onChange={id => onChange({ ...value, end_profiles: [...value.end_profiles.filter(p => p.section_id !== s.section_id), ...(id ? [{ section_id: s.section_id, profile_revision_id: id, a_end_id: null, b_end_id: null, mapping_review: 'unreviewed' as const, mapping_basis: 'Explicit end mapping remains unassessed' }] : [])] })} />
      {end && <><Select label={`Profile A physical end ${label}`} clearable data={s.end_ids} value={end.a_end_id} onChange={a_end_id => updateEnd({ a_end_id })} /><Select label={`Profile B physical end ${label}`} clearable data={s.end_ids} value={end.b_end_id} onChange={b_end_id => updateEnd({ b_end_id })} /><Select label={`End mapping review ${label}`} data={['unreviewed', 'reviewed']} value={end.mapping_review} onChange={v => updateEnd({ mapping_review: v as 'unreviewed' | 'reviewed' })} /><Textarea label={`End mapping basis ${label}`} value={end.mapping_basis} onChange={e => updateEnd({ mapping_basis: e.currentTarget.value })} /></>}
    </Stack></Fieldset>; })}
    <RevisionChoice label="Authored test intent" kinds={['cable_test_plan']} definitions={definitions} value={value.test_plan_revision_id} onChange={test_plan_revision_id => onChange({ ...value, test_plan_revision_id })} onDenied={onDenied} active={active} disabled={disabled} onActivity={onActivity} />
    <Button variant="subtle" onClick={onRemove}>Remove this binding</Button></Stack></Card>;
}
function ManifestView({ manifest, heading }: { manifest: Manifest; heading: string }) {
  return <Card withBorder><Stack><Title order={3}>{heading}</Title><Text><RevisionLabel id={manifest.inputs.root.revision_id} role="Root" /></Text><Text>Root snapshot {manifest.inputs.root.snapshot_id} · {manifest.inputs.root.snapshot_sha256}</Text><Text>Input SHA-256 {manifest.inputs_sha256} · {manifest.inputs.generator} · {manifest.inputs.format}</Text><Text>Declared readiness: {manifest.readiness}. Physical test {manifest.inputs.physical_test}; continuity {manifest.inputs.physical_continuity}; fit {manifest.inputs.fit}; qualified {String(manifest.inputs.physical_qualification)}.</Text>
    <Table><Table.Thead><Table.Tr><Table.Th>Output</Table.Th><Table.Th>Declared assessment and missing inputs</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{Object.entries(manifest.document_assessments).map(([name, a]) => <Table.Tr key={name}><Table.Td>{name}</Table.Td><Table.Td><Text>{a.status} · qualification {a.physical_qualification}</Text><Text size="sm">{JSON.stringify(a)}</Text></Table.Td></Table.Tr>)}</Table.Tbody></Table>
    {manifest.issues.map((i, index) => <Alert key={index} color="yellow">{i.path.join('/') || 'standalone'} · {i.code}: {i.message} ({i.status})</Alert>)}
    <Title order={4}>Frozen design pins</Title>{manifest.inputs.revision_pins.map(r => <Text key={r.revision_id} size="sm">{r.name} ({r.kind}) · <RevisionLabel id={r.revision_id} snapshotId={r.snapshot_id} /> · {r.snapshot_sha256}</Text>)}
    <Title order={4}>Exact source and rights provenance</Title>{manifest.inputs.source_pins.length === 0 ? <Text>No exact source files declared.</Text> : manifest.inputs.source_pins.map(s => <Text key={`${s.bundle_revision_id}:${s.path}`} size="sm"><RevisionLabel kind="source" id={s.bundle_revision_id} /> / {s.path} · {s.sha256} · rights {s.rights} · manifest {s.source_manifest_sha256} · ancestry {JSON.stringify(s.ancestry)}</Text>)}
  </Stack></Card>;
}
