import { useState } from "react";
import ModelPicker from "@/components/studio/ModelPicker";
import { modelDisplayName } from "@/components/studio/modelOptions";
import { updateProject as updateProjectApi } from "@/lib/studioApi";
import { useStudioStore } from "@/store/studio-store";
import type { StudioProject } from "@/types/studio";

export function ConfigBar({ project }: { project: StudioProject }) {
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
      // Always send the full configuration: partial PATCHes raced with
      // re-renders between saves and could drop freshly-picked values.
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
        className="flex items-center gap-2 text-left text-[11px] text-muted-foreground/80 hover:text-muted-foreground max-w-full overflow-hidden"
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
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-0.5">
      <ModelPicker
        label="Primary"
        value={project.primaryModel}
        onChange={(value) => save({ primaryModel: value })}
        settings={settings}
      />
      <ModelPicker
        label="Subagents"
        value={project.subagentModel}
        placeholder="Same as primary"
        onChange={(value) => save({ subagentModel: value })}
        settings={settings}
      />
      <button
        className="text-[11px] text-muted-foreground hover:text-foreground"
        onClick={() => setEditing(false)}
      >
        Done
      </button>
    </div>
  );
}

export default ConfigBar;
