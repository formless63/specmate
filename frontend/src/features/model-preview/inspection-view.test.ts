import * as THREE from 'three';
import { afterEach, expect, test, vi } from 'vitest';
import { addInspectionLighting, aimInspectionLighting, connectFreeOrbitUpdates, createFreeOrbitControls } from './inspection-view';

afterEach(() => { vi.restoreAllMocks(); });

function pointer(type: string, x: number, y: number, button = 0) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { button, pointerId: 1, pointerType: 'mouse', pageX: x, pageY: y, clientX: x, clientY: y });
  return event;
}

function fixture() {
  const element = document.createElement('canvas');
  element.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 300, bottom: 360, width: 300, height: 360, toJSON: () => ({}) });
  element.setPointerCapture = () => {};
  element.releasePointerCapture = () => {};
  const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 100);
  camera.position.set(0, 0, 5); camera.lookAt(0, 0, 0);
  const controls = createFreeOrbitControls(camera, element);
  return { element, camera, controls };
}

test('mouse rotation crosses the pole and the camera-facing underside gets comparable light', () => {
  const { element, camera, controls } = fixture();
  let runFrame: FrameRequestCallback | undefined;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { runFrame = callback; return 1; });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  const removeUpdates = connectFreeOrbitUpdates(controls, () => true);
  const scene = new THREE.Scene(), lights = addInspectionLighting(scene), target = new THREE.Vector3();
  const faceLight = () => {
    const normal = camera.position.clone().sub(target).normalize();
    const keyDirection = lights.key.position.clone().sub(target).normalize();
    const fillDirection = lights.fill.position.clone().sub(target).normalize();
    const hemisphere = (lights.hemisphere.color.r + lights.hemisphere.groundColor.r) / 2 * lights.hemisphere.intensity;
    return lights.ambient.intensity + hemisphere + lights.key.intensity * Math.max(0, normal.dot(keyDirection)) + lights.fill.intensity * Math.max(0, normal.dot(fillDirection));
  };
  aimInspectionLighting(lights, camera, target, 1);
  const topFacing = faceLight();
  element.dispatchEvent(pointer('pointerdown', 150, 180));
  document.dispatchEvent(pointer('pointermove', 150, 440));
  expect(runFrame).toBeDefined();
  runFrame!(0);
  expect(camera.position.z).toBeLessThan(0);
  aimInspectionLighting(lights, camera, target, 1);
  const undersideFacing = faceLight();
  expect(undersideFacing).toBeGreaterThan(topFacing * 0.9);
  expect(undersideFacing).toBeLessThan(topFacing * 1.1);
  document.dispatchEvent(pointer('pointerup', 150, 440));
  removeUpdates(); controls.dispose();
});

test('zoom and pan update on input, hidden or inactive views skip updates, and pending frames are cancelled', () => {
  const { element, camera, controls } = fixture();
  let runFrame: FrameRequestCallback | undefined, nextId = 0;
  const request = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { runFrame = callback; return ++nextId; });
  const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  let allowed = true; const removeUpdates = connectFreeOrbitUpdates(controls, () => allowed);
  element.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, cancelable: true }));
  runFrame!(0); const zoomed = camera.position.distanceTo(controls.target); expect(zoomed).toBeLessThan(5);
  element.dispatchEvent(pointer('pointerdown', 150, 180, 2));
  document.dispatchEvent(pointer('pointermove', 210, 180, 2)); runFrame!(1);
  expect(controls.target.x).not.toBe(0);
  allowed = false; const position = camera.position.clone();
  document.dispatchEvent(pointer('pointermove', 250, 180, 2)); runFrame!(2);
  expect(camera.position.equals(position)).toBe(true);
  allowed = true; const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  document.dispatchEvent(pointer('pointermove', 260, 180, 2)); expect(request).toHaveBeenCalledTimes(2);
  visibility.mockReturnValue('visible');
  document.dispatchEvent(pointer('pointermove', 280, 180, 2));
  expect(request).toHaveBeenCalledTimes(3);
  removeUpdates(); expect(cancel).toHaveBeenCalledTimes(1);
  controls.dispose();
});
