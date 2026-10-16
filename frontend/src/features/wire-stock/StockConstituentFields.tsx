import { NumberInput, Select, Stack, Text, TextInput } from '@mantine/core';
import type { Fact } from '../../../../packages/section-layout/src';
import type { Content } from '../parts/api';

type Constituent = { kind: string; source: string; values: Record<string,Fact>; components: {local_id:string;revision_id:string;snapshot_sha256:string}[] };
/** Reusable source facts remain editable on the Part, while compiled stock
 * pins an immutable revision and never silently adopts these local changes. */
export function StockConstituentFields({content,editable,change}:{content:Content;editable:boolean;change:(content:Content)=>void}) {
  const value=content.stock_constituent as Constituent | undefined;
  if(!value)return null;
  const update=(field:string,fact:Fact)=>change({...content,stock_constituent:{...value,values:{...value.values,[field]:fact}}});
  return <Stack gap="xs"><Text fw={600}>Reusable wire constituent · {value.kind}</Text><Text size="sm">Source {value.source}. Changes are local to this Part draft. Freeze a new revision and deliberately recompile a stock recipe to use them.</Text>
    {Object.entries(value.values).map(([field,fact])=><Stack gap={3} key={field}><Text size="sm">{field.replaceAll('_',' ')}{fact.unit?` (${fact.unit})`:''}</Text>{editable ? <>
      {(field.endsWith('_mm') || field==='area_mm2' || field==='strand_count') ? <NumberInput label={`${field} value`} value={typeof fact.value==='number'?fact.value:''} min={0} onChange={number=>update(field,{...fact,value:typeof number==='number'?number:null,status:typeof number==='number'?(fact.status==='unknown'?'documented':fact.status):'unknown'})}/> : <TextInput label={`${field} value`} value={fact.value??''} onChange={event=>update(field,{...fact,value:event.currentTarget.value||null,status:event.currentTarget.value?(fact.status==='unknown'?'documented':fact.status):'unknown'})}/>}
      <Select label={`${field} confidence`} allowDeselect={false} data={['unknown','documented','measured','inferred']} value={fact.status} onChange={status=>status && update(field,{...fact,status:status as Fact['status'],value:status==='unknown'?null:fact.value})}/>
      <TextInput label={`${field} source`} value={fact.source??''} onChange={event=>update(field,{...fact,source:event.currentTarget.value||null})}/>
    </> : <Text size="xs">{fact.value??'Unknown'} · {fact.status} · {fact.source??'Source unknown'}</Text>}</Stack>)}
    {(value.components??[]).map(pin=><Text key={pin.local_id} size="xs">{pin.local_id} · revision {pin.revision_id} · snapshot {pin.snapshot_sha256}</Text>)}
  </Stack>;
}
