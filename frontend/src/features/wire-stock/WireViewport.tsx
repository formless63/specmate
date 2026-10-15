// SPDX-License-Identifier: AGPL-3.0-only
// Lazy, event-driven lifecycle adapted from WireHub WireModel3d.tsx (see NOTICE).
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Alert, Button, Group, SegmentedControl, Slider, Stack, Switch, Text } from '@mantine/core';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { applyOffsets, applyXray, buildWireObject } from '../../../../packages/wire-geometry/src/scene';
import { modelSummary } from '../../../../packages/wire-geometry/src/model';
import { explodeOffsets, outerLayerPaths } from '../../../../packages/wire-geometry/src/explode';
import type { ExplodeMode } from '../../../../packages/wire-geometry/src/explode';
import type { WireModel } from '../../../../packages/wire-geometry/src/model';

import { DEFAULT_DIRECTION, frameBox, VIEW_DIRECTIONS } from '../../../../packages/wire-geometry/src/framing';
import type { CameraView } from '../../../../packages/wire-geometry/src/framing';

export type { CameraView };
/** True when the themed surface behind the canvas is dark (read from the page, not assumed). */
function isDark(element: Element): boolean {
  const scheme = element.closest('[data-mantine-color-scheme]')?.getAttribute('data-mantine-color-scheme') ?? document.documentElement.getAttribute('data-mantine-color-scheme');
  if (scheme === 'dark' || scheme === 'light') return scheme === 'dark';
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}
/**
 * Soft studio rig for small metal and plastic parts: a sky/ground hemisphere, a key from above and in
 * front, a fill from the other side and a rim from behind, so a dark jacket keeps an edge on a dark
 * canvas. The room environment does most of the work for metals; without it the lights carry more.
 */
function studioLights(dark: boolean, environment: boolean): THREE.Group {
  const k = environment ? 1 : 1.6;
  const rig = new THREE.Group();
  rig.add(new THREE.HemisphereLight('#ffffff', dark ? '#30343a' : '#9a9690', (dark ? 0.35 : 0.55) * k));
  const key = new THREE.DirectionalLight('#ffffff', (dark ? 2.2 : 1.6) * k); key.position.set(-0.6, 1.6, 1.2);
  const fill = new THREE.DirectionalLight('#dfe8ff', (dark ? 0.55 : 0.4) * k); fill.position.set(1.2, 0.3, 0.8);
  const rim = new THREE.DirectionalLight('#ffffff', (dark ? 1.1 : 0.6) * k); rim.position.set(0.2, 0.9, -1.4);
  rig.add(key, fill, rim);
  return rig;
}
const reducedMotion = (): boolean => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
/** Theme motion token (`--sb-motion-quick`) in ms; 0 when absent or unparsable, which means no tween. */
export function motionMs(element: Element): number {
  const raw = getComputedStyle(element).getPropertyValue('--sb-motion-quick').trim();
  const value = /^([0-9.]+)(ms|s)$/.exec(raw);
  return value ? Math.min(1000, Number(value[1]) * (value[2] === 's' ? 1000 : 1)) : 0;
}
/** Reduced motion falls back to stepped positions: five, with no in-between travel. */
export const EXPLODE_STEP = 0.25;
const SMOOTH_STEP = 0.01;
interface Live { scene: THREE.Scene; object?: ReturnType<typeof buildWireObject>; frame: (view?: CameraView, keep?: boolean) => void; rotate: (horizontal: number, vertical: number) => void; zoom: (factor: number) => void; environment: boolean; redraw: () => void }

export default function WireViewport({ model, active = true, shownEnd = "both" }: { model: WireModel; active?: boolean; shownEnd?: "a" | "b" | "both" }) {
  const host = useRef<HTMLDivElement>(null);
  const descriptionId = useId();
  const live = useRef<Live | null>(null);
  const reset = useRef<(view?: CameraView, keep?: boolean) => void>(() => {});
  const [problem, setProblem] = useState('');
  const [explode, setExplode] = useState(0);
  const [mode, setMode] = useState<ExplodeMode>('axial');
  const [xray, setXray] = useState(false);
  const reduced = reducedMotion();
  const shown = useRef({ amount: 0, mode: 'axial' as ExplodeMode, raf: 0 });
  const latest = useRef({ model, explode, mode, xray, active });
  latest.current = { model, explode, mode, xray, active };
  useEffect(() => {
    const container = host.current;
    if (!container) return;
    setProblem('');
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); }
    catch { setProblem('WebGL is unavailable. The section drawing and element dimensions remain available.'); return; }
    const element = renderer.domElement;
    element.setAttribute('aria-label', 'Interactive prepared wire preview');
    element.setAttribute('role', 'img'); element.setAttribute('aria-describedby', descriptionId);
    element.style.cssText = 'width:100%;max-width:100%;height:360px;display:block;touch-action:none';
    container.appendChild(element);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    // Transparent canvas: the host's themed surface (and dot grid) shows through. Neutral tone mapping
    // keeps recorded colors' hues while taming metal highlights.
    renderer.toneMapping = THREE.NeutralToneMapping; renderer.toneMappingExposure = 1;
    const scene = new THREE.Scene();
    // Image-based light gives metals and glossy jackets something to reflect. Optional: absent in minimal contexts.
    let environment = false;
    try {
      const pmrem = new THREE.PMREMGenerator(renderer);
      scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      pmrem.dispose(); environment = true;
    } catch { environment = false; }
    const dark = isDark(container);
    scene.environmentIntensity = dark ? 0.65 : 0.85;
    scene.add(studioLights(dark, environment));
    const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 10000);
    const controls = new OrbitControls(camera, element);
    controls.enableDamping = false;
    const render = () => {
      if (latest.current.active && container.clientWidth > 0 && document.visibilityState !== 'hidden') renderer.render(scene, camera);
    };
    const frame = (view?: CameraView, keep = false) => {
      const bounds = live.current?.object ? new THREE.Box3().setFromObject(live.current.object.group) : new THREE.Box3();
      const direction = view ? new THREE.Vector3(...VIEW_DIRECTIONS[view])
        : keep && camera.position.distanceToSquared(controls.target) > 0 ? camera.position.clone().sub(controls.target) : new THREE.Vector3(...DEFAULT_DIRECTION);
      const f = frameBox(bounds, direction, camera.fov, camera.aspect);
      camera.position.copy(f.position); camera.up.copy(f.up); camera.near = f.near; camera.far = f.far;
      camera.updateProjectionMatrix(); controls.target.copy(f.target); controls.update(); render();
    };
    live.current = { scene, frame, environment, redraw: render,
      rotate: (horizontal, vertical) => { const spherical = new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target)); spherical.theta += horizontal; spherical.phi = Math.max(0.05, Math.min(Math.PI - 0.05, spherical.phi + vertical)); camera.position.copy(new THREE.Vector3().setFromSpherical(spherical).add(controls.target)); controls.update(); render(); },
      zoom: factor => { camera.position.sub(controls.target).multiplyScalar(factor).add(controls.target); controls.update(); render(); },
    };
    reset.current = frame;
    const resize = () => {
      // Size from the container, never from the canvas or the page's text, so a wide sibling cannot widen the model.
      const parentWidth = container.parentElement?.clientWidth || Infinity;
      const width = Math.min(container.clientWidth, parentWidth), height = 360;
      if (width <= 0) return;
      renderer.setSize(width, height, false); camera.aspect = width / height; frame();
    };
    controls.addEventListener('change', render);
    const observer = new ResizeObserver(resize); observer.observe(container); resize();
    document.addEventListener('visibilitychange', render);
    const lost = (event: Event) => { event.preventDefault(); setProblem('The WebGL context was lost. The browser may restore it; otherwise close and reopen the 3D preview. The text description below remains available.'); };
    const restored = () => { setProblem(''); render(); };
    element.addEventListener('webglcontextlost', lost);
    element.addEventListener('webglcontextrestored', restored);
    return () => {
      reset.current = () => {};
      observer.disconnect(); document.removeEventListener('visibilitychange', render); element.removeEventListener('webglcontextlost', lost); element.removeEventListener('webglcontextrestored', restored); scene.environment?.dispose();
      scene.traverse(o => { if ((o as THREE.Light).isLight) (o as THREE.Light).dispose(); });
      cancelAnimationFrame(shown.current.raf); shown.current.raf = 0;
      controls.removeEventListener('change', render); controls.dispose(); live.current?.object?.dispose(); live.current = null;
      renderer.dispose(); renderer.forceContextLoss(); element.remove();
    };
  }, [descriptionId]);
  useEffect(() => {
    const state = live.current;
    if (!state) return;
    if (state.object) { state.scene.remove(state.object.group); state.object.dispose(); }
    state.object = buildWireObject(model, { environment: state.environment }); state.scene.add(state.object.group);
    cancelAnimationFrame(shown.current.raf); shown.current.raf = 0;
    // A new model starts at the chosen explode and x-ray, not at rest.
    shown.current.amount = latest.current.explode; shown.current.mode = latest.current.mode;
    applyOffsets(state.object.group, explodeOffsets(model, shown.current.amount, shown.current.mode));
    applyXray(state.object.group, outerLayerPaths(model), latest.current.xray);
    state.frame();
  }, [model]);
  useEffect(() => {
    const state = live.current;
    if (!state?.object) return;
    applyXray(state.object.group, outerLayerPaths(latest.current.model), xray); state.redraw();
  }, [xray]);
  useEffect(() => {
    const state = live.current, container = host.current;
    if (!state?.object || !container) return;
    const group = state.object.group, current = shown.current;
    const draw = () => { applyOffsets(group, explodeOffsets(latest.current.model, current.amount, current.mode)); state.redraw(); };
    cancelAnimationFrame(current.raf); current.raf = 0;
    const duration = reduced ? 0 : motionMs(container);
    const modeChanged = current.mode !== mode;
    if (modeChanged) { current.mode = mode; current.amount = 0; }
    const from = current.amount, to = explode;
    if (from === to && !modeChanged) return;
    if (duration <= 0 || from === to) { current.amount = to; draw(); state.frame(undefined, true); return; }
    const t0 = performance.now();
    const tick = (now: number) => {
      const k = Math.min(1, (now - t0) / duration), eased = k * k * (3 - 2 * k);
      current.amount = from + (to - from) * eased; draw();
      if (k < 1) current.raf = requestAnimationFrame(tick); else { current.raf = 0; current.amount = to; state.frame(undefined, true); }
    };
    current.raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(current.raf); current.raf = 0; };
  }, [explode, mode, reduced]);
  const description = useMemo(() => modelSummary(model), [model]);
  useEffect(() => { if (active) live.current?.redraw(); }, [active]);
  useEffect(() => { reset.current(shownEnd === "both" ? undefined : shownEnd); }, [shownEnd]);
  return <Stack style={{ minWidth: 0, maxWidth: '100%' }}>
    {problem && <Alert color="yellow" role="alert">{problem}</Alert>}
    <Group gap="xs"><Button size="xs" variant="quiet" onClick={() => { setExplode(0); setXray(false); reset.current(); }}>Reset view</Button><Button size="xs" variant="quiet" onClick={() => reset.current(undefined, true)}>Fit 3D view</Button><Button variant="light" onClick={() => reset.current('a')}>View end A</Button><Button variant="light" onClick={() => reset.current('b')}>View end B</Button><Button variant="light" onClick={() => reset.current('top')}>Top view</Button><Button variant="light" onClick={() => reset.current('front')}>Front view</Button><Button size="xs" variant="quiet" onClick={() => reset.current('side')}>Side view</Button>
      <Button size="xs" variant="quiet" aria-label="Rotate camera left" onClick={() => live.current?.rotate(-0.2, 0)}>←</Button><Button size="xs" variant="quiet" aria-label="Rotate camera right" onClick={() => live.current?.rotate(0.2, 0)}>→</Button><Button size="xs" variant="quiet" aria-label="Rotate camera up" onClick={() => live.current?.rotate(0, -0.2)}>↑</Button><Button size="xs" variant="quiet" aria-label="Rotate camera down" onClick={() => live.current?.rotate(0, 0.2)}>↓</Button><Button size="xs" variant="quiet" aria-label="Zoom camera in" onClick={() => live.current?.zoom(0.8)}>+</Button><Button size="xs" variant="quiet" aria-label="Zoom camera out" onClick={() => live.current?.zoom(1.25)}>−</Button></Group>
    <Group align="flex-end" gap="md" wrap="wrap" data-testid="explode-controls">
      <Stack gap={2} style={{ flex: '1 1 220px' }}>
        <Text size="xs" className="sb-silk" id={`${descriptionId}-explode`}>Explode: {Math.round(explode * 100)}%{reduced ? ' (stepped)' : ''}</Text>
        <Slider aria-labelledby={`${descriptionId}-explode`} min={0} max={1} step={reduced ? EXPLODE_STEP : SMOOTH_STEP} value={explode} onChange={setExplode} label={null} disabled={model.pieces.length === 0} />
      </Stack>
      <SegmentedControl size="xs" aria-label="Explode direction" value={mode} onChange={v => setMode(v as ExplodeMode)} data={[{ value: 'axial', label: 'Axial' }, { value: 'radial', label: 'Radial' }]} />
      <Switch label="X-ray" checked={xray} onChange={e => setXray(e.currentTarget.checked)} disabled={model.pieces.length === 0} />
    </Group>
    <div ref={host} className="sb-viewer sb-viewer-3d" style={{ display: problem ? 'none' : 'block', minWidth: 0, maxWidth: '100%', width: '100%' }} />
    <Text className="sb-visually-hidden" size="xs" id={descriptionId} data-testid={descriptionId} style={{ whiteSpace: 'normal', overflowWrap: 'anywhere', minWidth: 0 }}>{description}</Text>
    <details><summary>Camera and display notes</summary><Text size="sm" style={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}>Drag to orbit, wheel to zoom, right-drag to pan. End A is x = 0; end B is x = preview length. Recorded colors and materials are shown as recorded; unrecorded ones are neutral. Explode and x-ray are display-only: they move or fade the drawn layers and establish no dimension, gap or construction. Radial explode moves only elements recorded off the cable axis. Leads are illustrative; geometry establishes no fit or qualification. Camera buttons also work with the keyboard.</Text></details>
  </Stack>;
}
