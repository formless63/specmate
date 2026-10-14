import { Text, TextInput, Title } from "@mantine/core";
import { useMemo, useState } from "react";
import type { Project } from "../workspace/api";

const SHOWN = 60;

/**
 * Inline project chooser for a lens that works on project-held records (or still needs a project
 * as context) at Library scope. Choosing keeps the area and lens; it never changes access.
 */
export function ChooseProject({ toolLabel, projects, lastProjectId, onChoose }: {
  toolLabel: string;
  projects: Project[];
  lastProjectId: string | null;
  onChoose: (projectId: string) => void;
}) {
  const [filter, setFilter] = useState("");
  const active = useMemo(() => projects.filter((project) => !project.archived), [projects]);
  const rows = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const matching = needle ? active.filter((project) => project.name.toLowerCase().includes(needle)) : active;
    // The remembered project leads; the rest follow by name.
    return [...matching].sort((a, b) => Number(b.project_id === lastProjectId) - Number(a.project_id === lastProjectId) || a.name.localeCompare(b.name));
  }, [active, filter, lastProjectId]);
  return <section className="sb-dash sb-choose" aria-label={`Choose a project for ${toolLabel}`}>
    <Title order={2} className="sb-dash-title">Choose a project</Title>
    <Text className="sb-dash-note">{toolLabel} works in a project context. Choose one; the area and lens stay as they are. Every member sees every project.</Text>
    {active.length === 0 ? <div className="sb-dash-empty" role="status"><Text>No projects yet. Create one from Project › Overview.</Text></div> : <>
      <TextInput aria-label="Filter projects to open" placeholder="filter projects" size="xs" maw={360}
        leftSection={<span className="sb-mono" style={{ color: "var(--sb-accent)" }}>›</span>} value={filter} onChange={(event) => setFilter(event.currentTarget.value)} />
      <div className="sb-dash-list sb-choose-list" role="group" aria-label="Projects to open">
        {rows.slice(0, SHOWN).map((project) => <button key={project.project_id} type="button" className="sb-home-row" data-last={project.project_id === lastProjectId || undefined}
          aria-label={`Open ${toolLabel} in ${project.name}`} onClick={() => onChoose(project.project_id)}>
          <span className="sb-home-name">{project.name}</span>
          <span className="sb-home-meta sb-mono">{project.project_id === lastProjectId ? <span className="sb-silk">last opened</span> : <span>{project.purpose || "no purpose recorded"}</span>}</span>
        </button>)}
        {rows.length === 0 && <div className="sb-dash-empty" role="status"><Text>No project matches this filter.</Text></div>}
      </div>
      {rows.length > SHOWN && <Text className="sb-dash-note" role="status">Showing {SHOWN} of {rows.length}; refine the filter to find the rest.</Text>}
    </>}
  </section>;
}
