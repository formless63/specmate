import { ReadOnlyNote, usePermission, InspectionScope } from "../../lib/permissions";
import { Alert, Button, Card, Group, MantineThemeProvider, Select, Stack, Table, Text, TextInput, Textarea, Title } from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { targetLabel, valueLabel, type Evidence, type Fact, type Facts, type Method, type Purpose, type Role, type Status, type Value } from "./api";
import { requestJson, runOperation } from '../workspace/api';

type LedgerProps = { subjectId: string; active?: boolean; principalKey?: string };
export function FactLedger(props: LedgerProps) { return <LedgerSession key={`${props.principalKey ?? "standalone"}:${props.subjectId}`} {...props} />; }
function LedgerSession({ subjectId, active = true, principalKey = "standalone" }: LedgerProps) {
  const cache = useQueryClient();
  const [property, setProperty] = useState("cut_allowance");
  const [offset, setOffset] = useState(0);
  const facts = useQuery({ queryKey: ["fact-ledger", subjectId, property, offset, principalKey], queryFn: () => requestJson<Facts>(`/api/v0/facts/subjects/${subjectId}?property=${encodeURIComponent(property)}&offset=${offset}`, { cache: "no-store" }), enabled: active && !!property, retry: false, refetchOnWindowFocus: "always" });
  const append = useMutation({ mutationFn: (fact: Fact) => runOperation("facts.append", { subject_id: subjectId, fact }, { expectedState: facts.data?.state }), onSuccess: async () => { setOffset(0); await cache.invalidateQueries({ queryKey: ["fact-ledger", subjectId] }); }, onError: async () => { await cache.invalidateQueries({ queryKey: ["fact-ledger", subjectId] }); } });
  const retained = useRef<Facts | null>(null);
  if (facts.data && !facts.isError && !facts.isFetching) retained.current = facts.data;
  const data = facts.data ?? retained.current;
  const available = active && !facts.isError && !facts.isFetching && !!facts.data;
  useEffect(() => { if (!active) return; const focus = () => { void facts.refetch(); }; window.addEventListener('focus', focus); return () => window.removeEventListener('focus', focus); }, [active, facts.refetch]);
  return <MantineThemeProvider theme={{ components: { Select: Select.extend({ defaultProps: { comboboxProps: { withinPortal: false } } }) } }}><Stack>
    {active && <Button variant="quiet" onClick={() => void facts.refetch()}>Refresh fact access</Button>}
    <TextInput disabled={!active || append.isPending} label="Fact property" description="A stable property key, such as width or cut_allowance." value={property} onChange={(e) => { setProperty(e.currentTarget.value); setOffset(0); }} />
    {facts.isError && <Alert color="red">{facts.error.message}</Alert>}
    {data && <div hidden={!available} inert={!available || undefined}>
      <Text size="sm">Subject: {targetLabel(data.target, data.physical_unit_serial)} · {data.state}</Text>
      <Text size="sm">Assertions are attached evidence. Recording a later observation preserves existing frozen design state.</Text>
      {data.assessments[property]?.map((assessment, index) => <Alert key={index} color={assessment.status === "conflicting" ? "orange" : assessment.status === "known" ? "blue" : "gray"} title={`${property}: ${assessment.status.replaceAll("_", " ")}`}><Stack gap="xs"><Text>{assessment.reason ?? `${assessment.purpose} · ${assessment.role}`}</Text><Text>{assessment.value ? `Canonical value: ${valueLabel(assessment.value)}` : assessment.status === "conflicting" ? "Conflicting assertions retained; no value selected." : assessment.status === "known" ? "Multiple compatible candidates retained; no value selected." : "No known value."}</Text>{assessment.conditions?.map((condition) => <Text key={condition.property}>{condition.property}: {condition.status === "known" ? valueLabel(condition.value) : "Unknown"}</Text>)}</Stack></Alert>)}
      <Table><Table.Thead><Table.Tr><Table.Th>Assertion</Table.Th><Table.Th>Status / method</Table.Th><Table.Th>Original value</Table.Th><Table.Th>Purpose / role</Table.Th><Table.Th>Basis / provenance</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{data.assertions.map((assertion) => <Table.Tr key={assertion.assertion_id}><Table.Td>{assertion.assertion_id}<Text size="xs">Recorded {assertion.recorded_at}</Text></Table.Td><Table.Td>{assertion.fact.status} / {assertion.fact.provenance.method}<Text size="xs">Kind: {(assertion.evidence_kind ?? "unclassified").replaceAll("_", " ")}</Text></Table.Td><Table.Td>{valueLabel(assertion.fact.value)}<Text size="xs">Canonical: {valueLabel(assertion.canonical_value)}</Text></Table.Td><Table.Td>{assertion.fact.purpose} / {assertion.fact.role}</Table.Td><Table.Td><Text>{assertion.fact.basis}</Text>{assertion.fact.provenance.evidence.map((evidence, index) => <Text size="xs" key={index}>{evidence.kind === "citation" ? `Unverified citation: ${evidence.citation}` : evidence.kind === "assertion" ? `Input assertion: ${evidence.assertion_id}` : `Registered source: ${evidence.bundle_revision_id} / ${evidence.path}`}</Text>)}{assertion.fact.provenance.instrument && <Text size="xs">Instrument: {assertion.fact.provenance.instrument}</Text>}{assertion.fact.provenance.formula && <Text size="xs">Formula: {assertion.fact.provenance.formula} · {assertion.fact.provenance.algorithm_version}</Text>}</Table.Td></Table.Tr>)}</Table.Tbody></Table>
      <Group><Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous assertions</Button><Button disabled={!data.has_more} onClick={() => setOffset(offset + 50)}>Next assertions</Button></Group>
      <AssertionEditor key={property} property={property} state={data.state} physicalUnit={data.target.kind === "physical_unit"} busy={append.isPending} onAppend={(fact) => { if (available && !append.isPending) append.mutate(fact); }} />
      {append.isError && <Alert color="red">{append.error.message}</Alert>}
      {append.isSuccess && <Alert color="green">Assertion recorded; earlier evidence preserved.</Alert>}
    </div>}
  </Stack></MantineThemeProvider>;
}

function AssertionEditor({ property, state, physicalUnit, busy, onAppend }: { property: string; state: string; physicalUnit: boolean; busy: boolean; onAppend: (fact: Fact) => void }) {
  const appendGate = usePermission(physicalUnit ? "inventory.manage" : "item.create");
  const [status, setStatus] = useState<Status>("unknown");
  const [method, setMethod] = useState<Method>("source_observation");
  const [purpose, setPurpose] = useState<Purpose>("manufacturing");
  const [role, setRole] = useState<Role>(physicalUnit ? "actual" : "nominal");
  const [valueKind, setValueKind] = useState<Value["kind"]>("quantity");
  const [dimension, setDimension] = useState("length");
  const [unit, setUnit] = useState("mm");
  const [magnitude, setMagnitude] = useState("");
  const [lower, setLower] = useState("");
  const [upper, setUpper] = useState("");
  const [minus, setMinus] = useState("");
  const [plus, setPlus] = useState("");
  const [text, setText] = useState("");
  const [boolean, setBoolean] = useState<boolean | null>(null);
  const [basis, setBasis] = useState("");
  const [evidenceKind, setEvidenceKind] = useState<Evidence["kind"]>("citation");
  const [citation, setCitation] = useState("");
  const [bundle, setBundle] = useState("");
  const [sourcePath, setSourcePath] = useState("");
  const [inputIds, setInputIds] = useState("");
  const [formula, setFormula] = useState("");
  const [algorithmVersion, setAlgorithmVersion] = useState("");
  const [observedAt, setObservedAt] = useState("");
  const [instrument, setInstrument] = useState("");
  const [procedure, setProcedure] = useState("");
  const [conditionProperty, setConditionProperty] = useState("");
  const [conditionText, setConditionText] = useState("");
  const [conditionKind, setConditionKind] = useState<"text" | "quantity">("text");
  const [conditionDimension, setConditionDimension] = useState("temperature");
  const [conditionUnit, setConditionUnit] = useState("degC");
  const [conditionMagnitude, setConditionMagnitude] = useState("");
  function submit() {
    let value: Value | null = null;
    if (status === "known") value = valueKind === "quantity" ? { kind: valueKind, dimension, unit, magnitude } : valueKind === "range" ? { kind: valueKind, dimension, unit, lower, upper } : valueKind === "tolerance" ? { kind: valueKind, dimension, unit, minus, plus } : valueKind === "text" ? { kind: valueKind, text } : { kind: valueKind, value: boolean! };
    const evidence: Evidence[] = evidenceKind === "citation" ? [{ kind: "citation", citation }] : evidenceKind === "source_file" ? [{ kind: "source_file", bundle_revision_id: bundle, path: sourcePath }] : inputIds.split(",").map((id) => ({ kind: "assertion", assertion_id: id.trim() }));
    const conditionValue: Value | null = conditionKind === "text" ? (conditionText ? { kind: "text", text: conditionText } : null) : conditionMagnitude ? { kind: "quantity", dimension: conditionDimension, unit: conditionUnit, magnitude: conditionMagnitude } : null;
    const conditions: Fact["conditions"] = conditionProperty ? [{ property: conditionProperty, status: conditionValue ? "known" : "unknown", value: conditionValue }] : [];
    onAppend({ property, status, purpose, role, value, basis, conditions, provenance: { method, evidence, ...(method === "calculation" ? { formula, algorithm_version: algorithmVersion } : {}), ...(method === "measurement" ? { observed_at: observedAt, instrument, procedure } : {}) } });
  }
  const missingEvidence = evidenceKind === "citation" ? !citation.trim() : evidenceKind === "source_file" ? !bundle || !sourcePath : !inputIds.trim();
  const missingValue = status === "known" && (valueKind === "boolean" ? boolean === null : valueKind === "quantity" ? !magnitude : valueKind === "range" ? !lower || !upper : valueKind === "tolerance" ? !minus || !plus : !text);
  return <Card withBorder><Stack>
    <Title order={3}>Record assertion</Title>
    <Text size="sm">Current ledger state: {state}. A correction or a competing source becomes another assertion.</Text>
    <InspectionScope permission={physicalUnit ? 'inventory.manage' : 'item.create'}>
    <Group><Select label="Assertion status" value={status} allowDeselect={false} data={["known", "unknown", "conflicting", "not_applicable", "not_evaluated"]} onChange={(value) => setStatus(value as Status)} /><Select label="Assertion method" value={method} allowDeselect={false} data={physicalUnit ? ["source_observation", "reviewed_association", "calculation", "measurement", "preference"] : ["source_observation", "reviewed_association", "calculation", "preference"]} onChange={(value) => { setMethod(value as Method); if (value === "preference") setPurpose("preference"); else if (purpose === "preference") setPurpose("general"); }} /></Group>
    <Group><Select label="Assertion purpose" value={purpose} allowDeselect={false} data={["general", "manufacturing", "clearance", "illustration", "rating", "preference"]} onChange={(value) => setPurpose(value as Purpose)} /><Select label="Value role" value={role} allowDeselect={false} data={["actual", "nominal", "lower_bound", "upper_bound", "tolerance"]} onChange={(value) => setRole(value as Role)} /></Group>
    {status === "known" && <><Select label="Value type" value={valueKind} allowDeselect={false} data={["quantity", "range", "tolerance", "text", "boolean"]} onChange={(value) => { setValueKind(value as Value["kind"]); if (value === "tolerance") setRole("tolerance"); else if (value === "text" || value === "boolean") setRole("actual"); }} />{["quantity", "range", "tolerance"].includes(valueKind) && <Group><TextInput label="Quantity dimension" value={dimension} onChange={(e) => setDimension(e.currentTarget.value)} /><TextInput label="Original unit" description="Supported examples: mm, cm, m, in, g, kg, V, A, ohm, K, degC, ea." value={unit} onChange={(e) => setUnit(e.currentTarget.value)} /></Group>}{valueKind === "quantity" && <TextInput label="Magnitude" value={magnitude} onChange={(e) => setMagnitude(e.currentTarget.value)} />}{valueKind === "range" && <Group><TextInput label="Range lower" value={lower} onChange={(e) => setLower(e.currentTarget.value)} /><TextInput label="Range upper" value={upper} onChange={(e) => setUpper(e.currentTarget.value)} /></Group>}{valueKind === "tolerance" && <Group><TextInput label="Tolerance minus" value={minus} onChange={(e) => setMinus(e.currentTarget.value)} /><TextInput label="Tolerance plus" value={plus} onChange={(e) => setPlus(e.currentTarget.value)} /></Group>}{valueKind === "text" && <TextInput label="Known text value" value={text} onChange={(e) => setText(e.currentTarget.value)} />}{valueKind === "boolean" && <Select label="Known boolean value" placeholder="Choose an explicit value" value={boolean === null ? null : String(boolean)} allowDeselect={false} data={[{ value: "true", label: "True" }, { value: "false", label: "False" }]} onChange={(value) => setBoolean(value === "true")} />}</>}
    {status !== "known" && <Text>No value will be recorded for this status.</Text>}
    <TextInput label="Condition property" value={conditionProperty} onChange={(e) => setConditionProperty(e.currentTarget.value)} />{conditionProperty && <><Select label="Condition value type" value={conditionKind} allowDeselect={false} data={["text", "quantity"]} onChange={(value) => setConditionKind(value as "text" | "quantity")} />{conditionKind === "text" ? <TextInput label="Condition description" description="Leave empty for an explicitly unknown condition." value={conditionText} onChange={(e) => setConditionText(e.currentTarget.value)} /> : <Group><TextInput label="Condition dimension" value={conditionDimension} onChange={(e) => setConditionDimension(e.currentTarget.value)} /><TextInput label="Condition unit" value={conditionUnit} onChange={(e) => setConditionUnit(e.currentTarget.value)} /><TextInput label="Condition magnitude" description="Leave empty for an explicitly unknown condition." value={conditionMagnitude} onChange={(e) => setConditionMagnitude(e.currentTarget.value)} /></Group>}</>}
    <Textarea label="Assertion basis" value={basis} onChange={(e) => setBasis(e.currentTarget.value)} />
    <Select label="Evidence type" value={evidenceKind} allowDeselect={false} data={["citation", "source_file", "assertion"]} onChange={(value) => setEvidenceKind(value as Evidence["kind"])} />
    {evidenceKind === "citation" && <TextInput label="Evidence citation" description="A declared citation is unverified; it does not authorize external execution or qualify a rating." value={citation} onChange={(e) => setCitation(e.currentTarget.value)} />}
    {evidenceKind === "source_file" && <><TextInput label="Evidence source bundle revision ID" value={bundle} onChange={(e) => setBundle(e.currentTarget.value)} /><TextInput label="Evidence registered source path" value={sourcePath} onChange={(e) => setSourcePath(e.currentTarget.value)} /></>}
    {evidenceKind === "assertion" && <TextInput label="Input assertion IDs" description="Comma-separated exact assertion IDs. Declared conflicts need at least two." value={inputIds} onChange={(e) => setInputIds(e.currentTarget.value)} />}
    {method === "calculation" && <Group><TextInput label="Calculation formula" value={formula} onChange={(e) => setFormula(e.currentTarget.value)} /><TextInput label="Calculation algorithm version" value={algorithmVersion} onChange={(e) => setAlgorithmVersion(e.currentTarget.value)} /></Group>}
    {method === "measurement" && <><TextInput label="Observation time with timezone" placeholder="2026-01-01T12:00:00Z" value={observedAt} onChange={(e) => setObservedAt(e.currentTarget.value)} /><TextInput label="Measurement instrument" value={instrument} onChange={(e) => setInstrument(e.currentTarget.value)} /><Textarea label="Measurement procedure" value={procedure} onChange={(e) => setProcedure(e.currentTarget.value)} /></>}
    <Text size="sm">An illustrative dimension remains an illustration. It cannot qualify manufacturing fit. A reviewed association remains distinct from a measurement.</Text>
    </InspectionScope>
    <Button disabled={!basis.trim() || missingEvidence || missingValue} loading={busy} onClick={submit} {...appendGate.props}>Record immutable assertion</Button><ReadOnlyNote permission={physicalUnit ? "inventory.manage" : "design.edit"}>Recording assertions is unavailable.</ReadOnlyNote>
  </Stack></Card>;
}
