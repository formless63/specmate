// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Physically based materials and procedural surface textures for the wire viewer.
 * Colours come only from the shared appearance model: a recorded colour is used as
 * recorded, an unrecorded one is neutral and its surface carries a visible hatch.
 * Textures are generated in code (no image assets, fonts or licensed models).
 */
import * as THREE from 'three';
import { appearanceOf } from '../../section-layout/src';
import type { Appearance, Texture } from '../../section-layout/src';
import type { WirePiece } from './model';

export const pieceAppearance = (piece: WirePiece): Appearance =>
  appearanceOf({ kind: piece.kind === 'pigtail' ? 'drain' : piece.kind, color: piece.color, material: piece.material, construction: piece.construction ?? null });

/** Greyscale RGBA tile multiplied with the base colour. Returns null for smooth surfaces. */
export function patternPixels(texture: Texture, size = 64): Uint8Array | null {
  if (texture === 'none' || texture === 'solid-metal' || texture === 'foil') return null;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
    const u = x / size, v = y / size;
    const wave = (t: number): number => Math.abs(((t % 1) + 1) % 1 - 0.5) * 2; // 0 at line centre, 1 between
    let shade = 1;
    switch (texture) {
      case 'strands': shade = 0.62 + 0.38 * Math.min(1, wave(4 * (u + v)) * 1.6); break;
      case 'braid': shade = 0.6 + 0.4 * Math.min(1, Math.min(wave(4 * (u + v)), wave(4 * (u - v))) * 1.8); break;
      case 'spiral': shade = 0.6 + 0.4 * Math.min(1, wave(3 * (u + v)) * 1.6); break;
      case 'tape': shade = 0.7 + 0.3 * Math.min(1, wave(3 * v) * 1.5); break;
      case 'foam': shade = 0.78 + 0.22 * (0.5 + 0.5 * Math.sin(61 * u + 3 * Math.cos(47 * v)) * Math.cos(53 * v)); break;
      case 'fibre': shade = 0.72 + 0.28 * Math.min(1, Math.min(wave(8 * u), wave(8 * v)) * 2); break;
      case 'unknown': shade = 0.55 + 0.45 * Math.min(1, wave(3 * (u + v)) * 1.4); break;
    }
    const value = Math.round(255 * Math.max(0, Math.min(1, shade)));
    const i = (y * size + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = value; data[i + 3] = 255;
  }
  return data;
}

export interface MaterialSet { materialFor(piece: WirePiece): THREE.Material; dispose(): void }

/** `environment` is true only when an image-based light is attached; metals are toned down without one. */
export function createMaterials(options: { environment: boolean }): MaterialSet {
  const textures = new Map<Texture, THREE.DataTexture | null>();
  const materials: THREE.Material[] = [];
  const textureFor = (kind: Texture): THREE.DataTexture | null => {
    if (!textures.has(kind)) {
      const pixels = patternPixels(kind);
      let texture: THREE.DataTexture | null = null;
      if (pixels) {
        texture = new THREE.DataTexture(pixels, 64, 64, THREE.RGBAFormat);
        texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.generateMipmaps = true; texture.minFilter = THREE.LinearMipmapLinearFilter; texture.magFilter = THREE.LinearFilter;
        texture.needsUpdate = true;
      }
      textures.set(kind, texture);
    }
    return textures.get(kind)!;
  };
  return {
    materialFor(piece) {
      const look = pieceAppearance(piece);
      const map = textureFor(look.texture);
      const material = new THREE.MeshPhysicalMaterial({
        color: look.base, roughness: look.roughness,
        metalness: options.environment ? look.metalness : Math.min(look.metalness, 0.35),
        clearcoat: look.clearcoat, clearcoatRoughness: 0.25, ...(map ? { map } : {}),
      });
      materials.push(material);
      return material;
    },
    dispose() {
      materials.forEach(m => m.dispose());
      textures.forEach(t => t?.dispose());
      materials.length = 0; textures.clear();
    },
  };
}
