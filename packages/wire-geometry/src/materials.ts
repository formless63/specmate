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

/** Tile size of the generated surface textures, px. */
export const TILE = 128;
const fract = (v: number): number => v - Math.floor(v);
/** Lit profile across one round strand: bright on its crown, dark in the gap beside it. */
const crown = (f: number): number => { const c = 2 * f - 1; return Math.sqrt(Math.max(0, 1 - c * c)); };

/**
 * Greyscale RGBA tile multiplied with the base colour (and used as a bump map for metals). Returns null
 * for smooth surfaces. `u` runs along the cable, `v` once around it. A braid is two carrier families
 * crossing over and under, each carrier a few round ends wide; strands and a served (spiral) screen are
 * round wires laid side by side as a helix.
 */
export function patternPixels(texture: Texture, size = TILE): Uint8Array | null {
  if (texture === 'none' || texture === 'solid-metal' || texture === 'foil') return null;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
    const u = x / size, v = y / size;
    const wave = (t: number): number => Math.abs(fract(t) - 0.5) * 2; // 0 at line centre, 1 between
    let shade = 1;
    switch (texture) {
      case 'strands': shade = 0.35 + 0.65 * crown(fract(7 * (u - v))); break;
      case 'spiral': shade = 0.3 + 0.7 * crown(fract(10 * (u - v))); break;
      case 'braid': {
        const a = 4 * (u + v), b = 4 * (u - v);
        const over = (Math.floor(a) + Math.floor(b)) & 1;
        const along = over === 0 ? fract(b) : fract(a), across = over === 0 ? fract(a) : fract(b);
        // Each carrier dips under its neighbour at both ends of its float.
        shade = 0.2 + 0.8 * (0.55 + 0.45 * Math.sin(Math.PI * along)) * (0.35 + 0.65 * crown(fract(across * 4)));
        break;
      }
      case 'tape': shade = 0.72 + 0.28 * Math.min(1, wave(3 * v) * 1.5); break;
      case 'foam': shade = 0.8 + 0.2 * (0.5 + 0.5 * Math.sin(61 * u + 3 * Math.cos(47 * v)) * Math.cos(53 * v)); break;
      case 'fibre': shade = 0.72 + 0.28 * Math.min(1, Math.min(wave(8 * u), wave(8 * v)) * 2); break;
      case 'unknown': shade = 0.55 + 0.45 * Math.min(1, wave(3 * (u + v)) * 1.4); break;
    }
    const value = Math.round(255 * Math.max(0, Math.min(1, shade)));
    const i = (y * size + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = value; data[i + 3] = 255;
  }
  return data;
}

/** Textures whose relief is lit as well as coloured: a bump map raises the strand crowns. */
const RELIEF = new Set<Texture>(['strands', 'spiral', 'braid']);

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
        texture = new THREE.DataTexture(pixels, TILE, TILE, THREE.RGBAFormat);
        texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.generateMipmaps = true; texture.minFilter = THREE.LinearMipmapLinearFilter; texture.magFilter = THREE.LinearFilter; texture.anisotropy = 4;
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
      const metal = look.metalness > 0.5;
      const relief = map && RELIEF.has(look.texture);
      // A relief map is greyscale, so the colour map doubles as the bump map (one upload).
      const surface = { ...(map ? { map } : {}), ...(relief ? { bumpMap: map, bumpScale: metal ? 1.2 : 0.8 } : {}) };
      const plastic = !metal && look.fillSource !== 'unknown' && look.finish !== 'foam' && look.finish !== 'fibre';
      // Plastics get a soft sheen, strongest on the overall jacket, so a dark jacket keeps its form.
      const sheen = plastic ? (piece.kind === 'jacket' ? 0.4 : 0.25) : 0;
      const material = new THREE.MeshPhysicalMaterial({
        color: look.base, roughness: relief ? Math.min(1, look.roughness + 0.08) : look.roughness,
        metalness: options.environment ? look.metalness : Math.min(look.metalness, 0.35),
        clearcoat: look.clearcoat, clearcoatRoughness: 0.25, ...surface,
        ...(sheen > 0 ? { sheen, sheenRoughness: 0.45, sheenColor: new THREE.Color(look.base).lerp(new THREE.Color('#ffffff'), 0.4) } : {}),
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
