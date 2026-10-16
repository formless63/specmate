import { Select, Stack } from '@mantine/core';
import { useState } from 'react';
import { RevisionPicker } from '../cables/RevisionPicker';
import type { Definition } from './api';
export function RevisionChoice({label,kinds,value,onChange,definitions}:{label:string;kinds:string[];value:string;onChange:(value:string)=>void;definitions:Definition[]}){
 const [kind,setKind]=useState(kinds[0]??'');
 return <Stack gap="xs">{kinds.length>1&&<Select label={`${label} kind`} value={kind} data={kinds.map(value=>({value,label:value.replaceAll('_',' ')}))} onChange={next=>{setKind(next??kinds[0]??'');onChange('');}}/>}<RevisionPicker key={kind} label={label} kind={kind} value={value} onChange={onChange} definitions={definitions}/></Stack>;
}
