import * as THREE from 'three';
import { TrackballControls } from 'three/addons/controls/TrackballControls.js';

export function createFreeOrbitControls(camera: THREE.Camera, element: HTMLElement) {
  const controls = new TrackballControls(camera, element);
  // Static movement applies each input directly, so the viewer needs no render loop.
  controls.staticMoving = true;
  return controls;
}

/** TrackballControls collects pointer deltas and applies them from update(). */
export function connectFreeOrbitUpdates(controls: TrackballControls, canUpdate: () => boolean) {
  const element = controls.domElement;
  if (!element) return () => {};
  const document = element.ownerDocument;
  const window = document.defaultView;
  if (!window) return () => {};
  let frame = 0, disposed = false;
  const update = () => {
    frame = 0;
    if (!disposed && document.visibilityState !== 'hidden' && canUpdate()) controls.update();
  };
  const schedule = () => {
    if (!frame && !disposed && document.visibilityState !== 'hidden' && canUpdate()) frame = window.requestAnimationFrame(update);
  };
  document.addEventListener('pointermove', schedule);
  element.addEventListener('wheel', schedule);
  document.addEventListener('pointerup', schedule);
  return () => {
    disposed = true;
    if (frame) window.cancelAnimationFrame(frame);
    document.removeEventListener('pointermove', schedule);
    element.removeEventListener('wheel', schedule);
    document.removeEventListener('pointerup', schedule);
  };
}

export type InspectionLighting = {
  hemisphere: THREE.HemisphereLight;
  ambient: THREE.AmbientLight;
  key: THREE.DirectionalLight;
  fill: THREE.DirectionalLight;
};

/** Neutral ambient fill plus soft camera-relative lights keeps both model sides legible. */
export function addInspectionLighting(scene: THREE.Scene): InspectionLighting {
  const hemisphere = new THREE.HemisphereLight('#ffffff', '#e8edf2', 0.8);
  const ambient = new THREE.AmbientLight('#ffffff', 0.9);
  const key = new THREE.DirectionalLight('#ffffff', 1.15);
  const fill = new THREE.DirectionalLight('#ffffff', 0.45);
  scene.add(hemisphere, ambient, key, key.target, fill, fill.target);
  return { hemisphere, ambient, key, fill };
}

export function aimInspectionLighting(lights: InspectionLighting, camera: THREE.Camera, target: THREE.Vector3, span: number) {
  camera.updateWorldMatrix(true, false);
  const outward = new THREE.Vector3(0, 0, 1).applyQuaternion(camera.quaternion).normalize();
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion).normalize();
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion).normalize();
  lights.key.target.position.copy(target);
  lights.key.position.copy(target).addScaledVector(outward, span * 3);
  lights.fill.target.position.copy(target);
  lights.fill.position.copy(target).addScaledVector(outward, span * 2).addScaledVector(right, -span).addScaledVector(up, span * 0.5);
}
