import { Alert, Button, Group, SegmentedControl, Select, Stack, Switch, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { SbUnknown } from "../../components/sb";
import { useCan } from "../../lib/permissions";
import { RevisionLabel } from "../../lib/IdentityLabel";
import { revisionOptionLabel, newestFirst } from "../../lib/revision-labels";
import { faceForBody } from "../interfaces/BodyFace";
import { ConditionsEditor, PinoutSignalsEditor, firstSetRevision } from "../interfaces/PinoutSignals";
import { SignalTypeChip } from "../interfaces/SignalSetPanel";
import { read, unknownElectrical, type Body, type Definition, type Identity, type Inspection, type Pinout, type Signal, type VariantPort } from "../interfaces/api";
import type { PinRing } from "../../../../packages/connector-art/src";
import { FaceLegend, FaceStage, type StripPin } from "./FaceStage";
import { PinElectricalFacts, PinElectricalFields } from "./PinDetails";
import { SignalPalette } from "./SignalPalette";
import { familyColor, signalFamily } from "./palette";
import {
  assignSignal, clearPin, describe, diffPins, facePins, makeConditional, makeUnconditional, mayBePower, patchElectrical, pinName,
  rowsFromDraft, rowsFromInspection, usesByKey, type PinRow,
} from "./model";
import "./pinout-editor.css";

export type WorkbenchMode = "create" | "draft" | "frozen";

const SELF = "self";

/**
 * Visual pin table editor: the body's connector face, a signal palette grouped by type, variant
 * tabs over every pinout of the same body with a compare mode, port hazards as rings, and a dense
 * table fallback. Frozen pin tables use the same view read-only. Nothing here decides
 * compatibility; unknown pins stay hatched and unknown.
 */
export function PinoutWorkbench({ value, onChange, mode, definitions, definitionId = null, inspection = null }: {
  value: Pinout; onChange?: (v: Pinout) => void; mode: WorkbenchMode; definitions: Definition[];
  /** The pinout's definition (drafts): finds its frozen ports and leaves it out of the other variants. */
  definitionId?: string | null;
  /** A frozen pin table's inspection: rows come from its resolved signals. */
  inspection?: Inspection | null;
}) {
  const can = useCan(mode === "create" ? "item.create" : "design.edit");
  const editable = mode !== "frozen" && !!onChange && can;
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<string>(SELF);
  const [compare, setCompare] = useState(false);
  const [target, setTarget] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [choice, setChoice] = useState<string | null>(null);
  const [view, setView] = useState<"face" | "table" | null>(null);

  const bodyQuery = useQuery({ queryKey: ["interface-inspect", value.body_revision_id], queryFn: () => read<Inspection>(`interfaces/revisions/${value.body_revision_id}`), enabled: !!value.body_revision_id });
  const body: Body | null = bodyQuery.data?.interface.kind === "connector_body" ? bodyQuery.data.interface : null;
  const contacts = body?.contacts ?? [];
  const geometry = body ? faceForBody(body) : null;

  const setRevision = picked ?? firstSetRevision(value);
  const setQuery = useQuery({ queryKey: ["interface-inspect", setRevision], queryFn: () => read<Inspection>(`interfaces/revisions/${setRevision}`), enabled: !!setRevision && !inspection });
  const signals: Signal[] = setQuery.data?.interface.kind === "signal_set" ? setQuery.data.interface.signals : [];
  const byKey = useMemo(() => new Map(signals.map((s) => [s.key, s])), [signals]);

  const ownDefinition = definitionId ?? inspection?.definition_id ?? null;
  const selfRows = useMemo(() => inspection?.contacts && inspection.signals
    ? rowsFromInspection(inspection.contacts, inspection.signals, value.conditions)
    : rowsFromDraft(value, contacts, byKey), [inspection, value, contacts, byKey]);

  const variants = (bodyQuery.data?.pinout_variants ?? []).filter((v) => v.definition_id !== ownDefinition && v.revision_id !== inspection?.revision_id);
  const tabRevision = tab === SELF ? null : tab;
  const compareRevision = compare ? target ?? (tab === SELF ? variants[0]?.revision_id ?? null : SELF) : null;
  const tabQuery = useVariant(tabRevision);
  const compareQuery = useVariant(compareRevision === SELF ? null : compareRevision);

  // Ports: a frozen table lists its own; a draft looks at its newest frozen revision.
  const identity = useQuery({ queryKey: ["interface-identity-ports", ownDefinition], queryFn: () => read<Identity>(`catalog/definitions/${ownDefinition}`), enabled: !inspection && !!ownDefinition });
  const newest = identity.data?.revisions.reduce<{ revision_id: string; number: number } | null>((best, r) => (!best || r.number > best.number ? r : best), null) ?? null;
  const newestQuery = useVariant(!inspection && newest ? newest.revision_id : null);
  const selfPorts = inspection?.ports ?? newestQuery.data?.ports ?? [];

  const shownRows = tab === SELF ? selfRows : tabQuery.data ? rowsOf(tabQuery.data) : [];
  const shownPorts = tab === SELF ? selfPorts : tabQuery.data?.ports ?? [];
  const compareRows = compareRevision === SELF ? selfRows : compareQuery.data ? rowsOf(compareQuery.data) : null;
  const differences = compare && compareRows ? diffPins(shownRows, compareRows) : [];
  const shownLabel = tab === SELF ? value.variant_label ?? (mode === "frozen" ? "This pinout" : "This draft") : labelOf(variants.find((v) => v.revision_id === tab));
  const compareLabel = compareRevision === SELF ? value.variant_label ?? "This draft" : labelOf(variants.find((v) => v.revision_id === compareRevision));

  const mnc = mustNotConnect(shownPorts);
  const rings = new Map<string, PinRing[]>();
  for (const id of mnc.keys()) rings.set(id, ["must-not-connect"]);
  for (const d of differences) rings.set(d.contactId, [...(rings.get(d.contactId) ?? []), "differs"]);
  const pins = facePins(shownRows, rings);
  const row = shownRows.find((r) => r.contactId === selected);
  const editingSelf = editable && tab === SELF;
  const assigned = shownRows.filter((r) => r.status !== "unknown").length;
  const hazards = shownRows.filter(mayBePower).length;
  const strip: StripPin[] = shownRows.map((r) => ({
    id: r.contactId, name: pinName(r), text: r.status === "unknown" ? "unknown" : r.status === "conditional" ? "conditional" : r.meaning?.name ?? "unknown",
    fill: r.meaning?.type ? familyColor(signalFamily(r.meaning.type)) : undefined, unknown: r.status === "unknown",
    marks: [...(mnc.has(r.contactId) ? ["must not connect"] : []), ...(mayBePower(r) ? ["may be power"] : []), ...(differences.some((d) => d.contactId === r.contactId) ? ["differs"] : [])],
  }));
  const effectiveView = view ?? (geometry ? "face" : "table");
  const change = (next: Pinout) => onChange?.(next);
  const activeChoice = row?.status === "conditional" ? choice && row.alternatives.some((a) => a.choice === choice) ? choice : row.alternatives[0]?.choice ?? null : null;
  const assign = (signal: Signal) => { if (selected && setRevision) change(assignSignal(value, contacts, selected, signal, setRevision, activeChoice)); };
  const current = row?.status === "conditional" ? row.alternatives.find((a) => a.choice === activeChoice)?.meaning?.key ?? null : row?.meaning?.key ?? null;
  const assignment = (value.assignments ?? []).find((a) => a.contact_id === selected);
  const frozenElectrical = tab === SELF ? inspection?.contacts?.find((c) => c.contact_id === selected)?.electrical ?? null : tabQuery.data?.contacts?.find((c) => c.contact_id === selected)?.electrical ?? null;

  if (!value.body_revision_id) return <Text size="sm" c="dimmed">Choose the physical body to draw its face and assign pins.</Text>;
  if (bodyQuery.isError) return <Alert color="red">{bodyQuery.error.message}</Alert>;
  if (!body) return <Text size="sm" c="dimmed">Loading the body…</Text>;

  return <div className="pwb" data-mode={mode}>
    <dl className="pwb-cells">
      <Cell label="Variant" text={shownLabel} />
      <Cell label="Assigned" text={`${assigned}/${shownRows.length}`} sub={shownRows.length - assigned ? `${shownRows.length - assigned} unknown` : "all pins declared"} />
      <Cell label="Must not connect" text={String(mnc.size)} sub={shownPorts.length ? `from ${shownPorts.length} port${shownPorts.length === 1 ? "" : "s"}` : "no frozen ports"} />
      <Cell label="May be power" text={String(hazards)} sub="conditional pins" />
      {compare && <Cell label="Differs" text={compareRows ? String(differences.length) : null} sub={compareLabel ? `vs ${compareLabel}` : undefined} />}
      <Cell label="Pin table" text={tab === SELF ? value.review : variants.find((v) => v.revision_id === tab) ? "frozen" : null} />
    </dl>

    <div className="pwb-tabs" role="tablist" aria-label="Pinout variants of this body">
      <button type="button" role="tab" aria-selected={tab === SELF} className="pwb-tab" onClick={() => setTab(SELF)}>{value.variant_label ?? (mode === "frozen" ? "This pinout" : "This draft")}{mode !== "frozen" && <span className="pwb-tab-sub">draft</span>}</button>
      {variants.map((v) => <button type="button" role="tab" key={v.revision_id} aria-selected={tab === v.revision_id} className="pwb-tab" onClick={() => { setTab(v.revision_id); if (compareRevision === v.revision_id) setTarget(null); }}>{labelOf(v)}<span className="pwb-tab-sub">r{v.number}</span></button>)}
      <span className="pwb-tabs-spacer" />
      <Switch size="xs" label="Compare" checked={compare} disabled={variants.length === 0} onChange={(e) => setCompare(e.currentTarget.checked)} />
      {compare && <Select size="xs" aria-label="Compare with" w={190} value={compareRevision} onChange={setTarget}
        data={[...(tab === SELF ? [] : [{ value: SELF, label: value.variant_label ?? "This draft" }]), ...variants.filter((v) => v.revision_id !== tab).map((v) => ({ value: v.revision_id, label: labelOf(v) }))]} />}
      <SegmentedControl size="xs" aria-label="Pin table view" value={effectiveView} onChange={(v) => setView(v as "face" | "table")} data={[{ value: "face", label: "Face", disabled: !geometry }, { value: "table", label: "Table" }]} />
    </div>
    {variants.length === 0 && <Text size="xs" c="dimmed">No other frozen pinout variants of this body yet; compare needs one.</Text>}
    {tab !== SELF && <Text size="xs" className="pwb-viewing">Viewing frozen variant {shownLabel}. {editable ? "Switch to the first tab to edit this draft." : ""}</Text>}
    {(tabQuery.isError || compareQuery.isError) && <Alert color="red">{(tabQuery.error ?? compareQuery.error)?.message}</Alert>}

    <div className="pwb-grid">
      <div className="pwb-main">
        {effectiveView === "face" && geometry ? <FaceStage geometry={geometry} pins={pins} strip={strip} selected={selected} onSelect={setSelected}
          caption={`${shownLabel}${body.family ? ` · ${body.family}` : ""}`}
          banner={compare && compareRows ? <div className="pwb-banner" role="status">{differences.length === 0 ? `No pin differs from ${compareLabel}.` : <>{differences.length} pin{differences.length === 1 ? "" : "s"} differ{differences.length === 1 ? "s" : ""} from {compareLabel}: {differences.map((d) => <span key={d.contactId} className="pwb-diff"><b>{d.pin}</b> {d.a} → {d.b}</span>)}</>}</div> : null}
          legend={<FaceLegend marks={["unknown", "conditional", "must-not-connect", "hazard", ...(compare ? ["differs" as const] : [])]} />} />
          : <div className="pwb-table">
            {!geometry && <Text size="xs" c="dimmed">This body has no face drawing{body.geometry_key ? ` (face key ${body.geometry_key} is not in this library)` : ""}; set one in a new body draft. The pins are listed as a table.</Text>}
            {compare && compareRows && <div className="pwb-banner" role="status">{differences.length} pin{differences.length === 1 ? "" : "s"} differ from {compareLabel}{differences.length ? ": " : "."}{differences.map((d) => <span key={d.contactId} className="pwb-diff"><b>{d.pin}</b> {d.a} → {d.b}</span>)}</div>}
            {editingSelf ? <PinoutSignalsEditor value={value} onChange={change} definitions={definitions} contacts={contacts} setRevision={picked} onSetRevision={setPicked} selected={selected} onSelect={setSelected} hideConditions />
              : <ReadTable rows={shownRows} selected={selected} onSelect={setSelected} differs={new Set(differences.map((d) => d.contactId))} mnc={mnc} />}
          </div>}
      </div>

      <aside className="pwb-inspector" aria-label="Pin inspector">
        {!row ? <Text size="sm" c="dimmed">Pick a pin on the face{editingSelf ? ", then a signal" : ""}.</Text> : <Stack gap={6}>
          <Group gap={6} justify="space-between" wrap="nowrap"><Text fw={600}>Pin {pinName(row)}{row.label && row.label !== row.number && row.label !== row.contactId ? ` · ${row.label}` : ""}</Text><span className="sb-silk">{shownLabel}</span></Group>
          <PinMeaning row={row} />
          {mnc.get(row.contactId)?.map((m) => <Text key={m.port} size="xs" className="pwb-warn" data-kind="mnc">Must not connect on {m.port}: {m.reason || "reason not stated"}</Text>)}
          {mayBePower(row) && <Text size="xs" className="pwb-warn" data-kind="hazard">May be power until its condition is selected.</Text>}
          {differences.find((d) => d.contactId === row.contactId) && <Text size="xs" className="pwb-warn" data-kind="differs">{compareLabel}: {differences.find((d) => d.contactId === row.contactId)!.b}</Text>}
          {editingSelf && <>
            {row.status === "conditional" && <SegmentedControl size="xs" fullWidth aria-label="Alternative to assign" value={activeChoice ?? ""} onChange={setChoice} data={row.alternatives.map((a) => ({ value: a.choice, label: a.choiceName }))} />}
            {!setRevision && <SetPicker definitions={definitions} onPick={setPicked} label="Signal set for the palette" />}
            {setQuery.isError && <Alert color="red">{setQuery.error.message}</Alert>}
            <SignalPalette signals={signals} uses={usesByKey(selfRows)} current={current} disabled={!setRevision} onPick={assign}
              hint={row.status === "conditional" ? `Assigning the ${row.alternatives.find((a) => a.choice === activeChoice)?.choiceName ?? ""} alternative.` : undefined} />
            {setRevision && <Text size="xs" c="dimmed"><RevisionLabel id={setRevision} role="Signals from" /></Text>}
            <Group gap={4}>
              <Button size="compact-xs" variant="default" disabled={!assignment} onClick={() => change(clearPin(value, contacts, row.contactId))}>Clear pin</Button>
              {row.status !== "conditional" && (value.conditions ?? []).map((c) => <Button key={c.key} size="compact-xs" variant="subtle" onClick={() => change(makeConditional(value, contacts, row.contactId, c.key))}>Depends on {c.name}</Button>)}
              {row.status === "conditional" && <Button size="compact-xs" variant="subtle" onClick={() => change(makeUnconditional(value, contacts, row.contactId))}>Not conditional</Button>}
            </Group>
            <details className="pwb-details"><summary>Electrical details</summary>
              <PinElectricalFields pin={pinName(row)} value={assignment?.electrical ?? unknownElectrical()} onChange={(patch) => change(patchElectrical(value, contacts, row.contactId, patch))} />
            </details>
          </>}
          {!editingSelf && <PinElectricalFacts value={tab === SELF && !inspection ? assignment?.electrical ?? null : frozenElectrical} />}
        </Stack>}
      </aside>
    </div>

    {editingSelf && <div className="pwb-setup">
      <Group align="end" gap="xs">
        <SetPicker definitions={definitions} onPick={setPicked} label={setRevision ? "Change signal set" : "Signal set"} />
        {setRevision && <Text size="xs"><RevisionLabel id={setRevision} role="Signals from" /></Text>}
      </Group>
      <ConditionsEditor value={value} onChange={change} />
    </div>}
  </div>;
}

function useVariant(revisionId: string | null) {
  return useQuery({ queryKey: ["interface-inspect", revisionId], queryFn: () => read<Inspection>(`interfaces/revisions/${revisionId}`), enabled: !!revisionId });
}

function rowsOf(inspection: Inspection): PinRow[] {
  const conditions = inspection.interface.kind === "pinout" ? inspection.interface.conditions : [];
  return rowsFromInspection(inspection.contacts ?? [], inspection.signals ?? {}, conditions);
}

const labelOf = (v: { variant_label: string | null; name: string } | undefined) => (v ? v.variant_label ?? v.name : "variant");

/** Contacts that any listed port says must not connect, with the port and reason. */
function mustNotConnect(ports: readonly VariantPort[]): Map<string, { port: string; reason: string | null }[]> {
  const out = new Map<string, { port: string; reason: string | null }[]>();
  for (const p of ports) for (const m of p.must_not_connect) out.set(m.contact_id, [...(out.get(m.contact_id) ?? []), { port: p.device_label || p.name, reason: m.reason }]);
  return out;
}

function Cell({ label, text, sub }: { label: string; text: string | null; sub?: string }) {
  return <div className="sb-cell"><dt className="sb-silk">{label}</dt><dd data-unknown={text === null || undefined}>{text ?? <SbUnknown />}</dd>{sub && <p className="pwb-sub">{sub}</p>}</div>;
}

function PinMeaning({ row }: { row: PinRow }) {
  if (row.status === "unknown") return <div><SbUnknown what="Signal" />{row.note && <Text size="xs" c="dimmed">Note: {row.note}</Text>}</div>;
  if (row.status === "conditional") return <Stack gap={2}><Text size="xs" c="dimmed">Depends on a condition; unknown until one is selected</Text>
    {row.alternatives.map((a) => <Group key={a.choice} gap={6} wrap="nowrap"><span className="pwb-choice">{a.choiceName}</span>{a.meaning ? <><Text size="sm">{a.meaning.name}</Text>{a.meaning.type && <SignalTypeChip type={a.meaning.type} />}</> : <SbUnknown what="Signal" />}</Group>)}</Stack>;
  return <Group gap={6} wrap="nowrap"><Text size="sm" fw={600}>{row.meaning?.name}</Text>{row.meaning?.type && <SignalTypeChip type={row.meaning.type} />}</Group>;
}

function SetPicker({ definitions, onPick, label = "Signal set" }: { definitions: Definition[]; onPick: (revisionId: string | null) => void; label?: string }) {
  const [definition, setDefinition] = useState<string | null>(null);
  const identity = useQuery({ queryKey: ["signal-set-identity", definition], queryFn: () => read<Identity>(`catalog/definitions/${definition}`), enabled: !!definition });
  return <Group align="end" gap="xs">
    <Select size="xs" label={label} searchable placeholder="Choose a signal set" value={definition} data={definitions.filter((d) => d.kind === "signal_set").map((d) => ({ value: d.definition_id, label: d.name }))} onChange={setDefinition} />
    {identity.data && <Select size="xs" label="Signal set revision" value={null} onChange={onPick} data={newestFirst(identity.data.revisions).map((r) => ({ value: r.revision_id, label: revisionOptionLabel(identity.data.name, r.number) }))} />}
  </Group>;
}

/** Dense read-only pin table (frozen variants and viewers). */
function ReadTable({ rows, selected, onSelect, differs, mnc }: { rows: PinRow[]; selected: string | null; onSelect: (id: string | null) => void; differs: Set<string>; mnc: Map<string, unknown> }) {
  return <div className="pwb-scroll"><table className="pwb-readtable">
    <thead><tr><th>Pin</th><th>Label</th><th>Signal</th><th>Type</th><th>Role</th><th>Marks</th></tr></thead>
    <tbody>{rows.map((r) => <tr key={r.contactId} data-selected={selected === r.contactId || undefined}>
      <td><button type="button" className="pwb-row-pick" aria-pressed={selected === r.contactId} aria-label={`Select pin ${pinName(r)}`} onClick={() => onSelect(selected === r.contactId ? null : r.contactId)}>{pinName(r)}</button></td>
      <td>{r.label || "—"}</td>
      <td>{r.status === "unknown" ? <SbUnknown what="Signal" /> : describe(r)}</td>
      <td>{r.meaning?.type ? <SignalTypeChip type={r.meaning.type} /> : r.status === "conditional" ? "per condition" : <SbUnknown what="Type" />}</td>
      <td>{r.role}</td>
      <td>{[mnc.has(r.contactId) && "must not connect", mayBePower(r) && "may be power", differs.has(r.contactId) && "differs"].filter(Boolean).join(", ") || "—"}</td>
    </tr>)}</tbody>
  </table></div>;
}
