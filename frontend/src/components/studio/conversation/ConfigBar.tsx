import { useRef, useState } from "react";
import ModelPicker from "@/components/studio/ModelPicker";
import { modelDisplayName } from "@/components/studio/modelOptions";
import { updateProject as updateProjectApi } from "@/lib/studioApi";
import { useStudioStore } from "@/store/studio-store";
import type { StudioProject } from "@/types/studio";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

type Models = { primaryModel: string; subagentModel: string };
export default function ConfigBar({ project, initialModels, onInitialModels }: { project?: StudioProject; initialModels?: Models; onInitialModels?: (models: Models) => void }) {
  const settings = useStudioStore((state) => state.settings);
  const currentRunConfig = useStudioStore((state) => state.currentRunConfig);
  const runStatus = useStudioStore((state) => state.runStatus);
  const [saving, setSaving] = useState(false);
  const saveLock = useRef(false);
  const models = project ?? initialModels ?? { primaryModel: "", subagentModel: "" };
  const working = runStatus === "running" || runStatus === "waiting_for_user";
  const save = async (patch: Partial<Models>) => {
    if (saveLock.current) return;
    const next = { primaryModel: models.primaryModel, subagentModel: models.subagentModel, ...patch };
    if (!project) { onInitialModels?.(next); return; }
    saveLock.current = true; setSaving(true);
    try { useStudioStore.getState().updateProject(await updateProjectApi(project.id, next)); }
    catch (error) { useStudioStore.getState().setError(error instanceof Error ? error.message : String(error)); }
    finally { saveLock.current = false; setSaving(false); }
  };
  return <Popover><PopoverTrigger asChild><button className="configuration-trigger" aria-label="Configure models and execution">
    <span>{modelDisplayName(working && currentRunConfig ? currentRunConfig.primary_model : models.primaryModel) || "Best available"}</span><span aria-hidden="true">⌄</span>
  </button></PopoverTrigger><PopoverContent className="configuration-panel" align="start">
    <h2>Models & execution</h2><p>{working ? "Changes apply to your next instruction." : "Choose the models that will work on this project."}</p>
    <fieldset disabled={saving}>
      <ModelPicker label="Primary" value={models.primaryModel} settings={settings} onChange={(value) => void save({ primaryModel: value })} />
      <p>Understands the brief, coordinates work, and reviews the result.</p>
      <ModelPicker label="Subagents" value={models.subagentModel} placeholder="Same as primary" settings={settings} onChange={(value) => void save({ subagentModel: value })} />
      <p>Specialists that implement focused parts of the project.</p>
    </fieldset>
    <div className="execution-policy"><strong>Adaptive team</strong><p>The primary model delegates focused work and can run independent specialists in parallel. Team size follows the task.</p></div>
    {working && currentRunConfig && <p>Running with {modelDisplayName(currentRunConfig.primary_model)} · specialists: {modelDisplayName(currentRunConfig.subagent_model) || "same as primary"}</p>}
    {saving && <p role="status">Saving models…</p>}
  </PopoverContent></Popover>;
}
