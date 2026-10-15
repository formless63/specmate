import { describe, expect, it } from 'vitest';
import { appearanceOf, classifyMaterial, edgeColor, endFaceLayout, luminance, renderEndFaceSvg, renderSectionSvg, resolveColor, sectionLayout } from '../../../../packages/section-layout/src';
import { braidedCoax, shieldedPair, unrecordedCoax } from './fixtures';

const parse = (svg: string) => new DOMParser().parseFromString(svg, 'image/svg+xml');

describe('color resolution', () => {
  it('draws a recorded hex color exactly as recorded', () => {
    expect(resolveColor('#1B1b1D')).toEqual({ status: 'known', hex: '#1b1b1d', named: false, label: '#1b1b1d' });
    expect(resolveColor('#abc')).toMatchObject({ status: 'known', hex: '#aabbcc' });
  });
  it('reads a tracer stripe and flags conventional names', () => {
    expect(resolveColor('white/blue')).toMatchObject({ status: 'known', hex: '#f4f4f0', stripe: '#1f5fbf', named: true });
  });
  it('never guesses: unrecorded, malformed and injected values are unknown', () => {
    expect(resolveColor(null)).toMatchObject({ status: 'unknown', reason: 'unrecorded' });
    expect(resolveColor('')).toMatchObject({ status: 'unknown', reason: 'unrecorded' });
    for (const bad of ['sparkling', 'red" onload="x', 'red/blue/green', '#12', 'red/']) expect(resolveColor(bad)).toMatchObject({ status: 'unknown', reason: 'unparseable' });
  });
});

describe('material classification', () => {
  it.each([
    ['Tinned copper', 'tinned-copper'], ['OFC', 'copper'], ['Silver plated copper', 'silver-plated-copper'],
    ['copper-clad aluminum', 'copper-clad-aluminum'], ['Aluminum foil on polyester', 'aluminum-foil'],
    ['Mylar / aluminum laminate', 'aluminum-foil'], ['aluminum', 'aluminum'], ['aluminium', 'aluminum'], ['Aluminium foil', 'aluminum-foil'], ['Foam PE', 'foam-polyethylene'],
    ['FEP', 'fluoropolymer'], ['PTFE', 'fluoropolymer'], ['PVC', 'pvc'], ['XLPE', 'polyethylene'], ['Silicone rubber', 'silicone'],
    ['TPE', 'elastomer'], ['PUR', 'polyurethane'], ['Kapton', 'polyimide'], ['cotton yarn', 'textile'], ['Unobtainium', 'unrecognized'],
  ])('%s -> %s', (text, family) => expect(classifyMaterial(text)).toBe(family));
  it('treats null as unrecorded, distinct from unrecognized', () => expect(classifyMaterial(null)).toBe('unrecorded'));
});

describe('element appearance', () => {
  it('uses the material-typical hue for a bare metal with no color, and says so', () => {
    const a = appearanceOf({ kind: 'conductor', color: null, material: 'Copper', construction: 'stranded' });
    expect(a).toMatchObject({ base: '#b87333', fillSource: 'material-typical', texture: 'strands', finish: 'metal', metalness: 1 });
    expect(a.notes.join(' ')).toContain('typical color');
  });
  it('keeps an unrecorded polymer color unknown rather than guessing', () => {
    const a = appearanceOf({ kind: 'insulation', color: null, material: 'PVC' });
    expect(a.fillSource).toBe('unknown');
    expect(a.texture).toBe('none');
    const b = appearanceOf({ kind: 'jacket', color: null, material: null });
    expect(b).toMatchObject({ fillSource: 'unknown', texture: 'unknown', materialLabel: 'Unknown', colorLabel: 'Unknown' });
  });
  it('draws a conductor of unrecorded material as neutral metal, not copper', () => {
    const a = appearanceOf({ kind: 'conductor', color: null, material: null, construction: null });
    expect(a).toMatchObject({ fillSource: 'kind-neutral', finish: 'metal' });
    expect(a.base).not.toBe('#b87333');
  });
  it('selects the shield texture from its recorded construction', () => {
    for (const construction of ['braid', 'spiral', 'tape', 'foil'] as const)
      expect(appearanceOf({ kind: 'shield', color: null, material: 'Tinned copper', construction }).texture).toBe(construction);
  });
  it('keeps edges visible on near-black and near-white fills', () => {
    expect(luminance(edgeColor('#101010'))).toBeGreaterThan(luminance('#101010'));
    expect(luminance(edgeColor('#f4f4f0'))).toBeLessThan(luminance('#f4f4f0'));
  });
});

describe('realistic section drawing', () => {
  it('draws each element in its recorded color with material texture and finish attributes', () => {
    const svg = parse(renderSectionSvg(sectionLayout(shieldedPair()), 'Pair'));
    const el = (path: string) => svg.querySelector(`[data-element="${path}"]`)!;
    expect(el('stock.pair.core-a.insulation').getAttribute('data-fill-source')).toBe('conventional-name');
    expect(el('stock.pair.core-a.insulation').querySelector('path')!.getAttribute('fill')).toBe('#c62828');
    expect(el('stock.jacket').querySelector('path')!.getAttribute('fill')).toBe('#1b1b1d');
    expect(el('stock.jacket').getAttribute('data-fill-source')).toBe('recorded');
    expect(el('stock.pair.core-a.wire').getAttribute('data-texture')).toBe('strands');
    expect(el('stock.screen').getAttribute('data-material-family')).toBe('aluminum-foil');
    expect(el('stock.pair.core-b.insulation').querySelector('[data-stripe]')!.getAttribute('stroke')).toBe('#1f5fbf');
  });
  it('hatches unrecorded elements and says so in the description', () => {
    const svg = parse(renderSectionSvg(sectionLayout(unrecordedCoax()), 'Coax'));
    expect(svg.querySelector('[data-element="stock.jacket"]')!.getAttribute('data-fill-source')).toBe('unknown');
    expect(svg.querySelector('[data-element="stock.jacket"]')!.getAttribute('data-texture')).toBe('unknown');
    expect(svg.querySelector('desc')!.textContent).toMatch(/2 elements drawn hatched/);
  });
  it('references only ids it defines and nothing external', () => {
    const text = renderSectionSvg(sectionLayout(shieldedPair()), 'Pair');
    const svg = parse(text);
    const all = [...svg.querySelectorAll('[id]')].map(e => e.getAttribute('id'));
    const refs = [...text.matchAll(/url\(#([^)]+)\)/g)].map(m => m[1]!);
    expect(refs.length).toBeGreaterThan(5);
    for (const ref of refs) expect(all).toContain(ref);
    expect(text).not.toMatch(/https?:\/\/(?!www\.w3\.org)|<image|href=/);
    expect(new Set(all).size).toBe(all.length);
  });
  it('is deterministic and keeps ids distinct between different drawings', () => {
    const a = renderSectionSvg(sectionLayout(shieldedPair()), 'A');
    expect(renderSectionSvg(sectionLayout(shieldedPair()), 'A')).toBe(a);
    const b = renderSectionSvg(sectionLayout(braidedCoax()), 'B');
    const idsOf = (t: string) => new Set([...t.matchAll(/ id="([^"]+)"/g)].map(m => m[1]));
    for (const id of idsOf(a)) expect(idsOf(b).has(id)).toBe(false);
  });
  it('marks selection with a reticle and leaves the engineering fill alone', () => {
    const section = sectionLayout(braidedCoax());
    const plain = parse(renderSectionSvg(section, 'C'));
    const picked = parse(renderSectionSvg(section, 'C', { selected: 'stock.braid' }));
    expect(plain.querySelector('[data-selected]')).toBeNull();
    expect(picked.querySelector('[data-selected]')).not.toBeNull();
    const fill = (d: Document) => d.querySelector('[data-element="stock.braid"] path')!.getAttribute('fill');
    expect(fill(picked)).toBe(fill(plain));
  });
  it('does not inject unsafe color text', () => {
    const section = sectionLayout(braidedCoax());
    section.features[0]!.color = 'red" onload="alert(1)';
    expect(renderSectionSvg(section, 'x')).not.toContain('onload');
  });
});

describe('end face', () => {
  const section = sectionLayout(shieldedPair());
  const at = (r: ReturnType<typeof endFaceLayout>) => { if (r.status !== 'ok') throw new Error(r.reason); return r.face; };
  it('draws the viewed-from end as recorded and the other end mirrored', () => {
    const a = at(endFaceLayout(section, 'a')), b = at(endFaceLayout(section, 'b'));
    expect(a.mirrored).toBe(false);
    expect(b.mirrored).toBe(true);
    const drain = (f: typeof a) => f.terminals.find(t => t.role === 'drain')!;
    expect(drain(a).x).toBeCloseTo(1.2, 10);
    expect(drain(b).x).toBeCloseTo(-1.2, 10);
    expect(drain(b).y).toBeCloseTo(drain(a).y, 10);
  });
  it('reverses how each ring reads at the opposite end', () => {
    expect(at(endFaceLayout(section, 'a')).ringReadings).toEqual([{ path: 'stock.pair', drawn: 'cw', atThisEnd: 'cw' }]);
    expect(at(endFaceLayout(section, 'b')).ringReadings).toEqual([{ path: 'stock.pair', drawn: 'cw', atThisEnd: 'ccw' }]);
  });
  it('turns counter-clockwise on screen', () => {
    const turned = at(endFaceLayout(section, 'a', { rotationDeg: 90 }));
    const core = turned.terminals.find(t => t.path === 'stock.pair.core-a.wire')!;
    // core-a sits at 12 o'clock (0,-1); a quarter turn counter-clockwise puts it at 9 o'clock (-1,0)
    expect(core.x).toBeCloseTo(-1, 10);
    expect(core.y).toBeCloseTo(0, 10);
  });
  it('places one terminal per conducting element and none for insulation or jacket', () => {
    const face = at(endFaceLayout(section, 'a'));
    expect(face.terminals.map(t => t.path).sort()).toEqual(['stock.drain', 'stock.pair.core-a.wire', 'stock.pair.core-b.wire', 'stock.screen']);
    expect(face.unplaced).toEqual([]);
  });
  it('picks a shield up on the side the end connections leave toward', () => {
    const shield = (end: 'a' | 'b') => at(endFaceLayout(section, end)).terminals.find(t => t.role === 'shield')!;
    expect(shield('a').x).toBeCloseTo(-3.35 / 2, 10);
    expect(shield('b').x).toBeCloseTo(3.35 / 2, 10);
  });
  it('has no face when the viewed-from end is unknown, rather than inventing chirality', () => {
    const stock = shieldedPair(); stock.viewed_from = 'unknown';
    expect(endFaceLayout(sectionLayout(stock), 'a').status).toBe('unavailable');
  });
  it('renders markers upright and mirrors the drawing with a transform', () => {
    const face = at(endFaceLayout(section, 'b', { rotationDeg: 30 }));
    const svg = parse(renderEndFaceSvg(face, 'End B'));
    expect(svg.querySelector('[data-view="end-face"]')!.getAttribute('transform')).toBe('rotate(-30) scale(-1 1)');
    expect(svg.querySelectorAll('[data-terminal]')).toHaveLength(4);
    expect(svg.querySelector('[data-callout]')).toBeNull();
  });
});
