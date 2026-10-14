import { Alert, Button, Checkbox, Group, Select, Stack, Text, Title } from '@mantine/core';
import { useState } from 'react';
import { command, type RevisionDetail } from './api';
import { useCan } from '../../lib/permissions';

/**
 * Registers a PCB intake for one exact preserved revision, including a reviewed edited
 * derivative. Registration only preserves the selection; extraction stays a separate,
 * explicit request in the PCB tool.
 */
export function RegisterPcbIntake({ workspaceId, projectId, detail, busy, setBusy, onFailure }: {
  workspaceId: string; projectId?: string | null; detail: RevisionDetail; busy: boolean;
  setBusy: (value: boolean) => void; onFailure: (reason: unknown) => void;
}) {
  const canRegister = useCan('source.register');
  const boards = detail.manifest.files.map(entry => entry.path).filter(path => path.toLowerCase().endsWith('.kicad_pcb'));
  const [board, setBoard] = useState<string | null>(boards.length === 1 ? boards[0]! : null);
  const [useHere, setUseHere] = useState(true);
  const [registered, setRegistered] = useState('');
  if (!canRegister || boards.length === 0) return null;
  async function register() {
    if (!board) return;
    setBusy(true); setRegistered('');
    try {
      const result = await command<{ intake_id: string }>('pcb.register_intake', {
        workspace_id: workspaceId, source_revision_id: detail.revision_id, board_path: board,
        ...(projectId && useHere ? { project_id: projectId } : {}),
      });
      setRegistered(result.intake_id);
    } catch (reason) { onFailure(reason); } finally { setBusy(false); }
  }
  return <Stack gap="xs">
    <Title order={4}>Register a PCB intake</Title>
    <Text size="sm">Preserves this exact revision{detail.role === 'derivative' ? ' (an edited derivative; the original stays untouched)' : ''} for PCB interpretation. Nothing is parsed or run until extraction is requested in the PCB tool.</Text>
    <Group align="end">
      <Select label="Board to interpret" data={boards} value={board} onChange={setBoard} disabled={busy} />
      {projectId && <Checkbox label="Use in this project" checked={useHere} onChange={event => setUseHere(event.currentTarget.checked)} disabled={busy} />}
      <Button disabled={!board} loading={busy} onClick={() => void register()}>Register PCB intake</Button>
    </Group>
    {registered && <Alert color="green" role="status">PCB intake <code>{registered}</code> registered for {board}. Open it from the PCB tool to request extraction.</Alert>}
  </Stack>;
}
