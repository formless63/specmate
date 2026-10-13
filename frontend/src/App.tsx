import { Badge, Container, Group, Stack, Text, Title } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { fetchHealth } from "./api";

export function App() {
  const health = useQuery({ queryKey: ["health"], queryFn: ({ signal }) => fetchHealth(signal) });
  return (
    <Container size="sm" py="xl">
      <Stack>
        <Title order={1}>Specmate</Title>
        <Text c="dimmed">
          Development skeleton. Engineering features are not implemented in this build.
        </Text>
        <Group>
          <Text>Backend</Text>
          {health.isPending && <Badge color="gray">checking</Badge>}
          {health.isError && <Badge color="red">unreachable</Badge>}
          {health.isSuccess && (
            <Badge color="green">
              {health.data.status} · v{health.data.version}
            </Badge>
          )}
        </Group>
      </Stack>
    </Container>
  );
}
