import { Alert, Button, Group, MultiSelect, PasswordInput, Select, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import { useEffect, useState } from "react";
import { ApiError, requestJson, runOperation } from "../workspace/api";

type Member = { username: string; role: string; grants: string[] };
type Access = { project_id: string; name: string; permissions: string[]; state?: string; members?: Member[] };
const grants = ["project.read", "project.admin", "design.edit", "design.freeze", "source.register", "build.execute", "inventory.manage", "inventory.reserve"];

export function ProjectAccessPanel({ projectId, onAccessChanged }: { projectId: string; onAccessChanged?: () => Promise<void> }) {
  const [access, setAccess] = useState<Access | null>(null);
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<string | null>("viewer");
  const [extra, setExtra] = useState<string[]>([]);
  const [canCreate, setCanCreate] = useState(false);
  const [newUsername, setNewUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function refresh() {
    const result = await requestJson<Access>(`/api/v0/access/projects/${projectId}`);
    setAccess(result); setName(result.name);
  }
  useEffect(() => {
    let active = true;
    setAccess(null); setError(null); setNotice(null); setUsername(""); setPassword(""); setCanCreate(false);
    void Promise.all([requestJson<Access>(`/api/v0/access/projects/${projectId}`),
      requestJson<{ can_create_local_accounts: boolean }>("/api/v0/access/account-policy")])
      .then(([result, policy]) => { if (active) { setAccess(result); setName(result.name); setCanCreate(policy.can_create_local_accounts); } })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "Unable to read project access."); });
    return () => { active = false; };
  }, [projectId]);

  async function act(work: () => Promise<void>) {
    setBusy(true); setError(null); setNotice(null);
    try { await work(); }
    catch (reason) {
      if (reason instanceof ApiError && [401, 403, 404].includes(reason.status)) {
        setAccess(null);
        try { await onAccessChanged?.(); } catch { /* Preserve the scoped denial. */ }
      }
      setError(reason instanceof Error ? reason.message : "Unable to update access.");
    } finally { setBusy(false); }
  }

  return <Stack>
    <Title order={2}>Project access</Title>
    {error && <Alert color="red">{error}</Alert>}
    {notice && <Alert color="green">{notice}</Alert>}
    {!access ? <Text>Project access is unavailable.</Text> : <>
      <Text>Current permissions: {access.permissions.join(", ")}</Text>
      {access.state && access.members ? <>
        <form onSubmit={(event) => { event.preventDefault(); void act(async () => {
          await runOperation("project.rename", { project_id: projectId, name }, { expectedState: access.state });
          await refresh(); await onAccessChanged?.(); setNotice("Project name updated.");
        }); }}><Group align="end"><TextInput label="Project name" value={name} onChange={(event) => setName(event.currentTarget.value)} required disabled={busy} />
          <Button type="submit" loading={busy}>Save name</Button></Group></form>
        <Table><Table.Thead><Table.Tr><Table.Th>Member</Table.Th><Table.Th>Role</Table.Th><Table.Th>Extra grants</Table.Th><Table.Th>Actions</Table.Th></Table.Tr></Table.Thead>
          <Table.Tbody>{access.members.map((member) => <Table.Tr key={member.username}>
            <Table.Td>{member.username}</Table.Td><Table.Td>{member.role}</Table.Td><Table.Td>{member.grants.join(", ") || "None"}</Table.Td>
            <Table.Td><Group><Button size="xs" variant="light" disabled={busy} onClick={() => { setUsername(member.username); setRole(member.role); setExtra(member.grants); }}>Edit {member.username}</Button>
              <Button size="xs" color="red" variant="light" disabled={busy} onClick={() => void act(async () => {
                await runOperation("project.remove_member", { project_id: projectId, username: member.username }, { expectedState: access.state });
                try { await refresh(); } finally { await onAccessChanged?.(); }
              })}>Remove {member.username}</Button></Group></Table.Td>
          </Table.Tr>)}</Table.Tbody></Table>
        <form onSubmit={(event) => { event.preventDefault(); void act(async () => {
          await runOperation("project.set_member", { project_id: projectId, username, role, grants: extra }, { expectedState: access.state });
          try { await refresh(); } finally { await onAccessChanged?.(); } setUsername(""); setExtra([]); setNotice("Project membership updated.");
        }); }}><Stack maw={520}>
          <TextInput label="Local account username" value={username} onChange={(event) => setUsername(event.currentTarget.value)} required disabled={busy} />
          <Select label="Project role" data={["viewer", "editor", "owner"]} value={role} onChange={setRole} allowDeselect={false} disabled={busy} />
          <MultiSelect label="Explicit additional permissions" data={grants} value={extra} onChange={setExtra} disabled={busy} />
          <Text c="dimmed">Editors can change drafts and register sources. Freezing and native execution require explicit grants. Owners hold every project permission.</Text>
          <Button type="submit" loading={busy}>Save member</Button>
        </Stack></form>
      </> : <Text>Project administrators manage membership and grants.</Text>}
    </>}
    {canCreate && <form onSubmit={(event) => { event.preventDefault(); void act(async () => {
      try { await runOperation("account.create", { username: newUsername, password });
        setNewUsername(""); setNotice("Local account created. Add it to this project to grant access."); }
      finally { setPassword(""); }
    }); }}><Stack maw={520}><Title order={3}>Create a local account</Title>
      <TextInput label="New account username" value={newUsername} onChange={(event) => setNewUsername(event.currentTarget.value)} required autoComplete="off" disabled={busy} />
      <PasswordInput label="New account password" value={password} onChange={(event) => setPassword(event.currentTarget.value)} required autoComplete="new-password" disabled={busy} />
      <Button type="submit" loading={busy}>Create local account</Button>
    </Stack></form>}
  </Stack>;
}
