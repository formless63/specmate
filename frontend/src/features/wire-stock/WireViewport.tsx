// SPDX-License-Identifier: AGPL-3.0-only
// Lazy, event-driven lifecycle adapted from WireHub WireModel3d.tsx (see NOTICE).
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Group, Stack, Text } from '@mantine/core';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildWireObject } from '../../../../packages/wire-geometry/src/scene';
import type { WireModel } from '../../../../packages/wire-geometry/src/model';

interface Live { scene: THREE.Scene; object?: ReturnType<typeof buildWireObject>; frame: (end?: 'a' | 'b') => void }

export default function WireViewport({ model }: { model: WireModel }) {
  const host = useRef<HTMLDivElement>(null);
  const live = useRef<Live | null>(null);
  const reset = useRef<(end?: 'a' | 'b') => void>(() => {});
  const [problem, setProblem] = useState('');
  useEffect(() => {
    const container = host.current;
    if (!container) return;
    setProblem('');
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true }); }
    catch { setProblem('WebGL is unavailable. The section drawing and element dimensions remain available.'); return; }
    const element = renderer.domElement;
    element.setAttribute('aria-label', 'Interactive prepared wire preview');
    element.style.cssText = 'width:100%;height:360px;display:block;touch-action:none';
    container.appendChild(element);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const scene = new THREE.Scene(); scene.background = new THREE.Color('#e9edf2');
    scene.add(new THREE.HemisphereLight('#ffffff', '#606975', 3));
    const light = new THREE.DirectionalLight('#ffffff', 3); light.position.set(-5, 10, 8); scene.add(light);
    const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 10000);
    const controls = new OrbitControls(camera, element);
    controls.enableDamping = false;
    const render = () => renderer.render(scene, camera);
    const frame = (end?: 'a' | 'b') => {
      const bounds = live.current?.object ? new THREE.Box3().setFromObject(live.current.object.group) : new THREE.Box3();
      const center = bounds.isEmpty() ? new THREE.Vector3() : bounds.getCenter(new THREE.Vector3());
      const radius = bounds.isEmpty() ? 1 : Math.max(bounds.getSize(new THREE.Vector3()).length() / 2, 0.001);
      const direction = (end ? new THREE.Vector3(end === 'a' ? -1 : 1, 0.03, 0.02) : new THREE.Vector3(-0.35, 0.8, 1)).normalize();
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
    live.current = { scene, frame };
    reset.current = frame;
    const resize = () => {
      const width = Math.max(container.clientWidth, 1), height = 360;
      renderer.setSize(width, height, false); camera.aspect = width / height; frame();
    };
    controls.addEventListener('change', render);
    const observer = new ResizeObserver(resize); observer.observe(container); resize();
    const lost = (event: Event) => { event.preventDefault(); setProblem('The WebGL context was lost. Close and reopen the 3D preview to retry.'); };
    element.addEventListener('webglcontextlost', lost);
    return () => {
      reset.current = () => {};
      observer.disconnect(); element.removeEventListener('webglcontextlost', lost);
      controls.removeEventListener('change', render); controls.dispose(); live.current?.object?.dispose(); live.current = null;
      renderer.dispose(); renderer.forceContextLoss(); element.remove();
    };
  }, []);
  useEffect(() => {
    const state = live.current;
    if (!state) return;
    if (state.object) { state.scene.remove(state.object.group); state.object.dispose(); }
    state.object = buildWireObject(model); state.scene.add(state.object.group); state.frame();
  }, [model]);
  return <Stack>
    {problem && <Alert color="yellow" role="alert">{problem}</Alert>}
    <Group><Button variant="light" onClick={() => reset.current()}>Fit 3D view</Button><Button variant="light" onClick={() => reset.current('a')}>View end A</Button><Button variant="light" onClick={() => reset.current('b')}>View end B</Button></Group>
    <div ref={host} style={{ display: problem ? 'none' : 'block' }} />
    <Text size="sm">Drag to orbit, wheel to zoom, right-drag to pan. End A is x = 0; end B is x = preview length. Colors and leads are illustrative; geometry establishes no fit or qualification.</Text>
  </Stack>;
}
