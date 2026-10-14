import { Alert, Anchor, Badge, Button, FileInput, Group, Select, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import { command, getIntake, listIntakes, listPopulations, PcbRequestError, preserveFiles, type Intake, type IntakeSummary, type NativeReport, type PopulationDraft } from "./api";
import { PopulationEditor } from "./PopulationEditor";
import { UpgradeOffer, UpgradeProvenance } from "./FormatUpgrade";
import { PcbFabricationPanel } from "../pcb-fabrication/PcbFabricationPanel";
import { FirmwarePanel } from "../firmware/FirmwarePanel";
import { RevisionLabel } from "../../lib/IdentityLabel";
import { useCan } from "../../lib/permissions";

export type PcbPanelProps = { workspaceId: string };

export function PcbPanel(props: PcbPanelProps) {
  return <ProjectPanel key={props.workspaceId} {...props} />;
}

function ProjectPanel({ workspaceId }: PcbPanelProps) {
  const [items, setItems] = useState<IntakeSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [intake, setIntake] = useState<Intake | null>(null);
  const [populations, setPopulations] = useState<PopulationDraft[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [name, setName] = useState("");
  const [rights, setRights] = useState("");
  const [boardPath, setBoardPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lifetime = useRef(new AbortController());
  const readSequence = useRef(0);
  const denied = useRef(false);
  const [accessLost, setAccessLost] = useState(false);
  const canImport = useCan("source.register");
  const canExecute = useCan("build.execute");

  function failure(reason: unknown) {
    if (lifetime.current.signal.aborted) return;
    if (reason instanceof PcbRequestError && [401, 403, 404].includes(reason.status)) {
      denied.current = true; setAccessLost(true); ++readSequence.current;
      setIntake(null); setPopulations([]); setItems([]); setSelected(null); setFiles([]);
    }
    setError(reason instanceof Error ? reason.message : "PCB request failed.");
  }
  async function refreshList() {
    try {
      const result = await listIntakes(workspaceId, lifetime.current.signal);
      if (!denied.current) setItems(result);
    }
    catch (reason) { failure(reason); }
  }
  async function load(id: string) {
    const sequence = ++readSequence.current;
    try {
      const [result, drafts] = await Promise.all([
        getIntake(id, lifetime.current.signal), listPopulations(id, lifetime.current.signal),
      ]);
      if (sequence === readSequence.current && !denied.current) { setIntake(result); setPopulations(drafts); setError(""); }
    } catch (reason) {
      if (sequence === readSequence.current) { setIntake(null); setPopulations([]); failure(reason); }
    }
  }
  useEffect(() => {
    lifetime.current = new AbortController();
    void refreshList();
    return () => lifetime.current.abort();
    // Scope changes remount ProjectPanel, discarding all captured data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    ++readSequence.current;
    setIntake(null); setPopulations([]);
    if (selected) void load(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);
  useEffect(() => {
    if (!selected) return;
    const refresh = () => { void load(selected); };
    window.addEventListener("focus", refresh);
    const states = [...(intake?.attempts ?? []), ...(intake?.upgrade?.attempts ?? [])].map((a) => a.state);
    const pending = states.some((state) => !["succeeded", "failed", "cancelled"].includes(state));
    const timer = pending ? window.setInterval(refresh, 3000) : undefined;
    return () => { window.removeEventListener("focus", refresh); if (timer) window.clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, [...(intake?.attempts ?? []), ...(intake?.upgrade?.attempts ?? [])].map((a) => a.state).join(",")]);

  async function work(action: () => Promise<void>) {
    setBusy(true); setError("");
    try { await action(); } catch (reason) { failure(reason); }
    finally { if (!lifetime.current.signal.aborted) setBusy(false); }
  }
  async function importSources() {
    await work(async () => {
      const result = await preserveFiles(workspaceId, files, name, rights, boardPath ?? "", lifetime.current.signal);
      setFiles([]); setBoardPath(null);
      await refreshList(); setSelected(result.intake_id);
    });
  }
  async function extract() {
    if (!intake?.available_recipe_id) return;
    const id = intake.intake_id;
    await work(async () => {
      await command("pcb.request_extraction", { intake_id: id, recipe_id: intake.available_recipe_id }, lifetime.current.signal);
      await load(id);
    });
  }
  async function accept(attemptId: string) {
    if (!intake) return;
    const id = intake.intake_id;
    await work(async () => {
      await command("pcb.accept_extraction", { attempt_id: attemptId }, lifetime.current.signal);
      await load(id);
    });
  }
  async function requestUpgrade() {
    const recipe = intake?.upgrade?.available_recipe_id;
    if (!intake || !recipe) return;
    const id = intake.intake_id;
    await work(async () => {
      await command("pcb.request_upgrade", { intake_id: id, recipe_id: recipe }, lifetime.current.signal);
      await load(id);
    });
  }
  async function acceptUpgrade(attemptId: string) {
    await work(async () => {
      const result = await command<{ intake_id: string }>("pcb.accept_upgrade", { upgrade_attempt_id: attemptId }, lifetime.current.signal);
      await refreshList(); setSelected(result.intake_id);
    });
  }
  const boardOptions = files.filter((f) => f.name.toLowerCase().endsWith(".kicad_pcb")).map((f) => f.webkitRelativePath || f.name);
  const report = intake?.interpretations.at(-1)?.report;
  return <Stack>
    <Title order={2}>PCB intake</Title>
    <Text>Preserve source files, then explicitly request a supported native interpretation. Originals remain authoritative.</Text>
    {error && <Alert color="red" role="alert">{error}</Alert>}
    {canImport && !accessLost && <Stack gap="xs">
      <FileInput label="Original source files" multiple value={files} onChange={(value) => { setFiles(value); setBoardPath(null); }} />
      <TextInput label="Source package name" value={name} onChange={(e) => setName(e.currentTarget.value)} />
      <TextInput label="Source rights declaration" description="Declare the rights that apply to these files and derived outputs." value={rights} onChange={(e) => setRights(e.currentTarget.value)} />
      <Select label="Board to interpret" description="Optional. Other inputs are preserved with unsupported semantic coverage." clearable data={boardOptions} value={boardPath} onChange={setBoardPath} />
      <Button onClick={() => void importSources()} loading={busy} disabled={!files.length || !name.trim() || !rights.trim()}>Preserve sources</Button>
    </Stack>}
    <Select label="Preserved PCB intake" value={selected} onChange={setSelected} data={items.map((i) => ({ value: i.intake_id, label: `${i.board_path || "Unparsed package"} · ${i.source_revision_id.slice(0, 8)}${i.upgraded_from_kicad ? ` · upgraded from KiCad ${i.upgraded_from_kicad}` : ""}` }))} />
    <Button variant="subtle" onClick={() => { void refreshList(); if (selected) void load(selected); }}>Refresh intake</Button>
    {intake && <Stack>
      <Text size="sm"><RevisionLabel kind="source" id={intake.source_revision_id} role="source" /></Text>
      {intake.format_upgrade && <UpgradeProvenance upgrade={intake.format_upgrade} />}
      <Table><Table.Thead><Table.Tr><Table.Th>Original file</Table.Th><Table.Th>Coverage</Table.Th><Table.Th>Rights</Table.Th></Table.Tr></Table.Thead>
        <Table.Tbody>{intake.files.map((file) => <Table.Tr key={file.path}>
          <Table.Td><Anchor href={`/api/v0/pcb/intakes/${intake.intake_id}/original?path=${encodeURIComponent(file.path)}`}>{file.path}</Anchor><Text size="xs">SHA-256: {file.sha256}</Text></Table.Td>
          <Table.Td>{file.coverage}</Table.Td><Table.Td>{file.rights}</Table.Td>
        </Table.Tr>)}</Table.Tbody>
      </Table>
      <Text size="sm">KiCad 10.0.6 board format 20260206 on amd64; older KiCad boards are read through a recorded format upgrade. Schematic, netlist, fabrication and BOM semantics are currently preserved without parsing.</Text>
      {intake.board_path && canExecute && <Stack gap="xs">
        {!intake.available_recipe_id && <Text>Native extraction is unavailable on this installation. Your source files are preserved.</Text>}
        <Button onClick={() => void extract()} loading={busy} disabled={!intake.available_recipe_id}>Request native extraction</Button>
      </Stack>}
      {intake.attempts.map((attempt) => <Group key={attempt.attempt_id}><Text>Extraction {attempt.attempt_id.slice(0, 8)}</Text><Badge>{attempt.state}</Badge>
        {attempt.diagnostic && <Text c="red">{attempt.diagnostic}</Text>}
        {attempt.state === "succeeded" && canImport && !intake.interpretations.some((i) => i.attempt_id === attempt.attempt_id) && <Button size="xs" onClick={() => void accept(attempt.attempt_id)} disabled={busy}>Validate interpretation</Button>}
      </Group>)}
      {intake.upgrade && <UpgradeOffer upgrade={intake.upgrade} busy={busy} onRequest={() => void requestUpgrade()} onAccept={(id) => void acceptUpgrade(id)} onOpen={(id) => { void refreshList(); setSelected(id); }} />}
      {report && <ReportView report={report} />}
      {report && <PcbFabricationPanel key={intake.intake_id} intakeId={intake.intake_id} blocked={accessLost} />}
      {!!intake.interpretations.length && <PopulationEditor
        workspaceId={workspaceId} intake={intake} drafts={populations}
        onChanged={() => selected && load(selected)} onAccessLost={failure}
      />}
    </Stack>}
    {!accessLost && <FirmwarePanel workspaceId={workspaceId} />}
  </Stack>;
}

export function ReportView({ report }: { report: NativeReport }) {
  return <Stack>
    <Title order={3}>Extracted interpretation</Title>
    <Text size="sm">Native source SHA-256: {report.source_sha256}</Text>
    <Text>{report.coordinate_frame} · {report.units}</Text>
    <Group><Badge>{report.components.length} components</Badge><Badge>{report.pads.length} pads</Badge><Badge>{Object.keys(report.copper_nets).length} copper nets</Badge><Badge>{report.mounting_holes.length} nonplated hole candidates</Badge></Group>
    <BoardPreview report={report} />
    <Table><Table.Thead><Table.Tr><Table.Th>Component</Table.Th><Table.Th>Value</Table.Th><Table.Th>Placement (mm)</Table.Th><Table.Th>Side / rotation</Table.Th><Table.Th>Population</Table.Th></Table.Tr></Table.Thead>
      <Table.Tbody>{report.components.map((component) => <Table.Tr key={component.id}><Table.Td>{component.reference}</Table.Td><Table.Td>{component.value}</Table.Td><Table.Td>{component.position.join(", ")}</Table.Td><Table.Td>{component.side} / {component.rotation_deg}°</Table.Td><Table.Td>{component.dnp ? "DNP in native source" : "Native DNP flag unset; variants unreviewed"}</Table.Td></Table.Tr>)}</Table.Tbody>
    </Table>
    {Object.entries(report.copper_nets).map(([net, terminals]) => <Text key={net}>{net}: {terminals.join(", ")}</Text>)}
    <Table><Table.Thead><Table.Tr><Table.Th>Native pad</Table.Th><Table.Th>Net</Table.Th><Table.Th>Position (mm)</Table.Th><Table.Th>Type</Table.Th></Table.Tr></Table.Thead>
      <Table.Tbody>{report.pads.map((pad) => <Table.Tr key={pad.id}><Table.Td>{pad.terminal}<Text size="xs">{pad.id}</Text></Table.Td><Table.Td>{pad.net || "Unassigned"}</Table.Td><Table.Td>{pad.position.join(", ")}</Table.Td><Table.Td>{pad.type}</Table.Td></Table.Tr>)}</Table.Tbody>
    </Table>
    {report.mounting_holes.map((hole) => <Text key={hole.pad_id}>Nonplated drill: {hole.position.join(", ")} mm; drill {hole.drill.join(" × ")} mm; mounting role requires review.</Text>)}
    <Text>Outline: {report.outline.length ? report.outline_exact ? `${report.outline.length} closed polygon(s) with exact arcs/circles, displayed within ${report.outline_tolerance_mm} mm${report.outline_bridged_gaps?.length ? `; ${report.outline_bridged_gaps.length} outline gaps bridged (max ${Math.max(...report.outline_bridged_gaps.map(g => g.size_mm))} mm)` : ''}` : `${report.outline.length} closed line polygon(s)` : "Unresolved"}. No physical qualification.</Text>
    <Title order={4}>Parsed coverage and limitations</Title>
    {Object.entries(report.coverage).map(([category, coverage]) => <Text key={category}>{category}: {coverage}</Text>)}
    {report.unsupported.map((issue, i) => <Text key={i} size="sm">{issue}</Text>)}
  </Stack>;
}

function BoardPreview({ report }: { report: NativeReport }) {
  const vertices = report.outline.flat();
  if (!vertices.length) return null;
  const bounds = vertices.reduce<[number, number, number, number]>(([minX, minY, maxX, maxY], [x, y]) => [Math.min(minX, x), Math.min(minY, y), Math.max(maxX, x), Math.max(maxY, y)], [Infinity, Infinity, -Infinity, -Infinity]);
  const [minX, minY] = bounds;
  const width = bounds[2] - minX;
  const height = bounds[3] - minY;
  if (width <= 0 || height <= 0) return null;
  return <svg aria-label="Extracted board outline and native placements" role="img" viewBox={`${minX - 2} ${minY - 2} ${width + 4} ${height + 4}`} style={{ width: "100%", maxHeight: 320, background: "var(--sb-surface-sunken)" }}>
    {report.outline.map((polygon, i) => <polygon key={i} points={polygon.map((p) => p.join(",")).join(" ")} fill="var(--sb-surface-raised)" stroke="var(--sb-text-secondary)" strokeWidth={0.15} />)}
    {report.cutouts?.map((polygon, i) => <polygon key={`cutout-${i}`} points={polygon.map((p) => p.join(",")).join(" ")} fill="var(--sb-surface-sunken)" stroke="var(--sb-text-secondary)" strokeWidth={0.15} />)}
    {report.mounting_holes.map((hole) => <ellipse key={hole.pad_id} cx={hole.position[0]} cy={hole.position[1]} rx={hole.drill[0] / 2} ry={hole.drill[1] / 2} fill="var(--sb-surface-sunken)" stroke="var(--sb-text-tertiary)" strokeWidth={0.1} />)}
    {report.pads.filter((pad) => pad.type !== "npth").map((pad) => <circle key={pad.id} cx={pad.position[0]} cy={pad.position[1]} r={0.35} fill="var(--sb-review)" />)}
    {report.components.map((component) => <text key={component.id} x={component.position[0] + 0.7} y={component.position[1] - 0.7} fontSize={1.2} fill="var(--sb-text-primary)">{component.reference}</text>)}
    {report.outline_bridged_gaps?.map((gap, i) => <circle key={`gap-${i}`} data-testid="bridged-gap-marker" cx={(gap.at[0] + gap.to[0]) / 2} cy={(gap.at[1] + gap.to[1]) / 2} r={0.6} fill="none" stroke="var(--sb-review)" strokeWidth={0.2}><title>{`Bridged outline gap ${gap.size_mm} mm`}</title></circle>)}
  </svg>;
}
