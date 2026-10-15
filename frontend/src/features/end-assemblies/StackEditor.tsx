import { ActionIcon, Alert, Button, Card, Group, Select, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import { useQueries, useQuery } from "@tanstack/react-query";
import { SbStatus, SbUnknown } from "../../components/sb";
import { COMPONENT_KINDS, read as readBoard, type BoardInspection } from "../boards/api";
import { RevisionPicker } from "../cables/RevisionPicker";
import type { Inspection as InterfaceInspection } from "../interfaces/api";
import { SignalTypeChip } from "../interfaces/SignalSetPanel";
import {
  JOIN_KINDS, LAYER_LABELS, LAYER_ORDER, addLayer, removeLayer, resolveEnd, splitKey, stackComplete, terminalKey, terminalText,
  type Definition, type EndStack, type InlineLayer, type LayerKind, type ResolvedLayer, type ResolvedStack, type ResolvedTerminal, type StackLayer,
} from "./api";
import "./end-assemblies.css";

import { newestFirst } from '../../lib/revision-labels';
type EndSource = { stack: EndStack | null; end_assembly_revision_id: string | null };
function resolveBody(source: EndSource | null) {
  return !source ? null
    : source.end_assembly_revision_id ? { end_assembly_revision_id: source.end_assembly_revision_id }
    : source.stack && stackComplete(source.stack) ? { stack: source.stack } : null;
}
/** Resolve a stack or a frozen end assembly once its pins are filled in. */
export function useResolvedStack(source: EndSource | null, enabled = true) {
  const body = resolveBody(source);
  return useQuery({ queryKey: ["cable-end-resolve", body], queryFn: () => resolveEnd(body!), enabled: enabled && !!body, retry: false });
}
/** One resolution per cable end, in end order. */
export function useResolvedStacks(sources: EndSource[]) {
  return useQueries({ queries: sources.map((source) => {
    const body = resolveBody(source);
    return { queryKey: ["cable-end-resolve", body], queryFn: () => resolveEnd(body!), enabled: !!body, retry: false };
  }) });
}

/**
 * One end as a row of layer chips. ``outward`` reads wire-first (End B); the left end of a
 * cable is drawn mirrored so its shell is outermost on the left.
 */
export function StackDiagram({ layers, mirrored = false, label }: { layers: { kind: LayerKind; name: string | null; detail?: string | null; status?: string | null }[]; mirrored?: boolean; label: string }) {
  const shown = mirrored ? [...layers].reverse() : layers;
  return <div className="sb-stack-row" role="list" aria-label={label}>
    {shown.length === 0 && <SbUnknown what="end stack" />}
    {shown.map((layer, index) => <span key={`${layer.kind}-${index}`} role="listitem" className="sb-layer-chip" data-kind={layer.kind} data-unknown={!layer.name || undefined}>
      <span className="sb-layer-kind">{LAYER_LABELS[layer.kind]}</span>
      <span className="sb-layer-name">{layer.name ?? "unknown"}{layer.detail ? ` · ${layer.detail}` : ""}</span>
      {layer.status === "unknown" && <span className="sb-layer-flag">landing unknown</span>}
    </span>)}
  </div>;
}

export function resolvedChips(resolved: ResolvedStack) {
  return resolved.layers.map((l) => ({ kind: l.kind, name: l.name, detail: l.kind === "connector" ? l.variant_label ?? l.pinout_name ?? null : null, status: l.kind === "board" ? l.carried_status ?? null : null }));
}

/** Layer cards from the wire outward, then the joins between their terminals. */
export function StackEditor({ value, onChange, definitions, resolved, label = "End", nameFilter = null }: { value: EndStack; onChange: (v: EndStack) => void; definitions: Definition[]; resolved?: ResolvedStack; label?: string; nameFilter?: string | null }) {
  const present = new Set(value.layers.map((l) => l.kind));
  const setLayer = (layerId: string, next: StackLayer) => onChange({ ...value, layers: value.layers.map((l) => (l.layer_id === layerId ? next : l)) });
  return <Stack gap="xs">
    <Group gap="xs" aria-label={`${label} layers`}>
      <Text size="xs" c="dimmed">From the wire outward:</Text>
      {LAYER_ORDER.filter((k) => !present.has(k)).map((kind) => <Button key={kind} size="compact-xs" variant="default" onClick={() => onChange(addLayer(value, kind))}>Add {LAYER_LABELS[kind].toLowerCase()}</Button>)}
    </Group>
    {value.layers.map((layer) => <Card key={layer.layer_id} withBorder padding="xs" className="sb-layer-card" data-kind={layer.kind}>
      <Group justify="space-between" mb={4}><Text fw={600} size="sm">{LAYER_LABELS[layer.kind]}</Text>
        <ActionIcon variant="subtle" aria-label={`Remove ${LAYER_LABELS[layer.kind].toLowerCase()} layer from ${label}`} disabled={value.layers.length === 1} onClick={() => onChange(removeLayer(value, layer.layer_id))}>×</ActionIcon></Group>
      <LayerFields layer={layer} label={label} nameFilter={nameFilter} definitions={definitions} onChange={(next) => setLayer(layer.layer_id, next)} hasConnector={present.has("connector")} />
    </Card>)}
    <JoinEditor value={value} onChange={onChange} resolved={resolved} label={label} />
  </Stack>;
}

function LayerFields({ layer, label, definitions, onChange, hasConnector, nameFilter }: { layer: StackLayer; label: string; definitions: Definition[]; onChange: (l: StackLayer) => void; hasConnector: boolean; nameFilter: string | null }) {
  if (layer.kind === "connector") return <ConnectorFields layer={layer} label={label} definitions={definitions} onChange={onChange} nameFilter={nameFilter} />;
  if (layer.kind === "board") return <BoardFields layer={layer} label={label} definitions={definitions} onChange={onChange} hasConnector={hasConnector} />;
  if (layer.kind === "inline") return <InlineFields layer={layer} label={label} onChange={onChange} />;
  return <Stack gap={4}>
    <RevisionPicker label={`${label} shell`} title="Shell or hood part" kind="part" value={layer.part_revision_id ?? ""} onChange={(id) => onChange({ ...layer, part_revision_id: id || null })} definitions={definitions} />
    <TextInput size="xs" label="Shell description" placeholder="e.g. Small overmold shell" value={layer.label ?? ""} onChange={(e) => onChange({ ...layer, label: e.currentTarget.value || null })} />
    <Text size="xs" c="dimmed">A shell is mechanical: it joins nothing unless a bond is declared below.</Text>
  </Stack>;
}

function ConnectorFields({ layer, label, definitions, onChange, nameFilter }: { layer: Extract<StackLayer, { kind: "connector" }>; label: string; definitions: Definition[]; onChange: (l: StackLayer) => void; nameFilter: string | null }) {
  const body = useQuery({ queryKey: ["cable-body", layer.body_revision_id], queryFn: () => readBoard<InterfaceInspection>(`interfaces/revisions/${layer.body_revision_id}`), enabled: !!layer.body_revision_id });
  const variants = body.data?.pinout_variants?.filter((v) => v.same_body_revision) ?? [];
  return <Stack gap={4}>
    <RevisionPicker label={`${label} body`} title="Connector body" kind="connector_body" nameFilter={nameFilter} value={layer.body_revision_id} onChange={(id) => onChange({ ...layer, body_revision_id: id, pinout_revision_id: id === layer.body_revision_id ? layer.pinout_revision_id : "" })} definitions={definitions} />
    {variants.length > 0 && <Select size="xs" label="Pinout variant" aria-label={`${label} pinout variant`} placeholder="Choose the variant this end uses" value={variants.some((v) => v.revision_id === layer.pinout_revision_id) ? layer.pinout_revision_id : null}
      data={newestFirst(variants).map((v) => ({ value: v.revision_id, label: `${v.variant_label ?? v.name} · r${v.number}${v.role !== "unknown" ? ` · ${v.role}` : ""}` }))} onChange={(id) => onChange({ ...layer, pinout_revision_id: id ?? "" })} />}
    {layer.body_revision_id && body.data && variants.length === 0 && <Text size="xs" c="dimmed">No pinout variant of this exact body revision is frozen yet; pick one by name below.</Text>}
    {(variants.length === 0 || !variants.some((v) => v.revision_id === layer.pinout_revision_id)) && <RevisionPicker label={`${label} pinout`} title="Pinout" kind="pinout" value={layer.pinout_revision_id} onChange={(id) => onChange({ ...layer, pinout_revision_id: id })} definitions={definitions} />}
    {body.isError && <Alert color="red">{body.error.message}</Alert>}
  </Stack>;
}

function BoardFields({ layer, label, definitions, onChange, hasConnector }: { layer: Extract<StackLayer, { kind: "board" }>; label: string; definitions: Definition[]; onChange: (l: StackLayer) => void; hasConnector: boolean }) {
  const board = useQuery({ queryKey: ["cable-board", layer.board_revision_id], queryFn: () => readBoard<BoardInspection>(`interfaces/revisions/${layer.board_revision_id}`), enabled: !!layer.board_revision_id });
  const carried = board.data?.board?.connectors ?? [];
  return <Stack gap={4}>
    <RevisionPicker label={`${label} board`} title="Board (PCBA)" kind="board" value={layer.board_revision_id} onChange={(id) => onChange({ ...layer, board_revision_id: id, carried_connector_id: null })} definitions={definitions} />
    {carried.length > 0 && <Select size="xs" clearable label="Carries this end's connector" aria-label={`${label} carried connector`} description={hasConnector ? "The board's reviewed pad/contact landings join it to the connector layer." : "Add the connector layer first."}
      disabled={!hasConnector} placeholder="Not carried" value={layer.carried_connector_id}
      data={carried.map((c) => ({ value: c.local_id, label: `${c.body_name} r${c.body_revision_number} · ${c.status === "reviewed" ? "reviewed landings" : "landings unknown"}` }))}
      onChange={(id) => onChange({ ...layer, carried_connector_id: id })} />}
    {board.isError && <Alert color="red">{board.error.message}</Alert>}
  </Stack>;
}

function InlineFields({ layer, label, onChange }: { layer: InlineLayer; label: string; onChange: (l: StackLayer) => void }) {
  const setPart = (index: number, patch: Partial<InlineLayer["parts"][number]>) => onChange({ ...layer, parts: layer.parts.map((p, i) => (i === index ? { ...p, ...patch } : p)) });
  const addPart = () => {
    const ids = layer.parts.map((p) => p.local_id);
    let n = layer.parts.length + 1;
    while (ids.includes(`r${n}`)) n += 1;
    onChange({ ...layer, parts: [...layer.parts, { local_id: `r${n}`, label: null, component: { kind: "resistor", value: null, reference: `R${n}`, resistance_ohm: null, capacitance_f: null } }] });
  };
  return <Stack gap={4}>
    <Text size="xs" c="dimmed">Hand-soldered parts. Each has lead 1 (where a conductor lands) and lead 2 (joined below).</Text>
    <Table.ScrollContainer minWidth={560}><Table verticalSpacing={2} className="sb-stack-table">
      <Table.Thead><Table.Tr><Table.Th>Part</Table.Th><Table.Th>Reference</Table.Th><Table.Th>Kind</Table.Th><Table.Th>Value as written</Table.Th><Table.Th /></Table.Tr></Table.Thead>
      <Table.Tbody>{layer.parts.map((part, index) => <Table.Tr key={part.local_id}>
        <Table.Td><TextInput size="xs" aria-label={`${label} part ${part.local_id} name`} placeholder="e.g. Blanking resistor" value={part.label ?? ""} onChange={(e) => setPart(index, { label: e.currentTarget.value || null })} /></Table.Td>
        <Table.Td><TextInput size="xs" aria-label={`${label} part ${part.local_id} reference`} value={part.component.reference ?? ""} onChange={(e) => setPart(index, { component: { ...part.component, reference: e.currentTarget.value || null } })} /></Table.Td>
        <Table.Td><Select size="xs" aria-label={`${label} part ${part.local_id} kind`} value={part.component.kind} data={COMPONENT_KINDS.map((k) => ({ value: k, label: k }))} onChange={(v) => setPart(index, { component: { ...part.component, kind: (v ?? "unknown") as typeof part.component.kind, resistance_ohm: v === "resistor" ? part.component.resistance_ohm : null, capacitance_f: v === "capacitor" ? part.component.capacitance_f : null } })} /></Table.Td>
        <Table.Td><TextInput size="xs" aria-label={`${label} part ${part.local_id} value`} placeholder="unknown" value={part.component.value ?? ""} onChange={(e) => setPart(index, { component: { ...part.component, value: e.currentTarget.value || null } })} /></Table.Td>
        <Table.Td><ActionIcon variant="subtle" aria-label={`Remove part ${part.local_id}`} disabled={layer.parts.length === 1} onClick={() => onChange({ ...layer, parts: layer.parts.filter((_, i) => i !== index) })}>×</ActionIcon></Table.Td>
      </Table.Tr>)}</Table.Tbody>
    </Table></Table.ScrollContainer>
    <Button size="compact-xs" variant="default" w="fit-content" onClick={addPart}>Add part</Button>
  </Stack>;
}

/** Explicit joins between terminals of two layers; board landings appear read-only. */
function JoinEditor({ value, onChange, resolved, label }: { value: EndStack; onChange: (v: EndStack) => void; resolved?: ResolvedStack; label: string }) {
  const options = (resolved?.layers ?? []).flatMap((l) => l.terminals.map((t) => ({ value: terminalKey({ layer_id: l.layer_id, terminal_id: t.terminal_id }), label: `${LAYER_LABELS[l.kind]} · ${t.label}` })));
  const derived = (resolved?.joins ?? []).filter((j) => j.origin !== "declared");
  const setJoin = (index: number, patch: Partial<EndStack["joins"][number]>) => onChange({ ...value, joins: value.joins.map((j, i) => (i === index ? { ...j, ...patch } : j)) });
  const addJoin = () => {
    const ids = value.joins.map((j) => j.local_id);
    let n = value.joins.length + 1;
    while (ids.includes(`join-${n}`)) n += 1;
    const [first, second] = options;
    onChange({ ...value, joins: [...value.joins, { local_id: `join-${n}`, a: splitKey(first?.value ?? "/"), b: splitKey(second?.value ?? "/"), kind: "solder", basis: "" }] });
  };
  return <Stack gap={4}>
    <Title order={5}>Joins between layers</Title>
    {derived.length > 0 && <Text size="xs" data-testid={`${label}-landings`}>{derived.length} board landings from the board's carried connector: {derived[0]!.status === "reviewed" ? "reviewed" : <SbUnknown what="landing review" />}</Text>}
    {value.joins.length === 0 && <Text size="xs" c="dimmed">No declared joins.</Text>}
    {value.joins.length > 0 && <Table.ScrollContainer minWidth={720}><Table verticalSpacing={2} className="sb-stack-table">
      <Table.Thead><Table.Tr><Table.Th>From</Table.Th><Table.Th>To</Table.Th><Table.Th>How</Table.Th><Table.Th>Basis</Table.Th><Table.Th /></Table.Tr></Table.Thead>
      <Table.Tbody>{value.joins.map((join, index) => <Table.Tr key={join.local_id}>
        <Table.Td><Select size="xs" searchable aria-label={`${label} join ${join.local_id} from`} data={options} value={options.some((o) => o.value === terminalKey(join.a)) ? terminalKey(join.a) : null} placeholder={terminalKey(join.a)} onChange={(v) => v && setJoin(index, { a: splitKey(v) })} /></Table.Td>
        <Table.Td><Select size="xs" searchable aria-label={`${label} join ${join.local_id} to`} data={options} value={options.some((o) => o.value === terminalKey(join.b)) ? terminalKey(join.b) : null} placeholder={terminalKey(join.b)} onChange={(v) => v && setJoin(index, { b: splitKey(v) })} /></Table.Td>
        <Table.Td><Select size="xs" aria-label={`${label} join ${join.local_id} kind`} data={JOIN_KINDS} value={join.kind} onChange={(v) => setJoin(index, { kind: (v ?? "solder") as typeof join.kind })} /></Table.Td>
        <Table.Td><TextInput size="xs" aria-label={`${label} join ${join.local_id} basis`} placeholder="Required" value={join.basis} onChange={(e) => setJoin(index, { basis: e.currentTarget.value })} /></Table.Td>
        <Table.Td><ActionIcon variant="subtle" aria-label={`Remove join ${join.local_id}`} onClick={() => onChange({ ...value, joins: value.joins.filter((_, i) => i !== index) })}>×</ActionIcon></Table.Td>
      </Table.Tr>)}</Table.Tbody>
    </Table></Table.ScrollContainer>}
    <Button size="compact-xs" variant="default" w="fit-content" disabled={options.length < 2} onClick={addJoin}>Add join</Button>
    {options.length < 2 && <Text size="xs" c="dimmed">Joins list terminals once every layer's revision is chosen.</Text>}
  </Stack>;
}

export function SignalCell({ terminal }: { terminal: ResolvedTerminal }) {
  if (terminal.signal) return <Group gap={4} wrap="nowrap"><span>{terminal.signal.name}</span><SignalTypeChip type={terminal.signal.type} /></Group>;
  if (terminal.signal_status === "conditional") return <SbUnknown what="Signal (conditional)" />;
  if (terminal.reaches.length) return <Stack gap={0}>{terminal.reaches.map((r) => <Text key={r.contact_id} size="xs" data-unknown={r.status === "unknown" || undefined}>
    → {r.label}{r.signal ? ` · ${r.signal.name}` : ""} <span className="sb-stack-via">via {r.via.join(", ")}</span>{r.status === "unknown" && <> <SbUnknown what="step" /></>}</Text>)}</Stack>;
  return <SbUnknown what="Signal" />;
}

function LayerTerminals({ layer }: { layer: ResolvedLayer }) {
  return <Table.ScrollContainer minWidth={420}><Table verticalSpacing={2} className="sb-stack-table" aria-label={`${LAYER_LABELS[layer.kind]} terminals`}>
    <Table.Thead><Table.Tr><Table.Th>{layer.kind === "connector" ? "Contact" : layer.kind === "board" ? "Pad" : "Terminal"}</Table.Th><Table.Th>Signal or declared reach</Table.Th></Table.Tr></Table.Thead>
    <Table.Tbody>{layer.terminals.map((t) => <Table.Tr key={t.terminal_id}><Table.Td className="sb-mono">{t.label}{t.group ? <Text span size="xs" c="dimmed"> · {t.group}</Text> : null}</Table.Td><Table.Td>{layer.kind === "shell" ? <Text size="xs" c="dimmed">Mechanical; joined only by a declared bond.</Text> : <SignalCell terminal={t} />}</Table.Td></Table.Tr>)}</Table.Tbody>
  </Table></Table.ScrollContainer>;
}

/** Read-only stack: layer chips, then each layer's terminals with signals, then joins. */
export function StackView({ resolved, label = "End" }: { resolved: ResolvedStack; label?: string }) {
  return <Stack gap="xs">
    <StackDiagram layers={resolvedChips(resolved)} label={`${label} stack`} />
    {resolved.layers.map((layer) => <Card key={layer.layer_id} withBorder padding="xs" className="sb-layer-card" data-kind={layer.kind}>
      <Group gap="xs" mb={4}><Text fw={600} size="sm">{LAYER_LABELS[layer.kind]}</Text><Text size="sm">{layer.name ?? <SbUnknown what="part" />}</Text>
        {layer.kind === "connector" && layer.variant_label && <Text size="xs" c="dimmed">variant {layer.variant_label}</Text>}
        {layer.kind === "board" && layer.carried_connector_id && <SbStatus led={layer.carried_status === "reviewed" ? "info" : "review"} dimension="landings" value={layer.carried_status === "reviewed" ? "reviewed" : "unknown"} />}
        {layer.kind === "inline" && layer.parts?.map((p) => <Text key={p.local_id} size="xs" className="sb-mono">{p.name}: {p.summary}</Text>)}
      </Group>
      {layer.kind === "board" && layer.paths && layer.paths.length > 0 && <Text size="xs" c="dimmed">{layer.paths.length} declared board paths</Text>}
      <LayerTerminals layer={layer} />
    </Card>)}
    {resolved.joins.filter((j) => j.origin === "declared").length > 0 && <Table.ScrollContainer minWidth={420}><Table verticalSpacing={2} className="sb-stack-table" aria-label={`${label} joins`}>
      <Table.Thead><Table.Tr><Table.Th>From</Table.Th><Table.Th>To</Table.Th><Table.Th>How</Table.Th><Table.Th>Basis</Table.Th></Table.Tr></Table.Thead>
      <Table.Tbody>{resolved.joins.filter((j) => j.origin === "declared").map((j) => <Table.Tr key={j.local_id}><Table.Td>{j.a.label}</Table.Td><Table.Td>{j.b.label}</Table.Td><Table.Td>{j.kind}</Table.Td><Table.Td>{j.basis}</Table.Td></Table.Tr>)}</Table.Tbody>
    </Table></Table.ScrollContainer>}
    {resolved.evaluation.map((e) => <Text key={e.layer_id} size="xs" c="dimmed"><SbStatus led="not-evaluated" dimension={e.layer_id} value="not evaluated" /> {e.reason}</Text>)}
  </Stack>;
}

/** All terminals of a resolved stack as termination targets, grouped by layer. */
export function targetOptions(resolved: ResolvedStack | undefined) {
  return (resolved?.layers ?? []).map((layer) => ({
    group: `${LAYER_LABELS[layer.kind]}${layer.name ? ` · ${layer.name}` : ""}`,
    items: layer.terminals.map((t) => ({ value: terminalKey({ layer_id: layer.layer_id, terminal_id: t.terminal_id }), label: terminalText(t) })),
  }));
}

export function findTerminal(resolved: ResolvedStack | undefined, layerId: string, terminalId: string) {
  const layer = resolved?.layers.find((l) => l.layer_id === layerId);
  return { layer, terminal: layer?.terminals.find((t) => t.terminal_id === terminalId) };
}

