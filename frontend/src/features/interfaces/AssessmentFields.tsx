import { Badge, Button, Card, Group, Select, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { useState } from 'react';
import { EvidenceEditor, OperatingNumberInput } from './declaration-inputs';
import { TemperatureEditor, RatingScopeFacts } from './InterfaceConditions';
import { operating, unknownEvidence, type Assessment, type Bond, type Dimension, type Result, type Status } from './assessment-api';
import { RevisionLabel } from '../../lib/IdentityLabel';

const dimensions: { id: Dimension; label: string }[] = [
  { id: "mating", label: "Mating" }, { id: "pin_correspondence", label: "Pin correspondence" },
  { id: "polarity", label: "Polarity" }, { id: "levels", label: "Levels" }, { id: "current", label: "Current" }, { id: "protocol", label: "Protocol" },
  { id: "shielding", label: "Shielding" }, { id: "grounding", label: "Grounding" }, { id: "fit", label: "Fit" },
];
const choices = [{ value: "unknown", label: "Unknown" }, { value: "satisfied", label: "Declared satisfied" }, { value: "invalid", label: "Declared conflict" }];

export function AssessmentEditor({ value, onChange }: { value: Assessment; onChange: (value: Assessment) => void }) {
  const [rowId, setRowId] = useState("");
  return <Stack>
    <Group><TextInput label="Left exact pinout revision" value={value.left_pinout_revision_id} onChange={e => onChange({ ...value, left_pinout_revision_id: e.currentTarget.value })} /><TextInput label="Right exact pinout revision" value={value.right_pinout_revision_id} onChange={e => onChange({ ...value, right_pinout_revision_id: e.currentTarget.value })} /></Group>
    {(["mating", "fit"] as const).map(d => <Card key={d} withBorder><Stack><Title order={4}>{d === "mating" ? "Mating declaration" : "Fit declaration"}</Title><Select label={`${d} declaration`} data={choices} value={value[d].status} onChange={status => onChange({ ...value, [d]: { ...value[d], status: status as Status } })} /><TextInput label={`${d} basis`} value={value[d].basis ?? ""} onChange={e => onChange({ ...value, [d]: { ...value[d], basis: e.currentTarget.value || null } })} /><EvidenceEditor label={d} value={value[d].evidence} onChange={evidence => onChange({ ...value, [d]: { ...value[d], evidence } })} /></Stack></Card>)}
    <Title order={4}>Proposed contact correspondence and operating conditions</Title>
    <Text>Missing inputs remain unknown. Demand is an explicit operating input, never copied from a current rating. Protocol names do not establish interoperability.</Text>
    {value.pairs.map((pair, i) => {
      const update = (change: Partial<typeof pair>) => onChange({ ...value, pairs: value.pairs.map((p, j) => j === i ? { ...p, ...change } : p) });
      return <Card key={pair.local_id} withBorder><Stack><Title order={5}>Contact row {pair.local_id}</Title><Group>
        <TextInput label={`${pair.local_id} left contact`} value={pair.left_contact_id} onChange={e => update({ left_contact_id: e.currentTarget.value })} /><TextInput label={`${pair.local_id} right contact`} value={pair.right_contact_id} onChange={e => update({ right_contact_id: e.currentTarget.value })} /><TextInput label={`${pair.local_id} expected signal`} value={pair.expected_signal ?? ""} onChange={e => update({ expected_signal: e.currentTarget.value || null })} />
      </Group><TextInput label={`${pair.local_id} correspondence basis`} value={pair.basis} onChange={e => update({ basis: e.currentTarget.value })} /><EvidenceEditor label={`${pair.local_id} correspondence`} value={pair.evidence} onChange={evidence => update({ evidence })} />
      <Group>{(["voltage_min_v", "voltage_max_v", "demand_a"] as const).map(key => <OperatingNumberInput key={key} label={`${pair.local_id} ${key === "demand_a" ? "current demand A" : key === "voltage_min_v" ? "operating minimum V" : "operating maximum V"} (blank = unknown)`} value={pair.operating[key] ?? ""} min={key === "demand_a" ? 0 : undefined} onChange={n => update({ operating: { ...pair.operating, [key]: n } })} />)}</Group>
      {(["required_protocol", "condition", "basis"] as const).map(key => <TextInput key={key} label={`${pair.local_id} operating ${key.replaceAll("_", " ")}`} value={pair.operating[key] ?? ""} onChange={e => update({ operating: { ...pair.operating, [key]: e.currentTarget.value || null } })} />)}
      <TemperatureEditor label={`${pair.local_id} operating temperature`} value={pair.operating.temperature ?? null} onChange={temperature => update({ operating: { ...pair.operating, temperature } })} />
      <TextInput label={`${pair.local_id} operating mode (blank = unknown)`} value={pair.operating.mode ?? ""} onChange={e => update({ operating: { ...pair.operating, mode: e.currentTarget.value || null } })} />
      <EvidenceEditor label={`${pair.local_id} operating`} value={pair.operating.evidence} onChange={evidence => update({ operating: { ...pair.operating, evidence } })} /><Button variant="subtle" onClick={() => onChange({ ...value, pairs: value.pairs.filter((_, j) => j !== i) })}>Remove row {pair.local_id}</Button></Stack></Card>;
    })}
    <Group><TextInput label="New correspondence row ID" value={rowId} onChange={e => setRowId(e.currentTarget.value)} /><Button disabled={!/^[a-z][a-z0-9_-]{0,79}$/.test(rowId) || value.pairs.some(p => p.local_id === rowId)} onClick={() => { onChange({ ...value, pairs: [...value.pairs, { local_id: rowId, left_contact_id: "", right_contact_id: "", expected_signal: null, basis: "", evidence: unknownEvidence(), operating: operating() }] }); setRowId(""); }}>Add correspondence row</Button></Group>
    {(["shielding", "grounding"] as const).map(d => <Card key={d} withBorder><Stack><Title order={4}>{d === "shielding" ? "Shielding intent" : "Grounding intent"}</Title><Group>
      {(["left_contact_id", "right_contact_id", "basis"] as const).map(key => <TextInput key={key} label={`${d} ${key.replaceAll("_", " ")}`} value={value[d][key] ?? ""} onChange={e => onChange({ ...value, [d]: { ...value[d], [key]: e.currentTarget.value || null } })} />)}
      {(["required", "declared"] as const).map(key => <Select key={key} label={`${d} ${key} connection`} value={value[d][key]} data={["unknown", "bonded", "isolated"]} onChange={v => onChange({ ...value, [d]: { ...value[d], [key]: v as Bond["required"] } })} />)}
    </Group><EvidenceEditor label={d} value={value[d].evidence} onChange={evidence => onChange({ ...value, [d]: { ...value[d], evidence } })} /></Stack></Card>)}
  </Stack>;
}

export function AssessmentResults({ result }: { result: Result }) {
  return <Stack><Title order={3}>Separated assessment results</Title><Text><RevisionLabel id={result.left_pinout_revision_id} role="left pinout" /> · <RevisionLabel id={result.right_pinout_revision_id} role="exact right pinout" /></Text>
    {dimensions.map(d => <Card key={d.id} withBorder><Stack><Title order={4}>{d.label}</Title>{result.findings.filter(f => f.dimension === d.id).map((f, i) => <Stack gap="xs" key={`${f.pair_id}:${i}`}>
      <Group><Badge color={f.status === "invalid" ? "red" : f.status === "flagged" ? "orange" : f.status === "unknown" ? "gray" : "blue"}>{f.status === "satisfied" ? "Satisfied by declarations" : f.status === "invalid" ? "Invalid / conflicting declaration" : f.status === "flagged" ? "Flagged for review (allowed, not confirmed)" : "Unknown"}</Badge><Text>{f.pair_id ? `Contact row ${f.pair_id}` : "Exact pinout pair"} · {f.basis.replaceAll("_", " ")}</Text></Group><Text>{f.explanation}</Text>
      {Object.entries(f.facts).filter(([key]) => !["pair", "left", "right", "evidence", "rating_scope"].includes(key)).map(([key, fact]) => <Text size="sm" key={key}>{key.replaceAll("_", " ")}: {fact == null ? "unknown" : String(fact)}</Text>)}
      {f.pair_id && <ContactFacts facts={f.facts} />}
      <RatingScopeFacts value={f.facts.rating_scope} />
      {f.evidence.map((e, j) => <Text size="sm" key={j}>Evidence: {e.status.replaceAll("_", " ")}{e.citation ? ` · ${e.citation}` : ""}{e.source_path ? ` · ${e.source_bundle_revision_id} / ${e.source_path} · SHA-256 ${e.sha256} · rights ${e.rights ?? "unknown"}` : ""}</Text>)}
    </Stack>)}</Stack></Card>)}
    {result.limitations.map(text => <Text key={text}>{text}</Text>)}<Text>Physical qualification: not established.</Text>
  </Stack>;
}
function ContactFacts({ facts }: { facts: Record<string, unknown> }) {
  const pair = facts.pair as { left_contact_id: string; right_contact_id: string; expected_signal: string | null; basis: string; operating: Record<string, unknown> } | undefined;
  return <>{pair && <><Text>{pair.left_contact_id} → {pair.right_contact_id} · expected signal {pair.expected_signal ?? "unknown"} · {pair.basis}</Text><Text>Operating inputs: {Object.entries(pair.operating).filter(([key]) => key !== "evidence").map(([key, value]) => `${key.replaceAll("_", " ")}: ${value == null ? "unknown" : typeof value === "object" ? JSON.stringify(value) : value}`).join(" · ")}</Text></>}
    <Table><Table.Thead><Table.Tr><Table.Th>Retained electrical declaration</Table.Th><Table.Th>Left</Table.Th><Table.Th>Right</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{["signal", "role", "direction", "polarity", "polarity_basis", "voltage_min_v", "voltage_max_v", "current_max_a", "protocol", "condition", "basis"].map(key => <Table.Tr key={key}><Table.Td>{key.replaceAll("_", " ")}</Table.Td>{["left", "right"].map(side => <Table.Td key={side}>{String((facts[side] as Record<string, unknown> | null)?.[key] ?? "unknown")}</Table.Td>)}</Table.Tr>)}</Table.Tbody></Table>
  </>;
}
