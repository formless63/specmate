import { Alert, Button, Checkbox, Group, Modal, Select, Stack, Text, TextInput } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Connection, Viewport, XYPosition } from '@xyflow/react';
import { EngineeringFlow } from '../manual-canvas/EngineeringFlow';
import { LibraryPalette } from '../manual-canvas/LibraryPalette';
import { DROP_MIME, parseDrop, type LibraryDrop } from '../manual-canvas/model';
import { layoutKey, readPositions, writePositions, readViewport, writeViewport } from '../manual-canvas/layout';
import { authorizeConnectorReferences, readConnectorRevision } from '../interfaces/connector-api';
import { ApiError, requestJson } from '../workspace/api';
import { addHarnessJoint, describeHarnessTerminal, harnessGraph, placeHarnessDrop, type HarnessCanvasData } from './canvas-model';
import { COMPONENT_KINDS, type InlineComponent } from '../boards/api';
import type { Harness, Joint, Terminal } from './api';
import '../manual-canvas/manual-canvas.css';
type Props = { value: Harness; data: HarnessCanvasData; active: boolean; editable: boolean; scopeKey: string; selectedId: string | null; onSelect: (id: string) => void; onChange: (next: Harness) => void; authorize: () => Promise<void>; onDenied: (reason: unknown) => void };
type Placement = { drop: LibraryDrop; source?: unknown; name: string; position?: XYPosition; signature: string };
export function HarnessCanvas(props: Props) { return <Canvas key={props.scopeKey} {...props} />; }
function Canvas({ value, data, active, editable, scopeKey, selectedId, onSelect, onChange, authorize, onDenied }: Props) {
  const graph = useMemo(() => harnessGraph(value, data), [value, data]);
  const [palette, setPalette] = useState(false), [manual, setManual] = useState(false), [first, setFirst] = useState<string | null>(null), [second, setSecond] = useState<string | null>(null);
  const [positions, setPositions] = useState(() => readPositions(scopeKey)), [viewport, setViewport] = useState<Viewport | null>(() => readViewport(scopeKey)), [placement, setPlacement] = useState<Placement | null>(null), [joint, setJoint] = useState<{ left: Terminal; right: Terminal; signature: string } | null>(null), [kind, setKind] = useState<Joint['kind']>('termination'), [basis, setBasis] = useState(''), [target, setTarget] = useState<string | null>(null), [partUse, setPartUse] = useState<'shell' | 'inline' | null>(null), [twoLead, setTwoLead] = useState(false), [componentKind, setComponentKind] = useState<InlineComponent['kind']>('unknown'), [placedNode, setPlacedNode] = useState<string | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const candidate = useQuery({ queryKey: ['harness-canvas-candidate', scopeKey, placement?.drop.revisionId], enabled: active && !!placement?.drop.revisionId, retry: false, refetchOnWindowFocus: 'always', queryFn: async () => { await authorizeConnectorReferences({ pending_revision_id: placement!.drop.revisionId }); return true; } });
  useEffect(() => { if (!active || !placement?.drop.revisionId) return; const focus = () => { void candidate.refetch(); }; window.addEventListener('focus', focus); return () => window.removeEventListener('focus', focus); }, [active, placement?.drop.revisionId, candidate.refetch]);
  const candidateReadable = !placement?.drop.revisionId || !candidate.isFetching && !candidate.isError && !!candidate.data;
  const signature = JSON.stringify(value), latest = useRef({ active, editable, signature }), alive = useRef(false), ticket = useRef(0); latest.current = { active, editable, signature };
  useEffect(() => { alive.current = true; return () => { alive.current = false; ticket.current += 1; }; }, []);
  useEffect(() => { if (!active) { ticket.current += 1; setBusy(false); } }, [active]);
  useEffect(() => writePositions(scopeKey, positions), [scopeKey, positions]);
  const safe = (submitted: string, read: number) => alive.current && latest.current.active && latest.current.editable && latest.current.signature === submitted && ticket.current === read;
  async function guarded(work: (submitted: string, read: number) => Promise<void>) {
    if (!active || !editable || busy) return; const read = ++ticket.current; setBusy(true); setError('');
    try { await work(signature, read); } catch (reason) { if (safe(signature, read)) { onDenied(reason); setError(reason instanceof Error ? reason.message : 'Canvas edit unavailable.'); } } finally { if (alive.current && ticket.current === read) setBusy(false); }
  }
  async function choose(drop: LibraryDrop, position?: XYPosition, endpointId: string | null = null) {
    await guarded(async (submitted, read) => {
      await authorize(); let name = drop.kind.replaceAll('_', ' '), source: unknown;
      if (drop.revisionId) {
        const labels = await requestJson<{ labels: { revision_id: string; readable: boolean; kind: string; name: string; number: number }[] }>(`/api/v0/catalog/revision-labels?${new URLSearchParams({ revision_ids: drop.revisionId })}`, { cache: 'no-store' });
        const label = labels.labels.find(row => row.revision_id === drop.revisionId && row.readable && row.kind === drop.kind); if (!label) throw new ApiError(403, 'The exact Library revision is unavailable.'); name = `${label.name} r${label.number}`;
        if (drop.kind === 'pinout') source = (await readConnectorRevision(drop.revisionId)).interface;
      }
      if (safe(submitted, read)) { setTarget(endpointId); setPartUse(null); setTwoLead(false); setComponentKind('unknown'); setPlacement({ drop, source, name, position, signature: submitted }); }
    });
  }
  async function applyPlacement() {
    if (!placement || placement.signature !== signature) return;
    await guarded(async (submitted, read) => {
      await authorize(); if (placement.drop.revisionId) {
        const labels = await requestJson<{ labels: { revision_id: string; readable: boolean; kind: string }[] }>(`/api/v0/catalog/revision-labels?${new URLSearchParams({ revision_ids: placement.drop.revisionId })}`, { cache: 'no-store' });
        if (!labels.labels.some(row => row.revision_id === placement.drop.revisionId && row.readable && row.kind === placement.drop.kind)) throw new ApiError(403, 'The exact Library revision is unavailable.');
      }
      let savedStack; const endpoint = value.endpoints.find(item => item.local_id === target);
      if (endpoint?.end_assembly_revision_id && placement.drop.kind !== 'end_assembly' && placement.drop.kind !== 'wire_stock') { const saved = await readConnectorRevision(endpoint.end_assembly_revision_id); if (saved.interface.kind !== 'end_assembly') throw new ApiError(404, 'The exact saved end stack is unavailable.'); savedStack = saved.interface.stack; }
      if (!safe(submitted, read)) return; const next = placeHarnessDrop(value, placement.drop, placement.source, target, savedStack, placement.drop.kind === 'part' ? partUse === 'shell' ? { use: 'shell' } : partUse === 'inline' && twoLead ? { use: 'inline', declaredTwoLead: true, componentKind } : undefined : undefined); onChange(next.harness); setPlacedNode(next.node);
      if (placement.position) setPositions(previous => ({ ...previous, [layoutKey(next.node)]: placement.position! })); setPlacement(null);
    });
  }
  function connect(connection: Connection) {
    if (!active || !editable || busy) return; const left = graph.terminals.get(connection.sourceHandle ?? ''), right = graph.terminals.get(connection.targetHandle ?? '');
    if (!left || !right) { setError('Choose two currently resolved exact terminals.'); return; }
    try { addHarnessJoint(value, left, right, 'termination', 'Pending review'); setJoint({ left, right, signature }); setBasis(''); setKind(left.kind === 'segment' && right.kind === 'segment' ? 'splice' : 'termination'); setManual(false); } catch (reason) { setError((reason as Error).message); }
  }
  async function applyJoint() {
    if (!joint || joint.signature !== signature || !basis.trim()) return;
    await guarded(async (submitted, read) => { await authorize(); if (!safe(submitted, read)) return; onChange(addHarnessJoint(value, joint.left, joint.right, kind, basis)); setJoint(null); });
  }
  useEffect(() => { if (placedNode && active) { onSelect(placedNode); setPlacedNode(null); } }, [placedNode, value, active, onSelect]);
  const choices = [...graph.terminals].map(([id, terminal]) => ({ value: id, label: describeHarnessTerminal(terminal) }));
  return <section className="manual-canvas" aria-label="Harness manual canvas"><Group gap="xs"><Button size="xs" variant="quiet" onClick={() => setPalette(previous => !previous)}>{palette ? 'Hide Library' : 'Show Library'}</Button><Button size="xs" disabled={!editable || busy || choices.length < 2} onClick={() => setManual(true)}>Connect terminals</Button><Button size="xs" variant="quiet" onClick={() => setPositions({})}>Reset layout</Button><Text size="xs">Drag exact Library records, declare connections, then Save.</Text></Group>
    {candidate.isError && placement && <Alert color="red">Pending exact placement is unavailable. Its prepared identity is hidden.<Button onClick={() => void candidate.refetch()}>Refresh placement access</Button><Button onClick={() => setPlacement(null)}>Discard pending placement</Button></Alert>}{error && <Alert color="red">{error}</Alert>}{graph.unresolved > 0 && <Alert color="yellow">{graph.unresolved} declared paths have unresolved terminals. Their declarations remain in the inspector.</Alert>}
    <div className="manual-canvas-body" data-palette={palette}>{palette && <LibraryPalette active={active} scopeKey={scopeKey} disabled={!editable || busy} onChoose={drop => void choose(drop)} />}<EngineeringFlow active={active} disabled={!editable || busy} items={graph.items} edges={graph.edges} initialFocusId={graph.items[0]?.id} initialViewport={viewport} onViewportChange={next => { setViewport(next); writeViewport(scopeKey, next); }} positions={positions} onPositions={setPositions} onConnect={connect} selectedId={selectedId} onSelectItem={onSelect} mime={DROP_MIME} onDrop={(raw, position, endpointId) => { const drop = parseDrop(raw); if (drop) void choose(drop, position, endpointId); else setError('Drop a supported exact Library record.'); }} /></div>
    <Text size="xs">Each span belongs to one physical stock section. Edges show declared joints or explicit uncut breakout passages. Layout establishes no routing, continuity, fit or physical qualification.</Text>
    <Modal opened={active && candidateReadable && !!placement} onClose={() => !busy && setPlacement(null)} title="Review harness placement" transitionProps={{ duration: active ? 200 : 0 }}><Stack><Text>{placement?.name}</Text>{placement?.drop.kind !== 'wire_stock' && <Select label="Harness endpoint for this part" comboboxProps={{ withinPortal: false }} value={target ?? 'new'} data={[{ value: 'new', label: 'New separate endpoint' }, ...value.endpoints.map(endpoint => ({ value: endpoint.local_id, label: endpoint.label ?? endpoint.local_id }))]} onChange={next => setTarget(next === 'new' ? null : next)} />}<Text size="sm">{placement?.drop.kind === 'wire_stock' ? 'Adds one original physical section and one span. Planned cut length remains unknown.' : target ? 'Adds the selected layer to this endpoint. An exact saved stack is copied locally before editing; its Library revision is unchanged. Existing mappings remain for explicit review.' : 'Adds a separate endpoint with an exact saved stack or local stack layer. Existing endpoints and mappings are retained.'}</Text>{placement?.drop.kind === 'connector_body' && <Alert>Choose its exact pinout in the endpoint inspector before Save. Contacts are not inferred.</Alert>}{placement?.drop.kind === 'part' && <><Select label="Part use" disabled={busy} comboboxProps={{ withinPortal: false }} value={partUse} onChange={next => setPartUse(next as 'shell' | 'inline' | null)} data={[{ value: 'shell', label: 'Shell / hardware' }, { value: 'inline', label: 'Declared two-lead inline use' }]} />{partUse === 'inline' && <><Checkbox label="I declare this use has two leads" checked={twoLead} disabled={busy} onChange={event => setTwoLead(event.currentTarget.checked)} /><Select label="Authored component behavior" comboboxProps={{ withinPortal: false }} disabled={busy} value={componentKind} data={COMPONENT_KINDS.map(kind => ({ value: kind, label: kind === 'unknown' ? 'Unknown' : kind }))} onChange={next => setComponentKind((next ?? 'unknown') as InlineComponent['kind'])} /><Text size="sm">Exact Part provenance is pinned. Two-lead use and behavior are separate declarations; package pinout is not established.</Text></>}</>}<Text size="sm">Apply prepares the local working buffer. Save is a separate action.</Text><Button disabled={!editable || busy || placement?.signature !== signature || placement?.drop.kind === 'part' && (!partUse || partUse === 'inline' && !twoLead)} onClick={() => void applyPlacement()}>Apply local placement</Button></Stack></Modal>
    <Modal opened={active && manual} onClose={() => setManual(false)} title="Connect harness terminals" transitionProps={{ duration: active ? 200 : 0 }}><Stack><Select label="First exact harness terminal" searchable data={choices} value={first} onChange={setFirst} comboboxProps={{ withinPortal: false }} /><Select label="Second exact harness terminal" searchable data={choices} value={second} onChange={setSecond} comboboxProps={{ withinPortal: false }} /><Button disabled={!editable || !first || !second} onClick={() => connect({ source: '', target: '', sourceHandle: first, targetHandle: second })}>Review declared joint</Button></Stack></Modal>
    <Modal opened={active && !!joint} onClose={() => !busy && setJoint(null)} title="Review declared harness joint" transitionProps={{ duration: active ? 200 : 0 }}><Stack>{joint && <Text>{describeHarnessTerminal(joint.left)} ↔ {describeHarnessTerminal(joint.right)}</Text>}<Select label="Harness joint kind" data={['termination', 'splice', 'shield_bond']} value={kind} onChange={next => setKind(next as Joint['kind'])} comboboxProps={{ withinPortal: false }} /><TextInput label="Harness joint basis" value={basis} onChange={event => setBasis(event.currentTarget.value)} maxLength={2000} /><Text size="sm">A terminal may belong to one joint. Shield bonds and multi-member joints can be reviewed in Joints.</Text><Button disabled={!editable || busy || !basis.trim() || joint?.signature !== signature} onClick={() => void applyJoint()}>Apply declared joint</Button></Stack></Modal>
  </section>;
}
