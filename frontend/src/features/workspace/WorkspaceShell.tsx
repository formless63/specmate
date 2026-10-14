import { randomUUID } from "../../lib/random-id";
import { Alert, Button, Group, Menu, PasswordInput, Select, Stack, Text, TextInput, Title } from "@mantine/core";
import { useQueryClient } from "@tanstack/react-query";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { HomeFrame } from "../home/HomeFrame";
import { WorkspaceHome } from "../home/WorkspaceHome";
import { forgetLastProject, readLastProject, writeLastProject } from "../home/lastProject";
import { ApiError, requestJson, runOperation, type OperationResult, type Project, type SessionState } from "./api";

/** Controls a full-bleed project shell places in its own top bar when `slots` is enabled. */
export type ShellChrome = {
  username: string;
  projectControl: ReactNode;
  signOutControl: ReactNode;
  alert: ReactNode;
  /** Compact project switcher for phone widths; falls back to hiding project switching when absent. */
  projectMenu?: ReactNode;
  /** Compact account menu (containing Sign out) for phone widths. */
  accountMenu?: ReactNode;
};

/**
 * Owns the session, the authorized project list and the selected project. Before a project
 * is open it renders the workspace home in the Schematic Bench chrome; an open project is
 * rendered full-bleed and receives the account/project controls to host in its own top bar.
 */
export function WorkspaceShell({ children }: {
  children: (projectId: string, project: Project, refreshProjects: () => Promise<void>, principalKey: string, chrome: ShellChrome) => ReactNode;
}) {
  const cache = useQueryClient();
  const [session, setSession] = useState<SessionState | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const generation = useRef(0);

  const clearPrivate = useCallback(() => {
    generation.current += 1;
    void cache.cancelQueries();
    cache.clear();
    setProjects([]);
    setProjectId(null);
    setNotice(null);
  }, [cache]);

  const refresh = useCallback(async () => {
    const currentGeneration = generation.current;
    const state = await requestJson<SessionState>("/api/v0/session");
    if (currentGeneration !== generation.current) return;
    setSession(state);
    if (state.user) {
      const list = await requestJson<Project[]>("/api/v0/projects");
      if (currentGeneration !== generation.current) return;
      setProjects(list);
      const remembered = readLastProject(String(state.user.id));
      if (remembered && !list.some((p) => p.project_id === remembered)) forgetLastProject(String(state.user.id));
      setProjectId((selected) => {
        if (selected && !list.some((p) => p.project_id === selected)) {
          void cache.cancelQueries(); cache.clear();
          setNotice("A project you had open is no longer available to you. Its data was cleared from this screen.");
          return null;
        }
        return selected;
      });
    } else {
      clearPrivate();
    }
  }, [cache, clearPrivate]);

  useEffect(() => {
    let active = true;
    void refresh().catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : "Unable to reach the workshop.");
    });
    return () => { active = false; generation.current += 1; };
  }, [refresh]);

  async function act(work: () => Promise<void>): Promise<boolean> {
    setError(null);
    setBusy(true);
    try {
      await work();
      return true;
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401 && session?.user) {
        clearPrivate();
        setSession(null);
        setExpired(true);
        try { await refresh(); } catch { /* Original failure remains visible. */ }
      }
      setError(reason instanceof Error ? reason.message : "Request failed.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function signIn(event: FormEvent) {
    event.preventDefault();
    await act(async () => {
      const setup = session?.owner_setup_required;
      await requestJson<OperationResult<unknown>>(setup ? "/api/v0/setup/owner" : "/api/v0/session/login", {
        method: "POST", body: JSON.stringify({ request_id: randomUUID(), username, password,
          ...(setup ? { token } : {}) }),
      });
      setPassword("");
      setToken("");
      setExpired(false);
      clearPrivate();
      await refresh();
    });
    setPassword("");
  }

  async function signOut() {
    await act(async () => {
      await requestJson("/api/v0/session/logout", {
        method: "POST", body: JSON.stringify({ request_id: randomUUID() }),
      });
      clearPrivate();
      setUsername("");
      setPassword("");
      setToken("");
      await refresh();
    });
  }

  function selectProject(value: string | null) {
    if (value === projectId) return;
    generation.current += 1;
    void cache.cancelQueries();
    cache.clear();
    setProjectId(value);
    setError(null);
    setNotice(null);
    if (value && session?.user) writeLastProject(String(session.user.id), value);
  }

  /** Resolves true only when the project was created, so the form keeps the name after a failure. */
  async function createProject(name: string): Promise<boolean> {
    return act(async () => {
      const result = await runOperation<Project>("project.create", { name });
      await refresh();
      selectProject(result.result.project_id);
    });
  }

  const selectedProject = projects.find((project) => project.project_id === projectId);
  const userId = session?.user ? String(session.user.id) : null;
  // Only a remembered project the server still lists is offered; nothing is entered automatically.
  const lastProjectId = useMemo(() => {
    const remembered = userId ? readLastProject(userId) : null;
    return remembered && projects.some((project) => project.project_id === remembered) ? remembered : null;
  }, [userId, projects, projectId]);

  const signOutControl = <Button variant="quiet" onClick={() => void signOut()} loading={busy}>Sign out</Button>;

  if (session?.user && projectId && selectedProject) {
    const chrome: ShellChrome = {
      username: session.user.username,
      projectControl: <Group gap={6} wrap="nowrap"><Select aria-label="Project" size="xs" w={200} data={projects.map((project) => ({ value: project.project_id, label: project.name }))}
        value={projectId} onChange={selectProject} disabled={busy} allowDeselect={false} />
        <Button variant="quiet" onClick={() => selectProject(null)} disabled={busy}>All projects</Button></Group>,
      signOutControl,
      projectMenu: <Menu position="bottom-start" withinPortal>
        <Menu.Target><button type="button" className="sb-project-button" aria-label={`Project ${selectedProject.name}: switch`} disabled={busy}><span className="sb-project-name">{selectedProject.name}</span><span aria-hidden="true" className="sb-mono">▾</span></button></Menu.Target>
        <Menu.Dropdown mah={360} style={{ overflowY: "auto" }}>
          <Menu.Item onClick={() => selectProject(null)}>All projects</Menu.Item>
          <Menu.Divider />
          {projects.map((project) => <Menu.Item key={project.project_id} aria-current={project.project_id === projectId ? "true" : undefined}
            style={project.project_id === projectId ? { color: "var(--sb-accent)" } : undefined} onClick={() => selectProject(project.project_id)}>{project.name}</Menu.Item>)}
        </Menu.Dropdown></Menu>,
      accountMenu: <Menu position="bottom-end" withinPortal>
        <Menu.Target><Button variant="quiet" aria-label={`Account menu, signed in as ${session.user.username}`} className="sb-account-button">{session.user.username}</Button></Menu.Target>
        <Menu.Dropdown>
          <Menu.Label>Signed in as {session.user.username}</Menu.Label>
          <Menu.Item onClick={() => void signOut()} disabled={busy}>Sign out</Menu.Item>
        </Menu.Dropdown></Menu>,
      alert: error ? <Alert color="red" title="Unable to complete request">{error}</Alert> : null,
    };
    return <Fragment key={`${session.user.id}:${projectId}`}>{children(projectId, selectedProject, refresh, String(session.user.id), chrome)}</Fragment>;
  }

  if (session?.user) {
    return <HomeFrame username={session.user.username} signOutControl={signOutControl} statusLabel="Workshop home"
      actions={projects.map((project) => ({ id: `project:${project.project_id}`, label: project.name, description: "Open project", onClick: () => selectProject(project.project_id) }))}>
      {error && <div className="sb-view" style={{ paddingTop: 8 }}><Alert color="red" title="Unable to complete request">{error}</Alert></div>}
      <WorkspaceHome username={session.user.username} projects={projects} lastProjectId={lastProjectId} busy={busy} notice={notice}
        onOpen={selectProject} onCreate={createProject} />
    </HomeFrame>;
  }

  return <HomeFrame statusLabel={!session ? (error ? "Not connected" : "Connecting") : "Signed out"}>
    <div className="sb-home-panel"><Stack gap="sm">
      <Title order={1} className="sb-dash-title">Specmate workshop</Title>
      {expired && <Alert color="yellow" role="status" title="Session ended">Your session has ended. Sign in again to continue; open project data was cleared.</Alert>}
      {error && <Alert color="red" title={!session ? "Workshop unavailable" : "Unable to complete request"}>{error}</Alert>}
      {!session ? <><Text role="status">{error ? "The workshop could not be reached." : "Connecting to the workshop…"}</Text>
        {error && <Button variant="primary" onClick={() => void act(refresh)} loading={busy}>Retry connection</Button>}</>
      : <form onSubmit={(event) => void signIn(event)}><Stack maw={420}>
        <Title order={2} size="h3">{session.owner_setup_required ? "Set up the first owner" : "Sign in"}</Title>
        {session.owner_setup_required && <><Text>Use the one-time setup token supplied by the installation operator.</Text>
          <PasswordInput label="Setup token" value={token} onChange={(event) => setToken(event.currentTarget.value)} required autoComplete="off" /></>}
        <TextInput label="Username" value={username} onChange={(event) => setUsername(event.currentTarget.value)} required autoComplete="username" />
        <PasswordInput label="Password" value={password} onChange={(event) => setPassword(event.currentTarget.value)} required autoComplete={session.owner_setup_required ? "new-password" : "current-password"} />
        <Button type="submit" variant="commit" loading={busy}>{session.owner_setup_required ? "Create owner account" : "Sign in"}</Button>
      </Stack></form>}
    </Stack></div>
  </HomeFrame>;
}
