import { Alert, Stack, Text, Title } from '@mantine/core';
import { useEffect, useState } from 'react';
import { listParameters, type ParameterSpec } from './api';
import { ProfilesSection } from './ProfilesSection';
import { PreparationsSection } from './PreparationsSection';

/**
 * Optional printing preparation. `projectId` is navigation context only; profiles and
 * preparations are workspace items. Nothing here operates or submits to a printer.
 */
export function PrintingPanel({ workspaceId, projectId }: { workspaceId: string; projectId: string | null }) {
  const [specs, setSpecs] = useState<ParameterSpec[]>([]);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    listParameters().then(found => { if (alive) setSpecs(found); }).catch(e => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, []);
  return <Stack>
    <Title order={2}>Print preparation</Title>
    <Text size="sm">Optional. Profiles, manufacturing variants and slicing provenance. Preparation is not printer operation, printability or physical qualification.</Text>
    {error && <Alert color="red" role="alert">{error}</Alert>}
    <ProfilesSection projectId={projectId} specs={specs} onChanged={() => setTick(value => value + 1)} />
    <PreparationsSection workspaceId={workspaceId} projectId={projectId} refreshKey={tick} />
  </Stack>;
}
