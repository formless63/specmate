// SPDX-License-Identifier: AGPL-3.0-only
// Event-driven lifecycle follows the preserved WireHub-derived stock viewport (NOTICE).
import { Alert, Button, Group, Stack, Text } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Address, SharedScene } from './api';
import { selectionKey } from './api';
import { applySceneTheme, buildSceneObject, themedMaterial, tokenColor } from './geometry';
import type { Arrangement, SceneObject } from './geometry';
import { closedDisplay, retainedPoint, sectionPlane } from './display';
import type { CameraView, Display } from './display';
import { DisplayControls, openingInput } from './DisplayControls';

type Live = {
  scene: THREE.Scene; object?: SceneObject; highlight?: THREE.Box3Helper; relatedMarks: THREE.Box3Helper[];
  frame: (mode?: CameraView) => void; render: () => void; setSection: (display: Display) => void; plane: THREE.Plane | null;
};
type Props = { scene: SharedScene; arrangement: Arrangement; selected: Address | null; related?: Address[]; onSelect: (address: Address) => void; onRestoreCanonical?: () => void };
export default function SceneViewport(props: Props) {
  return <ScopedViewport key={JSON.stringify([props.scene.snapshot_id, props.scene.sha256])} {...props} />;
}
function ScopedViewport({ scene: projection, arrangement, selected, related, onSelect, onRestoreCanonical }: Props) {
  const host = useRef<HTMLDivElement>(null), live = useRef<Live | null>(null);
  const selection = useRef(onSelect); selection.current = onSelect;
  const reset = useRef<(mode?: CameraView) => void>(() => {});
  const [display, setDisplay] = useState(closedDisplay), [input, setInput] = useState(openingInput);
  const [problem, setProblem] = useState(''), [unknown, setUnknown] = useState<string[]>([]);
  useEffect(() => {
    const container = host.current;
    if (!container) return;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); }
    catch { setProblem('WebGL is unavailable. Occurrences, exact pins and unknowns remain inspectable.'); return; }
    const element = renderer.domElement;
    element.setAttribute('aria-label', 'Interactive shared engineering scene');
    element.style.cssText = 'width:100%;height:420px;display:block;touch-action:none';
    container.appendChild(element); renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight('#ffffff', '#606975', 3));
    const light = new THREE.DirectionalLight('#ffffff', 3); light.position.set(-5, 10, 8); scene.add(light);
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.001, 10000);
    camera.up.set(0, 0, 1);
    const controls = new OrbitControls(camera, element); controls.enableDamping = false;
    let contextLost = false, aspect = 1, mode: CameraView = 'isometric';
    const render = () => { if (!contextLost && container.clientWidth > 0 && document.visibilityState !== 'hidden') renderer.render(scene, camera); };
    const frame = (requested = mode) => {
      mode = requested;
      const bounds = live.current?.object ? new THREE.Box3().setFromObject(live.current.object.group) : new THREE.Box3();
      const center = bounds.isEmpty() ? new THREE.Vector3() : bounds.getCenter(new THREE.Vector3());
      const radius = bounds.isEmpty() ? 1 : Math.max(bounds.getSize(new THREE.Vector3()).length() / 2, 0.001);
      const direction = mode === 'top' ? new THREE.Vector3(0, 0, 1) : mode === 'end' ? new THREE.Vector3(1, 0, 0) : mode === 'front' ? new THREE.Vector3(0, -1, 0) : new THREE.Vector3(1, -1, 0.8).normalize();
      camera.up.set(0, mode === 'top' ? 1 : 0, mode === 'top' ? 0 : 1);
      const right = camera.up.clone().cross(direction).normalize(), up = direction.clone().cross(right).normalize();
      let halfWidth = 0.001, halfHeight = 0.001;
      if (!bounds.isEmpty()) for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
        const point = new THREE.Vector3(x, y, z).sub(center);
        halfWidth = Math.max(halfWidth, Math.abs(point.dot(right))); halfHeight = Math.max(halfHeight, Math.abs(point.dot(up)));
      }
      halfHeight = Math.max(halfHeight, halfWidth / aspect) * 1.15; halfWidth = halfHeight * aspect;
      camera.left = -halfWidth; camera.right = halfWidth; camera.top = halfHeight; camera.bottom = -halfHeight;
      camera.zoom = 1; camera.near = Math.max(radius / 10000, 0.000001); camera.far = radius * 10;
      camera.position.copy(center).addScaledVector(direction, radius * 3); camera.lookAt(center);
      camera.updateProjectionMatrix(); controls.target.copy(center); controls.update(); render();
    };
    live.current = { scene, relatedMarks: [], frame, render, plane: null, setSection: display => {
      const plane = sectionPlane(display); renderer.clippingPlanes = plane ? [plane] : [];
      if (live.current) live.current.plane = plane; render();
    } }; reset.current = frame;
    const resize = () => {
      const width = container.clientWidth;
      if (width <= 0 || contextLost) return;
      renderer.setSize(width, 420, false); aspect = width / 420; frame();
    };
    controls.addEventListener('change', render);
    const observer = new ResizeObserver(resize); observer.observe(container); resize();
    document.addEventListener('visibilitychange', render);
    const lost = (event: Event) => { event.preventDefault(); contextLost = true; setProblem('The WebGL context was lost. Close and reopen the scene view to retry.'); };
    element.addEventListener('webglcontextlost', lost);
    let start: [number, number] | null = null;
    const down = (event: PointerEvent) => { start = [event.clientX, event.clientY]; };
    const pick = (event: PointerEvent) => {
      if (!start || contextLost || Math.hypot(event.clientX - start[0], event.clientY - start[1]) > 4) return;
      start = null;
      const rect = element.getBoundingClientRect(); if (!rect.width || !rect.height) return;
      const ray = new THREE.Raycaster(); ray.params.Line.threshold = (camera.right - camera.left) / rect.width * 4;
      ray.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1), camera);
      const hit = live.current?.object ? ray.intersectObject(live.current.object.group, true).find(hit => retainedPoint(hit.point, live.current?.plane ?? null)) : undefined;
      if (hit?.object.userData.address) selection.current(hit.object.userData.address as Address);
    };
    element.addEventListener('pointerdown', down); element.addEventListener('pointerup', pick);
    return () => {
      reset.current = () => {}; observer.disconnect(); document.removeEventListener('visibilitychange', render);
      element.removeEventListener('webglcontextlost', lost); element.removeEventListener('pointerdown', down); element.removeEventListener('pointerup', pick);
      controls.removeEventListener('change', render); controls.dispose();
      const state = live.current; state?.object?.dispose(); state?.highlight?.geometry.dispose();
      state?.relatedMarks.forEach(disposeMark);
      if (state?.highlight) (state.highlight.material as THREE.Material).dispose(); live.current = null;
      renderer.dispose(); renderer.forceContextLoss(); element.remove();
    };
  }, []);
  // OS or app theme switch: recolour tagged materials in place (no geometry rebuild) and redraw.
  // The renderer is alpha with no clear colour, so the background follows the themed container.
  useEffect(() => {
    const recolour = () => {
      const state = live.current; if (!state) return;
      applySceneTheme(state.scene); state.render();
    };
    const query = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    query?.addEventListener?.('change', recolour);
    const observer = new MutationObserver(recolour);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mantine-color-scheme', 'data-theme', 'style', 'class'] });
    return () => { query?.removeEventListener?.('change', recolour); observer.disconnect(); };
  }, []);
  useEffect(() => {
    const state = live.current; if (!state) return;
    if (state.object) { state.scene.remove(state.object.group); state.object.dispose(); }
    state.object = buildSceneObject(projection, arrangement, display); state.scene.add(state.object.group);
    setUnknown(state.object.unknown); state.frame();
  }, [projection, arrangement, display.explosion, display.opening]);
  useEffect(() => { live.current?.setSection(display); }, [display.section]);
  useEffect(() => {
    const state = live.current; if (!state) return;
    if (state.highlight) { state.scene.remove(state.highlight); state.highlight.geometry.dispose(); (state.highlight.material as THREE.Material).dispose(); state.highlight = undefined; }
    const object = selected ? state.object?.objects.get(selectionKey(selected)) : undefined;
    if (object) { state.highlight = new THREE.Box3Helper(new THREE.Box3().setFromObject(object), '#e2a000'); state.scene.add(state.highlight); }
    state.render();
  }, [projection, arrangement, display.explosion, display.opening, selected]);
  // Related uses get a neutral outline (theme token), distinct from the selected accent; no animation.
  const relatedKey = JSON.stringify((related ?? []).map(address => selectionKey(address)));
  useEffect(() => {
    const state = live.current; if (!state) return;
    state.relatedMarks.forEach(mark => { state.scene.remove(mark); disposeMark(mark); }); state.relatedMarks = [];
    const color = tokenColor('--sb-border-strong', '#8a8f98');
    for (const address of related ?? []) {
      const object = state.object?.objects.get(selectionKey(address));
      if (!object || (selected && selectionKey(selected) === selectionKey(address))) continue;
      const mark = new THREE.Box3Helper(new THREE.Box3().setFromObject(object), color);
      themedMaterial(mark.material as THREE.LineBasicMaterial, '--sb-border-strong', '#8a8f98');
      state.scene.add(mark); state.relatedMarks.push(mark);
    }
    state.render();
  }, [projection, arrangement, display.explosion, display.opening, selected, relatedKey]);
  return <Stack>
    {problem && <Alert color="yellow" role="alert">{problem}</Alert>}
    <DisplayControls scene={projection} arrangement={arrangement} selected={selected} display={display} setDisplay={setDisplay} input={input} setInput={setInput} restore={() => { onRestoreCanonical?.(); setInput(openingInput()); setDisplay(closedDisplay()); reset.current('isometric'); }} />
    <Group><Button variant="light" onClick={() => reset.current()}>Fit scene</Button><Button variant="light" onClick={() => reset.current('isometric')}>Orthographic isometric</Button><Button variant="light" onClick={() => reset.current('top')}>Orthographic top</Button><Button variant="light" onClick={() => reset.current('front')}>Orthographic front</Button><Button variant="light" onClick={() => reset.current('end')}>Orthographic end</Button></Group>
    <div ref={host} className="sb-viewer sb-viewer-3d" style={{ display: problem ? 'none' : 'block' }} />
    <Text size="sm">Drag to orbit, wheel to zoom, right-drag to pan. Click geometry to select its contextual occurrence. All views are orthographic illustrations; display geometry provides no fit, clearance or manufacturing approval.</Text>
    {unknown.map((issue, i) => <Text size="sm" key={i}>{issue}</Text>)}
  </Stack>;
}

function disposeMark(mark: THREE.Box3Helper) { mark.geometry.dispose(); (mark.material as THREE.Material).dispose(); }
