import { Alert, Button, Group, MultiSelect, PasswordInput, Select, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import { useCallback, useEffect, useState } from "react";
import { describeAccess } from "../shell/areas";
import { ApiError, requestJson, runOperation } from "../workspace/api";

type Member = { username: string; role: string; grants: string[] };
type Access = { workspace_id: string; name: string; role: string; permissions: string[]; state?: string; members?: Member[] };

const ROLES = [
  { value: "viewer", label: "Viewer: reads everything" },
  { value: "contributor", label: "Contributor: adds items and edits projects" },
  { value: "editor", label: "Editor: edits and freezes any item" },
  { value: "admin", label: "Admin: every permission and membership" },
];
const GRANTS = [
  { value: "build.execute", label: "Native execution (build.execute)" },
  { value: "inventory.manage", label: "Inventory management (inventory.manage)" },
  { value: "design.freeze", label: "Freeze (design.freeze)" },
];

/**
 * Workspace members, roles and explicit grants. Every member reads every project and library item;
 * the role decides what they may change. Only admins see and change the roster, under the
 * workspace access-state token; the server keeps at least one active admin.
 */
export function WorkspaceAccessPanel({ onAccessChanged }: { /** @deprecated Access is workspace-wide; ignored. */ projectId?: string; onAccessChanged?: () => Promise<void> }) {
  const [access, setAccess] = useState<Access | null>(null);
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<string | null>("viewer");
  const [extra, setExtra] = useState<string[]>([]);
  const [canCreate, setCanCreate] = useState(false);
  const [newUsername, setNewUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const read = useCallback(() => requestJson<Access>("/api/v0/access/workspace"), []);
  useEffect(() => {
    let active = true;
    void Promise.all([read(), requestJson<{ can_create_local_accounts: boolean }>("/api/v0/access/account-policy")])
      .then(([result, policy]) => { if (active) { setAccess(result); setCanCreate(policy.can_create_local_accounts); } })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "Unable to read workspace access."); });
    return () => { active = false; };
  }, [read]);

  async function act(work: () => Promise<void>) {
    setBusy(true); setError(null); setNotice(null);
    try { await work(); }
    catch (reason) {
      if (reason instanceof ApiError && [401, 403, 404].includes(reason.status)) {
        setAccess(null);
        try { await onAccessChanged?.(); } catch { /* Preserve the denial. */ }
      }
      setError(reason instanceof Error ? reason.message : "Unable to update access.");
    } finally { setBusy(false); }
  }

  async function afterChange(message: string) {
    try { setAccess(await read()); } finally { await onAccessChanged?.(); }
    setNotice(message);
  }

  const own = access ? describeAccess(access.permissions, access.role) : null;
  return <Stack className="sb-dash">
    <Title order={2} className="sb-dash-title">Workspace access</Title>
    {access && own && <dl className="sb-context sb-context-4">
      <Cell label="Workspace" value={access.name} />
      <Cell label="Your role" value={own.label} />
      <Cell label="Members" value={access.members ? String(access.members.length) : "Admins only"} unknown={!access.members} />
      <Cell label="Your grants" value={access.permissions.filter((p) => GRANTS.some((g) => g.value === p)).join(", ") || "none"} />
    </dl>}
    <Text className="sb-dash-note">Every member reads every project and library item. Roles decide what a member may change; native execution and inventory management are separate grants. Projects have no separate access.</Text>
    {error && <Alert color="red" role="alert">{error}</Alert>}
    {notice && <Alert color="green" role="status">{notice}</Alert>}
    {!access ? <Text>{error ? "Workspace access is unavailable." : "Reading workspace access…"}</Text> : access.state && access.members ? <>
      <div className="sb-ws-scroll"><Table className="sb-ws-table" verticalSpacing={4} horizontalSpacing="sm">
        <Table.Thead><Table.Tr><Table.Th>Member</Table.Th><Table.Th>Role</Table.Th><Table.Th>Grants</Table.Th><Table.Th><span className="sb-visually-hidden">Actions</span></Table.Th></Table.Tr></Table.Thead>
        <Table.Tbody>{access.members.map((member) => <Table.Tr key={member.username}>
          <Table.Td className="sb-mono">{member.username}</Table.Td><Table.Td>{member.role}</Table.Td><Table.Td className="sb-mono">{member.grants.join(", ") || "none"}</Table.Td>
          <Table.Td className="sb-ws-num"><Group gap={4} justify="flex-end" wrap="nowrap">
            <Button size="xs" variant="quiet" disabled={busy} onClick={() => { setUsername(member.username); setRole(member.role); setExtra(member.grants); }}>Edit {member.username}</Button>
            <Button size="xs" variant="quiet" disabled={busy} onClick={() => void act(async () => {
              await runOperation("workspace.remove_member", { workspace_id: access.workspace_id, username: member.username }, { expectedState: access.state });
              await afterChange(`${member.username} is no longer a member.`);
            })}>Remove {member.username}</Button>
          </Group></Table.Td>
        </Table.Tr>)}</Table.Tbody></Table></div>
      <form onSubmit={(event) => { event.preventDefault(); void act(async () => {
        await runOperation("workspace.set_member", { workspace_id: access.workspace_id, username, role, grants: extra }, { expectedState: access.state });
        await afterChange("Workspace membership updated.");
        setUsername(""); setExtra([]);
      }); }}><Stack maw={520} gap={6}>
        <Title order={3} size="h5">Add or change a member</Title>
        <TextInput label="Local account username" size="xs" value={username} onChange={(event) => setUsername(event.currentTarget.value)} required disabled={busy} />
        <Select label="Workspace role" size="xs" data={ROLES} value={role} onChange={setRole} allowDeselect={false} disabled={busy} />
        <MultiSelect label="Explicit grants" size="xs" data={GRANTS} value={extra} onChange={setExtra} disabled={busy} />
        <Button type="submit" size="xs" loading={busy}>Save member</Button>
      </Stack></form>
    </> : <Text>Workspace admins manage members, roles and grants.</Text>}
    {canCreate && <form onSubmit={(event) => { event.preventDefault(); void act(async () => {
      try { await runOperation("account.create", { username: newUsername, password });
        setNewUsername(""); setNotice("Local account created. Add it as a member to grant access."); }
      finally { setPassword(""); }
    }); }}><Stack maw={520} gap={6}><Title order={3} size="h5">Create a local account</Title>
      <TextInput label="New account username" size="xs" value={newUsername} onChange={(event) => setNewUsername(event.currentTarget.value)} required autoComplete="off" disabled={busy} />
      <PasswordInput label="New account password" size="xs" value={password} onChange={(event) => setPassword(event.currentTarget.value)} required autoComplete="new-password" disabled={busy} />
      <Button type="submit" size="xs" loading={busy}>Create local account</Button>
    </Stack></form>}
  </Stack>;
}

function Cell({ label, value, unknown = false }: { label: string; value: string; unknown?: boolean }) {
  return <div className={`sb-cell${unknown ? " sb-hatch" : ""}`}>
    <dt className="sb-silk">{label}</dt>
    <dd data-unknown={unknown} title={value}>{value}</dd>
  </div>;
}
