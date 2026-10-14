// Synthetic constructions for cable-view checks. No catalog, vendor or customer data.
import type { GroupElement, RoundElement, StockElement, StockSpecification } from '../../../../packages/section-layout/src';

const base = { label: '', source: null, material: null, color: null, x_mm: 0, y_mm: 0 };
export const round = (kind: RoundElement['kind'], id: string, outer: number, inner: number, extra: Partial<RoundElement> = {}): RoundElement =>
  ({ ...base, label: id, id, kind, outer_diameter_mm: outer, inner_diameter_mm: inner, construction: null, area_mm2: null, ...extra });
export const group = (id: string, children: StockElement[], extra: Partial<GroupElement> = {}): GroupElement =>
  ({ ...base, label: id, id, kind: 'group', role: 'stock', arrangement: 'concentric', pitch_mm: null, direction: 'cw', children, ...extra });

/** Two coloured cores (one tracer-striped), foil screen, drain and jacket. Outer diameter 4.2 mm. */
export const shieldedPair = (): StockSpecification => ({
  schema_version: '1', construction: 'pair', viewed_from: 'a', facts: {},
  structure: group('stock', [
    group('pair', [
      group('core-a', [
        round('conductor', 'wire', 0.6, 0, { material: 'Tinned copper', construction: 'stranded' }),
        round('insulation', 'insulation', 1, 0.6, { material: 'PVC', color: 'red' }),
      ]),
      group('core-b', [
        round('conductor', 'wire', 0.6, 0, { material: 'Bare copper', construction: 'stranded' }),
        round('insulation', 'insulation', 1, 0.6, { material: 'Polyethylene', color: 'white/blue' }),
      ]),
    ], { role: 'pair', arrangement: 'ring', pitch_mm: 2, direction: 'cw' }),
    round('drain', 'drain', 0.4, 0, { material: 'Tinned copper', construction: 'stranded', x_mm: 1.2 }),
    round('shield', 'screen', 3.4, 3.3, { material: 'Aluminium foil on polyester', construction: 'foil' }),
    round('jacket', 'jacket', 4.2, 3.4, { material: 'PVC', color: '#1b1b1d' }),
  ]),
});

/** Braided coax, Ø3.2 mm, with every colour and material recorded. */
export const braidedCoax = (): StockSpecification => ({
  schema_version: '1', construction: 'coax', viewed_from: 'a', facts: {},
  structure: group('stock', [
    round('conductor', 'center', 0.5, 0, { material: 'Silver-plated copper', construction: 'solid' }),
    round('dielectric', 'dielectric', 2, 0.5, { material: 'Foam polyethylene', color: 'natural' }),
    round('shield', 'braid', 2.4, 2, { material: 'Tinned copper', construction: 'braid' }),
    round('jacket', 'jacket', 3.2, 2.4, { material: 'Polyurethane', color: '#6b4423' }),
  ]),
});

/** Same geometry with nothing recorded about colour or material. */
export const unrecordedCoax = (): StockSpecification => {
  const stock = braidedCoax();
  for (const child of stock.structure.children) if (child.kind !== 'group' && child.kind !== 'web') { child.material = null; child.color = null; }
  return stock;
};

/** Two cores side by side inside a braid screen, a drain outside the screen and a jacket. Outer diameter 4.2 mm. */
export const screenedTwinWithDrain = (): StockSpecification => ({
  schema_version: '1', construction: 'bundle', viewed_from: 'a', facts: {},
  structure: group('stock', [
    group('pair', [
      group('core-a', [
        round('conductor', 'wire', 0.5, 0, { material: 'Bare copper', construction: 'stranded' }),
        round('insulation', 'insulation', 1.3, 0.5, { material: 'Polyethylene', color: 'red' }),
      ], { x_mm: -0.7 }),
      group('core-b', [
        round('conductor', 'wire', 0.5, 0, { material: 'Bare copper', construction: 'stranded' }),
        round('insulation', 'insulation', 1.3, 0.5, { material: 'Polyethylene', color: 'yellow' }),
      ], { x_mm: 0.7 }),
    ], { role: 'pair' }),
    round('shield', 'screen', 2.9, 2.7, { material: 'Tinned copper', construction: 'braid' }),
    round('drain', 'drain', 0.4, 0, { material: 'Tinned copper', construction: 'stranded', y_mm: 1.5 }),
    round('jacket', 'jacket', 4.2, 3.4, { material: 'PVC', color: '#303030' }),
  ]),
});
