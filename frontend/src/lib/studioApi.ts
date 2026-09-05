import { convertFileSrc } from "@tauri-apps/api/core";
import type { RunSettings } from "./runSettings";
import { native } from "./native";
import type { StudioProject, StudioTranscriptMessage, StudioIteration } from "@/types/studio";
export const listProjects = () => native<StudioProject[]>("list_projects");
export const createProject = (name: string, brief: string) => native<StudioProject>("create_project", { name, brief });
export const deleteProject = (projectId: string) => native<void>("delete_project", { projectId });
export const updateProject = (projectId: string, patch: Partial<Pick<StudioProject, "name" | "brief" | "primaryModel" | "subagentModel">>) =>
  native<StudioProject>("update_project", { projectId, patch });
export const listIterations = (projectId: string) => native<StudioIteration[]>("list_iterations", { projectId });
export const getTranscript = (projectId: string) => native<StudioTranscriptMessage[]>("get_transcript", { projectId });
export const startRun = (projectId: string, text: string, settings: RunSettings, images: string[] = []) =>
  native<string>("start_run", { projectId, text, settings, images });
export const cancelRun = (projectId: string) => native<void>("cancel_run", { projectId });
export const workspaceUrl = (projectId: string) => convertFileSrc(`${projectId}/current/index.html`, "preview");
export const openPreview = (projectId: string, iterationId?: string) => native<void>("open_preview", { projectId, iterationId: iterationId ?? null });
export interface ServicesStatus {
  state: "installing" | "running" | "stopped" | "crashed";
  error?: string | null;
  sandboxed?: boolean;
  url?: string;
  services: Array<{ name: string; port: number; crashes: number; logs: string[] }>;
}
export const getServicesStatus = (projectId: string) => native<ServicesStatus>("services_status", { projectId });
export const startServices = (projectId: string) => native<ServicesStatus>("start_services", { projectId });
export const stopServices = (projectId: string) => native<void>("stop_services", { projectId });
export type { StudioRunEvent } from "@/types/studio";
