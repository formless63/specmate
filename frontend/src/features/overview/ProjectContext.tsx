import { Alert, Button, SimpleGrid, Table, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { readProjectContext } from "./work";

/** Project-held context is read separately from reusable library records. Membership stays workspace-wide. */
export function ProjectContext({ workspaceId, projectId, onOpenNotes, onAccessLost }: {
  workspaceId: string; projectId: string; onOpenNotes: () => void; onAccessLost?: () => Promise<void> | void;
}) {
  const context = useQuery({ queryKey: ["project-context", workspaceId, projectId], queryFn: () => readProjectContext(workspaceId, projectId), retry: false });
  const value = context.isError ? null : context.data;
  const denied = !!value && [value.decisions, value.releases, value.members].every(read => read.status === "unavailable" && read.denied);
  useEffect(() => { if (denied) void Promise.resolve(onAccessLost?.()).catch(() => {}); }, [denied, onAccessLost]);
  return <section aria-label="Project context">
    {context.isError && <Alert color="red">Project context is unavailable.</Alert>}
    <SimpleGrid cols={{ base: 1, md: 3 }}>
      <section aria-label="Project decisions"><h3 className="sb-dash-h">Decisions</h3>
        {value?.decisions.status === "ok" ? <>{value.decisions.value.items.length ? <ul>{value.decisions.value.items.map(item => <li key={item.item_id}>{item.current.title} · {item.current.decision_status ?? "Status unknown"}</li>)}</ul> : <Text size="sm">No decisions in the recent project notes.</Text>}{value.decisions.value.has_more && <Text size="xs">More project notes are available in Notes & files.</Text>}</> : <Text size="sm">{context.isPending ? "Reading decisions…" : "Decisions unavailable."}</Text>}
        <Button size="xs" variant="quiet" onClick={onOpenNotes}>Notes & files</Button>
      </section>
      <section aria-label="Project releases"><h3 className="sb-dash-h">Releases</h3>
        {value?.releases.status === "ok" ? <>{value.releases.value.releases.length ? <ul>{value.releases.value.releases.map(release => <li key={release.release_id}>{release.name} · {release.status}</li>)}</ul> : <Text size="sm">No project releases recorded.</Text>}</> : <Text size="sm">{context.isPending ? "Reading releases…" : "Releases unavailable."}</Text>}
      </section>
      <section aria-label="Project members"><h3 className="sb-dash-h">Members</h3><Text size="sm">Every workspace member can read this project. Projects have no separate membership.</Text>
        {value?.members.status === "ok" && <>{value.members.value.members ? <Table><Table.Thead><Table.Tr><Table.Th>Member</Table.Th><Table.Th>Workspace role</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{value.members.value.members.map(member => <Table.Tr key={member.username}><Table.Td>{member.username}</Table.Td><Table.Td>{member.role}</Table.Td></Table.Tr>)}</Table.Tbody></Table> : <Text size="xs">Your workspace role: {value.members.value.role}. Workspace admins manage the member roster.</Text>}</>}
      </section>
    </SimpleGrid>
  </section>;
}
