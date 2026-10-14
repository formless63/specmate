import { Alert, Anchor, Button, Stack, Table, Text } from '@mantine/core';
import { useEffect, useState } from 'react';
import { useCan } from '../../lib/permissions';
import { findReusable, reusedOutputUrl, reuseResult, type ReusableResult, type ReuseRequest } from './api';
import { ReproLevel } from './BuildsPanel';

/**
 * Offers an earlier succeeded attempt over the identical input key instead of a new build
 * (BLD-005). Gated by build.execute: without it nothing is looked up or shown. Reuse runs
 * nothing; it records an explicit link whose reads recheck current workspace authority.
 */
export function ReusableResultOffer({ request, excludeBuildId, onInspect }: {
  request: ReuseRequest | null;
  /** The attempt already being viewed; it is never offered as a reuse of itself. */
  excludeBuildId?: string;
  onInspect?: (buildId: string) => void;
}) {
  const canExecute = useCan('build.execute');
  const [offer, setOffer] = useState<ReusableResult | null>(null);
  const [reused, setReused] = useState<(ReusableResult & { reuse_id: string }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const requestKey = request ? JSON.stringify(request) : '';
  useEffect(() => {
    setOffer(null); setReused(null); setError('');
    if (!canExecute || !requestKey) return;
    let current = true;
    // Keyed by the exact request value; a denied or failed lookup offers nothing rather than guessing.
    findReusable(JSON.parse(requestKey) as ReuseRequest).then(found => { if (current) setOffer(found.reusable); }, () => undefined);
    return () => { current = false; };
  }, [canExecute, requestKey]);
  if (!canExecute || !request || !offer || offer.build_id === excludeBuildId) return null;
  async function reuse() {
    if (!request || !offer) return;
    setBusy(true); setError('');
    try { setReused(await reuseResult(request, offer.build_id)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Reuse failed.'); }
    finally { setBusy(false); }
  }
  return <Alert color="blue" title="Reusable result available" aria-label="Reusable result available">
    <Stack gap="xs">
      <Text size="sm">Attempt {offer.build_id} succeeded on {offer.created_at} over the identical staged inputs, rights, recipe and configuration. Reusing it records a link instead of running the tool again.</Text>
      <ReproLevel level={offer.reproducibility} />
      <Text size="xs">A reused result carries the original attempt's evidence only; it is not a new execution or physical qualification.</Text>
      {!reused && <Button variant="quiet" loading={busy} onClick={() => void reuse()}>Reuse result of {offer.build_id}</Button>}
      {onInspect && <Button variant="subtle" disabled={busy} onClick={() => onInspect(offer.build_id)}>Inspect matched attempt {offer.build_id}</Button>}
      {reused && <>
        <Text size="sm">Reuse recorded ({reused.reuse_id}).</Text>
        <Table><Table.Thead><Table.Tr><Table.Th>Reused output</Table.Th><Table.Th>Exact bytes / rights</Table.Th></Table.Tr></Table.Thead><Table.Tbody>
          {reused.outputs.map(o => <Table.Tr key={o.output_id}><Table.Td><Anchor href={reusedOutputUrl(reused.reuse_id, o.output_id)}>{o.path}</Anchor></Table.Td>
            <Table.Td><Text size="xs">{o.sha256} · {o.size} bytes · {o.rights}</Text></Table.Td></Table.Tr>)}</Table.Tbody></Table>
      </>}
      {error && <Text size="xs" c="red">{error}</Text>}
    </Stack>
  </Alert>;
}
