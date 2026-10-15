import { ActionIcon, Alert, Button, Card, Checkbox, Group, Select, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { SbStatus, SbUnknown } from "../../components/sb";
import { RevisionLabel } from "../../lib/IdentityLabel";
import { InspectionScope, ReadOnlyNote, usePermission, type PermissionName } from "../../lib/permissions";
import { newestFirst, revisionOptionLabel } from "../../lib/revision-labels";
import { definitionIn, referenceFromProject, useOpenNewest, useOpenProbed } from "../scope/openProbed";
import { ContinueDraftButton } from "../scope/ContinueDraftButton";
import {
  COMPONENT_KINDS, SIDES, TERMINAL_KINDS, VIAS, command, emptyBoard, emptyComponent, pathSummary, proposalPath, read, terminalId,
  type Board, type BoardDraft, type BoardInspection, type BoardPath, type BoardProposal, type BoardTrace, type Definition, type Identity,
} from "./api";
import { BoardDrawing } from "./BoardDrawing";
import { layoutBoard, tracedPathIds } from "./board-layout";
import "./boards.css";

const KIND_LABELS: Record<string, string> = { solder_pad: "Solder pad", through_hole: "Through hole", connector_contact: "Connector contact", test_point: "Test point", unknown: "unknown" };
const VIA_LABELS: Record<string, string> = { copper: "Straight copper", component: "Through a component", switch: "Switch or jumper state", unknown: "Unknown" };
const QUERIES = [{ value: "dc_continuity", label: "DC path" }, { value: "resistance", label: "Series resistance" }, { value: "shortness", label: "Short" }, { value: "signal", label: "Signal path" }];
const TRACE_WORDS: Record<string, string> = {
  modeled_series_resistance: "series resistance", modeled_dc_path: "declared DC path", modeled_ideal_short: "ideal short (declared)",
  modeled_no_ideal_short: "no ideal short", modeled_blocked: "blocked", modeled_signal_candidate: "declared signal path", unknown: "unknown",
};

/** Boards lens: labeled pads, the connector a board carries and declared pad-to-pad paths. */
export function BoardPanel({ projectId }: { projectId: string | null }) {
  return <Boards key={projectId ?? "library"} projectId={projectId} />;
}

function Boards({ projectId }: { projectId: string | null }) {
  const cache = useQueryClient();
  const createGate = usePermission("item.create");
  const freezeGate = usePermission("design.freeze");
  const [name, setName] = useState("");
  const [value, setValue] = useState<Board>(emptyBoard);
  const [newKey, setNewKey] = useState(0);
  const [definitionId, setDefinitionId] = useState<string | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [revisionId, setRevisionId] = useState<string | null>(null);
  const definitions = useQuery({ queryKey: ["board-definitions", projectId], queryFn: () => read<Definition[]>("workspace/definitions") });
  const identity = useQuery({ queryKey: ["board-identity", definitionId], queryFn: () => read<Identity>(`catalog/definitions/${definitionId}`), enabled: !!definitionId });
  const draft = useQuery({ queryKey: ["board-draft", draftId], queryFn: () => read<BoardDraft>(`interfaces/drafts/${draftId}`), enabled: !!draftId });
  const pick = (id: string | null) => { setDefinitionId(id); setDraftId(null); setRevisionId(null); };
  const openNewest = useOpenNewest(identity.data, setDraftId, setRevisionId);
  useOpenProbed(definitionIn(definitions.data, ["board"]), (id) => { pick(id); openNewest(id); });
  const create = useMutation({ mutationFn: () => command<BoardDraft>("interface.create", { name, interface: value }), onSuccess: async (data) => {
    setDefinitionId(data.definition_id); setDraftId(data.draft_id); setRevisionId(null);
    await referenceFromProject(projectId, data.definition_id, "board");
    await cache.invalidateQueries({ queryKey: ["board-definitions", projectId] });
  } });
  const freeze = useMutation({ mutationFn: () => command<{ revision_id: string }>("interface.freeze", { draft_id: draftId }, draft.data?.state), onSuccess: async (data) => {
    setRevisionId(data.revision_id);
    await cache.invalidateQueries({ queryKey: ["board-draft", draftId] });
    await cache.invalidateQueries({ queryKey: ["board-identity", definitionId] });
  } });
  const boards = (definitions.data ?? []).filter((d) => d.kind === "board");
  return <Stack>
    <Title order={2}>Boards</Title>
    <Text size="sm">A board's labeled pads, the connector it carries and how pads are joined on the board: straight copper, through a part such as a series resistor, or through a switch or jumper state. Bought boards are typed by hand; KiCad boards can be proposed from an accepted import for review. Anything not declared stays unknown.</Text>
    {definitions.isError && <Alert color="red">{definitions.error.message}</Alert>}
    <Group align="end">
      <Select label="Board" searchable placeholder={boards.length ? "Choose a board" : "No boards yet"} data={boards.map((d) => ({ value: d.definition_id, label: d.name }))} value={definitionId} onChange={pick} />
      {identity.data && <ContinueDraftButton drafts={identity.data.drafts} revisionId={revisionId} draftId={draftId} onOpen={setDraftId} />}
      {identity.data && <Select label="Frozen revision" value={revisionId} onChange={setRevisionId} data={newestFirst(identity.data.revisions).map((r) => ({ value: r.revision_id, label: revisionOptionLabel(identity.data.name, r.number) }))} />}
      {identity.data && identity.data.drafts.length > 0 && <Select label="Draft" value={draftId} onChange={setDraftId} data={identity.data.drafts.map((d, i) => ({ value: d.draft_id, label: `Draft ${i + 1}` }))} />}
    </Group>
    {identity.isError && <Alert color="red">{identity.error.message}</Alert>}
    {revisionId && <BoardInspector key={revisionId} revisionId={revisionId} />}
    {draft.isError && <Alert color="red">{draft.error.message}</Alert>}
    {draft.data && <><BoardDraftEditor key={`${draft.data.draft_id}:${draft.data.state}`} draft={draft.data} definitions={definitions.data ?? []} onSaved={async () => { await cache.invalidateQueries({ queryKey: ["board-draft", draftId] }); }} />
      <Group><Button loading={freeze.isPending} disabled={!draft.data.content.interface} onClick={() => freeze.mutate()} {...freezeGate.props}>Freeze board</Button><ReadOnlyNote permission="design.freeze">Freezing boards is unavailable.</ReadOnlyNote></Group></>}
    {freeze.isError && <Alert color="red">{freeze.error.message}</Alert>}
    <Card withBorder><Stack gap="xs">
      <Title order={3}>New board</Title>
      <InspectionScope permission="item.create">
        <TextInput label="Board name" value={name} onChange={(e) => setName(e.currentTarget.value)} />
        <KicadProposal definitions={definitions.data ?? []} onUse={(board, label) => { setValue(board); setNewKey((k) => k + 1); if (!name.trim()) setName(label); }} />
        <BoardEditor key={newKey} value={value} onChange={setValue} definitions={definitions.data ?? []} permission="item.create" title={name.trim() || "New board"} />
      </InspectionScope>
      <Group><Button disabled={!name.trim()} loading={create.isPending} onClick={() => create.mutate()} {...createGate.props}>Create board draft</Button><ReadOnlyNote permission="item.create">Creating boards is unavailable.</ReadOnlyNote></Group>
      {create.isError && <Alert color="red">{create.error.message}</Alert>}
    </Stack></Card>
  </Stack>;
}

function BoardDraftEditor({ draft, definitions, onSaved }: { draft: BoardDraft; definitions: Definition[]; onSaved: () => Promise<void> }) {
  const editGate = usePermission("design.edit");
  const [value, setValue] = useState<Board>(() => draft.content.interface ?? emptyBoard());
  const save = useMutation({ mutationFn: () => command("interface.update", { draft_id: draft.draft_id, interface: value }, draft.state), onSuccess: onSaved });
  return <Card withBorder><Stack gap="xs"><Title order={3}>Edit board draft</Title>
    {!draft.content.interface && <Text size="sm" c="dimmed">This board has no declared pads or paths yet. Saving declares them.</Text>}
    <InspectionScope permission="design.edit"><BoardEditor value={value} onChange={setValue} definitions={definitions} title="Board draft" /></InspectionScope>
    <Group><Button loading={save.isPending} onClick={() => save.mutate()} {...editGate.props}>Save board draft</Button><ReadOnlyNote permission="design.edit">Saving boards is unavailable.</ReadOnlyNote></Group>
    {save.isError && <Alert color="red">{save.error.message}</Alert>}
  </Stack></Card>;
}

/** Fallback table editor: pad table, carried connector correspondence and the path table. */
function BoardTableEditor({ value, onChange, definitions }: { value: Board; onChange: (v: Board) => void; definitions: Definition[] }) {
  const [label, setLabel] = useState("");
  const [group, setGroup] = useState("");
  const labels = new Map(value.terminals.map((t) => [t.terminal_id, t.label]));
  const terminalOptions = value.terminals.map((t) => ({ value: t.terminal_id, label: t.group ? `${t.label} · ${t.group}` : t.label }));
  const setTerminal = (id: string, patch: Partial<Board["terminals"][number]>) => onChange({ ...value, terminals: value.terminals.map((t) => (t.terminal_id === id ? { ...t, ...patch } : t)) });
  const removeTerminal = (id: string) => onChange({
    ...value, terminals: value.terminals.filter((t) => t.terminal_id !== id),
    paths: value.paths.filter((p) => p.from_terminal !== id && p.to_terminal !== id),
    carried_connectors: value.carried_connectors.map((c) => ({ ...c, correspondence: c.correspondence.filter((x) => x.terminal_id !== id) })),
  });
  const addTerminal = () => {
    const ids = value.terminals.map((t) => t.terminal_id);
    onChange({ ...value, terminals: [...value.terminals, { terminal_id: terminalId(label, ids), label: label.trim(), group: group.trim() || null, kind: "unknown", side: "unknown", native_pad_ids: [], note: null }] });
    setLabel("");
  };
  const setPath = (id: string, patch: Partial<BoardPath>) => onChange({ ...value, paths: value.paths.map((p) => (p.local_id === id ? { ...p, ...patch } : p)) });
  const addPath = () => {
    const ids = value.paths.map((p) => p.local_id);
    let n = value.paths.length + 1;
    while (ids.includes(`path-${n}`)) n += 1;
    const [first, second] = value.terminals;
    onChange({ ...value, paths: [...value.paths, { local_id: `path-${n}`, from_terminal: first?.terminal_id ?? "", to_terminal: second?.terminal_id ?? "", via: "copper", component: null, switch: null, provenance: "declared", basis: "" }] });
  };
  return <Stack gap="xs">
    <Text size="sm">{value.origin === "kicad_derived" ? "Proposed from a KiCad import: review every pad and path before relying on it." : "Black-box board: pads and paths typed from its drawing or datasheet."}</Text>
    <Title order={4}>Pads</Title>
    {value.terminals.length === 0 && <Text size="sm" c="dimmed">No pads declared.</Text>}
    {value.terminals.length > 0 && <Table.ScrollContainer minWidth={720}><Table withTableBorder verticalSpacing={4} className="sb-board-table">
      <Table.Thead><Table.Tr><Table.Th>Label</Table.Th><Table.Th>Group</Table.Th><Table.Th>Kind</Table.Th><Table.Th>Side</Table.Th><Table.Th>Native pad</Table.Th><Table.Th /></Table.Tr></Table.Thead>
      <Table.Tbody>{value.terminals.map((t) => <Table.Tr key={t.terminal_id}>
        <Table.Td><TextInput size="xs" aria-label={`Label of pad ${t.label}`} value={t.label} onChange={(e) => setTerminal(t.terminal_id, { label: e.currentTarget.value })} /></Table.Td>
        <Table.Td><TextInput size="xs" aria-label={`Group of pad ${t.label}`} placeholder="none" value={t.group ?? ""} onChange={(e) => setTerminal(t.terminal_id, { group: e.currentTarget.value || null })} /></Table.Td>
        <Table.Td><Select size="xs" aria-label={`Kind of pad ${t.label}`} value={t.kind} data={TERMINAL_KINDS.map((k) => ({ value: k, label: KIND_LABELS[k]! }))} onChange={(v) => setTerminal(t.terminal_id, { kind: (v ?? "unknown") as typeof t.kind })} /></Table.Td>
        <Table.Td><Select size="xs" aria-label={`Side of pad ${t.label}`} value={t.side} data={SIDES.map((s) => ({ value: s, label: s }))} onChange={(v) => setTerminal(t.terminal_id, { side: (v ?? "unknown") as typeof t.side })} /></Table.Td>
        <Table.Td className="sb-mono">{t.note ?? (t.native_pad_ids.length ? `${t.native_pad_ids.length} native` : "none")}</Table.Td>
        <Table.Td><ActionIcon variant="subtle" aria-label={`Remove pad ${t.label}`} onClick={() => removeTerminal(t.terminal_id)}>×</ActionIcon></Table.Td>
      </Table.Tr>)}</Table.Tbody>
    </Table></Table.ScrollContainer>}
    <Group align="end">
      <TextInput size="xs" label="New pad label" placeholder="e.g. CS" value={label} onChange={(e) => setLabel(e.currentTarget.value)} />
      <TextInput size="xs" label="Group" placeholder="e.g. Cable side" value={group} onChange={(e) => setGroup(e.currentTarget.value)} />
      <Button size="xs" variant="default" disabled={!label.trim()} onClick={addTerminal}>Add pad</Button>
    </Group>
    <ConnectorEditor value={value} onChange={onChange} definitions={definitions} terminalOptions={terminalOptions} />
    <Title order={4}>Paths</Title>
    {value.paths.length === 0 && <Text size="sm" c="dimmed">No paths declared: every pad's connection is unknown.</Text>}
    {value.paths.length > 0 && <Table.ScrollContainer minWidth={1000}><Table withTableBorder verticalSpacing={4} className="sb-board-table">
      <Table.Thead><Table.Tr><Table.Th>From</Table.Th><Table.Th>To</Table.Th><Table.Th>Through</Table.Th><Table.Th>Detail</Table.Th><Table.Th>Basis</Table.Th><Table.Th /></Table.Tr></Table.Thead>
      <Table.Tbody>{value.paths.map((p) => {
        const name = `${labels.get(p.from_terminal) ?? "?"} to ${labels.get(p.to_terminal) ?? "?"}`;
        return <Table.Tr key={p.local_id}>
          <Table.Td><Select size="xs" aria-label={`From pad of path ${p.local_id}`} value={p.from_terminal || null} data={terminalOptions} onChange={(v) => setPath(p.local_id, { from_terminal: v ?? "" })} /></Table.Td>
          <Table.Td><Select size="xs" aria-label={`To pad of path ${p.local_id}`} value={p.to_terminal || null} data={terminalOptions} onChange={(v) => setPath(p.local_id, { to_terminal: v ?? "" })} /></Table.Td>
          <Table.Td><Select size="xs" aria-label={`How path ${name} is joined`} value={p.via} data={VIAS.map((v) => ({ value: v, label: VIA_LABELS[v]! }))} disabled={p.provenance !== "declared"}
            onChange={(v) => { const via = (v ?? "unknown") as BoardPath["via"]; setPath(p.local_id, { via, component: via === "component" ? p.component ?? emptyComponent() : null, switch: via === "switch" ? p.switch ?? { condition_key: value.conditions[0]?.key ?? "", closed_when: value.conditions[0]?.choices[0]?.key ?? "" } : null }); }} /></Table.Td>
          <Table.Td><PathDetail path={p} name={name} board={value} onChange={(patch) => setPath(p.local_id, patch)} /></Table.Td>
          <Table.Td><TextInput size="xs" aria-label={`Basis of path ${name}`} placeholder="Required" value={p.basis} onChange={(e) => setPath(p.local_id, { basis: e.currentTarget.value })} /></Table.Td>
          <Table.Td><ActionIcon variant="subtle" aria-label={`Remove path ${name}`} onClick={() => onChange({ ...value, paths: value.paths.filter((x) => x.local_id !== p.local_id) })}>×</ActionIcon></Table.Td>
        </Table.Tr>;
      })}</Table.Tbody>
    </Table></Table.ScrollContainer>}
    <Group><Button size="xs" variant="default" disabled={value.terminals.length < 2} onClick={addPath}>Add path</Button></Group>
  </Stack>;
}

function PathDetail({ path, name, board, onChange }: { path: BoardPath; name: string; board: Board; onChange: (patch: Partial<BoardPath>) => void }) {
  if (path.via === "component" && path.component) {
    const c = path.component;
    const put = (patch: Partial<typeof c>) => onChange({ component: { ...c, ...patch } });
    return <Group gap={4} wrap="nowrap">
      <Select size="xs" w={110} aria-label={`Component kind on path ${name}`} value={c.kind} data={COMPONENT_KINDS.map((k) => ({ value: k, label: k }))} onChange={(v) => { const kind = (v ?? "unknown") as typeof c.kind; put({ kind, resistance_ohm: kind === "resistor" ? c.resistance_ohm : null, capacitance_f: kind === "capacitor" ? c.capacitance_f : null }); }} />
      <TextInput size="xs" w={70} aria-label={`Reference on path ${name}`} placeholder="Ref" value={c.reference ?? ""} onChange={(e) => put({ reference: e.currentTarget.value || null })} />
      <TextInput size="xs" w={80} aria-label={`Written value on path ${name}`} placeholder="Value" value={c.value ?? ""} onChange={(e) => put({ value: e.currentTarget.value || null })} />
      {c.kind === "resistor" && <TextInput size="xs" w={110} aria-label={`Resistance in ohm on path ${name} (blank = unknown)`} placeholder="ohm, unknown" value={c.resistance_ohm ?? ""} onChange={(e) => put({ resistance_ohm: e.currentTarget.value.trim() || null })} />}
      {c.kind === "capacitor" && <TextInput size="xs" w={110} aria-label={`Capacitance in farad on path ${name} (blank = unknown)`} placeholder="F, unknown" value={c.capacitance_f ?? ""} onChange={(e) => put({ capacitance_f: e.currentTarget.value.trim() || null })} />}
    </Group>;
  }
  if (path.via === "switch" && path.switch) {
    const condition = board.conditions.find((x) => x.key === path.switch!.condition_key);
    return <Group gap={4} wrap="nowrap">
      <Select size="xs" aria-label={`Switch on path ${name}`} value={path.switch.condition_key || null} data={board.conditions.map((x) => ({ value: x.key, label: x.name }))} onChange={(v) => onChange({ switch: { condition_key: v ?? "", closed_when: board.conditions.find((x) => x.key === v)?.choices[0]?.key ?? "" } })} />
      <Select size="xs" aria-label={`Closed in state on path ${name}`} value={path.switch.closed_when || null} data={(condition?.choices ?? []).map((x) => ({ value: x.key, label: `closed in ${x.name}` }))} onChange={(v) => onChange({ switch: { ...path.switch!, closed_when: v ?? "" } })} />
    </Group>;
  }
  if (path.via === "unknown") return <SbUnknown what="Path" />;
  return <Text size="xs">{pathSummary(path, board.conditions)}</Text>;
}

/** The connector body the board carries and which pad lands on which contact (one body here; more are kept). */
function ConnectorEditor({ value, onChange, definitions, terminalOptions }: { value: Board; onChange: (v: Board) => void; definitions: Definition[]; terminalOptions: { value: string; label: string }[] }) {
  const connector = value.carried_connectors[0] ?? null;
  const [bodyDefinition, setBodyDefinition] = useState<string | null>(null);
  const identity = useQuery({ queryKey: ["board-body-identity", bodyDefinition], queryFn: () => read<Identity>(`catalog/definitions/${bodyDefinition}`), enabled: !!bodyDefinition });
  const body = useQuery({ queryKey: ["interface-inspect", connector?.body_revision_id], queryFn: () => read<{ interface: { kind: string; contacts?: { contact_id: string; number?: string | null; label: string; physical_role: string }[] } }>(`interfaces/revisions/${connector!.body_revision_id}`), enabled: !!connector?.body_revision_id });
  const put = (next: typeof connector) => onChange({ ...value, carried_connectors: next ? [next, ...value.carried_connectors.slice(1)] : value.carried_connectors.slice(1) });
  const contacts = (body.data?.interface.contacts ?? []).filter((c) => c.physical_role !== "key");
  const landing = (contactId: string) => connector?.correspondence.find((x) => x.contact_id === contactId)?.terminal_id ?? null;
  const land = (contactId: string, terminal: string | null) => {
    if (!connector) return;
    const rest = connector.correspondence.filter((x) => x.contact_id !== contactId && x.terminal_id !== terminal);
    put({ ...connector, correspondence: terminal ? [...rest, { terminal_id: terminal, contact_id: contactId }] : rest });
  };
  return <Stack gap={4}>
    <Title order={4}>Connector it carries</Title>
    <Group align="end">
      <Select size="xs" label="Connector body" searchable clearable placeholder={connector ? "Change body" : "None carried"} value={bodyDefinition} data={definitions.filter((d) => d.kind === "connector_body").map((d) => ({ value: d.definition_id, label: d.name }))} onChange={setBodyDefinition} />
      {identity.data && <Select size="xs" label="Body revision" value={connector?.body_revision_id ?? null} data={newestFirst(identity.data.revisions).map((r) => ({ value: r.revision_id, label: revisionOptionLabel(identity.data.name, r.number) }))}
        onChange={(v) => put(v ? { local_id: connector?.local_id ?? "connector", body_revision_id: v, correspondence: [], review: "unreviewed", basis: null } : null)} />}
      {connector && <Text size="xs"><RevisionLabel id={connector.body_revision_id} role="Body" /></Text>}
      {connector && <Button size="xs" variant="subtle" onClick={() => put(null)}>Remove connector</Button>}
    </Group>
    {connector && contacts.length > 0 && <Table.ScrollContainer minWidth={420}><Table withTableBorder verticalSpacing={2} className="sb-board-table">
      <Table.Thead><Table.Tr><Table.Th>Contact</Table.Th><Table.Th>Pad landing on it</Table.Th></Table.Tr></Table.Thead>
      <Table.Tbody>{contacts.map((c) => <Table.Tr key={c.contact_id}>
        <Table.Td className="sb-mono">{c.number ?? c.label ?? c.contact_id}</Table.Td>
        <Table.Td><Select size="xs" clearable aria-label={`Pad on contact ${c.number ?? c.contact_id}`} placeholder="none declared" value={landing(c.contact_id)} data={terminalOptions} onChange={(v) => land(c.contact_id, v)} /></Table.Td>
      </Table.Tr>)}</Table.Tbody>
    </Table></Table.ScrollContainer>}
    {connector && <Group align="end">
      <Select size="xs" label="Correspondence review" value={connector.review} data={[{ value: "unreviewed", label: "Unreviewed (reads unknown)" }, { value: "reviewed", label: "Reviewed" }]} onChange={(v) => put({ ...connector, review: (v ?? "unreviewed") as typeof connector.review })} />
      <TextInput size="xs" label="Correspondence basis" value={connector.basis ?? ""} onChange={(e) => put({ ...connector, basis: e.currentTarget.value || null })} />
    </Group>}
    {value.carried_connectors.length > 1 && <Text size="xs" c="dimmed">{value.carried_connectors.length - 1} further carried connector(s) are kept unchanged.</Text>}
  </Stack>;
}

/** Switch and jumper states that switch paths refer to. */
export function ConditionEditor({ value, onChange }: { value: Board; onChange: (v: Board) => void }) {
  const [name, setName] = useState("");
  const [states, setStates] = useState("");
  const choices = states.split(",").map((s) => s.trim()).filter(Boolean);
  const add = () => {
    const keys = value.conditions.map((c) => c.key);
    const used: string[] = [];
    onChange({ ...value, conditions: [...value.conditions, { key: terminalId(name, keys), name: name.trim(), choices: choices.map((c) => { const key = terminalId(c, used); used.push(key); return { key, name: c }; }) }] });
    setName(""); setStates("");
  };
  return <Stack gap={4}>
    <Title order={4}>Switches and jumpers</Title>
    {value.conditions.map((c) => <Group key={c.key} gap="xs"><Text size="sm">{c.name}: {c.choices.map((x) => x.name).join(" / ")}</Text>
      <Button size="xs" variant="subtle" disabled={value.paths.some((p) => p.switch?.condition_key === c.key)} onClick={() => onChange({ ...value, conditions: value.conditions.filter((x) => x.key !== c.key) })}>Remove</Button></Group>)}
    <Group align="end">
      <TextInput size="xs" label="Switch or jumper" placeholder="e.g. Sync jumper" value={name} onChange={(e) => setName(e.currentTarget.value)} />
      <TextInput size="xs" label="States (comma separated)" placeholder="Fitted, Open" value={states} onChange={(e) => setStates(e.currentTarget.value)} />
      <Button size="xs" variant="default" disabled={!name.trim() || choices.length < 2} onClick={add}>Add switch</Button>
    </Group>
  </Stack>;
}

/** Proposes pads and paths from a frozen KiCad population; the result only fills the new-board editor. */
export function KicadProposal({ definitions, onUse, active = true, principalKey = "", pinned }: { definitions: Definition[]; onUse: (board: Board, name: string) => void; active?: boolean; principalKey?: string; pinned?: { definitionId: string; revisionId: string } | null }) {
  const [definition, setDefinition] = useState<string | null>(null);
  const [ownRevision, setRevision] = useState<string | null>(null);
  const revision = pinned?.revisionId ?? ownRevision;
  const [chosen, setChosen] = useState<string[] | null>(null);
  const identity = useQuery({ queryKey: ["board-population-identity", principalKey, definition], queryFn: () => read<Identity>(`catalog/definitions/${definition}`), enabled: active && !pinned && !!definition });
  useEffect(() => { setChosen(null); }, [pinned?.revisionId]);
  const proposal = useQuery({ queryKey: ["board-proposal", principalKey, revision, chosen], queryFn: () => read<BoardProposal>(proposalPath(revision!, chosen)), enabled: active && !!revision });
  const data = proposal.isError || proposal.isFetching ? null : proposal.data;
  const selected = chosen ?? data?.components.filter((c) => c.selected).map((c) => c.component_id) ?? [];
  const toggle = (id: string, on: boolean) => setChosen(on ? [...selected, id] : selected.filter((x) => x !== id));
  const populations = definitions.filter((d) => d.kind === "pcb_population");
  return <Card withBorder className="sb-board-proposal"><Stack gap="xs">
    <Title order={4}>Propose from a KiCad import</Title>
    <Text size="xs" c="dimmed">Choose which components' pads are the board's pads. Nets and resistor passages become proposed paths; nothing is accepted until you create and review the board.</Text>
    {!pinned && <Group align="end">
      <Select size="xs" label="PCB population" searchable placeholder={populations.length ? "Choose a population" : "No PCB populations"} data={populations.map((d) => ({ value: d.definition_id, label: d.name }))} value={definition} onChange={(v) => { setDefinition(v); setRevision(null); setChosen(null); }} />
      {identity.data && <Select size="xs" label="Population revision" value={revision} data={newestFirst(identity.data.revisions).map((r) => ({ value: r.revision_id, label: revisionOptionLabel(identity.data.name, r.number) }))} onChange={(v) => { setRevision(v); setChosen(null); }} />}
    </Group>}
    {proposal.isError && <Alert color="red">{proposal.error.message}</Alert>}
    {data && <>
      <div className="sb-board-components">{data.components.map((c) => <Checkbox key={c.component_id} size="xs" checked={selected.includes(c.component_id)} onChange={(e) => toggle(c.component_id, e.currentTarget.checked)}
        label={`${c.reference} · ${c.value} · ${c.pad_count} pad${c.pad_count === 1 ? "" : "s"}${c.port_association ? " · port association" : ""}`} />)}</div>
      <Group gap="lg">
        <Stack gap={0}><Text className="sb-silk">Pads</Text><Text size="sm">{data.board.terminals.length}</Text></Stack>
        <Stack gap={0}><Text className="sb-silk">Paths</Text><Text size="sm">{data.board.paths.length}</Text></Stack>
        <Stack gap={0}><Text className="sb-silk">Not mapped</Text><Text size="sm">{data.unmapped_passages.length} passage{data.unmapped_passages.length === 1 ? "" : "s"}</Text></Stack>
        <Stack gap={0}><Text className="sb-silk">Review</Text><SbStatus led="review" dimension="proposal" value="review required" /></Stack>
      </Group>
      {data.board.paths.length > 0 && <div className="sb-board-paths">{data.board.paths.map((p) => <PathChip key={p.local_id} from={labelOf(data.board, p.from_terminal)} to={labelOf(data.board, p.to_terminal)} summary={pathSummary(p, data.board.conditions)} native />)}</div>}
      {data.limitations.map((l) => <Text key={l} size="xs" c="dimmed">{l}</Text>)}
      <Group><Button size="xs" variant="default" disabled={data.board.terminals.length === 0} onClick={() => onUse(data.board, `${data.population_name} board`)}>Use proposal in the new board</Button></Group>
    </>}
  </Stack></Card>;
}

const labelOf = (board: Board, id: string) => board.terminals.find((t) => t.terminal_id === id)?.label ?? id;

function PathChip({ from, to, summary, native, unknown }: { from: string; to: string; summary: string; native?: boolean; unknown?: boolean }) {
  return <span className="sb-path-chip" data-native={native || undefined} data-unknown={unknown || undefined}>
    <span className="sb-path-pad">{from}</span><span className="sb-path-via">{summary}</span><span className="sb-path-pad">{to}</span>
  </span>;
}

/** Discrete facts over the drawing: pads, paths, unknown connections, what it carries, review. */
function BoardCells({ board, carries, extra }: { board: Board; carries: string; extra?: ReactNode }) {
  const connected = new Set(board.paths.flatMap((p) => [p.from_terminal, p.to_terminal]));
  const unknown = board.terminals.filter((t) => !connected.has(t.terminal_id)).length;
  const groups = new Set(board.terminals.map((t) => t.group ?? "Ungrouped")).size;
  const native = board.paths.filter((p) => p.provenance !== "declared").length;
  const parts = board.paths.filter((p) => p.via === "component");
  return <dl className="bv-cells">
    <div className="sb-cell"><dt className="sb-silk">Pads</dt><dd>{board.terminals.length}</dd><p className="bv-sub">{groups} group{groups === 1 ? "" : "s"}</p></div>
    <div className="sb-cell"><dt className="sb-silk">Paths</dt><dd>{board.paths.length}</dd><p className="bv-sub">{native ? `${native} proposed from a native net` : "declared paths only · not continuity"}</p></div>
    <div className={`sb-cell${unknown ? " sb-hatch" : ""}`}><dt className="sb-silk">Connection unknown</dt><dd>{unknown ? `${unknown} pad${unknown === 1 ? "" : "s"}` : "none"}</dd><p className="bv-sub">pads without a declared path</p></div>
    <div className="sb-cell"><dt className="sb-silk">Parts</dt><dd>{parts.length ? parts.map((p) => [p.component?.reference, p.component?.value].filter(Boolean).join(" ") || "part").join(", ") : "none"}</dd><p className="bv-sub">on declared paths</p></div>
    <div className="sb-cell"><dt className="sb-silk">Carries</dt><dd>{carries}</dd></div>
    <div className="sb-cell"><dt className="sb-silk">Review</dt><dd><SbStatus led={board.review === "reviewed" ? "info" : "review"} dimension="board" value={board.review} /></dd></div>
    {extra}
  </dl>;
}

const nextPathId = (board: Board) => {
  const ids = board.paths.map((p) => p.local_id);
  let n = board.paths.length + 1;
  while (ids.includes(`path-${n}`)) n += 1;
  return `path-${n}`;
};

/**
 * Board editor: the drawing first. Click a pad, then another, to declare straight copper between
 * them; select a path to choose how it is joined in the inspector. The table editor stays below
 * as a fallback and for the carried connector's contact landings.
 */
export function BoardEditor({ value, onChange, definitions, permission = "design.edit", title = "Board" }: { value: Board; onChange: (v: Board) => void; definitions: Definition[]; permission?: PermissionName; title?: string }) {
  const gate = usePermission(permission);
  const [armed, setArmed] = useState<string | null>(null);
  const [selection, setSelection] = useState<{ pad: string } | { path: string } | null>(null);
  const layout = useMemo(() => layoutBoard(value), [value]);
  const labels = new Map(value.terminals.map((t) => [t.terminal_id, t.label]));
  const onPad = (id: string) => {
    if (!gate.allowed) { setSelection({ pad: id }); return; }
    if (armed === null) { setArmed(id); setSelection({ pad: id }); return; }
    if (armed === id) { setArmed(null); return; }
    const local_id = nextPathId(value);
    onChange({ ...value, paths: [...value.paths, { local_id, from_terminal: armed, to_terminal: id, via: "copper", component: null, switch: null, provenance: "declared", basis: "" }] });
    setArmed(null); setSelection({ path: local_id });
  };
  const selectedPad = selection && "pad" in selection ? value.terminals.find((t) => t.terminal_id === selection.pad) ?? null : null;
  const selectedPath = selection && "path" in selection ? value.paths.find((p) => p.local_id === selection.path) ?? null : null;
  return <Stack gap="xs">
    <Text size="sm">{value.origin === "kicad_derived" ? "Proposed from a KiCad import: review every pad and path before relying on it." : "Black-box board: pads and paths typed from its drawing or datasheet."}</Text>
    <BoardCells board={value} carries={value.carried_connectors.length ? `${value.carried_connectors.length} connector${value.carried_connectors.length === 1 ? "" : "s"}` : "none declared"} />
    <div className="bv-bench">
      <div className="bv-stage">
        <div className="bv-viewport">{value.terminals.length ? <BoardDrawing layout={layout} board={value} title={title} armedPad={armed} selectedPad={selectedPad?.terminal_id ?? null} selectedPath={selectedPath?.local_id ?? null}
          onPad={onPad} onPath={(id) => { setArmed(null); setSelection({ path: id }); }} /> : <Text size="sm" c="dimmed">No pads declared: add the first pad in the inspector.</Text>}</div>
        {armed ? <div className="bv-armed" role="status">Drawing a path from pad {labels.get(armed)}: click the pad it joins.<Button size="compact-xs" variant="subtle" onClick={() => setArmed(null)}>Cancel</Button></div>
          : gate.allowed && value.terminals.length > 1 ? <div className="bv-hint">Click two pads to join them with copper; select a path to set its part or switch.</div> : null}
      </div>
      <aside className="bv-inspector" aria-label="Board inspector">
        {selectedPath ? <PathInspector key={selectedPath.local_id} path={selectedPath} board={value} onChange={onChange} onDone={() => setSelection(null)} />
          : selectedPad ? <PadInspector key={selectedPad.terminal_id} pad={selectedPad} board={value} onChange={onChange} onDone={() => { setSelection(null); setArmed(null); }} />
          : <BoardDefaults value={value} onChange={onChange} />}
      </aside>
    </div>
    <details className="bv-table-fallback">
      <summary className="sb-silk">Table editor and carried connector</summary>
      <BoardTableEditor value={value} onChange={onChange} definitions={definitions} />
    </details>
  </Stack>;
}

/** Nothing selected: add a pad, declare switch states, set the review. */
export function BoardDefaults({ value, onChange, onlyPads = false }: { value: Board; onChange: (v: Board) => void; onlyPads?: boolean }) {
  const [label, setLabel] = useState("");
  const [group, setGroup] = useState(value.terminals[value.terminals.length - 1]?.group ?? "");
  const groups = [...new Set(value.terminals.map((t) => t.group).filter((g): g is string => !!g))];
  const add = () => {
    onChange({ ...value, terminals: [...value.terminals, { terminal_id: terminalId(label, value.terminals.map((t) => t.terminal_id)), label: label.trim(), group: group.trim() || null, kind: "unknown", side: "unknown", native_pad_ids: [], note: null }] });
    setLabel("");
  };
  return <Stack gap={6}>
    <Text className="sb-silk">Add a pad</Text>
    <Group gap={6} align="end" wrap="nowrap">
      <TextInput size="xs" label="Pad label" placeholder="e.g. CS" value={label} onChange={(e) => setLabel(e.currentTarget.value)} />
      <TextInput size="xs" label="Pad group" placeholder="e.g. Cable side" value={group} onChange={(e) => setGroup(e.currentTarget.value)} list="bv-groups" />
    </Group>
    <datalist id="bv-groups">{groups.map((g) => <option key={g} value={g} />)}</datalist>
    <Button size="compact-xs" variant="default" w="fit-content" disabled={!label.trim()} onClick={add}>Add pad to board</Button>
    {!onlyPads && <><ConditionEditor value={value} onChange={onChange} />
    <Select size="xs" label="Board review" value={value.review} data={["unreviewed", "reviewed"]} onChange={(v) => onChange({ ...value, review: (v ?? "unreviewed") as Board["review"] })} />
    <TextInput size="xs" label="Review basis" value={value.review_basis ?? ""} onChange={(e) => onChange({ ...value, review_basis: e.currentTarget.value || null })} /></>}
  </Stack>;
}

export function PadInspector({ pad, board, onChange, onDone }: { pad: Board["terminals"][number]; board: Board; onChange: (v: Board) => void; onDone: () => void }) {
  const set = (patch: Partial<Board["terminals"][number]>) => onChange({ ...board, terminals: board.terminals.map((t) => (t.terminal_id === pad.terminal_id ? { ...t, ...patch } : t)) });
  const remove = () => {
    onChange({ ...board, terminals: board.terminals.filter((t) => t.terminal_id !== pad.terminal_id), paths: board.paths.filter((p) => p.from_terminal !== pad.terminal_id && p.to_terminal !== pad.terminal_id),
      carried_connectors: board.carried_connectors.map((c) => ({ ...c, correspondence: c.correspondence.filter((x) => x.terminal_id !== pad.terminal_id) })) });
    onDone();
  };
  const joined = board.paths.filter((p) => p.from_terminal === pad.terminal_id || p.to_terminal === pad.terminal_id).length;
  return <Stack gap={6}>
    <Title order={4}>Pad {pad.label}</Title>
    <Text size="xs" c="dimmed">{joined ? `${joined} declared path${joined === 1 ? "" : "s"}` : "No declared path: its connection is unknown."}{pad.note ? ` · ${pad.note}` : ""}</Text>
    <TextInput size="xs" label="Pad label" value={pad.label} onChange={(e) => set({ label: e.currentTarget.value })} />
    <TextInput size="xs" label="Pad group" placeholder="none" value={pad.group ?? ""} onChange={(e) => set({ group: e.currentTarget.value || null })} />
    <Select size="xs" label="Pad kind" value={pad.kind} data={TERMINAL_KINDS.map((k) => ({ value: k, label: KIND_LABELS[k]! }))} onChange={(v) => set({ kind: (v ?? "unknown") as typeof pad.kind })} />
    <Select size="xs" label="Pad side" value={pad.side} data={SIDES.map((x) => ({ value: x, label: x }))} onChange={(v) => set({ side: (v ?? "unknown") as typeof pad.side })} />
    <Button size="compact-xs" variant="subtle" color="red" w="fit-content" onClick={remove}>Remove pad {pad.label}</Button>
  </Stack>;
}

export function PathInspector({ path, board, onChange, onDone }: { path: BoardPath; board: Board; onChange: (v: Board) => void; onDone: () => void }) {
  const label = (id: string) => board.terminals.find((t) => t.terminal_id === id)?.label ?? id;
  const set = (patch: Partial<BoardPath>) => onChange({ ...board, paths: board.paths.map((p) => (p.local_id === path.local_id ? { ...p, ...patch } : p)) });
  const c = path.component;
  const put = (patch: Partial<NonNullable<BoardPath["component"]>>) => set({ component: { ...(c ?? emptyComponent()), ...patch } });
  const condition = path.switch ? board.conditions.find((x) => x.key === path.switch!.condition_key) : undefined;
  return <Stack gap={6}>
    <Title order={4}>{label(path.from_terminal)} to {label(path.to_terminal)}</Title>
    <Text size="xs" c="dimmed">{pathSummary(path, board.conditions)}{path.provenance !== "declared" ? " · proposed from a native net, review it" : ""}</Text>
    <Select size="xs" label="Path kind" value={path.via} disabled={path.provenance !== "declared"} data={VIAS.map((v) => ({ value: v, label: VIA_LABELS[v]! }))}
      onChange={(v) => { const via = (v ?? "unknown") as BoardPath["via"]; set({ via, component: via === "component" ? path.component ?? emptyComponent() : null, switch: via === "switch" ? path.switch ?? { condition_key: board.conditions[0]?.key ?? "", closed_when: board.conditions[0]?.choices[0]?.key ?? "" } : null }); }} />
    {path.via === "component" && c && <>
      <Select size="xs" label="Part kind" value={c.kind} data={COMPONENT_KINDS.map((k) => ({ value: k, label: k }))} onChange={(v) => { const kind = (v ?? "unknown") as typeof c.kind; put({ kind, resistance_ohm: kind === "resistor" ? c.resistance_ohm : null, capacitance_f: kind === "capacitor" ? c.capacitance_f : null }); }} />
      <Group gap={6} grow><TextInput size="xs" label="Reference" placeholder="R1" value={c.reference ?? ""} onChange={(e) => put({ reference: e.currentTarget.value || null })} />
        <TextInput size="xs" label="Written value" placeholder="470R" value={c.value ?? ""} onChange={(e) => put({ value: e.currentTarget.value || null })} /></Group>
      {c.kind === "resistor" && <TextInput size="xs" label="Resistance in ohm (blank = unknown)" placeholder="unknown" value={c.resistance_ohm ?? ""} onChange={(e) => put({ resistance_ohm: e.currentTarget.value.trim() || null })} />}
      {c.kind === "capacitor" && <TextInput size="xs" label="Capacitance in farad (blank = unknown)" placeholder="unknown" value={c.capacitance_f ?? ""} onChange={(e) => put({ capacitance_f: e.currentTarget.value.trim() || null })} />}
    </>}
    {path.via === "switch" && path.switch && (board.conditions.length === 0 ? <Text size="xs" c="dimmed">Declare a switch or jumper first (clear the selection to see the switch form).</Text> : <>
      <Select size="xs" label="Switch" value={path.switch.condition_key || null} data={board.conditions.map((x) => ({ value: x.key, label: x.name }))} onChange={(v) => set({ switch: { condition_key: v ?? "", closed_when: board.conditions.find((x) => x.key === v)?.choices[0]?.key ?? "" } })} />
      <Select size="xs" label="Closed in state" value={path.switch.closed_when || null} data={(condition?.choices ?? []).map((x) => ({ value: x.key, label: `closed in ${x.name}` }))} onChange={(v) => set({ switch: { ...path.switch!, closed_when: v ?? "" } })} />
    </>)}
    {path.via === "unknown" && <SbUnknown what="Path" />}
    <TextInput size="xs" label="Path basis" placeholder="Required" value={path.basis} onChange={(e) => set({ basis: e.currentTarget.value })} />
    <Button size="compact-xs" variant="subtle" color="red" w="fit-content" onClick={() => { onChange({ ...board, paths: board.paths.filter((p) => p.local_id !== path.local_id) }); onDone(); }}>Delete path</Button>
  </Stack>;
}

/** A frozen board drawn, with pads' landings, declared paths and an on-demand "Follow a path". */
export function BoardInspector({ revisionId }: { revisionId: string }) {
  const inspection = useQuery({ queryKey: ["board-inspect", revisionId], queryFn: () => read<BoardInspection>(`interfaces/revisions/${revisionId}`) });
  const view = inspection.data?.board;
  const board = inspection.data?.interface;
  const [from, setFrom] = useState<string | null>(null);
  const [to, setTo] = useState<string | null>(null);
  const [states, setStates] = useState<Record<string, string>>({});
  const [result, setResult] = useState<BoardTrace | null>(null);
  const [traceKey, setTraceKey] = useState(0);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const connectorName = view?.connectors[0]?.body_name;
  const layout = useMemo(() => (board ? layoutBoard(board, connectorName) : null), [board, connectorName]);
  const traced = result && board ? tracedPathIds(board.paths, result.paths.map((p) => p.terminal_ids)) : null;
  const clear = () => { setResult(null); setSelectedPath(null); };
  const onPad = (id: string) => {
    clear();
    if (!from || (from && to)) { setFrom(id); setTo(null); } else if (id !== from) setTo(id);
  };
  const onPath = (id: string) => {
    const p = board?.paths.find((x) => x.local_id === id);
    if (!p) return;
    setResult(null); setSelectedPath(id); setFrom(p.from_terminal); setTo(p.to_terminal);
  };
  return <Card withBorder><Stack gap="xs"><Title order={3}>Frozen board</Title>
    {inspection.isError && <Alert color="red">{inspection.error.message}</Alert>}
    {view && board && layout && <>
      <BoardCells board={board} carries={view.connectors.map((c) => c.body_name).join(", ") || "No connector declared"}
        extra={<><div className="sb-cell"><dt className="sb-silk">Origin</dt><dd>{view.origin === "kicad_derived" ? "From a KiCad import" : "Black box"}</dd></div>
          <div className="sb-cell"><dt className="sb-silk">Continuity</dt><dd><SbStatus led="not-evaluated" dimension="continuity" value="not evaluated" /></dd></div></>} />
      <div className="bv-bench">
        <div className="bv-stage">
          <div className="bv-viewport"><BoardDrawing layout={layout} board={board} title={inspection.data!.revision_id ? "Board" : "Board"} litPads={new Set([from, to].filter((x): x is string => !!x))}
            selectedPath={selectedPath} traced={traced} traceKey={traceKey} states={states} onPad={onPad} onPath={onPath} /></div>
          <div className="bv-hint">Click a path, or two pads, then Follow. Declared paths only: this is not measured continuity.</div>
        </div>
        <aside className="bv-inspector" aria-label="Board inspector">
          <TraceForm revisionId={revisionId} board={board} from={from} to={to} setFrom={(v) => { clear(); setFrom(v); }} setTo={(v) => { clear(); setTo(v); }}
            states={states} setStates={(s) => { setResult(null); setStates(s); }} result={result} onResult={(r) => { setResult(r); setTraceKey((k) => k + 1); }} />
        </aside>
      </div>
      <details className="bv-table-fallback">
        <summary className="sb-silk">Pads and paths table</summary>
        <Table.ScrollContainer minWidth={640}><Table withTableBorder verticalSpacing={4} className="sb-board-table">
          <Table.Thead><Table.Tr><Table.Th>Pad</Table.Th><Table.Th>Group</Table.Th><Table.Th>Kind</Table.Th><Table.Th>Lands on</Table.Th><Table.Th>Paths</Table.Th></Table.Tr></Table.Thead>
          <Table.Tbody>{view.terminals.map((t) => <Table.Tr key={t.terminal_id}>
            <Table.Td className="sb-board-label">{t.label}</Table.Td>
            <Table.Td>{t.group ?? "none"}</Table.Td>
            <Table.Td>{t.kind === "unknown" ? <SbUnknown what="Kind" /> : KIND_LABELS[t.kind]}</Table.Td>
            <Table.Td>{t.landings.length ? t.landings.map((l) => <Group key={`${l.connector_id}:${l.contact_id}`} gap={6} wrap="nowrap"><Text size="sm">{l.body_name} contact {l.number ?? l.contact_id}</Text>{l.status === "unknown" && <SbStatus led="review" dimension="landing" value="unreviewed, unknown" />}</Group>) : "none declared"}</Table.Td>
            <Table.Td>{t.connection === "declared" ? `${t.path_ids.length} declared` : <SbUnknown what="Connection" />}</Table.Td>
          </Table.Tr>)}</Table.Tbody>
        </Table></Table.ScrollContainer>
        {view.paths.length === 0 ? <SbUnknown what="Every path" /> : <div className="sb-board-paths">{view.paths.map((p) => <PathChip key={p.local_id} from={p.from_label} to={p.to_label} summary={p.summary} native={p.provenance !== "declared"} unknown={p.via === "unknown"} />)}</div>}
      </details>
      <Text size="xs" c="dimmed"><RevisionLabel id={revisionId} /></Text>
    </>}
  </Stack></Card>;
}

export function TraceForm({ revisionId, board, from, to, setFrom, setTo, states, setStates, result, onResult, active = true }: {
  active?: boolean;
  revisionId: string; board: Board; from: string | null; to: string | null; setFrom: (v: string | null) => void; setTo: (v: string | null) => void;
  states: Record<string, string>; setStates: (s: Record<string, string>) => void; result: BoardTrace | null; onResult: (r: BoardTrace | null) => void;
}) {
  const [query, setQuery] = useState("dc_continuity");
  const [ideal, setIdeal] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const epoch = useRef(0); const enabled = useRef(active); enabled.current = active;
  const intent = JSON.stringify([revisionId, from, to, states, query, ideal]);
  useEffect(() => { epoch.current += 1; return () => { epoch.current += 1; }; }, [intent, active]);
  const options = board.terminals.map((t) => ({ value: t.terminal_id, label: t.group ? `${t.label} · ${t.group}` : t.label }));
  const run = async () => {
    if (!enabled.current || !from || !to || from === to) return; const token = epoch.current;
    const params = new URLSearchParams({ from_terminal_id: from!, to_terminal_id: to!, query, copper_assumption: ideal ? "ideal_zero_resistance" : "unspecified" });
    for (const [key, state] of Object.entries(states)) params.append("condition", `${key}=${state}`);
    setError(null);
    try { const next = await read<BoardTrace>(`interfaces/revisions/${revisionId}/board-trace?${params.toString()}`); if (enabled.current && token === epoch.current) onResult(next); }
    catch (reason) { if (enabled.current && token === epoch.current) { onResult(null); setError(reason instanceof Error ? reason.message : String(reason)); } }
  };
  return <Stack gap={6}>
    <Title order={4}>Follow a path</Title>
    <Select size="xs" label="From pad" searchable value={from} data={options} onChange={setFrom} />
    <Select size="xs" label="To pad" searchable value={to} data={options} onChange={setTo} />
    <Select size="xs" label="Question" value={query} data={QUERIES} onChange={(v) => { setQuery(v ?? "dc_continuity"); onResult(null); }} />
    {board.conditions.map((c) => <Select key={c.key} size="xs" label={c.name} clearable placeholder="Not selected (unknown)" value={states[c.key] ?? null} data={c.choices.map((x) => ({ value: x.key, label: x.name }))}
      onChange={(v) => { const next = { ...states }; if (v) next[c.key] = v; else delete next[c.key]; setStates(next); }} />)}
    <Checkbox size="xs" label="Assume ideal copper" checked={ideal} onChange={(e) => setIdeal(e.currentTarget.checked)} />
    <Button size="xs" variant="default" w="fit-content" disabled={!from || !to || from === to} onClick={() => void run()}>Follow</Button>
    {error && <Alert color="red">{error}</Alert>}
    {result && <Stack gap={2} role="status" aria-label="Path result">
      {result.status === "unknown" ? <SbUnknown what="Result" /> : <SbStatus led={result.status === "modeled_blocked" ? "failed" : "info"} dimension="declared model" value={TRACE_WORDS[result.status] ?? result.status} />}
      {result.series_resistance_ohm !== null && <Text size="sm">Series resistance {result.series_resistance_ohm} ohm (declared values)</Text>}
      <Text size="xs" c="dimmed">{result.reason.replaceAll("_", " ")}</Text>
      {result.paths.map((p, i) => <Text key={i} size="xs" className="sb-mono">{p.terminal_labels.join(" → ")}</Text>)}
    </Stack>}
  </Stack>;
}
