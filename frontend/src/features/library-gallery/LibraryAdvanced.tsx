import { Button, Group, Stack, Text } from '@mantine/core';
import { lazy, Suspense, useState } from 'react';
import { useNavigation } from '../navigation';

const CatalogLookup = lazy(() => import('../discovery/CatalogLookup').then(module => ({ default: module.CatalogLookup })));
const Matching = lazy(() => import('../catalog-matching/MatchingWorkspace').then(module => ({ default: module.MatchingWorkspace })));
const Upgrades = lazy(() => import('../revision-upgrades/RevisionUpgradeWorkspace').then(module => ({ default: module.RevisionUpgradeWorkspace })));
const options = [{ id: 'lookup', label: 'Catalog lookup' }, { id: 'matching', label: 'Catalog matching' }, { id: 'revision-upgrades', label: 'Revision upgrades' }];

/** Less frequent catalog operations stay available without another navigation destination. */
export function LibraryAdvanced({ principalKey }: { principalKey: string }) {
  const navigation = useNavigation();
  const selected = navigation?.location.filters?.section;
  const requested = options.some(option => option.id === selected) ? selected! : null;
  const [opened, setOpened] = useState(!!requested);
  const [tool, setTool] = useState(requested ?? 'lookup');
  const [mounted, setMounted] = useState(!!requested);
  const [lastRequested, setLastRequested] = useState(requested);
  const [visited, setVisited] = useState(() => new Set([tool]));
  if (requested !== lastRequested) { setLastRequested(requested); if (requested) { setOpened(true); setMounted(true); setTool(requested); setVisited(current => new Set([...current, requested])); } }
  const projectId = navigation?.location.project ?? null;
  return <details open={opened} onToggle={event => { setOpened(event.currentTarget.open); if (event.currentTarget.open) setMounted(true); }}>
    <summary>Advanced</summary>
    {mounted && <Stack gap="xs"><Group gap="xs" aria-label="Advanced catalog tools">{options.map(option => <Button key={option.id} size="xs" variant={tool === option.id ? 'light' : 'quiet'} onClick={() => { setTool(option.id); setVisited(current => new Set([...current, option.id])); }}>{option.label}</Button>)}</Group>
      <Suspense fallback={<Text role="status">Loading catalog tools…</Text>}>
        {visited.has('lookup') && <div hidden={tool !== 'lookup'}><CatalogLookup projectId={projectId} /></div>}
        {visited.has('matching') && <div hidden={tool !== 'matching'}><Matching projectId={projectId} /></div>}
        {visited.has('revision-upgrades') && <div hidden={tool !== 'revision-upgrades'}><Upgrades principalKey={principalKey} projectId={projectId} active={opened && tool === 'revision-upgrades'} /></div>}
      </Suspense>
    </Stack>}
  </details>;
}
