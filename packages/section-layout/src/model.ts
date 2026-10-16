/** Browser projection of the authoritative version 1 stock contract. */
export type ElementKind = 'conductor' | 'dielectric' | 'insulation' | 'shield' | 'drain' | 'filler' | 'jacket' | 'web' | 'group';
export interface ElementBase {
  id: string;
  label: string;
  material: string | null;
  color: string | null;
  source: string | null;
  color_label?: string | null;
  stripe_colors?: string[];
  facts?: Record<string, Fact>;
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
  insulated_diameter_mm?: number | null;
  insulation_material?: string | null;
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
  bonded_sets?: { local_id: string; element_paths: string[]; basis: string }[] | null;
  lay?: { arrangement: 'pair' | '6-around-1' | '6-around-2' | '7-around-1' | 'figure-8'; direction: 'cw' | 'ccw'; viewed_from: 'a' | 'b' | 'unknown'; ring: string[]; center: string | null; inner: string[]; source: string; status: 'documented' | 'measured' | 'inferred' } | null;
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
  insulatedDiameterMm?: number | null;
  colorLabel?: string | null;
  stripeColors?: string[];
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
  colorLabel?: string | null;
  stripeColors?: string[];
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
