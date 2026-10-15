import { expect, test } from "vitest";
import { schemeFromConfig } from "./part-numbers";

test('prefix checks and suggestions use explicit Specmate kinds and never mutate known identifiers', () => {
  const scheme = schemeFromConfig({ prefixes: { cable: 'CBL', wire_stock: 'WIR' }, digits: 4 });
  const known = [{ pn: 'CBL-0001', kind: 'cable', source: 'Synthetic entered sample' }];
  expect(scheme.parse('cbl-0001')).toBe('CBL-0001');
  expect(scheme.check('WIR-0001', 'cable')[0]?.code).toBe('pn-wrong-kind');
  expect(scheme.suggest({ kind: 'cable', label: 'Synthetic cable' }, known)?.pn).toBe('CBL-0002');
  expect(known[0]?.pn).toBe('CBL-0001');
});
test('declarative choice counter and variant preserve explicit ranges', () => {
  const scheme = schemeFromConfig({ type: 'declarative', template: '{kind}-{seq}-{variant}', segments: [
    { id: 'kind', type: 'choice', values: [{ value: 'C', kinds: ['cable'] }] },
    { id: 'seq', type: 'counter', width: 4, ranges: [{ from: 10, to: 99 }] },
    { id: 'variant', type: 'variant', style: 'numeric', width: 2, first: '00' },
  ] });
  expect(scheme.parse('C-0010-00')).toBe('C-0010-00');
  expect(scheme.suggest({ kind: 'cable', label: 'Synthetic cable' }, [])?.pn).toBe('C-0010-00');
});
test.each(['(a+)+$', '(a|aa)+$', '^a+a+$'])('custom validation expression %s is unsupported before previews', expression => {
  expect(() => schemeFromConfig({ type: 'declarative', template: '{seq}', segments: [{ id: 'seq', type: 'counter', width: 4 }], validation: { regex: expression } })).toThrow();
});


test('overlapping choice prefixes use bounded token matching without changing format intent', () => {
  const choices = Array.from({ length: 10 }, (_, index) => ({ id: `choice${index}`, type: 'choice', values: Array.from({ length: 8 }, (_, length) => ({ value: 'A'.repeat(length + 1) })) }));
  const scheme = schemeFromConfig({ type: 'declarative', template: choices.map(segment => `{${segment.id}}`).join('') + '-{seq}', segments: [...choices, { id: 'seq', type: 'counter', width: 4 }] });
  expect(scheme.parse('A'.repeat(55) + '!0001')).toBeUndefined();
  expect(scheme.parse('A'.repeat(10) + '-0001')).toBe('A'.repeat(10) + '-0001');
});
