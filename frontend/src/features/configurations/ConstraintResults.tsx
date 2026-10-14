import { Stack, Table, Text, Title } from '@mantine/core';
import { SbStatus, type SbLed } from '../../components/sb';
import type { ConstraintEvaluation, ConstraintOutcome, ConstraintReason, Resolution } from './api';

/** Outcome LEDs: there is no generic OK; unknown and not evaluated never read as valid. */
export const OUTCOME_LED: Record<ConstraintOutcome, SbLed> = { valid: 'info', invalid: 'failed', unknown: 'review', not_evaluated: 'not-evaluated' };
export const OUTCOME_LABEL: Record<ConstraintOutcome, string> = { valid: 'valid', invalid: 'invalid', unknown: 'unknown', not_evaluated: 'not evaluated' };
const KIND: Record<string, string> = { requires: 'Requires', excludes: 'Excludes', fact_limit: 'Fact limit' };

/** Resolutions captured before constraint evaluation carry no evaluation object. */
export function evaluation(resolution: Resolution): ConstraintEvaluation | null {
  return typeof resolution.constraints === 'object' ? resolution.constraints : null;
}

function Reasons({ reasons }: { reasons: ConstraintReason[] }) {
  if (!reasons.length) return <Text size="sm">-</Text>;
  return <Stack gap={2}>{reasons.map((item, index) => <Text key={index} size="sm" data-code={item.code}>
    {item.message}{item.assertion_ids?.length ? <Text span className="sb-silk"> · assertions {item.assertion_ids.map((id) => id.slice(0, 8)).join(', ')}</Text> : null}
  </Text>)}</Stack>;
}

/** Per-rule outcomes with rule-level and fact-level reasons, read from one resolution. */
export function ConstraintResults({ resolution }: { resolution: Resolution }) {
  const result = evaluation(resolution);
  if (!result) return <Text size="sm">Constraints were not evaluated for this resolution.</Text>;
  return <Stack gap="xs">
    <Title order={4}>Constraints</Title>
    {result.results.length === 0
      ? <Text size="sm">The pinned option-set revision declares no constraints; nothing is evaluated and compatibility is not assumed.</Text>
      : <Table aria-label="Constraint outcomes">
        <Table.Thead><Table.Tr><Table.Th>Rule</Table.Th><Table.Th>Outcome</Table.Th><Table.Th>Rule reasons</Table.Th><Table.Th>Fact reasons</Table.Th></Table.Tr></Table.Thead>
        <Table.Tbody>{result.results.map((rule) => <Table.Tr key={rule.key} data-outcome={rule.outcome}>
          <Table.Td><Text size="sm">{rule.label}</Text><Text className="sb-silk">{KIND[rule.kind] ?? rule.kind} · {rule.key}</Text><Text className="sb-silk">{rule.basis}</Text></Table.Td>
          <Table.Td><SbStatus led={OUTCOME_LED[rule.outcome]} dimension="constraint" value={OUTCOME_LABEL[rule.outcome]} /></Table.Td>
          <Table.Td><Reasons reasons={rule.reasons.filter((item) => item.level === 'rule')} /></Table.Td>
          <Table.Td><Reasons reasons={rule.reasons.filter((item) => item.level === 'fact')} /></Table.Td>
        </Table.Tr>)}</Table.Tbody>
      </Table>}
    {result.limitations.map((item) => <Text key={item} className="sb-silk">{item}</Text>)}
  </Stack>;
}
