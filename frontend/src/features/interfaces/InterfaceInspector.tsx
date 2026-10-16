import { formatCoordinates } from '../../lib/format';
import { Alert, Button, Card, Group, Select, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { read, type Inspection, type Trace } from './api';
import { RevisionLabel } from '../../lib/IdentityLabel';
import { BodyFace } from './BodyFace';
import { MatingList } from './Mating';
import { PinSignalCell, PinoutVariantList } from './PinoutSignals';
import { PinoutWorkbench } from '../pinout-editor/PinoutWorkbench';
import { ContactDrawing } from './InterfaceConditions';

export function InterfaceInspector({ revisionId }: { revisionId: string }) {
  const [contactId, setContactId] = useState("");
  const [traced, setTraced] = useState("");
  const [viewSide, setViewSide] = useState<"mating" | "termination" | null>(null);
  const inspected = useQuery({ queryKey: ["interface-inspect", revisionId], queryFn: () => read<Inspection>(`interfaces/revisions/${revisionId}`) });
  const tracedPath = useQuery({ queryKey: ["interface-trace", revisionId, traced], queryFn: () => read<Trace>(`interfaces/revisions/${revisionId}/trace?contact_id=${encodeURIComponent(traced)}`), enabled: !!traced });
  return <Card withBorder><Stack><Title order={3}>Frozen interface inspection</Title><Text size="sm"><RevisionLabel id={revisionId} /></Text>
    {inspected.isError && <Alert color="red">{inspected.error.message}</Alert>}
    <Button disabled={inspected.isFetching} onClick={() => void inspected.refetch()}>Refresh interface authority</Button>
    {inspected.data && !inspected.isError && !inspected.isFetching && <><Text>Compatibility: {inspected.data.compatibility}</Text>
      {inspected.data.interface.kind === "connector_body" && <><Text>Body family: {inspected.data.interface.family ?? "unknown"}; mating role: {inspected.data.interface.mating_role}</Text><BodyFace body={inspected.data.interface} />{inspected.data.pinout_variants && <PinoutVariantList variants={inspected.data.pinout_variants} title="Pinout variants" currentBody={revisionId} />}{inspected.data.mates_with && <MatingList mates={inspected.data.mates_with} matedBy={inspected.data.mated_by ?? []} />}<Text>Viewing side: {inspected.data.interface.drawing_orientation.viewing_side}</Text>{inspected.data.interface.contacts.map((c) => <Text key={c.contact_id}>{c.contact_id}: {c.physical_role} · number {c.number ?? "unknown"} · {c.label || "unlabeled"} · source x,y {formatCoordinates(c.position_mm)} mm</Text>)}</>}
      {inspected.data.interface.kind === "pinout" && <><Text><RevisionLabel id={inspected.data.interface.body_revision_id} role="Body" /></Text><Text>Variant: {inspected.data.interface.variant_label ?? "unnamed"} · role {inspected.data.interface.role ?? "unknown"} · standard {inspected.data.interface.standard ?? "not stated"}</Text><Text>Pin table: {inspected.data.interface.review}; viewing side: {inspected.data.interface.orientation.viewing_side}</Text><PinoutWorkbench value={inspected.data.interface} mode="frozen" definitions={[]} inspection={inspected.data} /><details className="pwb-details"><summary>Full electrical pin table</summary><Table><Table.Thead><Table.Tr><Table.Th>Physical contact</Table.Th><Table.Th>Typed signal</Table.Th><Table.Th>Signal note</Table.Th><Table.Th>Role</Table.Th><Table.Th>Direction</Table.Th><Table.Th>Polarity</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{inspected.data.contacts?.map((c) => <Table.Tr key={c.contact_id}><Table.Td>{c.contact_id} ({c.physical_role})</Table.Td><Table.Td><PinSignalCell row={inspected.data.signals?.[c.contact_id]} /></Table.Td><Table.Td>{c.electrical?.signal ?? "—"}</Table.Td><Table.Td>{c.electrical?.role ?? "unknown"}</Table.Td><Table.Td>{c.electrical?.direction ?? "unknown"}</Table.Td><Table.Td>{c.electrical?.polarity ?? "unknown"} · {c.electrical?.polarity_basis ?? "unknown basis"}</Table.Td></Table.Tr>)}</Table.Tbody></Table></details></>}
      {inspected.data.contact_view && <><Select label="Contact drawing viewing side" value={viewSide ?? inspected.data.contact_view.selected_orientation.viewing_side} data={["mating", "termination"]} onChange={side => setViewSide(side as "mating" | "termination")} /><ContactDrawing view={viewSide && inspected.data.contact_views ? inspected.data.contact_views[viewSide] : inspected.data.contact_view} /></>}
      {inspected.data.contacts?.map(c => c.electrical?.conditional_ratings?.map(r => <Card withBorder key={`${c.contact_id}:${r.local_id}`}><Text>Contact {c.contact_id} conditional rating {r.local_id}: {r.minimum ?? "no minimum"} to {r.maximum} {r.dimension === "voltage" ? "V" : "A"}</Text><Text>Temperature {r.scope.temperature ? `${r.scope.temperature.minimum_c} to ${r.scope.temperature.maximum_c} C` : "unconstrained"} · mode {r.scope.mode ?? "unconstrained"} · basis {r.basis}</Text><Text>Evidence: {JSON.stringify(inspected.data.rating_evidence?.[c.contact_id]?.[r.local_id] ?? r.evidence)}</Text></Card>))}
      {inspected.data.interface.kind === "interface_map" && <><Text><RevisionLabel id={inspected.data.interface.assembly_revision_id} role="Assembly" /></Text><Text><RevisionLabel id={inspected.data.interface.external_pinout_revision_id} role="External pinout" /></Text><Group align="end"><TextInput label="External contact to trace" value={contactId} onChange={(e) => setContactId(e.currentTarget.value)} /><Button disabled={!contactId} onClick={() => setTraced(contactId)}>Trace declared path</Button></Group></>}
    </>}
    {tracedPath.isError && <Alert color="red">{tracedPath.error.message}</Alert>}
    {inspected.data && !inspected.isError && !inspected.isFetching && tracedPath.data && !tracedPath.isError && !tracedPath.isFetching && <><Text>Path: {tracedPath.data.status}. Continuity: {tracedPath.data.continuity}.</Text>{tracedPath.data.targets.map((t) => <Card withBorder key={t.passage_id}><Text>{tracedPath.data.external_contact_id} → {t.path.join(" / ")} · {t.feature_id}</Text><Text size="sm"><RevisionLabel id={t.revision_id} snapshotId={t.snapshot_id} /></Text><Text>Feature status: {t.feature_status}; condition: {t.condition ?? "unknown"}</Text><Text>Declaration: {t.basis}</Text></Card>)}</>}
  </Stack></Card>;
}
