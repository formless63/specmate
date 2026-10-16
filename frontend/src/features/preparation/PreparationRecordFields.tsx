import { Alert, Stack, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { RevisionLabel } from '../../lib/IdentityLabel';
import { RevisionPicker } from '../cables/RevisionPicker';
import { loadFrozenStock } from '../wire-stock/viewer-api';
import type { SecondaryContext } from '../records/SecondaryRecordPage';
import { ProfileEditor, FormulaInspection, conductiveChoices } from './ProfileEditor';
import { ProfileEditor as EndEditor, EndInspection } from '../end-preparation/ProfileEditor';
import { stockFeatures, type Profile as EndProfile } from '../end-preparation/api';
import type { Profile } from './api';
export function PreparationRecordFields({ context, end = false, scopeKey }: { context: SecondaryContext; end?: boolean; scopeKey: string }) {
  const {content,change,editing,active,refreshAccess}=context;
  const key=end?'end_preparation_profile':'preparation_profile', value=content[key] as Profile | EndProfile | undefined;
  const stock=useQuery({queryKey:['secondary-profile-stock',scopeKey,value?.stock_revision_id],enabled:active&&!!value?.stock_revision_id,retry:false,staleTime:0,refetchOnWindowFocus:'always',queryFn:()=>loadFrozenStock(value!.stock_revision_id)});
  useEffect(()=>{if(stock.isError&&active)refreshAccess();},[stock.isError,stock.error,active]);
  if(!value)return <Text>Typed profile content is unavailable.</Text>;
  const changeValue=(next:Profile|EndProfile)=>change({...content,[key]:next});
  const available=active&&!stock.isError&&!stock.isFetching?stock.data:undefined;
  return <Stack><Text>{end?'Independent per-end preparation intent. A bond expectation does not create a bond.':'Reviewed cut formulas produce suggestions; they do not change the stock or cable declarations.'} Physical qualification remains unevaluated.</Text>
    {editing?<RevisionPicker label="Preparation stock" kind="wire_stock" value={value.stock_revision_id} onChange={id=>changeValue({...value,stock_revision_id:id})}/>:<RevisionLabel id={value.stock_revision_id} role="Exact stock"/>}
    {stock.isError&&<Alert color="red">{stock.error.message}</Alert>}
    {editing ? end ? <EndEditor value={value as EndProfile} features={available?stockFeatures(available.structure):[]} onChange={changeValue}/> : <ProfileEditor value={value as Profile} choices={available?conductiveChoices(available.structure):[]} onChange={changeValue}/> : end ? <><EndInspection label="End A" end={(value as EndProfile).a}/><EndInspection label="End B" end={(value as EndProfile).b}/></> : (value as Profile).formulas.map(formula=><FormulaInspection key={formula.local_id} formula={formula}/>)}
  </Stack>;
}
