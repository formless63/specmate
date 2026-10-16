import { Alert, Badge, Button, Group, Stack, Text, TextInput } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { EditorFrame, type EditorView } from '../../components/editor';
import { DefinitionPickerScope } from '../../components/library/DefinitionSelect';
import { InspectionScope, usePermission } from '../../lib/permissions';
import { randomUUID } from '../../lib/random-id';
import { CableWorkbench } from '../cable-workbench/CableWorkbench';
import { CableFields, EndCard, useBodies, useCableSources } from '../cables/CablePanel';
import { cableProblems, initialCable, type Cable, type Draft } from '../cables/api';
import { connectorReferences } from '../interfaces/useConnectorSession';
import { authorizeConnectorReferences, connectorCommand } from '../interfaces/connector-api';
import { useNavigation } from '../navigation';
import { RecipeComposer } from '../recipes/RecipeComposer';
import { requestJson } from '../workspace/api';

type Mode = 'ports' | 'blank';
type Props = { active: boolean; workspaceId: string; principalKey: string };
export function NewCable(props: Props) { return <NewCableSession key={`${props.principalKey}:${props.workspaceId}`} {...props} />; }
function NewCableSession(props: Props) {
  const navigation = useNavigation(), start = navigation?.location.filters?.start;
  const mode: Mode | null = start === 'ports' || start === 'blank' ? start : null;
  const [visited, setVisited] = useState<Mode[]>(mode ? [mode] : []);
  if (mode && !visited.includes(mode)) setVisited(current => [...current, mode]);
  return <Stack gap="sm"><Group><Button variant="quiet" onClick={() => navigation?.navigate({ area: 'designs', lens: 'new-design', probe: null, filters: {} })}>Choose design type</Button>{mode && <Button variant="quiet" onClick={() => navigation?.navigate({ filters: { kind: 'cable' } })}>Choose cable start</Button>}</Group>
    {!mode && <section aria-label="Start a cable"><Text component="h1" fw={600}>New cable</Text><Group><Button onClick={() => navigation?.navigate({ filters: { kind: 'cable', start: 'blank' } })}>Start blank cable</Button><Button variant="quiet" onClick={() => navigation?.navigate({ filters: { kind: 'cable', start: 'ports' } })}>Start from two device ports</Button></Group><Text size="sm">Start freely and map pins by hand. Device-port requirements are optional; pinout variants remain separate exact records.</Text></section>}
    {visited.map(value => <div key={value} hidden={mode !== value}><CableCreation {...props} active={props.active && mode === value} mode={value} /></div>)}
  </Stack>;
}
function CableCreation({ active, workspaceId, principalKey, mode }: Props & { mode: Mode }) {
  const navigation = useNavigation(), cache = useQueryClient(), create = usePermission('item.create');
  const [value, setValue] = useState<Cable>(initialCable()), [name, setName] = useState(''), [view, setView] = useState<EditorView>('build'), [busy, setBusy] = useState(false), [error, setError] = useState(''), [created, setCreated] = useState<string | null>(null);
  const alive = useRef(true), latest = useRef({ active }); latest.current = { active }; const keys = useRef(new Map<string,string>());
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const [activation, setActivation] = useState({ active, generation: 0 }); const generation = activation.generation+(activation.active !== active ? 1 : 0); if (activation.active !== active) setActivation({ active, generation });
  const authority = useQuery({ queryKey: ['new-cable-authority', principalKey, workspaceId, connectorReferences(value), generation], enabled: active, retry: false, refetchOnWindowFocus: 'always', queryFn: async ({ signal }) => { const access = await requestJson<{ workspace_id: string; permissions: string[] }>('/api/v0/access/workspace', { signal, cache: 'no-store' }); if (access.workspace_id !== workspaceId) throw new Error('Workspace unavailable.'); await authorizeConnectorReferences(value); return access; } });
  useEffect(() => { if (!active) return; const focus = () => { void authority.refetch(); }; window.addEventListener('focus', focus); return () => window.removeEventListener('focus', focus); }, [active, authority.refetch]);
  const sources = useCableSources(value, workspaceId), stacks = sources.resolved.map(row => row.data), bodies = useBodies(stacks);
  const readable = active && !authority.isError && !authority.isFetching && !!authority.data && !sources.denied;
  const editable = readable && create.allowed && authority.data!.permissions.includes('item.create') && !busy && !created;
  const change = (next: Cable) => { if (editable) setValue(next); };
  const save = async () => {
    if (!editable || !name.trim()) return; const problems = cableProblems(value); if (problems.length) { setError(problems.join(' ')); return; } setBusy(true); setError('');
    const payload = { workspace_id: workspaceId, name: name.trim(), cable: value }, fingerprint = JSON.stringify(payload); if (!keys.current.has(fingerprint)) keys.current.set(fingerprint, randomUUID());
    try { await authority.refetch({ throwOnError: true }); if (!alive.current || !latest.current.active) return; const result = await connectorCommand<Draft>('cable.create', payload, undefined, keys.current.get(fingerprint)!); if (!alive.current) return; setCreated(result.definition_id); await cache.invalidateQueries({ queryKey: ['workspace','designs'] }); if (latest.current.active) navigation?.navigate({ area: 'designs', lens: 'cables', project: null, probe: { object: result.definition_id, rev: null, path: [] }, filters: { status: 'draft' } }); }
    catch (failure) { if (alive.current) { setError(failure instanceof Error ? failure.message : 'Cable draft could not be created.'); void authority.refetch(); } }
    finally { if (alive.current) setBusy(false); }
  };
  return <DefinitionPickerScope.Provider value={{ key: `${principalKey}:${workspaceId}`, active: readable }}>{active && !readable && <Alert color={authority.isError || sources.denied ? 'red' : 'blue'}>{authority.isError || sources.denied ? 'New cable sources are unavailable. Prepared values remain hidden.' : 'Rechecking new cable access…'}<Button onClick={() => void authority.refetch()}>Retry new cable access</Button></Alert>}
    <div hidden={!readable} inert={!readable || undefined}><EditorFrame name={name.trim() || 'New cable'} view={view} onView={setView} revision={<Badge variant="outline">New · unsaved</Badge>} status={<Text size="xs">Proposal and declared wiring · physical qualification not evaluated</Text>} actions={<Button disabled={!editable || !name.trim()} loading={busy} onClick={() => void save()}>Create cable draft</Button>}>
      <TextInput label="Cable name" value={name} disabled={!editable} onChange={event => setName(event.currentTarget.value)} />{error && <Alert color="red">{error}</Alert>}{created && <Group><Text>Draft created.</Text><Button onClick={() => navigation?.navigate({ area: 'designs', lens: 'cables', project: null, probe: { object: created, rev: null, path: [] }, filters: { status: 'draft' } })}>Open created cable</Button></Group>}
      {mode === 'ports' && <RecipeComposer active={readable && view === 'build'} workspaceId={workspaceId} principalKey={principalKey} name={name} current={value.stock_revision_id ? value : null} disabled={!editable} onApply={change} />}
      <div hidden={view !== 'build'}><CableWorkbench mode="new" name={name || 'New cable'} cable={value} onChange={editable ? change : undefined} stacks={readable ? stacks : []} bodies={readable ? bodies : []} stock={readable ? sources.stock.data : undefined} revision={{ value: 'New', sub: 'not saved' }} editor={{ active: readable && view === 'build', dirty: true, notes: <Text>Save a draft before attaching record notes.</Text>, recipe: <InspectionScope permission="item.create"><CableFields value={value} onChange={change} sources={sources} showSelections={mode === 'blank'} /></InspectionScope> }} endForms={value.endpoints.map((_end,index) => <InspectionScope key={index} permission="item.create"><EndCard index={index} value={value} onChange={change} family={sources.family} choices={sources.choices} denied={!readable} resolved={sources.resolved[index]!} errors={{}} /></InspectionScope>)} /></div>
      {view !== 'build' && <Text>Save this cable draft to use its {view === 'schematic' ? 'schematic' : 'documents'} view.</Text>}
    </EditorFrame></div>
  </DefinitionPickerScope.Provider>;
}
