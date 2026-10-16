import { Button, Group, Select, Stack, Text, TextInput, UnstyledButton } from "@mantine/core";
import { useState, type ReactNode } from "react";
import { SbStatus, SbUnknown } from "../../components/sb";
import { InspectionScope, ReadOnlyNote, usePermission } from "../../lib/permissions";
import type { Cable } from "../cables/api";
import { LAYER_LABELS, splitKey, terminalKey, type ResolvedStack } from "../end-assemblies/api";
import { SignalCell, findTerminal, targetOptions } from "../end-assemblies/StackEditor";
import { statusLed } from "../intent-check/IntentCheckPanel";
import { DIMENSIONS, DIMENSION_LABELS, type CheckRow, type IntentCheck } from "../intent-check/api";
import { SignalTypeChip } from "../interfaces/SignalSetFields";
import type { ProposedRow } from "../intent-propose/ProposeWiring";
import { REQUIREMENT_LABELS } from "../intents/api";
import { DEFAULT_NOTE, assignLanding, landingOf, splitTermKey, type CheckIndex, type Drawing, type DrawnWire } from "./model";
import { STATUS_WORDS, familyColor, signalFamily } from "./palette";
import { landingWords, ohms, workshopChips } from "./chips";

export type InspectorProps = {
  drawing: Drawing;
  selection: string | null;
  onSelect: (key: string | null) => void;
  cable: Cable;
  stacks: (ResolvedStack | undefined)[];
  check: IntentCheck | null | undefined;
  index: CheckIndex;
  /** Present only while the cable is editable here. */
  onChange?: (cable: Cable) => void;
  armed: { endpointId: string; path: string } | null;
  onArm: (armed: { endpointId: string; path: string } | null) => void;
  proposalRows: ProposedRow[];
  onAcceptRow?: (rowId: string) => void;
  onRejectRow?: (rowId: string) => void;
  accepting?: boolean;
};

const endLetter = (cable: Cable, endpointId: string) => `End ${String.fromCharCode(65 + Math.max(0, cable.endpoints.findIndex((e) => e.local_id === endpointId)))}`;

function Swatch({ wire }: { wire: DrawnWire }) {
  const color = wire.look && wire.look.fillSource !== "unknown" ? wire.look.base : null;
  return <span className="cwb-swatch" role="img" aria-label={color ? `Color ${wire.look?.colorLabel}` : "Color unknown"}
    style={color ? { background: color } : { backgroundImage: "repeating-linear-gradient(135deg, var(--sb-hatch) 0 1px, transparent 1px 4px)" }} />;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section><h4 className="cwb-section-title">{title}</h4>{children}</section>;
}

/** One intent row: signal, type, requirement, outcome, path chain and the ten dimensions with reasons. */
export function RowDetail({ row, drawing, onSelect }: { row: CheckRow; drawing: Drawing; onSelect?: (key: string) => void }) {
  return <Stack gap="xs">
    <Group gap={6} wrap="wrap">
      <span className="sb-mono" style={{ fontSize: 12 }}>{row.signal?.name ?? "Signal unknown"}</span>
      {row.signal && <SignalTypeChip type={row.signal.type} />}
      <span className="sb-tag">{REQUIREMENT_LABELS[row.requirement]}</span>
      <SbStatus led={statusLed(row.outcome)} dimension="row" value={STATUS_WORDS[row.outcome]} />
    </Group>
    <Text size="xs" className="sb-mono">{row.from_label ?? "none"} → {row.to_labels.join(", ") || (row.requirement === "must_not_connect" ? "must not connect" : "none")}</Text>
    <Section title="Path chain">
      {row.path.length ? <div className="sb-path-chain" role="list" aria-label="Declared path">
        {workshopChips(row.path, drawing).map((chip, i) => <span key={i} role="listitem" className="sb-chain-chip" data-kind={chip.kind} data-unknown={chip.unknown || undefined} title={chip.title}
          onClick={chip.key && onSelect ? () => onSelect(chip.key!) : undefined} style={chip.key && onSelect ? { cursor: "pointer" } : undefined}>{chip.text}</span>)}
      </div> : <Text size="xs" c="dimmed">No declared path.</Text>}
      {row.note && <Text size="xs" mt={4}>{row.note}</Text>}
    </Section>
    <Section title="Check · 10 dimensions">
      <div className="cwb-dims" role="list" aria-label={`Dimensions of ${row.signal?.name ?? row.row_id}`}>
        {DIMENSIONS.map((name) => <div key={name} role="listitem" style={{ display: "contents" }}>
          <SbStatus led={statusLed(row.dimensions[name].status)} dimension={DIMENSION_LABELS[name]} value={STATUS_WORDS[row.dimensions[name].status]} />
          <span className="cwb-why">{row.dimensions[name].reason}{row.dimensions[name].evidence.length ? ` (${row.dimensions[name].evidence.join("; ")})` : ""}</span>
        </div>)}
      </div>
    </Section>
    <Section title="Conductor convention">
      <Text size="xs">{row.dimensions.convention.reason}</Text>
      <Text size="xs" c="dimmed">Conventions only flag; they never change an outcome.</Text>
    </Section>
  </Stack>;
}

/** Landing controls for one element at one end: pick in the drawing, or the accessible select, plus the note. */
function LandingEditor({ cable, endpointId, path, resolved, onChange, armed, onArm }: { cable: Cable; endpointId: string; path: string; resolved: ResolvedStack | undefined; onChange: (c: Cable) => void; armed: boolean; onArm: (on: boolean) => void }) {
  const edit = usePermission("design.edit");
  const [note, setNote] = useState("");
  const current = landingOf(cable, endpointId, path);
  const groups = targetOptions(resolved);
  const known = new Set(groups.flatMap((g) => g.items.map((i) => i.value)));
  const stale = current && !known.has(terminalKey(current)) ? [{ group: "Not in this end", items: [{ value: terminalKey(current), label: `${current.layer_id} / ${current.terminal_id} (not in this end)` }] }] : [];
  const name = `${endLetter(cable, endpointId)} ${path}`;
  return <div className="cwb-land">
    <Group justify="space-between" gap={4} wrap="nowrap">
      <Text size="xs" fw={600}>{endLetter(cable, endpointId)}</Text>
      <Button size="compact-xs" variant={armed ? "primary" : "default"} disabled={!resolved || !edit.allowed} title={edit.reason} aria-pressed={armed} onClick={() => onArm(!armed)}>
        {armed ? "Click a pad or pin…" : "Choose in drawing"}
      </Button>
    </Group>
    <InspectionScope permission="design.edit">
      <Select size="xs" clearable searchable label={`${name} target`} placeholder="unassigned" disabled={!resolved} data={[...groups, ...stale]}
        value={current ? terminalKey(current) : null} onChange={(target) => { onChange(assignLanding(cable, endpointId, path, target ? splitKey(target) : null, note)); onArm(false); }} />
      <TextInput size="xs" label={`${name} termination basis`} placeholder={DEFAULT_NOTE} value={current ? current.basis : note}
        onChange={(event) => { const text = event.currentTarget.value; if (current) onChange({ ...cable, assignments: cable.assignments.map((a) => a === current ? { ...a, basis: text } : a) }); else setNote(text); }} />
    </InspectionScope>
    {!resolved && <Text size="xs" c="dimmed">Choose this end's layers to land on its pads and pins.</Text>}
  </div>;
}

function RowsOf({ rows, chosen, onChoose }: { rows: CheckRow[]; chosen: string | null; onChoose: (id: string) => void }) {
  if (rows.length < 2) return null;
  return <Group gap={4} wrap="wrap" role="group" aria-label="Rows through this mark">
    {rows.map((row) => <UnstyledButton key={row.row_id} className="cwb-chip" style={{ gridTemplateColumns: "auto minmax(0,1fr)" }} aria-pressed={row.row_id === chosen} onClick={() => onChoose(row.row_id)}>
      <span className="sb-led" data-state={statusLed(row.outcome)} aria-hidden="true" /><span className="cwb-chip-name">{row.signal?.name ?? row.row_id}</span>
    </UnstyledButton>)}
  </Group>;
}

/**
 * The probe inspector: what the selected wire, pin, pad, part or row is, its check, and (while
 * editable) where the selected element lands at each end. Forms for the whole cable and each
 * end live in the other inspector tabs.
 */
export function ProbeDetails(props: InspectorProps) {
  const { drawing, selection, cable, stacks, check, index, onChange, armed, onArm, onSelect } = props;
  const [chosenRow, setChosenRow] = useState<string | null>(null);
  if (!selection) {
    return <Stack gap="xs">
      <Text size="sm">Click a wire, pin, pad, part or a cross-section element to probe it. Everything related lights up.</Text>
      {check && <Group gap="sm" wrap="wrap">
        <SbStatus led={statusLed(check.ends.from.mating.status)} dimension="from mating" value={STATUS_WORDS[check.ends.from.mating.status]} />
        <SbStatus led={statusLed(check.ends.to.mating.status)} dimension="to mating" value={STATUS_WORDS[check.ends.to.mating.status]} />
        <SbStatus led={statusLed(check.cable.isolation.status)} dimension="isolation" value={STATUS_WORDS[check.cable.isolation.status]} />
        <SbStatus led={statusLed(check.cable.shield.status)} dimension="shield" value={STATUS_WORDS[check.cable.shield.status]} />
      </Group>}
      {check && <Text size="xs" c="dimmed">Declared topology, not measured continuity; no physical qualification.</Text>}
    </Stack>;
  }
  const rowsOf = (key: string) => (index.rowsOf.get(key) ?? []).map((id) => index.rows.get(id)!).filter(Boolean);
  if (selection.startsWith("w:")) {
    const wire = drawing.wires.find((w) => w.key === selection);
    if (!wire) return <Text size="sm">This element is no longer drawn.</Text>;
    const rows = rowsOf(selection);
    const row = rows.find((r) => r.row_id === chosenRow) ?? rows[0];
    return <Stack gap="sm">
      <div className="cwb-probe-head"><Swatch wire={wire} /><h3>{wire.display}</h3></div>
      <Group gap={6} wrap="wrap">
        <span className="sb-tag">{wire.kind}</span>
        <span className="sb-mono" style={{ fontSize: 11 }}>{wire.path}</span>
        {!wire.inStock && <span className="sb-tag">not in this stock</span>}
      </Group>
      {!check && <Section title="Signal at each end">{cable.endpoints.slice(0, 2).map((e, i) => {
        const term = i === 0 ? wire.aTerminal : wire.bTerminal;
        const at = term ? splitTermKey(term) : null;
        const t = at ? findTerminal(stacks[i], at.layerId, at.terminalId).terminal : undefined;
        return <Group key={e.local_id} gap={6} wrap="nowrap" align="flex-start"><Text size="xs" w={48}>{endLetter(cable, e.local_id)}</Text>{t ? <SignalCell terminal={t} /> : term ? <SbUnknown what="Signal" /> : <Text size="xs" c="dimmed">not landed</Text>}</Group>;
      })}</Section>}
      {check && rows.length === 0 && <Text size="xs" c="dimmed">No intent row passes this element.</Text>}
      <RowsOf rows={rows} chosen={row?.row_id ?? null} onChoose={setChosenRow} />
      {row && <RowDetail row={row} drawing={drawing} onSelect={onSelect} />}
      {onChange && <Section title="Landings">
        <Stack gap={6}>{cable.endpoints.slice(0, 2).map((e, i) => <LandingEditor key={e.local_id} cable={cable} endpointId={e.local_id} path={wire.path} resolved={stacks[i]} onChange={onChange}
          armed={armed?.endpointId === e.local_id && armed.path === wire.path} onArm={(on) => onArm(on ? { endpointId: e.local_id, path: wire.path } : null)} />)}</Stack>
        <ReadOnlyNote permission="design.edit">Changing landings is unavailable.</ReadOnlyNote>
      </Section>}
    </Stack>;
  }
  if (selection.startsWith("t:")) {
    const t = drawing.terminals.get(selection);
    const at = splitTermKey(selection);
    if (!t || !at) return <Text size="sm">This terminal is no longer drawn.</Text>;
    const i = cable.endpoints.findIndex((e) => e.local_id === at.endpointId);
    const resolved = findTerminal(stacks[i], at.layerId, at.terminalId).terminal;
    const landed = drawing.wires.filter((w) => w.aTerminal === selection || w.bTerminal === selection);
    const rows = rowsOf(selection);
    const row = rows.find((r) => r.row_id === chosenRow) ?? rows[0];
    return <Stack gap="sm">
      <div className="cwb-probe-head"><span className="cwb-swatch" style={{ background: familyColor(signalFamily(t.signal?.type)) }} aria-hidden="true" /><h3>{t.layerKind === "unknown" ? "" : `${LAYER_LABELS[t.layerKind]} `}{t.label}</h3></div>
      <Text size="xs" c="dimmed">{endLetter(cable, at.endpointId)} · {t.kind.replace(/_/g, " ")}</Text>
      {resolved ? <SignalCell terminal={resolved} /> : <SbUnknown what="Signal" />}
      <Section title="Landed here">{landed.length ? <Stack gap={2}>{landed.map((w) => <UnstyledButton key={w.key} onClick={() => onSelect(w.key)} className="cwb-chip" style={{ gridTemplateColumns: "auto minmax(0,1fr)" }}><Swatch wire={w} /><span className="cwb-chip-name">{w.display}</span></UnstyledButton>)}</Stack> : <Text size="xs" c="dimmed">No stock element lands here.</Text>}</Section>
      <RowsOf rows={rows} chosen={row?.row_id ?? null} onChoose={setChosenRow} />
      {row && <RowDetail row={row} drawing={drawing} onSelect={onSelect} />}
    </Stack>;
  }
  if (selection.startsWith("r:")) {
    const row = index.rows.get(selection.slice(2));
    if (!row) return <Text size="sm">This row is no longer checked.</Text>;
    const wires = drawing.wires.filter((w) => index.rowRefs.get(row.row_id)?.has(w.key));
    return <Stack gap="sm">
      <div className="cwb-probe-head"><span className="cwb-swatch" style={{ background: familyColor(signalFamily(row.signal?.type)) }} aria-hidden="true" /><h3>{row.signal?.name ?? row.row_id}</h3></div>
      <RowDetail row={row} drawing={drawing} onSelect={onSelect} />
      <Section title="Conductors on this path">{wires.length ? <Stack gap={2}>{wires.map((w) => <UnstyledButton key={w.key} onClick={() => onSelect(w.key)} className="cwb-chip" style={{ gridTemplateColumns: "auto minmax(0,1fr)" }}><Swatch wire={w} /><span className="cwb-chip-name">{w.display}</span></UnstyledButton>)}</Stack> : <Text size="xs" c="dimmed">No conductor carries this row.</Text>}</Section>
    </Stack>;
  }
  if (selection.startsWith("q:")) {
    const rowId = selection.slice(2);
    const row = props.proposalRows.find((r) => r.row_id === rowId);
    if (!row) return <Text size="sm">This proposal row was already decided.</Text>;
    return <ProposalDetail row={row} cable={cable} drawing={drawing} onAccept={props.onAcceptRow} onReject={props.onRejectRow} accepting={props.accepting} />;
  }
  if (selection.startsWith("p:")) {
    const part = drawing.ends.flatMap((e) => e.parts).find((p) => p.key === selection);
    const trace = drawing.ends.flatMap((e) => e.traces).find((p) => p.key === selection);
    return <Stack gap="xs">
      <div className="cwb-probe-head"><h3>{part ? part.name : trace ? "Board path" : "Part"}</h3></div>
      <Text size="sm">{ohms(part?.summary ?? trace?.summary ?? "")}</Text>
      {trace && <Text size="xs" c="dimmed">{trace.status === "unknown" ? <SbUnknown what="Path" /> : "Declared on the board revision."}</Text>}
      {part && <Text size="xs" c="dimmed">Lead 1 is where a conductor lands; lead 2 is joined on the connector side. Behavior is not evaluated here.</Text>}
    </Stack>;
  }
  return null;
}

export function ProposalDetail({ row, cable, drawing, onAccept, onReject, accepting }: { row: ProposedRow; cable: Cable; drawing: Drawing; onAccept?: (id: string) => void; onReject?: (id: string) => void; accepting?: boolean }) {
  const edit = usePermission("design.edit");
  return <Stack gap="xs">
    <div className="cwb-probe-head"><h3>Proposed · {row.row_id}</h3></div>
    <Text size="xs">{row.reason ?? row.questions[0]?.text ?? "Proposed from the intent."}</Text>
    <Stack gap={2}>{row.assignments.map((a) => <Text key={`${a.endpoint_id}${a.element_path}`} size="xs" title={`${a.element_path} → ${a.layer_id} ${a.terminal_id}`}>{endLetter(cable, a.endpoint_id)}: {landingWords(drawing, a)}</Text>)}</Stack>
    {onAccept && <Group gap="xs">
      <Button size="xs" loading={accepting} {...edit.props} disabled={edit.props.disabled || row.assignments.length === 0} onClick={() => onAccept(row.row_id)}>Accept {row.row_id}</Button>
      <Button size="xs" variant="default" onClick={() => onReject?.(row.row_id)}>Reject</Button>
    </Group>}
    <ReadOnlyNote permission="design.edit">Accepting into a draft is unavailable.</ReadOnlyNote>
  </Stack>;
}

