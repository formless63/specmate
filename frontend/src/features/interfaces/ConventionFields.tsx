import { RevisionPicker } from "../cables/RevisionPicker";
import { Alert, Button, Card, Group, Select, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { SbUnknown } from "../../components/sb";
import { RevisionLabel } from "../../lib/IdentityLabel";
import { loadFrozenStock } from "../wire-stock/viewer-api";
import { CONDUCTIVE_KINDS, SIGNAL_TYPES, SIGNAL_TYPE_LABELS, USE_LABELS, read, useText, type ConductiveKind, type Convention, type ConventionRule, type ConventionUse, type ConventionUseKind, type ConventionView, type Definition, type Inspection, type SignalSet, type SignalType } from "./api";
import { SignalTypeChip } from "./SignalSetFields";
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
export function ConventionEditor({ value, onChange, definitions }: { value: Convention; onChange: (v: Convention) => void; definitions?: Definition[] }) {
  const signalSet = useQuery({ queryKey: ["interface-inspect", value.signal_set_revision_id], queryFn: () => read<Inspection>(`interfaces/revisions/${value.signal_set_revision_id}`), enabled: !!value.signal_set_revision_id });
  const stock = useQuery({ queryKey: ["convention-stock", value.stock_revision_id], queryFn: () => loadFrozenStock(value.stock_revision_id!), enabled: !!value.stock_revision_id });
  const [color, setColor] = useState("");
  const [hex, setHex] = useState("");
  const [colorKind, setColorKind] = useState<ConductiveKind | null>(null);
  const signals = !signalSet.isError && !signalSet.isFetching && signalSet.data?.interface.kind === "signal_set" ? signalSet.data.interface.signals : [];
  const elements = !stock.isError && !stock.isFetching && stock.data ? conductiveElements(stock.data.structure as unknown as Node) : [];
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
    <RevisionPicker label="Signal set" kind="signal_set" definitions={definitions} value={value.signal_set_revision_id || ""} onChange={(id) => onChange({ ...value, signal_set_revision_id: id, rules: value.rules.map((r) => ({ ...r, use: { ...r.use, signal_key: null } })) })} />
    {value.scope === "stock" && <RevisionPicker label="Wire stock" kind="wire_stock" definitions={definitions} value={value.stock_revision_id ?? ""} onChange={(id) => onChange({ ...value, stock_revision_id: id, rules: [] })} />}
    {signalSet.isError && <Alert color="red">{signalSet.error.message}</Alert>}
    {stock.isError && <Alert color="red">{stock.error.message}</Alert>}
    {value.scope === "stock" && !stock.isError && !stock.isFetching && stock.data && <Table.ScrollContainer minWidth={900}><Table withTableBorder verticalSpacing={4} className="sb-signal-table">
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
  const view = !inspected.isError && !inspected.isFetching ? inspected.data?.convention : undefined;
  const value = !inspected.isError && !inspected.isFetching && inspected.data?.interface.kind === "conductor_convention" ? inspected.data.interface : null;
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
