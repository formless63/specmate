import { Alert, Button, Stack, Table, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { request } from '../sources/api';
import type { AssignmentReview } from './api';
/** Review the already selected exact Device; no duplicate owner chooser. */
export function FirmwareAssignmentReview({ snapshotId, principalKey, active }: { snapshotId: string | null; principalKey: string; active: boolean }) {
  const result = useQuery({ queryKey: ['firmware-assigned-targets', principalKey, snapshotId], enabled: active && !!snapshotId, retry: false, refetchOnWindowFocus: 'always', queryFn: () => request<AssignmentReview>(`pcb/assemblies/${snapshotId}/firmware-review`) });
  if (!snapshotId) return <Text>Freeze a Device revision to review its exact assigned firmware targets.</Text>;
  return <Stack>{active && <Button variant="quiet" onClick={() => void result.refetch()}>Refresh assigned target review</Button>}{active && result.isError && <Alert color="red">{result.error.message}</Alert>}{active && !result.isFetching && !result.isError && result.data && <Table><Table.Thead><Table.Tr><Table.Th>Occurrence</Table.Th><Table.Th>Firmware</Table.Th><Table.Th>Target review</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{result.data.assignments.map(row => <Table.Tr key={row.path.join('/')}><Table.Td>{row.path.join(' / ')}</Table.Td><Table.Td>{row.firmware_name}</Table.Td><Table.Td>{row.status}: {row.message}</Table.Td></Table.Tr>)}</Table.Tbody></Table>}</Stack>;
}
