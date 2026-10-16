import { Button, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { usePermission } from '../../lib/permissions';
import { useNavigation } from '../navigation';

/** Routing choices only: opening a form never creates engineering state. */
export function NewDesign({ onCreate }: { onCreate: (kind: 'cable' | 'harness' | 'assembly') => void }) {
  const navigation = useNavigation(), create = usePermission('item.create');
  return <Stack gap="md"><Title order={1}>New design</Title><Text size="sm">Choose what you want to prepare. Review and save it when ready.</Text>
    <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
      <section><Title order={2} size="h4">Cable</Title><Text size="sm">Begin with a blank cable and map pins by hand, or optionally connect two device ports.</Text><Button {...create.props} onClick={() => onCreate('cable')}>Prepare cable</Button></section>
      <section><Title order={2} size="h4">Harness</Title><Text size="sm">Arrange cables and shared sections.</Text><Button {...create.props} onClick={() => onCreate('harness')}>Prepare harness</Button></section>
      <section><Title order={2} size="h4">Device</Title><Text size="sm">Assemble exact parts and designs.</Text><Button {...create.props} onClick={() => onCreate('assembly')}>Prepare device</Button></section>
      <section><Title order={2} size="h4">Board</Title><Text size="sm">Start a board record, then review its source and population.</Text><Button {...create.props} onClick={() => navigation?.navigate({ area: 'library', lens: 'pcb', project: null, probe: null, filters: { status: 'new' } })}>Prepare board</Button></section>
      <section><Title order={2} size="h4">Printed part</Title><Text size="sm">Start a part record. Print preparation and physical qualification remain separate.</Text><Button {...create.props} onClick={() => navigation?.navigate({ area: 'library', lens: 'identity', project: null, probe: null, filters: { kind: 'part', status: 'new' } })}>Prepare printed part</Button></section>
    </SimpleGrid>
  </Stack>;
}
