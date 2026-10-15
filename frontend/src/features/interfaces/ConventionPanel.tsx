import { Alert, Button, Card, Group, Select, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { SbUnknown } from "../../components/sb";
import { InspectionScope, ReadOnlyNote, usePermission } from "../../lib/permissions";
import { RevisionLabel } from "../../lib/IdentityLabel";
import { revisionOptionLabel } from "../../lib/revision-labels";
import { definitionIn, referenceFromProject, useOpenNewest, useOpenProbed } from "../scope/openProbed";
import { ContinueDraftButton } from "../scope/ContinueDraftButton";
import { loadFrozenStock } from "../wire-stock/viewer-api";
import { CONDUCTIVE_KINDS, SIGNAL_TYPES, SIGNAL_TYPE_LABELS, USE_LABELS, command, initialInterface, read, useText, type ConductiveKind, type Convention, type ConventionRule, type ConventionUse, type ConventionUseKind, type ConventionView, type Definition, type Draft, type Identity, type Inspection, type SignalSet, type SignalType } from "./api";
import { SignalTypeChip } from "./SignalSetPanel";
import "./signals.css";

const RETURN_TYPES: SignalType[] = ["ground_return", "shield", "chassis"];
const PREFERENCES = [{ value: "preferred", label: "Preferred" }, { value: "allowed", label: "Allowed" }, { value: "avoid", label: "Avoid" }];
const USE_DATA = (Object.keys(USE_LABELS) as ConventionUseKind[]).map((value) => ({ value, label: USE_LABELS[value] }));
const KIND_LABELS: Record<ConductiveKind, string> = { conductor: "Conductor", shield: "Screen", drain: "Drain" };

/** One conductive stock element: its readable label chain below the stock root, and its kind. */
export type StockElementChoice = { path: string; label: string; kind: ConductiveKind };
type Node = { id: string; label: string; kind: string; children?: Node[] };

/** Conductors, screens and drains of a stock construction, in tree order, labeled for people. */
export function conductiveElements(root: Node): StockElementChoice[] {
  const found: StockElementChoice[] = [];
  const visit = (node: Node, path: string, labels: string[]) => {
    const chain = [...labels, node.label];
    if (node.kind === "group") node.children?.forEach((child) => visit(child, `${path}.${child.id}`, chain));
    else if ((CONDUCTIVE_KINDS as string[]).includes(node.kind)) found.push({ path, label: chain.slice(1).join(" / ") || node.label, kind: node.kind as ConductiveKind });
  };
  visit(root, root.id, []);
  return found;
}

const blankUse = (kind: ConventionUseKind): ConventionUse => ({ kind, signal_key: null, signal_type: kind === "signal_type" ? "analog_video" : null });

/** Conventions lens: what a shop usually uses each conductor of a stock for. A preference, never a pass. */
export function ConventionPanel({ projectId }: { projectId: string | null }) {
  return <Conventions key={projectId ?? "library"} projectId={projectId} />;
}

function Conventions({ projectId }: { projectId: string | null }) {
  const cache = useQueryClient();
  const createGate = usePermission("item.create");
  const freezeGate = usePermission("design.freeze");
  const [name, setName] = useState("");
  const [value, setValue] = useState<Convention>(() => initialInterface("conductor_convention") as Convention);
  const [definitionId, setDefinitionId] = useState<string | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [revisionId, setRevisionId] = useState<string | null>(null);
  const definitions = useQuery({ queryKey: ["convention-definitions", projectId], queryFn: () => read<Definition[]>("workspace/definitions") });
  const identity = useQuery({ queryKey: ["convention-identity", definitionId], queryFn: () => read<Identity>(`catalog/definitions/${definitionId}`), enabled: !!definitionId });
  const draft = useQuery({ queryKey: ["convention-draft", draftId], queryFn: () => read<Draft>(`interfaces/drafts/${draftId}`), enabled: !!draftId });
  const pick = (id: string | null) => { setDefinitionId(id); setDraftId(null); setRevisionId(null); };
  const openNewest = useOpenNewest(identity.data, setDraftId, setRevisionId);
  useOpenProbed(definitionIn(definitions.data, ["conductor_convention"]), (id) => { pick(id); openNewest(id); });
  const create = useMutation({ mutationFn: () => command<Draft>("interface.create", { name, interface: value }), onSuccess: async (data) => {
    setDefinitionId(data.definition_id); setDraftId(data.draft_id); setRevisionId(null);
    await referenceFromProject(projectId, data.definition_id, "conductor_convention");
    await cache.invalidateQueries({ queryKey: ["convention-definitions", projectId] });
  } });
  const freeze = useMutation({ mutationFn: () => command<{ revision_id: string }>("interface.freeze", { draft_id: draftId }, draft.data?.state), onSuccess: async (data) => {
    setRevisionId(data.revision_id);
    await cache.invalidateQueries({ queryKey: ["convention-draft", draftId] });
    await cache.invalidateQueries({ queryKey: ["convention-identity", definitionId] });
  } });
  const conventions = (definitions.data ?? []).filter((d) => d.kind === "conductor_convention");
  return <Stack>
    <Title order={2}>Conventions</Title>
    <Text size="sm">A convention records what a shop usually uses each conductor of a stock for. It ranks proposals and flags a later deviation; it never makes a check pass, and a conductor it does not mention stays unknown.</Text>
    {definitions.isError && <Alert color="red">{definitions.error.message}</Alert>}
    <Group align="end">
      <Select label="Convention" searchable placeholder={conventions.length ? "Choose a convention" : "No conventions yet"} data={conventions.map((d) => ({ value: d.definition_id, label: d.name }))} value={definitionId} onChange={pick} />
      {identity.data && <ContinueDraftButton drafts={identity.data.drafts} revisionId={revisionId} draftId={draftId} onOpen={setDraftId} />}
      {identity.data && <Select label="Frozen revision" value={revisionId} onChange={setRevisionId} data={identity.data.revisions.map((r) => ({ value: r.revision_id, label: revisionOptionLabel(identity.data.name, r.number) }))} />}
      {identity.data && identity.data.drafts.length > 0 && <Select label="Draft" value={draftId} onChange={setDraftId} data={identity.data.drafts.map((d, i) => ({ value: d.draft_id, label: `Draft ${i + 1}` }))} />}
    </Group>
    {identity.isError && <Alert color="red">{identity.error.message}</Alert>}
    {revisionId && <ConventionInspector key={revisionId} revisionId={revisionId} />}
    {draft.isError && <Alert color="red">{draft.error.message}</Alert>}
    {draft.data && <><ConventionDraft key={`${draft.data.draft_id}:${draft.data.state}`} draft={draft.data} definitions={definitions.data ?? []} onSaved={async () => { await cache.invalidateQueries({ queryKey: ["convention-draft", draftId] }); }} />
      <Group><Button loading={freeze.isPending} onClick={() => freeze.mutate()} {...freezeGate.props}>Freeze convention</Button><ReadOnlyNote permission="design.freeze">Freezing conventions is unavailable.</ReadOnlyNote></Group></>}
    {freeze.isError && <Alert color="red">{freeze.error.message}</Alert>}
    <Card withBorder><Stack gap="xs">
      <Title order={3}>New convention</Title>
      <InspectionScope permission="item.create">
        <TextInput label="Convention name" value={name} onChange={(e) => setName(e.currentTarget.value)} />
        <ConventionEditor value={value} onChange={setValue} definitions={definitions.data ?? []} />
      </InspectionScope>
      <Group><Button disabled={!name.trim() || !value.signal_set_revision_id || (value.scope === "stock" && !value.stock_revision_id)} loading={create.isPending} onClick={() => create.mutate()} {...createGate.props}>Create convention draft</Button><ReadOnlyNote permission="item.create">Creating conventions is unavailable.</ReadOnlyNote></Group>
      {create.isError && <Alert color="red">{create.error.message}</Alert>}
    </Stack></Card>
  </Stack>;
}

function ConventionDraft({ draft, definitions, onSaved }: { draft: Draft; definitions: Definition[]; onSaved: () => Promise<void> }) {
  const editGate = usePermission("design.edit");
  const [value, setValue] = useState<Convention>(() => (draft.content.interface as Convention | undefined) ?? (initialInterface("conductor_convention") as Convention));
  const save = useMutation({ mutationFn: () => command("interface.update", { draft_id: draft.draft_id, interface: value }, draft.state), onSuccess: onSaved });
  return <Card withBorder><Stack gap="xs"><Title order={3}>Edit convention draft</Title>
    <InspectionScope permission="design.edit"><ConventionEditor value={value} onChange={setValue} definitions={definitions} /></InspectionScope>
    <Group><Button loading={save.isPending} onClick={() => save.mutate()} {...editGate.props}>Save convention draft</Button><ReadOnlyNote permission="design.edit">Saving conventions is unavailable.</ReadOnlyNote></Group>
    {save.isError && <Alert color="red">{save.error.message}</Alert>}
  </Stack></Card>;
}

/** Pick one frozen revision of a definition of one kind: definition first, then its revision. */
function RevisionPicker({ label, kind, definitions, value, onChange }: { label: string; kind: string; definitions: Definition[]; value: string | null; onChange: (revisionId: string) => void }) {
  const [definitionId, setDefinitionId] = useState<string | null>(null);
  const identity = useQuery({ queryKey: ["convention-pick", definitionId], queryFn: () => read<Identity>(`catalog/definitions/${definitionId}`), enabled: !!definitionId });
  return <Group align="end">
    <Select label={label} searchable placeholder={`Choose ${label.toLowerCase()}`} value={definitionId} data={definitions.filter((d) => d.kind === kind).map((d) => ({ value: d.definition_id, label: d.name }))} onChange={setDefinitionId} />
    {identity.data && <Select label={`${label} revision`} value={value} data={identity.data.revisions.map((r) => ({ value: r.revision_id, label: revisionOptionLabel(identity.data.name, r.number) }))} onChange={(v) => v && onChange(v)} />}
    {value && <Text size="xs"><RevisionLabel id={value} role={label} /></Text>}
  </Group>;
}

/** The use cells of one rule: what the conductor carries, which signal or type, preference and basis. */
function UseCells({ who, use, signals, onUse, preference, onPreference, basis, onBasis, clearable }: {
  who: string; use: ConventionUse | null; signals: SignalSet["signals"]; onUse: (use: ConventionUse | null) => void;
  preference: ConventionRule["preference"]; onPreference: (p: ConventionRule["preference"]) => void; basis: string | null; onBasis: (b: string | null) => void; clearable: boolean;
}) {
  const choices = (use?.kind === "return_of" ? signals.filter((s) => !RETURN_TYPES.includes(s.type)) : signals).map((s) => ({ value: s.key, label: s.name }));
  return <>
    <Table.Td><Select size="xs" aria-label={`Use of ${who}`} clearable={clearable} placeholder="Not stated (unknown)" value={use?.kind ?? null} data={USE_DATA} onChange={(kind) => onUse(kind ? blankUse(kind as ConventionUseKind) : null)} /></Table.Td>
    <Table.Td>{use && (use.kind === "signal" || use.kind === "return_of")
      ? <Select size="xs" searchable aria-label={`Signal for ${who}`} placeholder="Choose a signal" value={use.signal_key} data={choices} onChange={(key) => onUse({ ...use, signal_key: key })} />
      : use?.kind === "signal_type"
        ? <Select size="xs" aria-label={`Signal type for ${who}`} value={use.signal_type} data={SIGNAL_TYPES.filter((t) => t !== "unknown").map((t) => ({ value: t, label: SIGNAL_TYPE_LABELS[t] }))} onChange={(t) => onUse({ ...use, signal_type: (t ?? "analog_video") as SignalType })} />
        : use ? <Text size="xs" c="dimmed">No signal</Text> : <SbUnknown what="Use" />}</Table.Td>
    <Table.Td><Select size="xs" aria-label={`Preference for ${who}`} disabled={!use} value={preference} data={PREFERENCES} onChange={(p) => onPreference((p ?? "preferred") as ConventionRule["preference"])} /></Table.Td>
    <Table.Td><TextInput size="xs" aria-label={`Basis for ${who}`} disabled={!use} placeholder="Why the shop does this" value={basis ?? ""} onChange={(e) => onBasis(e.currentTarget.value || null)} /></Table.Td>
  </>;
}

/** Convention editor: scope, exact signal set and stock, then one dense row per conductor. */
export function ConventionEditor({ value, onChange, definitions }: { value: Convention; onChange: (v: Convention) => void; definitions: Definition[] }) {
  const signalSet = useQuery({ queryKey: ["interface-inspect", value.signal_set_revision_id], queryFn: () => read<Inspection>(`interfaces/revisions/${value.signal_set_revision_id}`), enabled: !!value.signal_set_revision_id });
  const stock = useQuery({ queryKey: ["convention-stock", value.stock_revision_id], queryFn: () => loadFrozenStock(value.stock_revision_id!), enabled: !!value.stock_revision_id });
  const [color, setColor] = useState("");
  const [hex, setHex] = useState("");
  const [colorKind, setColorKind] = useState<ConductiveKind | null>(null);
  const signals = signalSet.data?.interface.kind === "signal_set" ? signalSet.data.interface.signals : [];
  const elements = stock.data ? conductiveElements(stock.data.structure as unknown as Node) : [];
  const ruleAt = (index: number, patch: Partial<ConventionRule>) => onChange({ ...value, rules: value.rules.map((r, i) => i === index ? { ...r, ...patch } : r) });
  const stockRule = (path: string) => value.rules.findIndex((r) => r.element_path === path);
  const setStockUse = (el: StockElementChoice, use: ConventionUse | null) => {
    const index = stockRule(el.path);
    if (use === null) { if (index >= 0) onChange({ ...value, rules: value.rules.filter((_, i) => i !== index) }); return; }
    if (index >= 0) ruleAt(index, { use });
    else onChange({ ...value, rules: [...value.rules, { element_path: el.path, color: null, color_hex: null, element_kind: null, use, preference: "preferred", basis: null }] });
  };
  const hexValid = hex === "" || /^#[0-9a-fA-F]{6}$/.test(hex);
  const heads = <><Table.Th>Use</Table.Th><Table.Th>Signal</Table.Th><Table.Th>Preference</Table.Th><Table.Th>Basis</Table.Th></>;
  return <Stack gap="xs">
    <Group align="end">
      <Select label="Convention scope" value={value.scope} data={[{ value: "stock", label: "One exact wire stock" }, { value: "color_code", label: "General color code" }]} onChange={(scope) => onChange({ ...value, scope: (scope ?? "stock") as Convention["scope"], stock_revision_id: null, rules: [] })} />
      <TextInput label="Description" value={value.description ?? ""} onChange={(e) => onChange({ ...value, description: e.currentTarget.value || null })} />
    </Group>
    <RevisionPicker label="Signal set" kind="signal_set" definitions={definitions} value={value.signal_set_revision_id || null} onChange={(id) => onChange({ ...value, signal_set_revision_id: id, rules: value.rules.map((r) => ({ ...r, use: { ...r.use, signal_key: null } })) })} />
    {value.scope === "stock" && <RevisionPicker label="Wire stock" kind="wire_stock" definitions={definitions} value={value.stock_revision_id} onChange={(id) => onChange({ ...value, stock_revision_id: id, rules: [] })} />}
    {stock.isError && <Alert color="red">{stock.error.message}</Alert>}
    {value.scope === "stock" && stock.data && <Table.ScrollContainer minWidth={900}><Table withTableBorder verticalSpacing={4} className="sb-signal-table">
      <Table.Thead><Table.Tr><Table.Th>Conductor</Table.Th><Table.Th>Kind</Table.Th>{heads}</Table.Tr></Table.Thead>
      <Table.Tbody>{elements.map((el) => {
        const index = stockRule(el.path);
        const rule = index >= 0 ? value.rules[index]! : null;
        return <Table.Tr key={el.path}>
          <Table.Td><Text size="sm">{el.label}</Text><Text className="sb-mono" size="xs" c="dimmed">{el.path}</Text></Table.Td>
          <Table.Td>{KIND_LABELS[el.kind]}</Table.Td>
          <UseCells who={el.label} clearable use={rule?.use ?? null} signals={signals} onUse={(use) => setStockUse(el, use)} preference={rule?.preference ?? "preferred"} onPreference={(preference) => index >= 0 && ruleAt(index, { preference })} basis={rule?.basis ?? null} onBasis={(basis) => index >= 0 && ruleAt(index, { basis })} />
        </Table.Tr>;
      })}</Table.Tbody>
    </Table></Table.ScrollContainer>}
    {value.scope === "color_code" && <>
      <Table.ScrollContainer minWidth={900}><Table withTableBorder verticalSpacing={4} className="sb-signal-table">
        <Table.Thead><Table.Tr><Table.Th>Color</Table.Th><Table.Th>Kind</Table.Th>{heads}<Table.Th /></Table.Tr></Table.Thead>
        <Table.Tbody>{value.rules.map((rule, i) => {
          const who = `${rule.color ?? "color"}${rule.element_kind ? ` ${KIND_LABELS[rule.element_kind].toLowerCase()}` : ""}`;
          return <Table.Tr key={`${rule.color}:${rule.element_kind}:${i}`}>
            <Table.Td><Text size="sm">{rule.color}</Text>{rule.color_hex ? <Text className="sb-mono" size="xs" c="dimmed">{rule.color_hex}</Text> : <Text size="xs" c="dimmed">No exact display color</Text>}</Table.Td>
            <Table.Td>{rule.element_kind ? KIND_LABELS[rule.element_kind] : "Any"}</Table.Td>
            <UseCells who={who} clearable={false} use={rule.use} signals={signals} onUse={(use) => use && ruleAt(i, { use })} preference={rule.preference} onPreference={(preference) => ruleAt(i, { preference })} basis={rule.basis} onBasis={(basis) => ruleAt(i, { basis })} />
            <Table.Td><Button size="xs" variant="subtle" aria-label={`Remove ${who}`} onClick={() => onChange({ ...value, rules: value.rules.filter((_, j) => j !== i) })}>Remove</Button></Table.Td>
          </Table.Tr>;
        })}</Table.Tbody>
      </Table></Table.ScrollContainer>
      <Group align="end">
        <TextInput label="Color name" value={color} onChange={(e) => setColor(e.currentTarget.value)} />
        <TextInput label="Exact display color" description="#RRGGBB; a stock matches only this exact color" error={hexValid ? undefined : "Use #RRGGBB"} value={hex} onChange={(e) => setHex(e.currentTarget.value)} />
        <Select label="Applies to" clearable placeholder="Any" value={colorKind} data={CONDUCTIVE_KINDS.map((k) => ({ value: k, label: KIND_LABELS[k] }))} onChange={(k) => setColorKind(k as ConductiveKind | null)} />
        <Button disabled={!color.trim() || !hexValid || value.rules.some((r) => r.color?.trim().toLowerCase() === color.trim().toLowerCase() && r.element_kind === colorKind)} onClick={() => { onChange({ ...value, rules: [...value.rules, { element_path: null, color: color.trim(), color_hex: hex || null, element_kind: colorKind, use: blankUse("spare"), preference: "preferred", basis: null }] }); setColor(""); setHex(""); }}>Add color rule</Button>
      </Group>
    </>}
    <Group><Select label="Convention review" value={value.review} data={["unreviewed", "reviewed"]} onChange={(v) => onChange({ ...value, review: (v ?? "unreviewed") as Convention["review"] })} /><TextInput label="Review basis" value={value.review_basis ?? ""} onChange={(e) => onChange({ ...value, review_basis: e.currentTarget.value || null })} /></Group>
  </Stack>;
}

/** Rows of a resolved convention: the element or color, what it carries and how strongly. */
export function ConventionRows({ view }: { view: ConventionView }) {
  return <Table.ScrollContainer minWidth={640}><Table withTableBorder verticalSpacing={4} className="sb-signal-table">
    <Table.Thead><Table.Tr><Table.Th>{view.scope === "stock" ? "Conductor" : "Color"}</Table.Th><Table.Th>Kind</Table.Th><Table.Th>Usually used for</Table.Th><Table.Th>Preference</Table.Th><Table.Th>Basis</Table.Th></Table.Tr></Table.Thead>
    <Table.Tbody>{view.rows.map((row) => <Table.Tr key={row.element_path ?? `${row.color}:${row.element_kind}`}>
      <Table.Td className="sb-signal-name">{row.element_label ?? row.color}{row.color_hex && <Text className="sb-mono" size="xs" c="dimmed">{row.color_hex}</Text>}{row.element_path && <Text className="sb-mono" size="xs" c="dimmed">{row.element_path}</Text>}</Table.Td>
      <Table.Td>{row.element_kind ? KIND_LABELS[row.element_kind] : "Any"}</Table.Td>
      <Table.Td><Group gap={6} wrap="nowrap"><Text size="sm">{useText(row.use)}</Text>{row.use.signal && row.use.kind === "signal" && <SignalTypeChip type={row.use.signal.type} />}</Group></Table.Td>
      <Table.Td>{PREFERENCES.find((p) => p.value === row.preference)?.label}</Table.Td>
      <Table.Td>{row.basis ?? <SbUnknown what="Basis" />}</Table.Td>
    </Table.Tr>)}
    {view.unmapped.map((row) => <Table.Tr key={row.element_path}>
      <Table.Td className="sb-signal-name">{row.element_label}<Text className="sb-mono" size="xs" c="dimmed">{row.element_path}</Text></Table.Td>
      <Table.Td>{KIND_LABELS[row.element_kind]}</Table.Td>
      <Table.Td><SbUnknown what="Use" /></Table.Td><Table.Td>—</Table.Td><Table.Td>—</Table.Td>
    </Table.Tr>)}</Table.Tbody>
  </Table></Table.ScrollContainer>;
}

/** A frozen convention: scope, exact pins and one row per conductor; unmapped conductors read unknown. */
export function ConventionInspector({ revisionId }: { revisionId: string }) {
  const inspected = useQuery({ queryKey: ["interface-inspect", revisionId], queryFn: () => read<Inspection>(`interfaces/revisions/${revisionId}`) });
  const view = inspected.data?.convention;
  const value = inspected.data?.interface.kind === "conductor_convention" ? inspected.data.interface : null;
  return <Card withBorder><Stack gap="xs"><Title order={3}>Frozen convention</Title><Text size="sm"><RevisionLabel id={revisionId} /></Text>
    {inspected.isError && <Alert color="red">{inspected.error.message}</Alert>}
    {view && <>
      <Group gap="lg">
        <Stack gap={0}><Text className="sb-silk">Scope</Text><Text size="sm">{view.scope === "stock" ? "One exact wire stock" : "General color code"}</Text></Stack>
        <Stack gap={0}><Text className="sb-silk">Wire stock</Text><Text size="sm">{view.stock ? `${view.stock.name} · revision ${view.stock.number}` : "Any (matched by exact color)"}</Text></Stack>
        <Stack gap={0}><Text className="sb-silk">Signals</Text><Text size="sm">{view.signal_set.name} · revision {view.signal_set.number}</Text></Stack>
        <Stack gap={0}><Text className="sb-silk">Review</Text><Text size="sm">{value?.review ?? "unreviewed"}</Text></Stack>
        <Stack gap={0}><Text className="sb-silk">Effect</Text><Text size="sm">Preference only</Text></Stack>
      </Group>
      <ConventionRows view={view} />
      <Text size="xs" c="dimmed">{view.effect_note}</Text>
    </>}
  </Stack></Card>;
}
