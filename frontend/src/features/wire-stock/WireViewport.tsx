// SPDX-License-Identifier: AGPL-3.0-only
// Lazy, event-driven lifecycle adapted from WireHub WireModel3d.tsx (see NOTICE).
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Alert, Button, Group, Stack, Text } from '@mantine/core';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { buildWireObject } from '../../../../packages/wire-geometry/src/scene';
import { modelSummary } from '../../../../packages/wire-geometry/src/model';
import type { WireModel } from '../../../../packages/wire-geometry/src/model';

/** Camera presets: end-on at A or B, looking down (top) or at the cable's length (front), as cab-stu's 3D wire offered. */
export type CameraView = 'a' | 'b' | 'top' | 'front';
const DIRECTIONS: Record<CameraView, [number, number, number]> = { a: [-1, 0.03, 0.02], b: [1, 0.03, 0.02], top: [0, 1, 0.02], front: [0, 0.03, 1] };
interface Live { scene: THREE.Scene; object?: ReturnType<typeof buildWireObject>; frame: (view?: CameraView) => void; environment: boolean; redraw: () => void }

export default function WireViewport({ model }: { model: WireModel }) {
  const host = useRef<HTMLDivElement>(null);
  const descriptionId = useId();
  const live = useRef<Live | null>(null);
  const reset = useRef<(view?: CameraView) => void>(() => {});
  const [problem, setProblem] = useState('');
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
    element.style.cssText = 'width:100%;height:360px;display:block;touch-action:none';
    container.appendChild(element);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    // Transparent canvas: the host's themed surface (and dot grid) shows through.
    renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 0.8;
    const scene = new THREE.Scene();
    // Image-based light gives metals and glossy jackets something to reflect. Optional: absent in minimal contexts.
    let environment = false;
    try {
      const pmrem = new THREE.PMREMGenerator(renderer);
      scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      pmrem.dispose(); environment = true;
    } catch { environment = false; }
    scene.environmentIntensity = 0.75;
    scene.add(new THREE.HemisphereLight('#ffffff', '#606975', environment ? 0.35 : 1.6));
    const light = new THREE.DirectionalLight('#ffffff', environment ? 1.4 : 1.8); light.position.set(-5, 10, 8); scene.add(light);
    const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 10000);
    const controls = new OrbitControls(camera, element);
    controls.enableDamping = false;
    const render = () => {
      if (container.clientWidth > 0 && document.visibilityState !== 'hidden') renderer.render(scene, camera);
    };
    const frame = (view?: CameraView) => {
      const bounds = live.current?.object ? new THREE.Box3().setFromObject(live.current.object.group) : new THREE.Box3();
      const center = bounds.isEmpty() ? new THREE.Vector3() : bounds.getCenter(new THREE.Vector3());
      const radius = bounds.isEmpty() ? 1 : Math.max(bounds.getSize(new THREE.Vector3()).length() / 2, 0.001);
      const direction = (view ? new THREE.Vector3(...DIRECTIONS[view]) : new THREE.Vector3(-0.35, 0.8, 1)).normalize();
      const right = new THREE.Vector3(0, 1, 0).cross(direction).normalize();
      const up = direction.clone().cross(right).normalize();
      const tanV = Math.tan(camera.fov * Math.PI / 360), tanH = tanV * camera.aspect;
      let distance = radius;
      // Fit every box corner in camera space: a long stock need not fit its length
      // into the viewport's height, and end-on views can show the actual cut face.
      if (!bounds.isEmpty()) for (const x of [bounds.min.x, bounds.max.x])
        for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
          const point = new THREE.Vector3(x, y, z).sub(center);
          distance = Math.max(distance, point.dot(direction) + Math.max(Math.abs(point.dot(right)) / tanH, Math.abs(point.dot(up)) / tanV) * 1.15);
        }
      camera.position.copy(center).addScaledVector(direction, distance);
      camera.near = Math.max(radius / 1000, 0.00001); camera.far = distance + radius * 10;
      camera.updateProjectionMatrix(); controls.target.copy(center); controls.update(); render();
    };
    live.current = { scene, frame, environment, redraw: render };
    reset.current = frame;
    const resize = () => {
      const width = container.clientWidth, height = 360;
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
      controls.removeEventListener('change', render); controls.dispose(); live.current?.object?.dispose(); live.current = null;
      renderer.dispose(); renderer.forceContextLoss(); element.remove();
    };
  }, [descriptionId]);
  useEffect(() => {
    const state = live.current;
    if (!state) return;
    if (state.object) { state.scene.remove(state.object.group); state.object.dispose(); }
    state.object = buildWireObject(model, { environment: state.environment }); state.scene.add(state.object.group); state.frame();
  }, [model]);
  const description = useMemo(() => modelSummary(model), [model]);
  return <Stack>
    {problem && <Alert color="yellow" role="alert">{problem}</Alert>}
    <Group><Button variant="light" onClick={() => reset.current()}>Fit 3D view</Button><Button variant="light" onClick={() => reset.current('a')}>View end A</Button><Button variant="light" onClick={() => reset.current('b')}>View end B</Button><Button variant="light" onClick={() => reset.current('top')}>Top view</Button><Button variant="light" onClick={() => reset.current('front')}>Front view</Button></Group>
    <div ref={host} className="sb-viewer sb-viewer-3d" style={{ display: problem ? 'none' : 'block' }} />
    <Text size="xs" id={descriptionId} data-testid={descriptionId}>{description}</Text>
    <Text size="sm">Drag to orbit, wheel to zoom, right-drag to pan. End A is x = 0; end B is x = preview length. Recorded colors and materials are shown as recorded; unrecorded ones are neutral. Leads are illustrative; geometry establishes no fit or qualification.</Text>
  </Stack>;
}
