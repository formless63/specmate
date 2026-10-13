import { Alert, Button, Card, Group, NativeSelect, Stack, Text, Title } from "@mantine/core";
import { useState } from "react";
import { evidenceLabel, scopeLabel, type Graph } from "../copper/api";
import { CopperProvenance } from "../copper/CopperProvenance";
import type { Evidence, Interpretation } from "./api";

const readable = (value: string) => value.replaceAll("_", " ");
const PAGE_SIZE = 20;
const queryMeaning: Record<string, string> = {
  dc_continuity: "Declared resistors allow resistive DC paths; ideal capacitors block steady-state DC. Missing parameters and unsupported operating behavior remain unknown.",
  shortness: "Ideal shortness requires exactly zero resistance for a supported path. Any positive resistor remains resistive; this is not a measured short-circuit result.",
  resistance: "Resistance is reported for a supported single series path. Multiple candidate paths require an unsupported network solver; no equivalent parallel resistance is inferred.",
  signal: "Signal queries report supported ideal series impedance at the explicit frequency. Capacitive impedance uses a derived approximation; ideal DC shortness and physical signal transfer remain unevaluated.",
};
function SourceEvidence({ evidence }: { evidence: string | Evidence }) {
  if (typeof evidence === "string") return <Text size="sm">{evidenceLabel(evidence)}</Text>;
  return <Stack gap={2}><Text size="sm">Evidence: {readable(evidence.status)}</Text>
    {evidence.citation && <Text size="sm">Citation (unverified): {evidence.citation}</Text>}
    {evidence.source_bundle_revision_id && <Text size="sm">Source bundle revision: {evidence.source_bundle_revision_id} · Path: {evidence.source_path ?? "unspecified"}</Text>}
    {evidence.sha256 && <Text size="xs">Source SHA-256: {evidence.sha256} · Rights: {evidence.rights ?? "unspecified"}</Text>}
  </Stack>;
}
/** Endpoint metadata belongs to the exact graph pinned by the authorized query. */
export function PathExplanation({ result, graph }: { result: Interpretation; graph: Graph }) {
  const [pathIndex, setPathIndex] = useState(0);
  const [stepPage, setStepPage] = useState(0);
  const [boundaryPage, setBoundaryPage] = useState(0);
  const [previousResult, setPreviousResult] = useState(result);
  if (previousResult !== result) {
    setPreviousResult(result);
    setPathIndex(0);
    setStepPage(0);
    setBoundaryPage(0);
  }
  const exactGraph = result.root_revision_id === graph.root_revision_id && result.root_snapshot_sha256 === graph.snapshot_sha256;
  const nodes = new Map(exactGraph ? graph.nodes.map((n) => [n.id, n]) : []);
  const label = (id: string) => { const node = nodes.get(id); return node ? `${scopeLabel(node.occurrence_path)} · ${node.label}` : id; };
  const path = result.paths[pathIndex];
  const boundaries = result.unmodeled_boundaries ?? [];
  const assumptions = result.assumptions;
  function terminal(id: string, role: string) {
    const node = nodes.get(id);
    return <Stack gap={2}><Text fw={500}>{role}: {label(id)}</Text><Text size="xs">Terminal identity: {id}</Text>
      {node ? <><Text size="sm">Feature kind: {node.feature_kind} · Exact feature fields: {Object.entries(node.terminal).map(([key, value]) => `${key}=${value}`).join(" · ")}</Text><CopperProvenance value={node.provenance} /></> : <Text size="sm">Exact endpoint metadata unavailable in the matching inspected graph.</Text>}
    </Stack>;
  }
  return <Stack style={{ overflowWrap: "anywhere" }}><Title order={3}>Declared model query result</Title>
    <Text fw={600}>{readable(result.status)} · {readable(result.reason)}</Text>
    <Text>Query semantics: {readable(result.query)}. Candidate reachability is a declared model result; no returned path is physical proof. No candidate path does not prove physical disconnection.</Text>
    <Text>{queryMeaning[result.query] ?? "This query has no supported explanation of its semantics; no behavior is inferred."}</Text>
    <Text>Model {result.revision_id} · {result.sha256} · review {result.review_id ?? "not accepted"}</Text><Text size="sm">Review state: {result.review_state}</Text>
    <Text>Exact query root: {result.root_revision_id ?? "not supplied"} · Snapshot SHA-256: {result.root_snapshot_sha256 ?? "not supplied"}</Text>
    {!exactGraph && <Alert color="yellow">The inspected graph does not match the query root revision and snapshot hash. Endpoint metadata is unavailable; identities and provenance supplied by the query remain visible.</Alert>}
    <Text>Physical continuity: {readable(result.physical_continuity)}. Signal transfer: {readable(result.signal_transfer)}. Physical qualification: {readable(result.physical_qualification)}.</Text>
    <Text>Compatibility: {readable(result.compatibility ?? "not_evaluated")}. Review acceptance concerns the declared model only.</Text>
    {assumptions ? <Card withBorder><Title order={4}>Exact query assumptions</Title><Text>Component model: {readable(assumptions.component_model)}</Text><Text>Model basis: {assumptions.model_basis}</Text><Text>Copper assumption: {readable(assumptions.copper)}. This is not a measured resistance.</Text><Text>Frequency: {assumptions.frequency_hz ?? "unspecified"}{assumptions.frequency_hz !== null ? " Hz" : ""}</Text><Text>Conditional contact model: {readable(assumptions.conditional_contacts)}</Text><Text>Assigned conditions: {(assumptions.condition_assignments ?? []).map((c) => `${c.condition_id} = ${c.state}`).join("; ") || "none; affected contacts remain unknown"}</Text></Card> : <Text>Query assumptions were not supplied; no defaults are inferred.</Text>}
    {result.limited && <Alert color="yellow">Search limit reached. The aggregate result is unknown; returned paths are incomplete candidates.</Alert>}
    {result.series_resistance_ohm != null && <Text>Declared single-series-path resistance: {result.series_resistance_ohm} Ω. This is not measured or a parallel-network equivalent.</Text>}
    {result.paths.length > 0 && <NativeSelect label="Candidate path to explain" value={String(pathIndex)} data={result.paths.map((p, index) => ({ value: String(index), label: `Candidate path ${index + 1} · ${readable(p.status)}` }))} onChange={(e) => { setPathIndex(Number(e.currentTarget.value)); setStepPage(0); }} />}
    {path && <Card withBorder><Stack><Title order={4}>Candidate path {pathIndex + 1} · {readable(path.status)}</Title>
      <Text>{path.terminal_ids.map(label).join(" → ")}</Text>{path.reasons.map((reason) => <Text key={reason}>{readable(reason)}</Text>)}<Text>Ideal shortness: {readable(path.shortness)}</Text>
      {path.series_resistance_ohm !== null && <Text>Series declared resistance: {path.series_resistance_ohm} Ω</Text>}
      {path.series_impedance_ohm && <Text>Series impedance: {path.series_impedance_ohm.real} + j({path.series_impedance_ohm.imaginary}) Ω · {readable(path.series_impedance_ohm.precision)}. Derived model approximation, not a measurement.</Text>}
      {!!path.conflicting_condition_ids?.length && <Alert color="yellow">Mutually exclusive requirements conflict: {path.conflicting_condition_ids.join(", ")}. These states cannot establish a combined proof.</Alert>}
      {(path.condition_requirements ?? []).map((c) => <Text key={`${c.condition_id}:${c.state}`}>Path requires {c.condition_id} = {c.state} · {readable(c.behavior)}</Text>)}
      <Text>Steps {path.steps.length ? stepPage * PAGE_SIZE + 1 : 0}–{Math.min((stepPage + 1) * PAGE_SIZE, path.steps.length)} of {path.steps.length}</Text>
      {path.steps.slice(stepPage * PAGE_SIZE, (stepPage + 1) * PAGE_SIZE).map((step, index) => <Card withBorder key={`${step.record_id}:${index}`}><Stack gap="xs">
        <Text fw={600}>{readable(step.kind)} · {readable(step.status)}{step.direction ? ` · traversal ${step.direction}` : ""}</Text><Text size="xs">Step record identity: {step.record_id}</Text>
        {terminal(step.from_terminal_id, "From")}{terminal(step.to_terminal_id, "To")}<Text>Basis: {step.basis}</Text><SourceEvidence evidence={step.evidence} />
        {step.provenance ? <CopperProvenance value={step.provenance} /> : <Text size="sm">Declaration scope: model {result.revision_id} · SHA-256 {result.sha256} · review {result.review_id ?? "not accepted"}. No copper origin was supplied for this step.</Text>}
        {step.resistance_ohm !== undefined && <Text>Declared ideal resistance: {step.resistance_ohm} Ω</Text>}{step.capacitance_f !== undefined && <Text>Declared ideal capacitance: {step.capacitance_f} F</Text>}
        {step.condition_requirement && <Text>Requires {step.condition_requirement.condition_id} = {step.condition_requirement.state}; query state {step.assigned_state ?? "unspecified"} · declared ideal contact.</Text>}{step.condition && <Text>Unevaluated condition: {step.condition}</Text>}
      </Stack></Card>)}
      <Group><Button disabled={stepPage === 0} onClick={() => setStepPage(stepPage - 1)}>Previous path steps</Button><Button disabled={(stepPage + 1) * PAGE_SIZE >= path.steps.length} onClick={() => setStepPage(stepPage + 1)}>Next path steps</Button></Group>
    </Stack></Card>}
    <Title order={4}>Unmodeled source boundaries</Title><Text>These source records do not establish usable component behavior or physical associations. A separately reviewed assertion may link a candidate; it does not qualify the source boundary.</Text>
    {result.unmodeled_boundaries === undefined ? <Text>Boundary metadata was not supplied by this query.</Text> : <Text>{boundaries.length} source boundaries. Missing records do not establish physical completeness.</Text>}
    {boundaries.slice(boundaryPage * PAGE_SIZE, (boundaryPage + 1) * PAGE_SIZE).map((boundary) => <Card withBorder key={boundary.id}><Text fw={600}>{readable(boundary.kind)} · {readable(boundary.status)}</Text><Text>{boundary.reason}</Text><Text size="xs">Boundary identity: {boundary.id}</Text><Text>Member identities: {boundary.members.join(" · ") || "none supplied"}</Text><CopperProvenance value={boundary.provenance} /></Card>)}
    {boundaries.length > PAGE_SIZE && <Group><Button disabled={boundaryPage === 0} onClick={() => setBoundaryPage(boundaryPage - 1)}>Previous source boundaries</Button><Button disabled={(boundaryPage + 1) * PAGE_SIZE >= boundaries.length} onClick={() => setBoundaryPage(boundaryPage + 1)}>Next source boundaries</Button></Group>}
  </Stack>;
}
