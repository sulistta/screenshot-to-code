import { native } from "./native";
import type { StudioProject } from "@/types/studio";
export interface ProjectFiles { revision: string; files: Record<string, string> }
export interface FileDifference { path: string; kind: string; diff: string }
export interface ProjectOptions { favorite: boolean; archived: boolean; trashed: boolean }
export const getFiles = (projectId: string) => native<ProjectFiles>("get_files", { projectId });
export const editFile = (projectId: string, path: string, content: string, revision: string) =>
  native<ProjectFiles>("edit_file", { projectId, path, content, revision });
export const revisionDiff = (projectId: string, iterationId: string) => native<{ changes: FileDifference[] }>("revision_diff", { projectId, iterationId });
export const restoreRevision = (projectId: string, iterationId: string, revision: string) => native<void>("restore_revision", { projectId, iterationId, revision });
export const setProjectOptions = (projectId: string, options: ProjectOptions) => native<StudioProject>("set_project_options", { projectId, ...options });
export const duplicateProject = (projectId: string) => native<StudioProject>("duplicate_project", { projectId });
export const restoreDraft = (projectId: string, runId: string) => native<void>("restore_draft", { projectId, runId });
export const importProject = (projectId: string) => native<boolean>("import_project", { projectId });
export const exportProject = (projectId: string) => native<boolean>("export_project", { projectId });
export const gitCheckpoint = (projectId: string) => native<{ commit: string }>("git_checkpoint", { projectId, message: "Studio checkpoint" });
