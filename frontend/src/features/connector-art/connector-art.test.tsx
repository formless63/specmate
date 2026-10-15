import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { CONNECTOR_GEOMETRIES, ConnectorFace, geometryForBody, geometryForView, inferGeometryKey, mirrorPath, numberedPinIds, type ConnectorGeometry } from '../../../../packages/connector-art/src';

// Expected layouts are written from the published numbering rules, not read back from the code.
const g = (key: string): ConnectorGeometry => {
  const found = CONNECTOR_GEOMETRIES[key];
  if (!found) throw new Error(`missing ${key}`);
  return found;
};
/** contact ids of the row at `y` (within 0.3 mm), left to right */
const row = (geometry: ConnectorGeometry, y: number): string[] =>
  geometry.pins.filter((p) => /^\d+$/.test(p.id) && Math.abs(p.at[1] - y) < 0.3).sort((a, b) => a.at[0] - b.at[0]).map((p) => p.id);
const rows = (geometry: ConnectorGeometry): string[][] => {
  const ys = [...new Set(geometry.pins.filter((p) => p.role !== 'shell' && /^\d+$/.test(p.id)).map((p) => Math.round(p.at[1] * 10) / 10))].sort((a, b) => a - b);
  return ys.map((y) => row(geometry, y));
};
const leftToRight = (geometry: ConnectorGeometry): string[] =>
  geometry.pins.filter((p) => p.role !== 'shell' && /^\d+$/.test(p.id)).sort((a, b) => a.at[0] - b.at[0]).map((p) => p.id);
/** contact ids around a notch-down arc, from the left end over the top to the right end */
const arcOrder = (geometry: ConnectorGeometry): string[] =>
  geometry.pins.filter((p) => /^\d+$/.test(p.id) && Math.hypot(p.at[0], p.at[1]) > 2).sort((a, b) => Math.atan2(a.at[0], -a.at[1]) - Math.atan2(b.at[0], -b.at[1])).map((p) => p.id);
const range = (n: number) => Array.from({ length: n }, (_, i) => String(i + 1));

describe('library', () => {
  test('every face numbers exactly its declared positions once', () => {
    for (const geometry of Object.values(CONNECTOR_GEOMETRIES)) {
      const ids = geometry.pins.map((p) => p.id);
      expect(new Set(ids).size, geometry.key).toBe(ids.length);
      if (geometry.outlineOnly) {
        expect(geometry.pins, geometry.key).toHaveLength(0);
        continue;
      }
      const numbered = numberedPinIds(geometry);
      expect(numbered.every((id) => Number(id) >= 1 && Number(id) <= geometry.pinCount), geometry.key).toBe(true);
    }
  });

  test.each([
    ['mini-din-3-female', 3], ['mini-din-4-female', 4], ['mini-din-5-female', 5], ['mini-din-6-female', 6], ['mini-din-7-female', 7], ['mini-din-8-female', 8],
    ['mini-din-9-female', 9], ['mini-din-10-female', 10], ['din-5-180-female', 5], ['din-5-240-female', 5], ['din-8-262-female', 8], ['din-8-270-female', 8],
    ['de-9-male', 9], ['da-15-male', 15], ['db-25-male', 25], ['de-15-hd-male', 15], ['jst-xh-3-male', 3], ['jst-ph-4-male', 4], ['header-2.54-2x5-male', 10],
  ])('%s has %i numbered positions 1..n', (key, count) => {
    expect(numberedPinIds(g(key))).toEqual(range(count));
    expect(g(key).pinCount).toBe(count);
  });

  test('SCART and JP21 share the 21-position shell; contact 21 is the shell contact', () => {
    for (const key of ['scart-female', 'jp21-female', 'scart-male']) {
      expect(numberedPinIds(g(key))).toEqual(range(20));
      expect(g(key).pins.find((p) => p.id === '21')?.role).toBe('shell');
      expect(g(key).pinCount).toBe(21);
    }
    expect(g('jp21-female').pins.map((p) => p.at)).toEqual(g('scart-female').pins.map((p) => p.at));
  });

  test('mini-DIN 10 is three rows (3/4/3), not a ring of contacts', () => {
    // Socket view, bottom tab down: 10-9-8 top, 7-6-5-4 middle, 3-2-1 bottom, left to right.
    expect(rows(g('mini-din-10-female'))).toEqual([['10', '9', '8'], ['7', '6', '5', '4'], ['3', '2', '1']]);
    // The plug's face is the mirror: each row reads the other way.
    expect(rows(g('mini-din-10-male'))).toEqual([['8', '9', '10'], ['4', '5', '6', '7'], ['1', '2', '3']]);
    // the top row has its gap between 9 and 8 in the socket view
    const top = g('mini-din-10-female').pins.filter((p) => ['10', '9', '8'].includes(p.id)).sort((a, b) => a.at[0] - b.at[0]);
    expect((top[2]?.at[0] ?? 0) - (top[1]?.at[0] ?? 0)).toBeGreaterThan((top[1]?.at[0] ?? 0) - (top[0]?.at[0] ?? 0));
  });

  test('mini-DIN socket rows follow the family rule', () => {
    expect(rows(g('mini-din-4-female'))).toEqual([['4', '3'], ['2', '1']]);
    expect(rows(g('mini-din-6-female'))).toEqual([['6', '5'], ['4', '3'], ['2', '1']]);
    expect(rows(g('mini-din-7-female'))).toEqual([['7', '6', '5'], ['4', '3'], ['2', '1']]);
    expect(rows(g('mini-din-8-female'))).toEqual([['8', '7', '6'], ['5', '4', '3'], ['2', '1']]);
    expect(rows(g('mini-din-9-female'))).toEqual([['9', '8', '7'], ['6', '5', '4', '3'], ['2', '1']]);
    expect(rows(g('mini-din-6-male'))).toEqual([['5', '6'], ['3', '4'], ['1', '2']]);
    expect(g('s-video-female').pins.map((p) => p.at)).toEqual(g('mini-din-4-female').pins.map((p) => p.at));
  });

  test('full-size DIN arcs read 1-4-2-5-3 (and 6..7 around them for eight pins)', () => {
    expect(arcOrder(g('din-5-180-female'))).toEqual(['1', '4', '2', '5', '3']);
    expect(arcOrder(g('din-5-180-male'))).toEqual(['3', '5', '2', '4', '1']);
    expect(arcOrder(g('din-5-240-female'))).toEqual(['1', '4', '2', '5', '3']);
    expect(arcOrder(g('din-8-270-female'))).toEqual(['6', '1', '4', '2', '5', '3', '7']);
    expect(arcOrder(g('din-8-262-female'))).toEqual(['6', '1', '4', '2', '5', '3', '7']);
    expect(g('din-8-270-female').pins.find((p) => p.id === '8')?.at[0]).toBe(0);
    // the 262° horseshoe puts its end contacts directly below the side contacts; 270° does not
    const at = (key: string, id: string) => g(key).pins.find((p) => p.id === id)?.at ?? [NaN, NaN];
    expect(at('din-8-262-female', '6')[0]).toBeCloseTo(at('din-8-262-female', '1')[0], 0);
    expect(at('din-8-270-female', '6')[0]).toBeGreaterThan(at('din-8-270-female', '1')[0]);
  });

  test('D-sub plugs number rows left to right from the wide row; sockets mirror', () => {
    expect(rows(g('de-9-male'))).toEqual([['1', '2', '3', '4', '5'], ['6', '7', '8', '9']]);
    expect(rows(g('de-9-female'))).toEqual([['5', '4', '3', '2', '1'], ['9', '8', '7', '6']]);
    expect(rows(g('de-15-hd-male'))).toEqual([range(5), ['6', '7', '8', '9', '10'], ['11', '12', '13', '14', '15']]);
    expect(rows(g('db-25-male'))[0]).toEqual(range(13));
  });

  test('SCART socket: evens on top 20..2, odds below 21..1, cut corner at the 20 end', () => {
    expect(row(g('scart-female'), -2.4)).toEqual(['20', '18', '16', '14', '12', '10', '8', '6', '4', '2']);
    expect(row(g('scart-female'), 2.4)).toEqual(['21', '19', '17', '15', '13', '11', '9', '7', '5', '3', '1']);
    const outline = (key: string) => g(key).outline as Extract<ConnectorGeometry['outline'], { kind: 'rect' }>;
    expect(Object.keys(outline('scart-female').chamfers ?? {})).toEqual(['bl']);
    expect(Object.keys(outline('scart-male').chamfers ?? {})).toEqual(['br']);
    expect(row(g('scart-male'), -2.4)[0]).toBe('2');
  });

  test('headers number 1..n left to right; two-row headers zig-zag', () => {
    expect(leftToRight(g('jst-xh-4-male'))).toEqual(range(4));
    expect(leftToRight(g('jst-xh-4-female'))).toEqual(['4', '3', '2', '1']);
    expect(rows(g('header-2.54-2x5-male'))).toEqual([['1', '3', '5', '7', '9'], ['2', '4', '6', '8', '10']]);
  });

  test('USB outlines carry no contact positions', () => {
    expect(g('usb-c').outlineOnly).toBe(true);
    expect(g('usb-micro-b-male').pins).toEqual([]);
  });
});

describe('views', () => {
  test('the solder side mirrors every position, the outline and the keyways', () => {
    const face = g('mini-din-10-female');
    const solder = geometryForView(face, 'solder');
    face.pins.forEach((pin, i) => {
      expect(solder.pins[i]?.at[0]).toBeCloseTo(-pin.at[0], 9);
      expect(solder.pins[i]?.at[1]).toBe(pin.at[1]);
    });
    // a socket seen from its solder side matches the plug's mating face
    expect(geometryForView(g('de-9-female'), 'solder').pins.map((p) => [p.id, p.at])).toEqual(g('de-9-male').pins.map((p) => [p.id, [p.at[0] + 0, p.at[1]]]));
    expect(geometryForView(face, 'mating')).toBe(face);
  });

  test('paths mirror exactly and twice is the identity', () => {
    const d = 'M-24 1.75 L-24 7.75 L-21 7.75 Z';
    expect(mirrorPath(d)).toBe('M24 1.75 L24 7.75 L21 7.75 Z');
    expect(mirrorPath(mirrorPath(d))).toBe(d);
    expect(() => mirrorPath('M0 0 l1 1 Z')).toThrow();
  });
});

describe('geometryForBody', () => {
  test('a declared key wins, and a mating role picks the gender', () => {
    expect(geometryForBody({ family: 'anything', geometry: 'mini-din-10' })?.key).toBe('mini-din-10-female');
    expect(geometryForBody({ geometry: 'mini-din-10', mating_role: 'plug' })?.key).toBe('mini-din-10-male');
    expect(geometryForBody({ geometry: { key: 'scart', gender: 'male' } })?.key).toBe('scart-male');
    expect(geometryForBody({ geometry: { geometry_key: 'scart', mating_role: 'receptacle' } })?.key).toBe('scart-female');
    expect(geometryForBody({ geometry: g('bnc-male') })?.key).toBe('bnc-male');
    expect(geometryForBody({ geometry: 'no-such-face' })).toBeNull();
  });

  test('inference needs an unambiguous family and a matching count', () => {
    expect(geometryForBody({ family: 'Mini-DIN 9', pin_count: 9 })?.key).toBe('mini-din-9-female');
    expect(geometryForBody({ family: 'mini din', pin_count: 11 })).toBeNull();
    expect(geometryForBody({ family: 'S-Video', pin_count: 4 })?.key).toBe('s-video-female');
    expect(inferGeometryKey('DIN', 5)).toBeNull();
    expect(inferGeometryKey('DIN 8 262°', 8)).toBe('din-8-262');
    expect(geometryForBody({ family: 'DE-9', pin_count: 9 })?.key).toBe('de-9-male');
    expect(geometryForBody({ family: 'D-Sub', pin_count: 25, mating_role: 'receptacle' })?.key).toBe('db-25-female');
    expect(geometryForBody({ family: 'SCART', pin_count: 20 })).toBeNull();
    expect(geometryForBody({ family: '10-pin round DIN', pin_count: 10 })).toBeNull();
    expect(geometryForBody({ family: null, pin_count: 10 })).toBeNull();
  });
});

describe('ConnectorFace', () => {
  test('draws an accessible image with one marker per position', () => {
    const { container } = render(<ConnectorFace geometry={g('mini-din-10-female')} />);
    const img = screen.getByRole('img', { name: /Mini-DIN 10 socket mating face, 10 positions/ });
    expect(img.getAttribute('data-view')).toBe('mating');
    expect(container.querySelectorAll('[data-pin]')).toHaveLength(11);
  });

  test('pins without a supplied entry are unknown and hatched, never plain', () => {
    const { container } = render(<ConnectorFace geometry={g('mini-din-4-female')} pins={[{ id: '1', state: 'pass', label: 'Luma ground' }, { id: '2', fill: '#c33' }]} />);
    const state = (id: string) => container.querySelector(`[data-pin="${id}"]`)?.getAttribute('data-state');
    expect(state('1')).toBe('pass');
    expect(state('2')).toBe('none');
    expect(state('3')).toBe('unknown');
    expect(state('shell')).toBe('none');
    expect(container.querySelector('[data-pin="3"] circle')?.getAttribute('fill')).toMatch(/^url\(#sb-cf-hatch-/);
  });

  test('clickable pins are buttons that respond to click and keyboard', () => {
    const onPinClick = vi.fn();
    render(<ConnectorFace geometry={g('de-9-male')} pins={[{ id: '3', label: 'Data out' }]} selectedPinId="3" onPinClick={onPinClick} />);
    const pin = screen.getByRole('button', { name: 'Pin 3, Data out, selected' });
    expect(pin.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: /^Pin 5, unknown/ }));
    fireEvent.keyDown(pin, { key: 'Enter' });
    expect(onPinClick.mock.calls).toEqual([['5'], ['3']]);
  });

  test('the solder view is labeled and mirrored', () => {
    const { container } = render(<ConnectorFace geometry={g('de-9-male')} view="solder" title="Rear" />);
    expect(screen.getByRole('img', { name: /^Rear, 9 positions/ }).getAttribute('data-view')).toBe('solder');
    const cx = (id: string) => Number(container.querySelector(`[data-pin="${id}"] circle`)?.getAttribute('cx'));
    expect(cx('1')).toBeGreaterThan(cx('5'));
  });
});
