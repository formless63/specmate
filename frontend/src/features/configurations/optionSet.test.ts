import { expect, test } from 'vitest';
import { blankConstraint, blankOption, emptyOptionSet, parseOptionSet, serializeOptionSet, validateOptionSet, type OptionSetBody } from './optionSet';

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
  constraints: [],
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
    constraints: [],
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

test('keeps declared constraints through parse and serialize and names rule problems', () => {
  const rules = [
    { kind: 'fact_limit', key: 'sensor-current', label: 'Sensor current', basis: 'Synthetic demand.', when: null, option_key: 'sensor', property: 'current_rating',
      purpose: 'rating', role: 'upper_bound', comparison: 'at_least', limit: { kind: 'quantity', dimension: 'current', unit: 'mA', magnitude: '2000' } },
    { kind: 'requires', key: 'paint-pop', label: 'Paint needs fitted', basis: 'Synthetic.', when: { option_key: 'finish', choice_key: 'paint' }, option_key: 'pop', choice_keys: ['fitted'] },
  ];
  const parsed = parseOptionSet({ option_set: { ...valid, constraints: rules } });
  expect(validateOptionSet(parsed)).toEqual([]);
  // Saving an option set never drops its rules.
  expect(serializeOptionSet(parsed).option_set.constraints).toEqual(rules);
  const broken: OptionSetBody = { ...parsed, constraints: [
    { ...parsed.constraints[0]!, key: 'sensor-current', property: 'Current', basis: ' ', limit: { kind: 'quantity', dimension: 'current', unit: 'A', magnitude: 'two' } } as OptionSetBody['constraints'][number],
    { ...parsed.constraints[1]!, key: 'sensor-current', when: { option_key: 'finish', choice_key: 'chrome' }, choice_keys: ['missing'] } as OptionSetBody['constraints'][number],
  ] };
  expect(validateOptionSet(broken)).toEqual(expect.arrayContaining([
    'Constraint keys must be unique.',
    'Constraint sensor-current: state the basis for this rule.',
    'Constraint sensor-current: name the fact property (a-z, 0-9 and _).',
    'Constraint sensor-current: the limit is one decimal number.',
    'Constraint sensor-current: the applicability condition must name a declared option and choice.',
    'Constraint sensor-current: constrained choices must be declared by the option.',
  ]));
  expect(blankConstraint(parsed, 'fact_limit')).toMatchObject({ key: 'rule-3', kind: 'fact_limit', option_key: 'sensor', when: null });
  expect(blankConstraint(parsed, 'excludes')).toMatchObject({ kind: 'excludes', when: { option_key: 'sensor', choice_key: 'a' }, option_key: 'pop' });
});
