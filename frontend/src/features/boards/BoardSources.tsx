import { Alert, Anchor, Badge, Button, Group, Stack, Table, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { RecordSections } from '../../components/record';
import { RevisionLabel } from '../../lib/IdentityLabel';
import { usePermission } from '../../lib/permissions';
import { randomUUID } from '../../lib/random-id';
import { command, getIntake, type PopulationReview } from '../pcb/api';
import { UpgradeOffer, UpgradeProvenance } from '../pcb/FormatUpgrade';
import { PcbFabricationPanel } from '../pcb-fabrication/PcbFabricationPanel';

/** Inspect/request against one exact intake. New attempts never repin the selected record. */
export function BoardSources({ review, active, principalKey, onAccessLost, onOpenIntake }: { review: PopulationReview; active: boolean; principalKey: string; onAccessLost: (error: unknown) => void; onOpenIntake: (id: string) => void }) {
  return <SelectedSources key={`${principalKey}:${review.interpretation.intake_id}:${review.interpretation.interpretation_id}`} review={review} active={active} principalKey={principalKey} onAccessLost={onAccessLost} onOpenIntake={onOpenIntake} />;
}
function SelectedSources({ review, active, principalKey, onAccessLost, onOpenIntake }: { review: PopulationReview; active: boolean; principalKey: string; onAccessLost: (error: unknown) => void; onOpenIntake: (id: string) => void }) {
  const pin = review.interpretation; const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const execute = usePermission('build.execute'); const source = usePermission('source.register');
  const epoch = useRef(0); const alive = useRef(false); const currentActive = useRef(active); currentActive.current = active;
  const keys = useRef(new Map<string, string>()); const inFlight = useRef(false);
  useEffect(() => { alive.current = true; epoch.current += 1; return () => { alive.current = false; epoch.current += 1; }; }, [principalKey]);
  const intake = useQuery({ queryKey: ['board-record-source', principalKey, pin.intake_id], enabled: active, retry: false, refetchOnWindowFocus: 'always', queryFn: ({ signal }) => getIntake(pin.intake_id, signal) });
  useEffect(() => { if (intake.isError) onAccessLost(intake.error); }, [intake.isError, intake.error, onAccessLost]);
  useEffect(() => { if (!active) return; const refresh = () => { void intake.refetch(); }; window.addEventListener('focus', refresh); const pending = intake.data?.attempts.some(attempt => !['succeeded', 'failed', 'cancelled'].includes(attempt.state)) || intake.data?.upgrade?.attempts.some(attempt => !['succeeded', 'failed', 'cancelled'].includes(attempt.state)); const timer = pending ? window.setInterval(refresh, 3000) : undefined; return () => { window.removeEventListener('focus', refresh); if (timer) window.clearInterval(timer); }; }, [active, intake.refetch, intake.data]);
  async function run(operation: string, payload: object, permission: boolean) {
    if (!alive.current || !currentActive.current || inFlight.current || !permission || intake.isError || intake.isFetching || !intake.data) return;
    const requestEpoch = epoch.current; const fingerprint = JSON.stringify([operation, payload]); const key = keys.current.get(fingerprint) ?? randomUUID(); keys.current.set(fingerprint, key); inFlight.current = true; setBusy(true); setError('');
    try { const result = await command<{ intake_id?: string }>(operation, payload, undefined, undefined, key); if (!alive.current || requestEpoch !== epoch.current) return;
      setNotice(result.intake_id && result.intake_id !== pin.intake_id ? `Recorded derivative intake ${result.intake_id}. This record retains its selected source and interpretation.` : 'Recorded. The selected record pins are unchanged.'); await intake.refetch();
    } catch (failure) { if (alive.current && requestEpoch === epoch.current) { setError(failure instanceof Error ? failure.message : String(failure)); onAccessLost(failure); } }
    finally { if (alive.current && requestEpoch === epoch.current) { inFlight.current = false; setBusy(false); } }
  }
  const retained = useRef<typeof intake.data>(undefined);
  const available = active && intake.isSuccess && !intake.isFetching && !intake.isError;
  if (available) retained.current = intake.data;
  const data = retained.current;
  const status = active && !available ? intake.isError ? <Alert color="red">Exact source intake unavailable. Retained files and jobs are hidden.</Alert> : <Text role="status">Reading exact source intake…</Text> : null;
  if (!data) return status;
  const selected = data.interpretations.find(item => item.interpretation_id === pin.interpretation_id && item.sha256 === pin.sha256);
  if (!selected || data.source_revision_id !== pin.source_revision_id || data.source_manifest_sha256 !== pin.source_manifest_sha256) return <Alert color="red">Selected source/report pins do not match this intake. No newest report was substituted.</Alert>;
  return <>{status}<Stack gap="xs" hidden={!available} inert={!available}><RevisionLabel kind="source" id={pin.source_revision_id} role="Selected source" /><Text size="xs">{pin.board_path} · accepted report {pin.interpretation_id} · SHA-256 {pin.sha256}</Text>
    {error && <Alert color="red">{error}</Alert>}{notice && <Text role="status" size="xs">{notice}</Text>}
    {data.format_upgrade && <UpgradeProvenance upgrade={data.format_upgrade} />}
    <Table.ScrollContainer minWidth={300}><Table verticalSpacing={4}><Table.Thead><Table.Tr><Table.Th>Preserved file</Table.Th><Table.Th>Rights / coverage</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{data.files.slice(page * 25, page * 25 + 25).map(file => <Table.Tr key={file.path}><Table.Td><Anchor href={`/api/v0/pcb/intakes/${data.intake_id}/original?path=${encodeURIComponent(file.path)}`}>{file.path}</Anchor><Text size="xs">{file.sha256}</Text></Table.Td><Table.Td>{file.rights}<Text size="xs">{file.coverage}</Text></Table.Td></Table.Tr>)}</Table.Tbody></Table></Table.ScrollContainer>
    <Group gap="xs"><Button size="xs" variant="quiet" disabled={!page} onClick={() => setPage(value => value - 1)}>Previous files</Button><Button size="xs" variant="quiet" disabled={(page + 1) * 25 >= data.files.length} onClick={() => setPage(value => value + 1)}>More files</Button></Group>
    <Text size="xs">The selected accepted interpretation drives the drawing. Requesting or accepting another report does not change this definition, draft or frozen revision.</Text>
    {execute.allowed && <Button size="xs" loading={busy} disabled={!data.available_recipe_id} onClick={() => void run('pcb.request_extraction', { intake_id: data.intake_id, recipe_id: data.available_recipe_id }, execute.allowed)}>Request native extraction</Button>}
    {!data.available_recipe_id && <Text size="xs">Extraction unavailable on this installation. Originals are retained.</Text>}
    {data.attempts.map(attempt => <Group gap="xs" key={attempt.attempt_id}><Text size="xs">Extraction {attempt.attempt_id.slice(0, 8)}</Text><Badge>{attempt.state}</Badge>{attempt.diagnostic && <Text size="xs">{attempt.diagnostic}</Text>}{attempt.state === 'succeeded' && source.allowed && !data.interpretations.some(item => item.attempt_id === attempt.attempt_id) && <Button size="xs" disabled={busy} onClick={() => void run('pcb.accept_extraction', { attempt_id: attempt.attempt_id }, source.allowed)}>Validate interpretation</Button>}</Group>)}
    {data.upgrade && <UpgradeOffer upgrade={data.upgrade} busy={busy} onRequest={() => void run('pcb.request_upgrade', { intake_id: data.intake_id, recipe_id: data.upgrade?.available_recipe_id }, execute.allowed)} onAccept={id => void run('pcb.accept_upgrade', { upgrade_attempt_id: id }, source.allowed)} onOpen={onOpenIntake} />}
    <RecordSections sections={[{ id: 'fabrication', label: 'Fabrication for this exact intake', content: () => <PcbFabricationPanel intakeId={data.intake_id} blocked={intake.isError} enabled={available} /> }]} />
    <Button size="xs" variant="quiet" onClick={() => void intake.refetch()}>Refresh exact source</Button>
  </Stack></>;
}
