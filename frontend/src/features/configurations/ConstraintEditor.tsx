import { Button, Checkbox, Group, NativeSelect, Stack, Text, TextInput, Textarea } from '@mantine/core';
import { FACT_PURPOSES, FACT_ROLES, LIMIT_UNITS, type ChoiceRef, type ConstraintBody, type OptionBody } from './optionSet';

const KIND_LABEL: Record<ConstraintBody['kind'], string> = {
  requires: 'Requires: when the condition holds, the option must resolve to one of the named choices',
  excludes: 'Excludes: when the condition holds, the option must not resolve to any named choice',
  fact_limit: 'Fact limit: the exact revision chosen must record the fact within the limit; a missing fact stays unknown',
};

type Props = { rule: ConstraintBody; options: OptionBody[]; disabled: boolean; editable: boolean; onChange: (rule: ConstraintBody) => void; onRemove: () => void };

function optionData(options: OptionBody[]) {
  return [{ value: '', label: 'Select an option' }, ...options.map((o) => ({ value: o.key, label: o.label || o.key }))];
}

function WhenEditor({ when, options, disabled, label, optional, onChange }: { when: ChoiceRef | null; options: OptionBody[]; disabled: boolean; label: string; optional: boolean; onChange: (when: ChoiceRef | null) => void }) {
  const option = options.find((o) => o.key === when?.option_key);
  return <Group align="end" gap="xs">
    {optional && <Checkbox label="Only when a choice is resolved" disabled={disabled} checked={when !== null}
      onChange={(event) => onChange(event.currentTarget.checked ? { option_key: options[0]?.key ?? '', choice_key: options[0]?.choices[0]?.key ?? '' } : null)} />}
    {when && <>
      <NativeSelect label="When option" aria-label={`Condition option of ${label}`} disabled={disabled} value={when.option_key} data={optionData(options)}
        onChange={(event) => { const key = event.currentTarget.value; onChange({ option_key: key, choice_key: options.find((o) => o.key === key)?.choices[0]?.key ?? '' }); }} />
      <NativeSelect label="Resolves to" aria-label={`Condition choice of ${label}`} disabled={disabled || !option} value={when.choice_key}
        data={[{ value: '', label: 'Select a choice' }, ...(option?.choices ?? []).map((c) => ({ value: c.key, label: c.label || c.key }))]}
        onChange={(event) => onChange({ ...when, choice_key: event.currentTarget.value })} />
    </>}
  </Group>;
}

/** One declared constraint rule; the server evaluates it at resolution with explicit reasons. */
export function ConstraintEditor({ rule, options, disabled, editable, onChange, onRemove }: Props) {
  const label = rule.label.trim() || rule.key;
  const subject = options.find((o) => o.key === rule.option_key);
  return <fieldset style={{ border: '1px solid var(--sb-border-subtle)', padding: 'var(--mantine-spacing-xs)', margin: 0 }}>
    <legend className="sb-silk">{label} · {rule.kind.replace('_', ' ')}</legend>
    <Stack gap="xs">
      <Text className="sb-silk">{KIND_LABEL[rule.kind]}</Text>
      <Group align="end" gap="xs">
        <TextInput label="Key" aria-label={`Key of rule ${label}`} disabled={disabled} value={rule.key} w={140} onChange={(event) => onChange({ ...rule, key: event.currentTarget.value })} />
        <TextInput label="Label" aria-label={`Label of rule ${label}`} disabled={disabled} value={rule.label} onChange={(event) => onChange({ ...rule, label: event.currentTarget.value })} />
        {editable && <Button variant="risk" disabled={disabled} onClick={onRemove}>Remove rule</Button>}
      </Group>
      <WhenEditor when={rule.when} options={options} disabled={disabled} label={label} optional={rule.kind === 'fact_limit'} onChange={(when) => onChange({ ...rule, when } as ConstraintBody)} />
      <Group align="end" gap="xs">
        <NativeSelect label={rule.kind === 'fact_limit' ? 'Option whose chosen revision is checked' : 'Constrained option'} aria-label={`Constrained option of ${label}`} disabled={disabled} value={rule.option_key} data={optionData(options)}
          onChange={(event) => onChange(rule.kind === 'fact_limit' ? { ...rule, option_key: event.currentTarget.value } : { ...rule, option_key: event.currentTarget.value, choice_keys: [] })} />
        {rule.kind !== 'fact_limit' && (subject?.choices ?? []).map((choice) => <Checkbox key={choice.key} label={choice.label || choice.key} disabled={disabled} checked={rule.choice_keys.includes(choice.key)}
          onChange={(event) => { const on = event.currentTarget.checked; onChange({ ...rule, choice_keys: on ? [...rule.choice_keys, choice.key] : rule.choice_keys.filter((key) => key !== choice.key) }); }} />)}
        {rule.kind === 'fact_limit' && <>
          <TextInput label="Fact property" aria-label={`Fact property of ${label}`} disabled={disabled} value={rule.property} placeholder="current_rating" onChange={(event) => onChange({ ...rule, property: event.currentTarget.value })} />
          <NativeSelect label="Purpose" aria-label={`Fact purpose of ${label}`} disabled={disabled} value={rule.purpose} data={FACT_PURPOSES} onChange={(event) => onChange({ ...rule, purpose: event.currentTarget.value })} />
          <NativeSelect label="Role" aria-label={`Fact role of ${label}`} disabled={disabled} value={rule.role} data={FACT_ROLES} onChange={(event) => onChange({ ...rule, role: event.currentTarget.value })} />
          <NativeSelect label="Comparison" aria-label={`Comparison of ${label}`} disabled={disabled} value={rule.comparison} data={[{ value: 'at_least', label: 'at least' }, { value: 'at_most', label: 'at most' }]}
            onChange={(event) => onChange({ ...rule, comparison: event.currentTarget.value as 'at_least' | 'at_most' })} />
          <TextInput label="Limit" aria-label={`Limit of ${label}`} disabled={disabled} value={rule.limit.magnitude} w={110} style={{ fontFamily: 'var(--sb-font-data)' }}
            onChange={(event) => onChange({ ...rule, limit: { ...rule.limit, magnitude: event.currentTarget.value } })} />
          <NativeSelect label="Unit" aria-label={`Limit unit of ${label}`} disabled={disabled} value={rule.limit.unit} data={LIMIT_UNITS.map((u) => ({ value: u.unit, label: `${u.unit} (${u.dimension})` }))}
            onChange={(event) => { const unit = event.currentTarget.value; onChange({ ...rule, limit: { ...rule.limit, unit, dimension: LIMIT_UNITS.find((u) => u.unit === unit)?.dimension ?? rule.limit.dimension } }); }} />
        </>}
      </Group>
      <Textarea label="Basis" aria-label={`Basis of rule ${label}`} disabled={disabled} value={rule.basis} minRows={1} onChange={(event) => onChange({ ...rule, basis: event.currentTarget.value })} />
    </Stack>
  </fieldset>;
}
