import { Alert, Button, Stack, Text } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RevisionPicker } from '../cables/RevisionPicker';
import { sha256Hex } from '../../lib/sha256';
import { command } from '../identity/api';
import { requestJson } from '../workspace/api';
import type { StockRecord } from './api';
import type { StockSpecification } from '../../../../packages/section-layout/src';

type Pin = { local_id: string; revision_id: string; snapshot_sha256: string };
type Recipe = { schema_version: '1'; template: StockSpecification; constituents: Pin[]; bindings: { element_path: string; target_field: string; formula: string; round_digits?: number | null; inputs: { constituent_local_id: string; field: string }[] }[]; source: string; recompute_layout: string; recompute_boundaries?: boolean };
/** Replacing a constituent is a deliberate exact-pin proposal; compilation uses
 * the shared operation and saved draft CAS. Frozen consumers never change. */
export function StockRecipePanel({ active, principalKey, current, revisionId, editable, dirty, onCompiled }: { active: boolean; principalKey: string; current: StockRecord | null; revisionId: string | null; editable: boolean; dirty: boolean; onCompiled: (record: StockRecord) => void }) {
  const frozen = useQuery({ queryKey: ['stock-recipe', principalKey, revisionId], enabled: active && !!revisionId, retry: false,
    queryFn: ({ signal }) => requestJson<{content: {stock_recipe?: Recipe}}>(`/api/v0/revisions/${revisionId}/snapshot`, {signal,cache:'no-store'}) });
  const recipe = revisionId ? frozen.isFetching || frozen.isError ? undefined : frozen.data?.content.stock_recipe : current?.content.stock_recipe as Recipe | undefined;
  const [proposal,setProposal]=useState<Recipe | null>(null), [problem,setProblem]=useState(''), [busy,setBusy]=useState(false);
  const scope=`${active}:${principalKey}:${revisionId}:${current?.draft_id}:${current?.state}`;const latest=useRef(scope);latest.current=scope;
  useEffect(()=>{setProposal(null);setProblem('');setBusy(false);return()=>{latest.current='';};},[scope]);
  const selected=proposal ?? recipe;
  if (!active) return null;
  if (frozen.isError) return <Alert color="red">Recipe provenance unavailable. Refresh record access.</Alert>;
  if (!selected) return <Text>No constituent recipe declared. This stock is authored directly.</Text>;
  async function replace(localId:string,revision:string) {
    if (!revision || !selected || !editable || busy) return;
    const expected=scope;setBusy(true);setProblem('');
    try {
      const response=await fetch(`/api/v0/revisions/${encodeURIComponent(revision)}/snapshot`,{credentials:'same-origin',cache:'no-store'});
      if (!response.ok) throw new Error('Selected constituent revision is unavailable.');
      const bytes=await response.arrayBuffer();
      const result=JSON.parse(new TextDecoder().decode(bytes)) as {content:{stock_constituent?:unknown}};
      const hash=await sha256Hex(bytes);
      if (latest.current!==expected) return;
      if (!result.content.stock_constituent) throw new Error('Choose an exact stock constituent part revision.');
      setProposal({...selected,constituents:selected.constituents.map(pin=>pin.local_id===localId?{...pin,revision_id:revision,snapshot_sha256:hash}:pin)});
    } catch(error) {if(latest.current===expected)setProblem(error instanceof Error?error.message:'Constituent unavailable.');}
    finally {if(latest.current===expected)setBusy(false);}
  }
  return <Stack gap="xs"><Text>Exact constituent recipe · source {selected.source}</Text><Text size="sm">Compiled fields follow these pinned parts. Selecting another revision prepares a proposal; compile it deliberately, then freeze a new stock revision. Existing consumers keep their original pins.</Text>
    {problem && <Alert color="red">{problem}</Alert>}
    {selected.constituents.map(pin=><Stack key={pin.local_id} gap={3}><Text size="xs">{pin.local_id} · snapshot {pin.snapshot_sha256}</Text>{editable ? <RevisionPicker label={`Constituent ${pin.local_id}`} kind="part" value={pin.revision_id} onChange={revision=>void replace(pin.local_id,revision)} /> : <Text size="xs">Revision {pin.revision_id}</Text>}</Stack>)}
    <details><summary>Compilation formulas and exact bindings</summary>{selected.bindings.map(binding=><Text key={`${binding.element_path}:${binding.target_field}`} size="xs">{binding.element_path} · {binding.target_field} = {binding.formula}({binding.inputs.map(input=>`${input.constituent_local_id}.${input.field}`).join(', ')}) · rounding {binding.round_digits ?? 'unrounded'}</Text>)}</details>
    {editable && <Button loading={busy} disabled={dirty || !current} onClick={async()=>{
      if(!current)return;const expected=scope;setBusy(true);setProblem('');
      try {const result=await command<StockRecord>('wire_stock.compile_recipe',{draft_id:current.draft_id,recipe:selected},current.state);if(latest.current===expected){onCompiled(result);setProposal(null);}}
      catch(error){if(latest.current===expected)setProblem(error instanceof Error?error.message:'Compilation failed.');}
      finally {if(latest.current===expected)setBusy(false);}
    }}>Compile reviewed recipe</Button>}
    {dirty && <Text size="xs">Resolve local construction edits before compiling a recipe.</Text>}
  </Stack>;
}
