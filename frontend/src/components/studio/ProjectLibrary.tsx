import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { listProjects, updateProject } from "@/lib/studioApi";
import { ProjectOptions, projectRequest } from "@/lib/projectApi";
import { StudioProject } from "@/types/studio";
import { useStudioStore } from "@/store/studio-store";

export default function ProjectLibrary({ search, onSelect }: { search: string; onSelect: () => void }) {
  const { projects, activeProjectId, setProjects, setError } = useStudioStore();
  const navigate = useNavigate();
  const [filter, setFilter] = useState("active");
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const perform = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try { await action(); setProjects(await listProjects()); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const change = (id: string, patch: Partial<ProjectOptions>) => perform(async () => {
    const options = await projectRequest<ProjectOptions>(id, "options");
    await projectRequest(id, "options", { ...options, ...patch }, "PUT");
    if (patch.trashed && id === activeProjectId) navigate("/");
  });
  const visible = projects.filter((project) => project.name.toLowerCase().includes(search.toLowerCase()) &&
    (filter === "trash" ? project.trashed : !project.trashed && (filter === "archived" ? project.archived :
      !project.archived && (filter !== "favorites" || project.favorite))))
    .sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite) || b.updatedAt.localeCompare(a.updatedAt));
  const beginRename = (project: StudioProject) => { setEditing(project.id); setName(project.name); };
  return <div className="project-library">
    <select aria-label="Project collection" value={filter} onChange={(event) => setFilter(event.target.value)}>
      <option value="active">All projects</option><option value="favorites">Favorites</option>
      <option value="archived">Archived</option><option value="trash">Trash</option>
    </select>
    {visible.map((project) => <article key={project.id} aria-current={project.id === activeProjectId ? "page" : undefined}>
      {editing === project.id ? <form onSubmit={(event) => { event.preventDefault(); void perform(async () => {
        await updateProject(project.id, { name }); setEditing(null);
      }); }}>
        <input aria-label="Project name" value={name} onChange={(event) => setName(event.target.value)} autoFocus />
        <button disabled={busy || !name.trim()}>Save</button>
        <button type="button" onClick={() => setEditing(null)}>Cancel</button>
      </form> : <button className="project-open" onClick={() => { navigate(`/projects/${project.id}`); onSelect(); }}>
        {project.favorite ? "★ " : ""}{project.name}
      </button>}
      <details><summary aria-label={`Actions for ${project.name}`}>Actions</summary>
        <div className="project-actions">
          {project.trashed ? <button disabled={busy} onClick={() => change(project.id, { trashed: false })}>Restore project</button> : <>
            <button disabled={busy} onClick={() => beginRename(project)}>Rename</button>
            <button disabled={busy} onClick={() => change(project.id, { favorite: !project.favorite })}>{project.favorite ? "Unfavorite" : "Favorite"}</button>
            <button disabled={busy} onClick={() => change(project.id, { archived: !project.archived })}>{project.archived ? "Unarchive" : "Archive"}</button>
            <button disabled={busy} onClick={() => perform(async () => {
              const copy = await projectRequest<{ id: string }>(project.id, "duplicate", {});
              navigate(`/projects/${copy.id}`); onSelect();
            })}>Duplicate</button>
            <button disabled={busy} onClick={() => change(project.id, { trashed: true })}>Move to trash</button>
          </>}
        </div>
      </details>
    </article>)}
    {visible.length === 0 && <p>No projects in this collection.</p>}
  </div>;
}
