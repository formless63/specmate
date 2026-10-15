/**
 * Choosing a face for a connector body record.
 *
 * An explicit geometry (a library key, `{ key, gender }`, or a full geometry object)
 * always wins. Without one, a face is inferred only from an unambiguous family text and
 * pin count; anything else returns `null` so the caller keeps its pin list. A family
 * name never establishes mating compatibility.
 */

import type { ConnectorGeometry, Gender } from './geometry';
import { CONNECTOR_GEOMETRIES } from './library';

export interface BodyLike {
  family?: string | null;
  pin_count?: number | null;
  geometry?: unknown;
  /** optional: `plug` selects the male face, `receptacle` the female face */
  mating_role?: string | null;
}

const genderOf = (value: unknown): Exclude<Gender, 'ungendered'> | null => {
  if (value === 'male' || value === 'plug') return 'male';
  if (value === 'female' || value === 'receptacle' || value === 'socket' || value === 'jack') return 'female';
  return null;
};

function isGeometry(value: unknown): value is ConnectorGeometry {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<ConnectorGeometry>;
  return typeof v.key === 'string' && typeof v.outline === 'object' && Array.isArray(v.pins) && Array.isArray(v.layers) && Array.isArray(v.keyways);
}

/** A library entry by key, optionally switched to a gender. Unknown keys return null. */
export function geometryByKey(key: string, gender?: Exclude<Gender, 'ungendered'> | null): ConnectorGeometry | null {
  const found = CONNECTOR_GEOMETRIES[key];
  if (found === undefined) return null;
  if (!gender || found.gender === 'ungendered' || found.gender === gender) return found;
  const base = key.replace(/-(male|female)$/, '');
  return CONNECTOR_GEOMETRIES[`${base}-${gender}`] ?? found;
}

/** The inferred library base key for a family text and pin count, or null when ambiguous. */
export function inferGeometryKey(family: string, pinCount: number | null | undefined): string | null {
  const f = family.trim().toLowerCase();
  const n = pinCount ?? null;
  const has = (re: RegExp): boolean => re.test(f);
  if (has(/s-?video/)) return 's-video';
  if (has(/mini[\s-]?din/)) return n !== null && n >= 3 && n <= 10 ? `mini-din-${n}` : null;
  if (has(/\bjp-?21\b/)) return 'jp21';
  if (has(/\b(scart|peritel|euroconnector)\b/)) return 'scart';
  if (has(/\b(hd-?15|de-?15|vga)\b/)) return 'de-15-hd';
  if (has(/\b(de-?9|db-?9)\b/)) return 'de-9';
  if (has(/\b(da-?15|db-?15)\b/)) return 'da-15';
  if (has(/\bdb-?25\b/)) return 'db-25';
  if (has(/d-?sub/)) return n === 9 ? 'de-9' : n === 15 ? 'da-15' : n === 25 ? 'db-25' : null;
  if (has(/\bdin\b/)) {
    if (n === 5 || has(/\bdin[\s-]?5\b/)) return has(/240/) ? 'din-5-240' : has(/180/) ? 'din-5-180' : null;
    if (n === 8 || has(/\bdin[\s-]?8\b/)) return has(/262/) ? 'din-8-262' : has(/270/) ? 'din-8-270' : null;
    return null;
  }
  if (has(/\b(rca|phono|cinch)\b/)) return 'rca';
  if (has(/\bbnc\b/)) return 'bnc';
  if (has(/\btrrs\b/)) return 'trrs-3.5';
  if (has(/\btrs\b|3\.5\s?mm/)) return n === 4 ? 'trrs-3.5' : 'trs-3.5';
  if (has(/jst[\s-]?xh/)) return n !== null && n >= 2 && n <= 4 ? `jst-xh-${n}` : null;
  if (has(/jst[\s-]?ph/)) return n !== null && n >= 2 && n <= 4 ? `jst-ph-${n}` : null;
  if (has(/dupont|2\.54|pin header/)) return n !== null && [2, 3, 4, 6].includes(n) ? `header-2.54-1x${n}` : n === 10 ? 'header-2.54-2x5' : null;
  if (has(/usb[\s-]?c\b|type[\s-]?c\b/)) return 'usb-c';
  if (has(/micro[\s-]?b|micro[\s-]?usb/)) return 'usb-micro-b';
  return null;
}

/**
 * The face for a body: its declared geometry, else an unambiguous inference from its
 * family text and pin count, else `null`.
 */
export function geometryForBody(body: BodyLike): ConnectorGeometry | null {
  const role = genderOf(body.mating_role);
  const declared = body.geometry;
  if (isGeometry(declared)) return declared;
  if (typeof declared === 'string' && declared !== '') return geometryByKey(declared, role);
  if (typeof declared === 'object' && declared !== null) {
    const record = declared as { key?: unknown; geometry_key?: unknown; gender?: unknown; mating_role?: unknown };
    const key = typeof record.key === 'string' ? record.key : typeof record.geometry_key === 'string' ? record.geometry_key : null;
    if (key) return geometryByKey(key, genderOf(record.gender) ?? genderOf(record.mating_role) ?? role);
  }
  if (!body.family) return null;
  const inferred = inferGeometryKey(body.family, body.pin_count);
  if (inferred === null) return null;
  const geometry = geometryByKey(inferred, role);
  if (geometry === null) return null;
  // An inferred face must have room for the declared numbered positions.
  if (body.pin_count != null && !geometry.outlineOnly && geometry.pinCount !== body.pin_count) return null;
  return geometry;
}
