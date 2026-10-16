import { Badge, Button, Group, NumberInput } from '@mantine/core';
import { useState } from 'react';
import { DefinitionPickerScope } from '../library/DefinitionSelect';
import { ConnectorCreation } from '../../features/recipes/ConnectorCreation';
import { Pick } from './Pick';
import './recipe.css';

export type Recipe = { fromPort: string; fromEnd: string; stock: string; toEnd: string; toPort: string; lengthMm: number | null };
export const emptyRecipe = (): Recipe => ({ fromPort: '', fromEnd: '', stock: '', toEnd: '', toPort: '', lengthMm: null });
type NewSlot = 'fromPort' | 'toPort' | 'fromEnd' | 'toEnd';
const fields = [ ['fromPort', 'From device port', 'port'], ['fromEnd', 'End A stack', 'end_assembly'], ['stock', 'Wire stock', 'wire_stock'], ['toEnd', 'End B stack', 'end_assembly'], ['toPort', 'To device port', 'port'] ] as const;
/** Changing a pick only prepares a recipe. A proposal is reviewed before any landing changes. */
export function RecipeBar({ value, onChange, active, workspaceId, principalKey, disabled = false, busy = false, questions = 0, onQuestions, onPropose }: { value: Recipe; onChange: (next: Recipe) => void; active: boolean; workspaceId: string; principalKey: string; disabled?: boolean; busy?: boolean; questions?: number; onQuestions?: () => void; onPropose: () => void }) {
  const [sheet, setSheet] = useState<NewSlot | null>(null), [visited, setVisited] = useState<NewSlot[]>([]);
  const open = (slot: NewSlot) => { setVisited(current => current.includes(slot) ? current : [...current, slot]); setSheet(slot); };
  return <DefinitionPickerScope.Provider value={{ key: `${principalKey}:${workspaceId}`, active }}>
    {active && <section className="recipe-bar" aria-label="Cable recipe"><div className="recipe-picks">{fields.map(([key, label, kind]) => <Pick key={key} label={label} kind={kind} value={value[key]} disabled={disabled || busy} onChange={next => onChange({ ...value, [key]: next })} onNew={key === 'stock' ? undefined : () => open(key)} />)}<NumberInput label="Length (mm, blank = unknown)" value={value.lengthMm ?? ''} min={0} disabled={disabled || busy} onChange={next => onChange({ ...value, lengthMm: typeof next === 'number' ? next : null })} /></div><Group gap="xs"><Badge variant="outline">Recipe · exact pins</Badge><Button size="xs" variant="quiet" onClick={onQuestions}>{questions} open question{questions === 1 ? '' : 's'}</Button><Button size="xs" disabled={disabled || busy || fields.some(([key]) => !value[key])} loading={busy} onClick={onPropose}>Propose wiring</Button></Group></section>}
    {visited.map(slot => <ConnectorCreation key={slot} kind={slot.endsWith('Port') ? 'port' : 'end_assembly'} active={active} opened={sheet === slot} workspaceId={workspaceId} principalKey={principalKey} onClose={() => setSheet(null)} onPick={pick => onChange({ ...value, [slot]: pick.revision_id })} />)}
  </DefinitionPickerScope.Provider>;
}
