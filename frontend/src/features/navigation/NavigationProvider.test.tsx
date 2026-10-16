import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, test } from 'vitest';
import { NavigationProvider, useNavigation } from './NavigationProvider';

afterEach(cleanup);
test.each(['shared-scene', 'cables'])('a %s alias with the same canonical home rewrites the current address while retaining local fields', async lens => {
 const history=createMemoryHistory({initialEntries:['/designs?project=p1']});
 function RetainedEditor(){const navigation=useNavigation()!;const[value,setValue]=useState('');return <><input aria-label="Local declaration" value={value} onChange={event=>setValue(event.currentTarget.value)}/><button onClick={()=>navigation.navigate({lens})}>Open retired picker</button><button onClick={()=>navigation.navigate({lens:'mechanical-proposals',probe:{object:'own-secondary-id',rev:75,path:['features','wall']}})}>Open exact secondary record</button><output>{navigation.location.lens}</output></>;}
 render(<NavigationProvider history={history}><RetainedEditor/></NavigationProvider>);
 const field=screen.getByRole('textbox',{name:'Local declaration'});fireEvent.change(field,{target:{value:'Retained local basis'}});fireEvent.click(screen.getByRole('button',{name:'Open retired picker'}));await waitFor(()=>expect(history.location.href).toBe('/designs?project=p1'));expect(screen.getByText('designs')).toBeTruthy();expect(screen.getByRole('textbox',{name:'Local declaration'})).toBe(field);expect((field as HTMLInputElement).value).toBe('Retained local basis');
 fireEvent.click(screen.getByRole('button',{name:'Open exact secondary record'}));await waitFor(()=>expect(history.location.href).toBe('/designs/own-secondary-id@75/~/features/wall?tool=mechanical-proposals&project=p1'));expect(screen.getByText('mechanical-proposals')).toBeTruthy();expect((field as HTMLInputElement).value).toBe('Retained local basis');history.back();await waitFor(()=>expect(history.location.href).toBe('/designs?project=p1'));
});
