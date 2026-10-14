import { expect, test } from 'vitest';
import { blankOption, emptyOptionSet, parseOptionSet, serializeOptionSet, validateOptionSet, type OptionSetBody } from './optionSet';

const valid: OptionSetBody = {
  schema_version: '0.1', target_revision_id: 'target-rev',
  options: [
    { key: 'sensor', label: 'Sensor', domain: 'part', path: ['sensor'], required: true, default_choice: 'a',
      choices: [{ key: 'a', label: 'Sensor A', revision_id: 'part-a', population_option_id: null, value: 'stale' }] },
    { key: 'pop', label: 'Population', domain: 'population', path: ['board'], required: true, default_choice: null,
      choices: [{ key: 'fitted', label: 'Fitted', revision_id: 'pop-rev', population_option_id: 'default', value: null }] },
    { key: 'finish', label: 'Finish', domain: 'process', path: null, required: false, default_choice: null,
      choices: [{ key: 'paint', label: 'Painted', revision_id: 'ignored', population_option_id: 'ignored', value: ' powder-coat ' }] },
  ],
};

test('accepts a coherent option set and serializes only subjects that apply to each domain', () => {
  expect(validateOptionSet(valid)).toEqual([]);
  const [part, population, finish] = serializeOptionSet(valid).option_set.options;
  expect(part!.choices[0]).toEqual({ key: 'a', label: 'Sensor A', revision_id: 'part-a', population_option_id: null, value: null });
  expect(population!.choices[0]!.population_option_id).toBe('default');
  expect(finish!.choices[0]).toEqual({ key: 'paint', label: 'Painted', revision_id: null, population_option_id: null, value: 'powder-coat' });
});

test('names each contract violation instead of a generic failure', () => {
  const broken: OptionSetBody = {
    schema_version: '0.1', target_revision_id: null,
    options: [
      { key: 'Bad Key', label: '', domain: 'firmware', path: null, required: true, default_choice: 'missing', choices: [{ key: 'x', label: 'X', revision_id: null, population_option_id: null, value: null }] },
      { key: 'pop', label: 'Population', domain: 'population', path: ['board'], required: true, default_choice: null, choices: [{ key: 'a', label: 'A', revision_id: 'rev', population_option_id: null, value: null }, { key: 'a', label: 'A2', revision_id: 'rev', population_option_id: 'default', value: null }] },
      { key: 'pop', label: 'Duplicate', domain: 'process', path: null, required: true, default_choice: null, choices: [] },
    ],
  };
  const problems = validateOptionSet(broken);
  expect(problems).toEqual(expect.arrayContaining([
    'Option keys must be unique.',
    'Bad Key: key must start with a lowercase letter and use a-z, 0-9, - or _.',
    'Bad Key: label is required.',
    'Bad Key: the default must name a declared choice.',
    'Bad Key: firmware options address one occurrence path.',
    'Bad Key / x: pin an exact frozen revision.',
    'pop: choice keys must be unique.',
    'pop: occurrence paths require an exact target assembly revision.',
    'pop / a: choose a population option of the revision.',
    'pop: declare at least one choice.',
  ]));
});

test('opens partial content leniently and generates unique blank keys', () => {
  expect(parseOptionSet(null)).toEqual(emptyOptionSet());
  const parsed = parseOptionSet({ option_set: { options: [{ key: 'option-1', choices: [{ key: 'a' }] }] } });
  expect(parsed.options[0]).toMatchObject({ key: 'option-1', label: '', domain: 'process', path: null, required: true });
  expect(blankOption(parsed).key).toBe('option-2');
});
