/** Independent DOM pointer/Three ray tests. The GPU renderer is explicitly doubled. */
import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as THREE from 'three';
import SceneViewport from './SceneViewport';
import { SharedScenePanel } from './SharedScenePanel';
import { ContextualInspectionWorkspace } from '../context-selection/ContextualInspectionWorkspace';
import { syntheticScene } from './test-fixtures';

const frame = vi.hoisted(() => ({ camera: null as THREE.Camera | null, scene: null as THREE.Scene | null }));
vi.mock('three', async original => ({ ...await original<typeof import('three')>(), WebGLRenderer: class {
  domElement = document.createElement('canvas');
  clippingPlanes: THREE.Plane[] = [];
  setPixelRatio() {} setSize() {} dispose() {} forceContextLoss() {}
  render(scene: THREE.Scene, camera: THREE.Camera) { scene.updateMatrixWorld(true); camera.updateMatrixWorld(true); frame.scene = scene; frame.camera = camera; }
} }));
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.setPointerCapture = vi.fn(); HTMLElement.prototype.releasePointerCapture = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({ x:0,y:0,left:0,top:0,right:600,bottom:420,width:600,height:420,toJSON:()=>({}) });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function clickWorld(x:number,y:number,z=0) {
  const point = new THREE.Vector3(x,y,z).project(frame.camera!);
  const canvas = screen.getByLabelText('Interactive shared engineering scene');
  for (const type of ['pointerdown','pointerup']) {
    const event = new MouseEvent(type, { bubbles:true, clientX:(point.x+1)*300, clientY:(1-point.y)*210, button:0 });
    Object.defineProperties(event, { pointerId:{value:1},pointerType:{value:'mouse'} });
    fireEvent(canvas,event);
  }
}
async function choose(label:string, value:string) { fireEvent.click(screen.getByRole('combobox',{name:label})); fireEvent.click(await screen.findByRole('option',{name:value})); }

test('ordinary pointer clicks pick analytically moved edges and reject both old and clipped edges', async () => {
  const scene=syntheticScene(), before=structuredClone(scene), select=vi.fn();
  render(<MantineProvider env="test"><SceneViewport scene={scene} arrangement="canonical" selected={scene.nodes[1]!.address} onSelect={select}/></MantineProvider>);
  fireEvent.click(screen.getByLabelText('Exploded display'));
  fireEvent.click(screen.getByRole('button',{name:'Open displayed occurrence branch'}));
  fireEvent.click(screen.getByRole('button',{name:'Orthographic top'}));
  // Right board Rz90 about its own origin: [0..40,-25..0] -> [0..25,0..40].
  // Its canonical +60X and root explosion +10X put edges at X70 and X95.
  clickWorld(95,20); expect(select).toHaveBeenLastCalledWith(scene.nodes[1]!.address);
  select.mockClear(); clickWorld(100,-12.5); expect(select).not.toHaveBeenCalled();
  fireEvent.click(screen.getByLabelText('Illustrative section clipping'));
  await choose('Section world display axis','X');
  fireEvent.change(screen.getByLabelText('Section chosen world display offset (mm)'),{target:{value:'90'}});
  clickWorld(70,20); expect(select).not.toHaveBeenCalled();
  clickWorld(95,20); expect(select).toHaveBeenLastCalledWith(scene.nodes[1]!.address);
  select.mockClear(); await choose('Section retained half-space','At or below chosen coordinate');
  clickWorld(95,20); expect(select).not.toHaveBeenCalled();
  clickWorld(70,20); expect(select).toHaveBeenLastCalledWith(scene.nodes[1]!.address);
  expect(scene).toEqual(before);
});

for (const host of ['shared','connected'] as const) test(`actual ${host} host Restore resets inspection while retaining exact feature`, async () => {
  const scene=syntheticScene(), before=structuredClone(scene);
  const choices={assemblies:[{snapshot_id:scene.snapshot_id,revision_id:scene.root.revision_id,name:'Synthetic root',number:1}],window:'latest_50_frozen_revisions'};
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>new Response(JSON.stringify(url.endsWith('/definitions') ? [{definition_id:'root'}] : url.includes('/snapshots/') ? scene : choices),{status:200})));
  render(<MantineProvider env="test">{host==='shared' ? <SharedScenePanel projectId="project-a"/> : <ContextualInspectionWorkspace projectId="project-a" principalKey="viewer-a"/>}</MantineProvider>);
  await waitFor(()=>expect(screen.getByRole('button',{name:host==='shared'?'Refresh scene access':'Refresh contextual scene choices'}).getAttribute('data-loading')).not.toBe('true'));
  fireEvent.change(screen.getByLabelText(host==='shared'?'Exact frozen assembly snapshot ID':'Exact contextual root snapshot ID'),{target:{value:scene.snapshot_id}});
  fireEvent.click(screen.getByRole('button',{name:host==='shared'?'Inspect exact scene':'Open contextual root'}));
  if(host==='shared') {
    fireEvent.click(await screen.findByRole('button',{name:'right/board · J1'}));
    fireEvent.click(screen.getByRole('button',{name:'component:one · U1 · native_component'}));
    await choose('Display arrangement','Separate local illustrations for inspection');
    fireEvent.click(screen.getByRole('button',{name:'Open scene view'}));
  } else {
    fireEvent.click(await screen.findByRole('button',{name:'Tree right/board · J1'}));
    fireEvent.click(screen.getByRole('tab',{name:'Context board'}));
    fireEvent.click(screen.getByRole('button',{name:'Board marker component:one'}));
    fireEvent.click(screen.getByRole('tab',{name:'Context scene'}));
    await choose('Connected scene arrangement','Local inspection');
    fireEvent.click(screen.getByRole('button',{name:'Open connected scene'}));
  }
  fireEvent.click(await screen.findByRole('button',{name:'Restore canonical display'}));
  expect((screen.getByRole('combobox',{name:host==='shared'?'Display arrangement':'Connected scene arrangement'}) as HTMLInputElement).value).toBe(host==='shared'?'Canonical placed illustrations':'Canonical');
  if(host==='shared') expect(screen.getByRole('button',{name:'component:one · U1 · native_component'}).getAttribute('aria-pressed')).toBe('true');
  else expect(within(screen.getByRole('region',{name:'Shared contextual selection'})).getByText('Stable feature: component:one')).toBeTruthy();
  expect(scene).toEqual(before);
});
