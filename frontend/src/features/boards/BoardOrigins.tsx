import { Stack } from '@mantine/core';
import { useState } from 'react';
import { KicadProposal } from './BoardPanel';
import { FrozenDefinitionPicker, type FrozenChoice } from './FrozenDefinitionPicker';
import type { Board } from './api';

export function BoardOrigins({ active, principalKey, onUse }: { active: boolean; principalKey: string; onUse: (board: Board, name: string) => void }) {
  const [choice, setChoice] = useState<FrozenChoice | null>(null);
  return <Stack gap="xs"><FrozenDefinitionPicker label="PCB population basis" kinds={['pcb_population']} active={active} principalKey={principalKey} onPick={setChoice} />
    {choice && <KicadProposal definitions={[]} pinned={{ definitionId: choice.definition_id, revisionId: choice.revision_id }} active={active} principalKey={principalKey} onUse={onUse} />}
  </Stack>;
}
