import { Alert, Button, Group, Select, Stack, Text, Textarea, TextInput } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { RevisionPicker } from '../cables/RevisionPicker';
import { requestJson } from '../workspace/api';
import type { RevisionDetail, SourcePage } from '../sources/api';
import type { MechanicalSource, TargetChoice, ModelPin } from '../mechanical-sources/api';
import { MechanicalUncertaintyEditor } from '../mechanical-sources/MechanicalUncertainty';
import { canonical, type Content } from './api';

const local = (prefix: string, rows: { local_id: string }[]) => { let number = 1; while (rows.some(row => row.local_id === `${prefix}${number}`)) number++; return `${prefix}${number}`; };
/** Source and model declarations remain the existing mechanical contract, not inferred geometry. */
export function MechanicalFields({ content, editable, active, workspaceId, principalKey, change }: { content: Content; editable: boolean; active: boolean; workspaceId: string; principalKey: string; change: (content: Content) => void }) {
  const source = content.mechanical_source as MechanicalSource | undefined;
  const [sourceId, setSourceId] = useState<string | null>(null), [sourceAfter, setSourceAfter] = useState<string | null>(null), [target, setTarget] = useState(''), [targetKind, setTargetKind] = useState('board'), [basis, setBasis] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [modelRevision, setModelRevision] = useState(''), [modelId, setModelId] = useState<string | null>(null), [modelTarget, setModelTarget] = useState<string | null>(null), [modelBasis, setModelBasis] = useState('');
  const signature = `${active}:${editable}:${canonical(content)}`, current = useRef(signature); current.current = signature;
  const sources = useQuery({ queryKey: ['part-mechanical-sources', principalKey, workspaceId, sourceAfter], enabled: active && editable, retry: false, queryFn: ({ signal }) => requestJson<SourcePage>(`/api/v0/sources/workspaces/${workspaceId}/revisions${sourceAfter ? `?after=${encodeURIComponent(sourceAfter)}` : ''}`, { signal }) });
  const modelChoices = useQuery({ queryKey: ['part-mechanical-models', principalKey, workspaceId, modelRevision], enabled: active && editable && !!modelRevision, retry: false, queryFn: ({ signal }) => requestJson<TargetChoice>(`/api/v0/mechanical-sources/targets/${modelRevision}`, { signal, cache: 'no-store' }) });
  const choices = active && editable && !modelChoices.isError && !modelChoices.isFetching ? modelChoices.data?.models ?? [] : [];
  const update = (value: MechanicalSource) => change({ ...content, mechanical_source: value });
  async function addModel() {
    const choice = choices.find(row => row.representation_id === modelId);
    if (!source || !active || !editable || busy || !choice || !source.targets.some(row => row.local_id === modelTarget) || !modelBasis.trim()) return;
    const selected = signature; setBusy(true); setError('');
    try {
      const detail = await requestJson<RevisionDetail>(`/api/v0/sources/revisions/${choice.source_revision_id}`, { cache: 'no-store' });
      if (current.current !== selected) return;
      const file = detail.manifest.files.find(row => row.path === choice.path && row.sha256 === choice.sha256);
      if (!file || detail.manifest_sha256 !== choice.source_manifest_sha256) throw new Error('The model does not match the selected exact source manifest.');
      const existing = source.sources.find(row => row.source_revision_id === detail.revision_id);
      const pin = existing ?? { local_id: local('source', source.sources), source_revision_id: detail.revision_id, source_manifest_sha256: detail.manifest_sha256, files: [] };
      const prior = pin.files.find(row => row.path === file.path);
      const format = prior?.format ?? (/\.(stl|obj|glb)$/i.test(file.path) ? 'mesh' : /\.(step|stp)$/i.test(file.path) ? 'step' : 'other');
      const files = [...pin.files.filter(row => row.path !== file.path), { path: file.path, sha256: file.sha256, rights: file.rights, role: 'model' as const, format }];
      const model: ModelPin = { local_id: local('model', source.models), representation_id: choice.representation_id, revision_id: choice.revision_id, snapshot_sha256: choice.snapshot_sha256, source_local_id: pin.local_id, path: file.path, target_local_id: modelTarget!, purpose: 'illustration', units: null, frame: null, accuracy: null, basis: modelBasis.trim() };
      update({ ...source, sources: [...source.sources.filter(row => row.local_id !== pin.local_id), { ...pin, files }], models: [...source.models, model] }); setModelId(null); setModelBasis('');
    } catch (failure) { if (current.current === selected) setError(failure instanceof Error ? failure.message : 'Exact model selection failed.'); }
    finally { setBusy(false); }
  }
  async function add(kind: 'source' | 'target') {
    if (!source || !editable || !active || busy || kind === 'source' && !sourceId || kind === 'target' && (!target || !basis.trim())) return;
    const selected = signature; setBusy(true); setError('');
    try {
      if (kind === 'source') {
        const detail = await requestJson<RevisionDetail>(`/api/v0/sources/revisions/${sourceId}`, { cache: 'no-store' });
        if (current.current !== selected) return;
        if (detail.manifest.files.length > 200) throw new Error('This bundle exceeds the 200-file mechanical source declaration bound. Select a smaller source bundle.');
        update({ ...source, sources: [...source.sources, { local_id: local('source', source.sources), source_revision_id: detail.revision_id, source_manifest_sha256: detail.manifest_sha256, files: detail.manifest.files.map(file => ({ path: file.path, sha256: file.sha256, rights: file.rights, role: 'supporting', format: 'other' })) }] }); setSourceId(null);
      } else {
        const detail = await requestJson<TargetChoice>(`/api/v0/mechanical-sources/targets/${target}`, { cache: 'no-store' });
        if (current.current !== selected) return;
        update({ ...source, targets: [...source.targets, { local_id: local('target', source.targets), role: detail.board ? 'board' : 'hardware', revision_id: detail.revision_id, snapshot_sha256: detail.snapshot_sha256, board: detail.board ? { interpretation_id: detail.board.interpretation_id, interpretation_sha256: detail.board.interpretation_sha256, source_revision_id: detail.board.source_revision_id, source_manifest_sha256: detail.board.source_manifest_sha256, option_id: null } : null, native_component_id: null, basis: basis.trim() }] }); setTarget(''); setBasis('');
      }
    } catch (failure) { if (current.current === selected) setError(failure instanceof Error ? failure.message : 'Exact source selection failed.'); }
    finally { setBusy(false); }
  }
  if (!source) return <Text>Mechanical source declaration unavailable.</Text>;
  return <Stack>{error && <Alert color="red">{error}</Alert>}<Text>Preserved source declarations · no native execution. Geometry, fit, clearance and manufacturability are not evaluated.</Text>
    <Select label="Mechanical item role" disabled={!editable || busy} allowDeselect={false} value={source.item_role} data={['enclosure', 'part', 'hardware']} onChange={role => role && update({ ...source, item_role: role as MechanicalSource['item_role'] })} />
    <Text fw={600}>Exact source files</Text>{source.sources.map(row => <Stack key={row.local_id} gap={4}><Text size="xs">{row.local_id} · {row.source_revision_id} · manifest {row.source_manifest_sha256}</Text>{row.files.map(file => <Group key={file.path}><Text size="sm">{file.path}</Text><Select aria-label={`Role for ${row.local_id} ${file.path}`} disabled={!editable || busy} value={file.role} data={['native', 'recipe', 'model', 'supporting', 'unsupported']} onChange={role => role && update({ ...source, sources: source.sources.map(item => item === row ? { ...item, files: row.files.map(entry => entry === file ? { ...entry, role: role as typeof file.role } : entry) } : item) })} /><Select aria-label={`Format for ${row.local_id} ${file.path}`} disabled={!editable || busy} value={file.format} data={['freecad', 'build123d', 'cadquery', 'step', 'brep', 'mesh', 'other']} onChange={format => format && update({ ...source, sources: source.sources.map(item => item === row ? { ...item, files: row.files.map(entry => entry === file ? { ...entry, format: format as typeof file.format } : entry) } : item) })} /></Group>)}
      {editable && <Button size="xs" variant="quiet" disabled={busy || source.models.some(model => model.source_local_id === row.local_id)} onClick={() => update({ ...source, sources: source.sources.filter(item => item !== row) })}>Remove {row.local_id}</Button>}</Stack>)}
    {editable && <><Select label="Preserved source revision" searchable value={sourceId} data={sources.isError || sources.isFetching ? [] : (sources.data?.revisions ?? []).filter(row => !source.sources.some(item => item.source_revision_id === row.revision_id)).map(row => ({ value: row.revision_id, label: `${row.name} · r${row.number}` }))} onChange={setSourceId} />{sources.isError && <Alert color="red">{sources.error.message}</Alert>}<Group><Button size="xs" disabled={!sourceId} loading={busy} onClick={() => void add('source')}>Add exact source</Button><Button size="xs" variant="quiet" disabled={!sources.data?.next_after || sources.isFetching || sources.isError} onClick={() => setSourceAfter(sources.data!.next_after)}>More source choices</Button></Group></>}
    <Text fw={600}>Declared targets</Text>{source.targets.map(row => <Stack key={row.local_id} gap={4}><Text>{row.local_id} · {row.role} · {row.revision_id}</Text><Text>{row.basis}</Text>{editable && <Button size="xs" variant="quiet" disabled={busy || source.models.some(model => model.target_local_id === row.local_id)} onClick={() => update({ ...source, targets: source.targets.filter(item => item !== row) })}>Remove {row.local_id}</Button>}</Stack>)}
    {editable && <><Select label="Mechanical target kind" allowDeselect={false} value={targetKind} data={['board', 'pcb_population', 'part', 'hardware', 'connector_body', 'mechanical_source']} onChange={kind => { if (kind) { setTargetKind(kind); setTarget(''); } }} /><RevisionPicker kind={targetKind} label="Mechanical target" value={target} onChange={setTarget} /><Textarea label="Mechanical target basis" value={basis} onChange={event => setBasis(event.currentTarget.value)} /><Button disabled={!target || !basis.trim()} loading={busy} onClick={() => void add('target')}>Add declared target</Button></>}
    <Text fw={600}>Pinned models</Text>{source.models.length === 0 && <Text>No model declarations. Geometry unknown.</Text>}{source.models.map(row => <Stack key={row.local_id} gap={4}><Text>{row.local_id} · {row.path} · {row.purpose}</Text><Text size="xs">{row.source_local_id} → {row.target_local_id} · units {row.units ?? 'unknown'} · frame {row.frame ?? 'unknown'} · accuracy {row.accuracy ?? 'unknown'}</Text><Text>{row.basis}</Text>{editable && <><Select label={`Purpose for ${row.local_id}`} allowDeselect={false} value={row.purpose} data={['illustration', 'clearance', 'manufacturing']} onChange={purpose => purpose && update({ ...source, models: source.models.map(item => item === row ? { ...row, purpose: purpose as ModelPin['purpose'] } : item) })} /><Select label={`Units for ${row.local_id}`} clearable placeholder="Unknown" value={row.units} data={['mm', 'm', 'in']} onChange={units => update({ ...source, models: source.models.map(item => item === row ? { ...row, units: units as ModelPin['units'] } : item) })} /><TextInput label={`Frame for ${row.local_id}`} value={row.frame ?? ''} onChange={event => update({ ...source, models: source.models.map(item => item === row ? { ...row, frame: event.currentTarget.value.trim() || null } : item) })} /><TextInput label={`Accuracy for ${row.local_id}`} value={row.accuracy ?? ''} onChange={event => update({ ...source, models: source.models.map(item => item === row ? { ...row, accuracy: event.currentTarget.value.trim() || null } : item) })} /><Button size="xs" variant="quiet" onClick={() => update({ ...source, models: source.models.filter(item => item !== row) })}>Remove model {row.local_id}</Button></>}</Stack>)}
    {editable && <><RevisionPicker kind="part" label="Model-bearing part" value={modelRevision} onChange={value => { setModelRevision(value); setModelId(null); }} /><Select label="Exact source model" value={modelId} data={choices.map(row => ({ value: row.representation_id, label: `${row.label} · ${row.path}` }))} onChange={setModelId} />{modelChoices.isError && <Alert color="red">{modelChoices.error.message}</Alert>}<Select label="Model target" value={modelTarget} data={source.targets.map(row => ({ value: row.local_id, label: row.local_id }))} onChange={setModelTarget} /><Textarea label="Model correspondence basis" value={modelBasis} onChange={event => setModelBasis(event.currentTarget.value)} /><Button disabled={!modelId || !modelTarget || !modelBasis.trim() || !choices.some(row => row.representation_id === modelId)} loading={busy} onClick={() => void addModel()}>Add exact model declaration</Button></>}
    <Textarea label="Mechanical limitations" description="One authored limitation per line." value={source.limitations.join('\n')} readOnly={!editable} onChange={event => update({ ...source, limitations: event.currentTarget.value.split('\n').filter(Boolean) })} />
    {editable && <MechanicalUncertaintyEditor source={source} onChange={uncertainty => update({ ...source, uncertainty })} />}
  </Stack>;
}
