import { Alert, Button, Group, Stack, Text, TextInput } from '@mantine/core';
import { useState } from 'react';
import { InspectionScope, useCan } from '../../lib/permissions';
import { command, registerBlob } from '../sources/api';

const MESH = /\.(stl|obj|3mf)$/i;
const MAX_BYTES = 16 * 1024 * 1024;
const message = (e: unknown) => e instanceof Error ? e.message : String(e);

/**
 * One step from a model file to a frozen mechanical part a preparation can pin: preserves the exact bytes as an
 * original source bundle, declares a mechanical part with that one model file, and freezes it. Rights are declared,
 * never verified, and no geometry is validated here.
 */
export function ModelUpload({ workspaceId, onCreated }: { workspaceId: string; onCreated: (mechanicalRevisionId: string, name: string) => void }) {
  const canRegister = useCan('source.register');
  const canCreate = useCan('item.create');
  const canFreeze = useCan('design.freeze');
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [rights, setRights] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const missing = [!canRegister && 'source.register', !canCreate && 'item.create', !canFreeze && 'design.freeze'].filter(Boolean) as string[];
  const tooBig = !!file && file.size > MAX_BYTES;
  const notMesh = !!file && !MESH.test(file.name);

  const submit = async () => {
    if (!file || !name.trim() || !rights.trim()) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const sha256 = await registerBlob(workspaceId, file);
      const bundle = await command<{ revision_id: string; manifest_sha256: string }>('source.create_original_bundle', {
        workspace_id: workspaceId, name: name.trim(), files: [{ path: file.name, sha256, media_type: 'application/octet-stream', rights: rights.trim() }],
      });
      const draft = await command<{ draft_id: string; state: string }>('mechanical_source.create', {
        workspace_id: workspaceId, name: name.trim(),
        mechanical_source: { item_role: 'part', sources: [{ local_id: 'original', source_revision_id: bundle.revision_id, source_manifest_sha256: bundle.manifest_sha256,
          files: [{ path: file.name, sha256, rights: rights.trim(), role: 'model', format: 'mesh' }] }] },
      });
      const frozen = await command<{ revision_id: string; number: number }>('mechanical_source.freeze', { draft_id: draft.draft_id }, { expectedState: draft.state });
      setNotice(`Preserved ${file.name} and froze mechanical part ${name.trim()} r${frozen.number}.`);
      setFile(null); setName(''); setRights('');
      onCreated(frozen.revision_id, name.trim());
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };

  return <Stack component="section" aria-label="Add a printable model" gap="xs">
    <Text fw={600} size="sm">Add a printable model</Text>
    <Text size="xs" c="dimmed">Preserves the exact file bytes, declares a mechanical part from it and freezes that part so a preparation can pin it. Geometry is not validated.</Text>
    {error && <Alert color="red" role="alert">{error}</Alert>}
    {notice && <Alert color="green" role="status">{notice}</Alert>}
    {missing.length > 0 && <Text size="sm">Adding a model needs {missing.join(', ')}; ask a workspace editor to add the part, then choose it below.</Text>}
    <InspectionScope permission="source.register">
      <Group align="end">
        <label><Text size="sm">Model file (STL, up to 16 MiB)</Text>
          <input aria-label="Model file to upload" type="file" accept=".stl,.obj,.3mf" disabled={busy || missing.length > 0}
            onChange={event => { const selected = event.currentTarget.files?.[0] ?? null; setFile(selected); if (selected) setName(selected.name.replace(/\.[^.]+$/, '')); }} /></label>
        <TextInput label="Part name" value={name} disabled={busy} onChange={e => setName(e.currentTarget.value)} />
        <TextInput label="Declared rights" description="A declaration, not license verification." value={rights} disabled={busy} onChange={e => setRights(e.currentTarget.value)} />
        <Button onClick={() => void submit()} loading={busy} disabled={!file || tooBig || !name.trim() || !rights.trim() || missing.length > 0}>Preserve model and freeze part</Button>
      </Group>
    </InspectionScope>
    {tooBig && <Text size="sm" c="red">This file exceeds the 16 MiB limit.</Text>}
    {notMesh && <Text size="sm">Only STL meshes are qualified OrcaSlicer inputs; this file will be preserved but slicing will be blocked.</Text>}
  </Stack>;
}
