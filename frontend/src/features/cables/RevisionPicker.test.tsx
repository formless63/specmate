import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { clearRevisionLabels } from '../../lib/revision-labels';
import { DefinitionPickerScope } from '../../components/library/DefinitionSelect';
import { RevisionPicker } from './RevisionPicker';
beforeEach(() => { Element.prototype.scrollIntoView = vi.fn(); clearRevisionLabels(); vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const definitions = ['one', 'two'].map(definition_id => ({ definition_id, kind: 'cable', name: `Synthetic ${definition_id}` }));
const response = (data: unknown, status=200) => new Response(JSON.stringify(data), {status});
async function choose(label:string, text:string) { const field=screen.getByRole('combobox',{name:label});fireEvent.focus(field);fireEvent.keyDown(field,{key:'ArrowDown'});fireEvent.click(await within(screen.getByRole('listbox',{name:label,hidden:true})).findByText(text)); }
function Host({active=true,onDenied}:{active?:boolean;onDenied?:(id:string)=>void}) {const [value,setValue]=useState('');return <DefinitionPickerScope.Provider value={{key:'synthetic-actor',active}}><RevisionPicker label="Subject" kind="cable" value={value} onChange={setValue} definitions={definitions} onAccessDenied={onDenied}/><output>{value}</output></DefinitionPickerScope.Provider>;}
function wrap(child:React.ReactNode) {return <MantineProvider><QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}>{child}</QueryClientProvider></MantineProvider>;}
test('changing definition chooses its newest revision and an explicit older pin stays exact',async()=>{
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>{const id=url.includes('/definitions/two')?'two':'one';return response(url.includes('revision-labels')?{labels:[]}:{definition_id:id,name:`Synthetic ${id}`,revisions:[{revision_id:`${id}-r1`,number:1},{revision_id:`${id}-r3`,number:3}]});}));
 render(wrap(<Host/>));await choose('Subject definition','Synthetic one');await waitFor(()=>expect(screen.getByRole('status').textContent).toBe('one-r3'));
 await choose('Subject revision','Synthetic one · r1');expect(screen.getByRole('status').textContent).toBe('one-r1');
 await choose('Subject definition','Synthetic two');await waitFor(()=>expect(screen.getByRole('status').textContent).toBe('two-r3'));
 fireEvent.click(screen.getByRole('button',{name:'Advanced: paste exact revision ID for Subject'}));fireEvent.change(screen.getByLabelText('Subject exact revision ID'),{target:{value:'exact-other-project'}});expect(screen.getByRole('status').textContent).toBe('exact-other-project');
});
test('denied definition history reports authority loss and inactive pickers do not disclose cached choices',async()=>{
 const onDenied=vi.fn();vi.stubGlobal('fetch',vi.fn(async()=>response({error:{message:'History denied'}},403)));
 const {rerender}=render(wrap(<Host onDenied={onDenied}/>));await choose('Subject definition','Synthetic one');await screen.findByText('History denied');expect(onDenied).toHaveBeenCalledWith('one');expect((screen.getByRole('combobox',{name:'Subject revision'}) as HTMLInputElement).disabled).toBe(true);
 rerender(wrap(<Host active={false} onDenied={onDenied}/>));expect((screen.getByRole('combobox',{name:'Subject revision'}) as HTMLInputElement).disabled).toBe(true);
});
