/** Browser projection of the authoritative version 1 stock contract. */
export type ElementKind = 'conductor' | 'dielectric' | 'insulation' | 'shield' | 'drain' | 'filler' | 'jacket' | 'web' | 'group';
export interface ElementBase {
  id: string;
  label: string;
  material: string | null;
  color: string | null;
  source: string | null;
  /** Offset from the parent; null is unknown and leaves the position unknown. */
  x_mm: number | null;
  y_mm: number | null;
}
export interface RoundElement extends ElementBase {
  kind: Exclude<ElementKind, 'web' | 'group'>;
  outer_diameter_mm: number | null;
  inner_diameter_mm: number | null;
  construction: 'solid' | 'stranded' | 'braid' | 'spiral' | 'foil' | 'tape' | null;
  area_mm2: number | null;
}
export interface WebElement extends ElementBase {
  kind: 'web'; width_mm: number | null; height_mm: number | null;
}
export interface GroupElement extends ElementBase {
  kind: 'group';
  role: 'stock' | 'coax' | 'pair' | 'ribbon' | 'figure-eight' | 'bundle';
  arrangement: 'concentric' | 'ring' | 'linear' | 'figure-eight';
  pitch_mm: number | null;
  direction: 'cw' | 'ccw';
  children: StockElement[];
}
export type StockElement = RoundElement | WebElement | GroupElement;
export interface Fact {
  value: number | string | null;
  unit: string | null;
  source: string | null;
  status: 'unknown' | 'documented' | 'measured' | 'inferred';
}
export interface StockSpecification {
  schema_version: '1';
  construction: 'coax' | 'pair' | 'ribbon' | 'figure-eight' | 'bundle';
  viewed_from: 'a' | 'b' | 'unknown';
  structure: GroupElement;
  facts: Record<string, Fact>;
}
export interface SectionRow {
  path: string;
  kind: Exclude<ElementKind, 'group'>;
  label: string;
  material: string | null;
  color: string | null;
  source: string | null;
  widthMm: number | null;
  heightMm: number | null;
  outerDiameterMm: number | null;
  innerDiameterMm: number | null;
  tag: string;
  construction?: RoundElement['construction'];
}
export interface SectionFeature {
  path: string;
  kind: Exclude<ElementKind, 'group'>;
  x: number;
  y: number;
  color: string | null;
  /** Null means unknown material, distinct from the display fallback. */
  material: string | null;
  /** Recorded construction (stranded, braid, foil ...); null when unrecorded or not applicable. */
  construction?: RoundElement['construction'];
  shape: { type: 'ring'; rOuter: number; rInner: number } | { type: 'web'; width: number; height: number };
}
/** A ring-arranged group: members are placed from 12 o'clock in the stated screen direction. */
export interface SectionGroup {
  path: string;
  arrangement: GroupElement['arrangement'];
  direction: GroupElement['direction'];
  /** Paths of the arranged members, in placement order. */
  members: string[];
}
export interface Section {
  schemaVersion: '1';
  viewedFrom: StockSpecification['viewed_from'];
  rows: SectionRow[];
  features: SectionFeature[];
  /** Arranged groups, kept so end faces can state how each ring reads. */
  groups?: SectionGroup[];
  unknown: string[];
  widthMm: number | null;
  heightMm: number | null;
  bounds: { minX: number; minY: number; maxX: number; maxY: number } | null;
  outline: string | null;
  /** The section has no electrical topology or implicit bonds. */
  electricalBonds: readonly [];
}
export interface StockGeometry {
  lengthMm: number;
  widthMm: number | null;
  heightMm: number | null;
  pieces: (SectionFeature & { startMm: number; endMm: number })[];
  unknown: string[];
}
