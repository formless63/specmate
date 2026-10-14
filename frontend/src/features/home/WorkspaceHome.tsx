import { Alert, Button, Text, TextInput, Title } from "@mantine/core";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { readOpenWork } from "../overview/work";
import { describeAccess, isReadOnly } from "../shell/areas";
import type { Project } from "../workspace/api";

type Props = {
  username: string;
  projects: Project[];
  /** Remembered project id, already checked against the authorized list by the caller. */
  lastProjectId: string | null;
  busy: boolean;
  /** Plain-words notice, e.g. an open project that is no longer available. */
  notice: string | null;
  onOpen: (projectId: string) => void;
  onCreate: (name: string) => Promise<boolean>;
};

export function WorkspaceHome({ username, projects, lastProjectId, busy, notice, onOpen, onCreate }: Props) {
  const [filter, setFilter] = useState("");
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const last = projects.find((project) => project.project_id === lastProjectId) ?? null;
  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return needle ? projects.filter((project) => project.name.toLowerCase().includes(needle)) : projects;
  }, [projects, filter]);
  const readOnlyCount = projects.filter((project) => isReadOnly(project.permissions)).length;
  const unreported = projects.filter((project) => !project.permissions?.length).length;
  const showForm = creating || projects.length === 0;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    if (await onCreate(trimmed)) setName("");
  }

  return <div className="sb-home">
    <nav className="sb-home-projects" aria-label="Projects">
      <div className="sb-rail-title sb-silk">Projects</div>
      {projects.length > 0 && <div className="sb-home-filter"><TextInput aria-label="Filter projects" placeholder="filter projects" size="xs" variant="unstyled"
        leftSection={<span className="sb-mono" style={{ color: "var(--sb-accent)" }}>›</span>} value={filter} onChange={(event) => setFilter(event.currentTarget.value)} /></div>}
      <div className="sb-home-rows">
        {shown.map((project) => {
          const access = describeAccess(project.permissions ?? []);
          const isLast = project.project_id === last?.project_id;
          return <button key={project.project_id} type="button" className="sb-home-row" data-last={isLast || undefined}
            aria-label={`Open ${project.name}`} onClick={() => onOpen(project.project_id)} disabled={busy}>
            <span className="sb-home-name">{project.name}</span>
            <span className="sb-home-meta sb-mono">
              <span data-unknown={!access.known}>{access.known ? access.label : "access not reported"}</span>
              {isReadOnly(project.permissions) && <span className="sb-tag">read-only</span>}
              {isLast && <span className="sb-silk">last opened</span>}
            </span>
          </button>;
        })}
        {projects.length > 0 && shown.length === 0 && <div className="sb-dash-empty" role="status"><Text>No project matches this filter.</Text></div>}
      </div>
      <div className="sb-home-new">
        {showForm ? <form onSubmit={(event) => void submit(event)} aria-label="New project">
          <TextInput label="New project name" size="xs" value={name} onChange={(event) => setName(event.currentTarget.value)} required disabled={busy} />
          <Button type="submit" variant="primary" size="xs" mt={6} fullWidth loading={busy} disabled={!name.trim()}>Create project</Button>
        </form> : <Button variant="primary" size="xs" fullWidth onClick={() => setCreating(true)}>New project</Button>}
      </div>
    </nav>

    <section className="sb-home-center" aria-label="Workshop">
      <Title order={1} className="sb-dash-title">Workshop</Title>
      {notice && <Alert color="yellow" role="status" title="Project no longer available">{notice}</Alert>}
      <dl className="sb-context sb-context-4">
        <Cell label="Signed in" value={username} />
        <Cell label="Projects" value={String(projects.length)} />
        <Cell label="Read-only" value={String(readOnlyCount)} />
        <Cell label="Access not reported" value={String(unreported)} unknown={unreported > 0} />
      </dl>
      {projects.length === 0 ? <div className="sb-dash-empty" role="status">
        <Title order={2} size="h3">No projects yet</Title>
        <Text>Create a project to start. Every project is private to the people you grant access to.</Text>
      </div>
      : last ? <Continue project={last} busy={busy} onOpen={onOpen} />
      : <div className="sb-dash-empty" role="status">
        <Title order={2} size="h3">Choose a project</Title>
        <Text>Open a project from the list to see what is waiting on you and what you can start.</Text>
      </div>}
    </section>
  </div>;
}

function Cell({ label, value, unknown = false }: { label: string; value: string; unknown?: boolean }) {
  return <div className={`sb-cell${unknown ? " sb-hatch" : ""}`}>
    <dt className="sb-silk">{label}</dt>
    <dd data-unknown={unknown} title={value}>{value}</dd>
  </div>;
}

function Continue({ project, busy, onOpen }: { project: Project; busy: boolean; onOpen: (projectId: string) => void }) {
  const [summary, setSummary] = useState<string | null>(null);
  const permissionKey = (project.permissions ?? []).join(",");
  useEffect(() => {
    let current = true;
    setSummary(null);
    void readOpenWork(project.project_id).then((work) => {
      if (!current) return;
      const parts: string[] = [];
      if (work.unread.status === "ok") parts.push(`${work.unread.value.rows.length}${work.unread.value.more ? "+" : ""} unread notifications`);
      if (work.reviews.status === "ok") parts.push(`${work.reviews.value.open.length}${work.reviews.value.more ? "+" : ""} open reviews`);
      setSummary(parts.length ? parts.join(" · ") : "Open work could not be read.");
    });
    return () => { current = false; };
  }, [project.project_id, permissionKey]);
  const access = describeAccess(project.permissions ?? []);
  return <div className="sb-home-continue">
    <h2 className="sb-dash-h">Continue where you left off</h2>
    <div className="sb-dash-row sb-home-continue-row">
      <span className="sb-led" data-state="active" aria-hidden="true" />
      <span className="sb-dash-row-title">{project.name}</span>
      <Button variant="commit" aria-label={`Continue in ${project.name}`} onClick={() => onOpen(project.project_id)} disabled={busy}>Continue in {project.name}</Button>
      <span />
      <span className="sb-dash-note" role="status">{summary ?? "Reading open work"} · {access.known ? access.label : "access not reported"}{isReadOnly(project.permissions) ? " · read-only" : ""}</span>
    </div>
  </div>;
}
