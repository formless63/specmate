import { randomUUID } from "../../lib/random-id";
import { Alert, Button, Container, Group, PasswordInput, Select, Stack, Text, TextInput, Title } from "@mantine/core";
import { useQueryClient } from "@tanstack/react-query";
import { Fragment, useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ApiError, requestJson, runOperation, type OperationResult, type Project, type SessionState } from "./api";

export function WorkspaceShell({ children }: { children: (projectId: string, project: Project, refreshProjects: () => Promise<void>) => ReactNode }) {
  const cache = useQueryClient();
  const [session, setSession] = useState<SessionState | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [projectName, setProjectName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);

  const clearPrivate = useCallback(() => {
    generation.current += 1;
    void cache.cancelQueries();
    cache.clear();
    setProjects([]);
    setProjectId(null);
    setProjectName("");
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
      setProjectId((selected) => {
        if (selected && !list.some((p) => p.project_id === selected)) {
          void cache.cancelQueries(); cache.clear(); return null;
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

  async function act(work: () => Promise<void>) {
    setError(null);
    setBusy(true);
    try {
      await work();
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401 && session?.user) {
        clearPrivate();
        setSession(null);
        try { await refresh(); } catch { /* Original failure remains visible. */ }
      }
      setError(reason instanceof Error ? reason.message : "Request failed.");
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
  }

  async function createProject(event: FormEvent) {
    event.preventDefault();
    await act(async () => {
      const result = await runOperation<Project>("project.create", { name: projectName.trim() });
      setProjectName("");
      await refresh();
      selectProject(result.result.project_id);
    });
  }

  const selectedProject = projects.find((project) => project.project_id === projectId);

  return <Container size="xl" py="lg"><Stack>
    <Title order={1}>Specmate workshop</Title>
    {error && <Alert color="red" title="Unable to complete request">{error}</Alert>}
    {!session ? <><Text>Connecting to the workshop…</Text>
      {error && <Button onClick={() => void act(refresh)} loading={busy}>Retry connection</Button>}</>
    : !session.user ? <form onSubmit={(event) => void signIn(event)}><Stack maw={420}>
      <Title order={2}>{session.owner_setup_required ? "Set up the first owner" : "Sign in"}</Title>
      {session.owner_setup_required && <><Text>Use the one-time setup token supplied by the installation operator.</Text>
        <PasswordInput label="Setup token" value={token} onChange={(event) => setToken(event.currentTarget.value)} required autoComplete="off" /></>}
      <TextInput label="Username" value={username} onChange={(event) => setUsername(event.currentTarget.value)} required autoComplete="username" />
      <PasswordInput label="Password" value={password} onChange={(event) => setPassword(event.currentTarget.value)} required autoComplete={session.owner_setup_required ? "new-password" : "current-password"} />
      <Button type="submit" loading={busy}>{session.owner_setup_required ? "Create owner account" : "Sign in"}</Button>
    </Stack></form> : <>
      <Group justify="space-between"><Text>Signed in as {session.user.username}</Text>
        <Button variant="light" onClick={() => void signOut()} loading={busy}>Sign out</Button></Group>
      <Select label="Project" placeholder="Select a private project" data={projects.map((project) => ({ value: project.project_id, label: project.name }))}
        value={projectId} onChange={selectProject} disabled={busy} clearable />
      <form onSubmit={(event) => void createProject(event)}><Group align="end">
        <TextInput label="New project name" value={projectName} onChange={(event) => setProjectName(event.currentTarget.value)} required disabled={busy} />
        <Button type="submit" loading={busy} disabled={!projectName.trim()}>Create project</Button>
      </Group></form>
      {projectId && selectedProject ? <Fragment key={`${session.user.id}:${projectId}`}>{children(projectId, selectedProject, refresh)}</Fragment>
        : <Text>Select or create a project to begin.</Text>}
    </>}
  </Stack></Container>;
}
