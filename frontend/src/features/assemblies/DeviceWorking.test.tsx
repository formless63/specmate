import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useState } from 'react';
import { OccurrenceControls, WorkingFirmware } from './DeviceWorking';
import { emptyAssembly } from './useDeviceRecord';
import type { Assembly } from './api';
import { PermissionsProvider } from '../../lib/permissions';
vi.mock('../cables/RevisionPicker', () => ({ RevisionPicker: ({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) => <input aria-label={label} value={value} onChange={event => onChange(event.currentTarget.value)} /> }));
beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} }); Element.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
test('changing or clearing firmware preserves the exact selected population option and every sibling assignment', () => {
  const before: Assembly = { ...emptyAssembly(), assignments: [
    { path: ['left', 'board'], assignments: { firmware_revision_id: 'old-left', population_option_id: 'left-population' } },
    { path: ['right', 'board'], assignments: { firmware_revision_id: 'old-right', population_option_id: 'right-population' } },
  ] };
  function Harness() { const [assembly, setAssembly] = useState(before); return <><WorkingFirmware assembly={assembly} editable paths={['left', 'right'].map(side => ({ path: [side, 'board'], label: side }))} onChange={setAssembly} /><output data-testid="working">{JSON.stringify(assembly)}</output></>; }
  render(<MantineProvider env="test"><Harness /></MantineProvider>);
  fireEvent.click(screen.getByRole('combobox', { name: 'Firmware occurrence' })); fireEvent.click(screen.getByRole('option', { name: 'right' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Firmware' }), { target: { value: '00000000-0000-4000-8000-000000000001' } }); fireEvent.click(screen.getByRole('button', { name: 'Apply firmware to working tree' }));
  let current = JSON.parse(screen.getByTestId('working').textContent!) as Assembly;
  expect(current.assignments?.[0]).toEqual(before.assignments?.[0]); expect(current.assignments?.[1]?.assignments.population_option_id).toBe('right-population');
  fireEvent.click(screen.getByRole('button', { name: 'Clear assignment right / board' })); current = JSON.parse(screen.getByTestId('working').textContent!) as Assembly;
  expect(current.assignments?.[1]?.assignments).toEqual({ firmware_revision_id: null, population_option_id: 'right-population' }); expect(before.assignments?.[1]?.assignments.firmware_revision_id).toBe('old-right');
});

test('applying one occurrence keeps an independently staged sibling transform in the current editor',()=>{
 const before:Assembly={...emptyAssembly(),occurrences:['left','right'].map(local_id=>({local_id,revision_id:'00000000-0000-4000-8000-000000000001',display_ref:local_id,placement:{status:'known',translation:[1,2,3],rotation_xyzw:[0,0,0,1]}}))};
 function Form(){const [value,setValue]=useState(before),[selected,setSelected]=useState<string|null>('left'),[staged,setStaged]=useState(new Set<string>());return <><OccurrenceControls assembly={value} selected={selected} onSelect={setSelected} editable onChange={setValue} staged={staged} epoch={0} onStaged={id=>setStaged(prior=>new Set([...prior,id]))} onApplied={id=>setStaged(prior=>new Set([...prior].filter(value=>value!==id)))}/><output data-testid="tree">{JSON.stringify(value)}</output></>;}
 render(<MantineProvider env="test"><PermissionsProvider permissions={['design.edit']}><Form/></PermissionsProvider></MantineProvider>);
 fireEvent.change(screen.getByLabelText('left X (mm)'),{target:{value:'77'}});fireEvent.click(screen.getByRole('combobox',{name:'Selected occurrence'}));fireEvent.click(screen.getByRole('option',{name:'right · right'}));fireEvent.change(screen.getByLabelText('right Y (mm)'),{target:{value:'88'}});fireEvent.click(screen.getByRole('button',{name:'Apply right to working tree'}));let current=JSON.parse(screen.getByTestId('tree').textContent!) as Assembly;expect(current.occurrences[0]!.placement?.translation).toEqual([1,2,3]);expect(current.occurrences[1]!.placement?.translation).toEqual([1,88,3]);
 fireEvent.click(screen.getByRole('combobox',{name:'Selected occurrence'}));fireEvent.click(screen.getByRole('option',{name:'left · left'}));expect((screen.getByLabelText('left X (mm)') as HTMLInputElement).value).toBe('77');fireEvent.click(screen.getByRole('button',{name:'Apply left to working tree'}));current=JSON.parse(screen.getByTestId('tree').textContent!) as Assembly;expect(current.occurrences.map(row=>row.placement?.translation)).toEqual([[77,2,3],[1,88,3]]);
});

test('exact wiring picker keeps repeated revision paths distinct and excludes owned stock ends',async()=>{
 const {QueryClient,QueryClientProvider}=await import('@tanstack/react-query');
 const {RelationshipControls}=await import('./DeviceWorking');
 const pin='00000000-0000-4000-8000-000000000001';
 const material={kind:'segment',segment_id:'lead',end:'b',element_path:'stock.core'};
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({nodes:[{id:'free',occurrence_path:[],terminal:material,label:'Flying core',feature_kind:'conductor',provenance:{exposed_material_end:true}},{id:'owned',occurrence_path:[],terminal:{...material,end:'a'},label:'Already landed core',feature_kind:'conductor',provenance:{exposed_material_end:false}}]}),{status:200})));
 function Form(){const [value,setValue]=useState<Assembly>({...emptyAssembly(),occurrences:['left','right'].map(local_id=>({local_id,revision_id:pin,display_ref:local_id}))});return <><RelationshipControls assembly={value} onChange={setValue} editable paths={['left','right'].map(id=>({path:[id],label:id}))}/><output data-testid="wired">{JSON.stringify(value)}</output></>;}
 render(<MantineProvider env="test"><QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><Form/></QueryClientProvider></MantineProvider>);
 fireEvent.click(screen.getByText('Add typed relationship'));
 for(const [name,option] of [['First occurrence','left'],['Second occurrence','right'],['Electrical address mode','Exact wiring terminals']]){fireEvent.click(screen.getByRole('combobox',{name:name!}));fireEvent.click(screen.getByRole('option',{name:option!}));}
 for(const name of ['First exact wiring terminal','Second exact wiring terminal']){fireEvent.click(await screen.findByRole('combobox',{name}));fireEvent.click(await screen.findByRole('option',{name:'Flying core'}));expect(screen.queryByRole('option',{name:'Already landed core'})).toBeNull();}
 fireEvent.change(screen.getByLabelText('Relationship local ID'),{target:{value:'join'}});fireEvent.change(screen.getByLabelText('Electrical join basis'),{target:{value:'Explicit assembly solder'}});fireEvent.click(screen.getByRole('button',{name:'Add relationship to working tree'}));
 const result=JSON.parse(screen.getByTestId('wired').textContent!) as Assembly;
 expect(result.relationships[0]).toMatchObject({kind:'electrical',a:{path:['left'],feature_id:null},b:{path:['right'],feature_id:null},a_terminal:material,b_terminal:material,basis:'Explicit assembly solder'});
});
