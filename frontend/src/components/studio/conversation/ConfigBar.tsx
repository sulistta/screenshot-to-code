import { useState } from "react";
import ModelPicker from "@/components/studio/ModelPicker";
import { modelDisplayName } from "@/components/studio/modelOptions";
import { updateProject as updateProjectApi } from "@/lib/studioApi";
import { useStudioStore } from "@/store/studio-store";
import type { StudioProject } from "@/types/studio";

export function ConfigBar({ project, compact }: { project: StudioProject; compact?: boolean }) {
  const updateProject = useStudioStore((state) => state.updateProject);
  const setError = useStudioStore((state) => state.setError);
  const settings = useStudioStore((state) => state.settings);
  const [editing, setEditing] = useState(false);

  const save = async (
    patch: Partial<StudioProject> & {
      primaryModel?: string;
      subagentModel?: string;
    },
  ) => {
    try {
      const full = {
        primaryModel: patch.primaryModel ?? project.primaryModel,
        subagentModel: patch.subagentModel ?? project.subagentModel,
      };
      const updated = await updateProjectApi(project.id, full);
      updateProject(updated);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };

  if (!editing) {
    return (
      <button
        className="inline-flex items-center gap-2 text-left text-[11px] text-stone-500 dark:text-zinc-400 hover:text-stone-700 dark:hover:text-zinc-200 max-w-full overflow-hidden"
        onClick={() => setEditing(true)}
        title="Configure models"
      >
        <span className="truncate">
          {project.primaryModel
            ? modelDisplayName(project.primaryModel)
            : "Best available"}{" "}
          · Agent team
        </span>
      </button>
    );
  }

  return (
    <div className={`flex flex-wrap items-center gap-2 ${compact ? "" : "py-0.5"}`}>
      <span className="forge-select">
        <ModelPicker
          label="Primary"
          value={project.primaryModel}
          onChange={(value) => save({ primaryModel: value })}
          settings={settings}
        />
      </span>
      <span className="forge-select">
        <ModelPicker
          label="Subagents"
          value={project.subagentModel}
          placeholder="Same as primary"
          onChange={(value) => save({ subagentModel: value })}
          settings={settings}
        />
      </span>
      <button
        className="text-[11px] text-stone-500 hover:text-stone-900 dark:hover:text-zinc-100 px-1"
        onClick={() => setEditing(false)}
      >
        Done
      </button>
    </div>
  );
}

export default ConfigBar;
