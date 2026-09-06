import { useShallow } from "zustand/react/shallow";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { listProjects, updateProject } from "@/lib/studioApi";
import { ProjectOptions, setProjectOptions, duplicateProject } from "@/lib/projectApi";
import { StudioProject } from "@/types/studio";
import { useStudioStore } from "@/store/studio-store";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export type ProjectCollection = "active" | "favorites" | "archived" | "trash";

export default function ProjectLibrary({
  search,
  onSelect,
  collection,
  onCollectionChange,
}: {
  search: string;
  onSelect: () => void;
  collection: ProjectCollection;
  onCollectionChange: (collection: ProjectCollection) => void;
}) {
  const { projects, activeProjectId, setProjects, setError } = useStudioStore(useShallow((s) => ({ projects: s.projects, activeProjectId: s.activeProjectId, setProjects: s.setProjects, setError: s.setError })));
  const navigate = useNavigate();
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const perform = async (id: string, action: () => Promise<unknown>) => {
    setBusyId(id);
    try {
      await action();
      setProjects(await listProjects());
      setOpenMenu(null);
    }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusyId(null); }
  };
  const change = (id: string, patch: Partial<ProjectOptions>) => perform(id, async () => {
    const project = useStudioStore.getState().projects.find((item) => item.id === id);
    if (!project) throw new Error("Project not found");
    await setProjectOptions(id, { favorite: !!project.favorite, archived: !!project.archived, trashed: !!project.trashed, ...patch });
    if (patch.trashed && id === useStudioStore.getState().activeProjectId) navigate("/");
  });
  const visible = projects.filter((project) => project.name.toLowerCase().includes(search.toLowerCase()) &&
    (collection === "trash" ? project.trashed : !project.trashed && (collection === "archived" ? project.archived :
      !project.archived && (collection !== "favorites" || project.favorite))))
    .sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite) || b.updatedAt.localeCompare(a.updatedAt));
  const beginRename = (project: StudioProject) => { setEditing(project.id); setName(project.name); setOpenMenu(null); };
  return <div className="project-library">
    <div className="px-1 pb-2">
      <label className="sr-only" htmlFor="forge-collection">Project collection</label>
      <select
        id="forge-collection"
        aria-label="Project collection"
        value={collection}
        onChange={(event) => onCollectionChange(event.target.value as ProjectCollection)}
        className="w-full bg-transparent text-[12px] text-stone-500 dark:text-zinc-400 outline-none cursor-pointer"
      >
        <option value="active">All projects</option><option value="favorites">Favorites</option>
        <option value="archived">Archived</option><option value="trash">Trash</option>
      </select>
    </div>
    {visible.map((project) => {
      const busy = busyId === project.id;
      return <article key={project.id} aria-current={project.id === activeProjectId ? "page" : undefined} className="group px-1 py-0.5">
        {editing === project.id ? <form className="flex items-center gap-1 px-2 py-1.5" onSubmit={(event) => {
          event.preventDefault();
          const value = name.trim();
          if (!value) return;
          void perform(project.id, async () => {
            await updateProject(project.id, { name: value }); setEditing(null);
          });
        }}>
          <input aria-label="Project name" value={name} onChange={(event) => setName(event.target.value)} autoFocus disabled={busy} className="w-full bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-700 rounded-md px-2 py-1 text-[13px] outline-none" />
          <button disabled={busy || !name.trim()} className="text-[12px] px-1.5 text-stone-600 disabled:opacity-40">{busy ? "Saving…" : "Save"}</button>
          <button type="button" disabled={busy} onClick={() => setEditing(null)} className="text-[12px] px-1.5 text-stone-400">Cancel</button>
        </form> : <div className="flex items-center gap-1">
          <button className="flex flex-1 items-center gap-2.5 min-w-0 text-left px-2 py-[7px] rounded-lg text-[13px] text-stone-700 dark:text-zinc-200 hover:bg-[#e9e7e3] dark:hover:bg-zinc-800/80" onClick={() => { navigate(`/projects/${project.id}`); onSelect(); }} title={project.name}>
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" className="shrink-0 text-stone-500 dark:text-zinc-400"><path d="M1.5 4.5c0-.8.7-1.5 1.5-1.5h3l1.5 1.8H13c.8 0 1.5.7 1.5 1.5v5.2c0 .8-.7 1.5-1.5 1.5H3c-.8 0-1.5-.7-1.5-1.5V4.5Z" stroke="currentColor" strokeWidth="1.3" /></svg>
            <span className="truncate">{project.favorite ? "★ " : ""}{project.name}</span>
            {project.id === activeProjectId && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-stone-900 dark:bg-white shrink-0" />}
          </button>
          <Popover open={openMenu === project.id} onOpenChange={(open) => setOpenMenu(open ? project.id : null)}>
            <PopoverTrigger asChild>
              <button aria-label={`Actions for ${project.name}`} className="shrink-0 text-stone-400 hover:text-stone-700 dark:hover:text-zinc-200 px-1.5 py-1 text-[13px] rounded-md">···</button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-44 p-1">
              <div className="project-actions flex flex-col" role="menu" aria-label={`Actions for ${project.name}`}>
                {project.trashed ? <button role="menuitem" className="w-full text-left px-2.5 py-1.5 text-[12px] rounded-md hover:bg-stone-100 dark:hover:bg-zinc-800 disabled:opacity-40" disabled={busy} onClick={() => change(project.id, { trashed: false })}>Restore project</button> : <>
                  <button role="menuitem" className="w-full text-left px-2.5 py-1.5 text-[12px] rounded-md hover:bg-stone-100 dark:hover:bg-zinc-800 disabled:opacity-40" disabled={busy} onClick={() => beginRename(project)}>Rename</button>
                  <button role="menuitem" className="w-full text-left px-2.5 py-1.5 text-[12px] rounded-md hover:bg-stone-100 dark:hover:bg-zinc-800 disabled:opacity-40" disabled={busy} onClick={() => change(project.id, { favorite: !project.favorite })}>{project.favorite ? "Unfavorite" : "Favorite"}</button>
                  <button role="menuitem" className="w-full text-left px-2.5 py-1.5 text-[12px] rounded-md hover:bg-stone-100 dark:hover:bg-zinc-800 disabled:opacity-40" disabled={busy} onClick={() => change(project.id, { archived: !project.archived })}>{project.archived ? "Unarchive" : "Archive"}</button>
                  <button role="menuitem" className="w-full text-left px-2.5 py-1.5 text-[12px] rounded-md hover:bg-stone-100 dark:hover:bg-zinc-800 disabled:opacity-40" disabled={busy} onClick={() => perform(project.id, async () => {
                    const copy = await duplicateProject(project.id);
                    navigate(`/projects/${copy.id}`); onSelect();
                  })}>Duplicate</button>
                  <button role="menuitem" className="w-full text-left px-2.5 py-1.5 text-[12px] rounded-md text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 disabled:opacity-40" disabled={busy} onClick={() => change(project.id, { trashed: true })}>Move to trash</button>
                </>}
              </div>
            </PopoverContent>
          </Popover>
        </div>}
      </article>;
    })}
    {visible.length === 0 && <p className="px-3 py-2 text-[12px] text-stone-400">No projects in this collection.</p>}
  </div>;
}
