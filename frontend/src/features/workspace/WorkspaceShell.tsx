import { randomUUID } from "../../lib/random-id";
import { Alert, Button, Menu, PasswordInput, Stack, Text, TextInput, Title } from "@mantine/core";
import { useQueryClient } from "@tanstack/react-query";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { HomeFrame } from "../home/HomeFrame";
import { forgetLastProject, readLastProject, writeLastProject } from "../home/lastProject";
import { HOME, useNavigation } from "../navigation";
import { ApiError, listWorkspaceProjects, requestJson, runOperation, type OperationResult, type Project, type SessionState } from "./api";

/** Controls the shell places in its top bar: scope switching, account and request alerts. */
export type ShellChrome = {
  username: string;
  signOutControl: ReactNode;
  alert: ReactNode;
  /** Compact scope switcher for phone widths. */
  projectMenu?: ReactNode;
  /** Compact account menu (containing Sign out) for phone widths. */
  accountMenu?: ReactNode;
};

/** Everything a signed-in shell needs: the workspace role, the current scope and scope actions. */
export type WorkspaceScope = {
  userId: string;
  username: string;
  /** Stable principal key for per-principal client caches. */
  principalKey: string;
  /** Changes only when session/workspace authority changes, never for project navigation. */
  authorityKey: string;
  workspaceId: string;
  /** The member's workspace role and permissions; they apply at every scope. */
  role: string;
  permissions: string[];
  /** Null at Library scope. */
  projectId: string | null;
  project: Project | null;
  /** Every project in the workspace, archived ones included (flagged). */
  projects: Project[];
  /** Remembered project id, already checked against the project list. */
  lastProjectId: string | null;
  busy: boolean;
  selectProject: (projectId: string | null) => void;
  /** Internal route synchronization; does not navigate or change authority. */
  setProjectContext: (projectId: string | null) => void;
  createProject: (name: string, purpose?: string) => Promise<boolean>;
  refresh: () => Promise<void>;
  chrome: ShellChrome;
};

type Membership = { workspaceId: string; role: string; permissions: string[] };

/**
 * Owns the session, the workspace membership, the project list and the current scope. A signed-in
 * member always lands inside the shell at Library scope; nothing opens a project automatically.
 * Signing out, losing membership or changing workspace authority clears private query data.
 * Project navigation does not change authority or discard workspace edits.
 */
export function WorkspaceShell({ children }: { children: (scope: WorkspaceScope) => ReactNode }) {
  const cache = useQueryClient();
  const [session, setSession] = useState<SessionState | null>(null);
  const [membership, setMembership] = useState<Membership | null>(null);
  const [noMembership, setNoMembership] = useState(false);
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
  const [authorityEpoch, setAuthorityEpoch] = useState(0);
  const known = useRef<Membership | null>(null);
  const knownUser = useRef<string | null>(null);
  const navigation = useNavigation();

  const clearCache = useCallback(() => {
    generation.current += 1;
    setAuthorityEpoch((value) => value + 1);
    void cache.cancelQueries();
    cache.clear();
  }, [cache]);

  const clearPrivate = useCallback(() => {
    clearCache();
    known.current = null;
    knownUser.current = null;
    setMembership(null);
    setNoMembership(false);
    setProjects([]);
    setProjectId(null);
    setNotice(null);
  }, [clearCache]);

  const refresh = useCallback(async () => {
    let currentGeneration = generation.current;
    const state = await requestJson<SessionState>("/api/v0/session");
    if (currentGeneration !== generation.current) return;
    if (state.user && knownUser.current && knownUser.current !== String(state.user.id)) {
      clearPrivate();
      currentGeneration = generation.current;
    }
    knownUser.current = state.user ? String(state.user.id) : null;
    setSession(state);
    if (!state.user) { clearPrivate(); return; }
    let page;
    try {
      page = await listWorkspaceProjects();
    } catch (reason) {
      if (currentGeneration !== generation.current) return;
      if (reason instanceof ApiError && reason.status === 404) {
        // Not (or no longer) a member: drop every private read and say so plainly.
        const wasMember = known.current !== null;
        clearPrivate();
        setNoMembership(true);
        if (wasMember) setNotice("You are no longer a member of this workspace. Its data was cleared from this screen.");
        return;
      }
      throw reason;
    }
    if (currentGeneration !== generation.current) return;
    const next: Membership = { workspaceId: page.workspace_id, role: page.role, permissions: page.permissions };
    const previous = known.current;
    if (previous && (previous.workspaceId !== next.workspaceId || previous.role !== next.role || previous.permissions.join(",") !== next.permissions.join(","))) {
      // A role change refreshes cached reads and which actions are offered.
      clearCache();
      setNotice(`Your workspace role is now ${next.role}. The actions offered were refreshed.`);
    }
    known.current = next;
    setMembership(next);
    setNoMembership(false);
    setProjects(page.results);
    const userId = String(state.user.id);
    const remembered = readLastProject(userId);
    if (remembered && !page.results.some((p) => p.project_id === remembered)) forgetLastProject(userId);
    setProjectId((selected) => {
      if (selected && !page.results.some((p) => p.project_id === selected)) {
        setNotice("The project you had open no longer exists. You are back at Projects.");
        return null;
      }
      return selected;
    });
  }, [cache, clearCache, clearPrivate]);

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
      // Signing out leaves no project or selection in the address for the next sign-in.
      navigation?.navigate({ area: HOME.area, lens: HOME.lens, project: null, probe: null }, { replace: true });
      setUsername("");
      setPassword("");
      setToken("");
      await refresh();
    });
  }

  const selectProject = useCallback((value: string | null) => {
    // Projects are navigation context; changing one must not discard workspace editors or reads.
    setProjectId(value);
    navigation?.navigate({ area: "projects", lens: "overview", project: value, probe: null, filters: {} });
    setError(null);
    setNotice(null);
    if (value && session?.user) writeLastProject(String(session.user.id), value);
  }, [navigation, session]);

  /** Resolves true only when the project was created, so the form keeps the name after a failure. */
  async function createProject(name: string, purpose = ""): Promise<boolean> {
    return act(async () => {
      const result = await runOperation<Project>("project.create", { name, ...(purpose ? { purpose } : {}) });
      await refresh();
      selectProject(result.result.project_id);
    });
  }

  const selectedProject = projects.find((project) => project.project_id === projectId) ?? null;
  const userId = session?.user ? String(session.user.id) : null;
  // Only a remembered project the server still lists is offered; nothing is entered automatically.
  const lastProjectId = useMemo(() => {
    const remembered = userId ? readLastProject(userId) : null;
    return remembered && projects.some((project) => project.project_id === remembered) ? remembered : null;
  }, [userId, projects, projectId]);

  const signOutControl = <Button variant="quiet" onClick={() => void signOut()} loading={busy}>Sign out</Button>;
  const alert = notice || error ? <>
    {notice && <Alert color="yellow" role="status" title="Workspace changed">{notice}</Alert>}
    {error && <Alert color="red" title="Unable to complete request">{error}</Alert>}
  </> : null;

  if (session?.user && membership) {
    const user = session.user;
    const current = selectedProject;
    const chrome: ShellChrome = {
      username: user.username,
      signOutControl,
      accountMenu: <Menu position="bottom-end" withinPortal>
        <Menu.Target><Button variant="quiet" aria-label={`Account menu, signed in as ${user.username}`} className="sb-account-button">{user.username}</Button></Menu.Target>
        <Menu.Dropdown>
          <Menu.Label>Signed in as {user.username}</Menu.Label>
          <Menu.Item onClick={() => void signOut()} disabled={busy}>Sign out</Menu.Item>
        </Menu.Dropdown></Menu>,
      alert,
    };
    const scope: WorkspaceScope = {
      userId: String(user.id), username: user.username, principalKey: String(user.id),
      authorityKey: `${user.id}:${membership.workspaceId}:${authorityEpoch}:${membership.role}:${membership.permissions.join(",")}`,
      workspaceId: membership.workspaceId, role: membership.role, permissions: membership.permissions,
      projectId: current ? current.project_id : null, project: current, projects, lastProjectId, busy,
      selectProject, setProjectContext: setProjectId, createProject, refresh, chrome,
    };
    return <Fragment key={scope.authorityKey}>{children(scope)}</Fragment>;
  }

  if (session?.user && noMembership) {
    return <HomeFrame username={session.user.username} signOutControl={signOutControl} statusLabel="No workspace">
      <div className="sb-home-panel"><Stack gap="sm">
        <Title order={1} className="sb-dash-title">No workspace access</Title>
        {alert}
        <Text>This account is not a member of a workspace. Ask a workspace admin to add you; nothing private is shown until then.</Text>
        <Button variant="quiet" onClick={() => void act(refresh)} loading={busy}>Check again</Button>
      </Stack></div>
    </HomeFrame>;
  }

  if (session?.user) {
    return <HomeFrame username={session.user.username} signOutControl={signOutControl} statusLabel="Connecting">
      <div className="sb-home-panel"><Stack gap="sm">
        {alert}
        <Text role="status">{error ? "The workspace could not be read." : "Reading your workspace…"}</Text>
        {error && <Button variant="primary" onClick={() => void act(refresh)} loading={busy}>Retry</Button>}
      </Stack></div>
    </HomeFrame>;
  }

  return <HomeFrame statusLabel={!session ? (error ? "Not connected" : "Connecting") : "Signed out"}>
    <div className="sb-home-panel"><Stack gap="sm">
      <Title order={1} className="sb-dash-title">Specmate workshop</Title>
      {expired && <Alert color="yellow" role="status" title="Session ended">Your session has ended. Sign in again to continue; private data was cleared from this screen.</Alert>}
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
