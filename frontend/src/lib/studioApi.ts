import type {
  StudioProject,
  StudioTranscriptMessage,
  StudioRunEvent,
  StudioIteration,
} from "@/types/studio";

const HTTP_BASE = import.meta.env.VITE_HTTP_BACKEND_URL || "";

/** Extract the server's actionable message from an error response. */
async function failure(response: Response, fallback: string): Promise<Error> {
  const detail = await response
    .json()
    .then((data) =>
      typeof data.detail === "string" ? data.detail : Array.isArray(data.detail) ? data.detail.map((item: { msg?: string }) => item.msg).join("; ") : null,
    )
    .catch(() => null);
  return new Error(detail || fallback);
}

export async function listProjects(): Promise<StudioProject[]> {
  const response = await fetch(`${HTTP_BASE}/api/projects`);
  if (!response.ok) throw await failure(response, "Failed to load projects");
  const data = await response.json();
  return data.projects;
}

export async function createProject(
  name: string,
  brief: string,
): Promise<StudioProject> {
  const response = await fetch(`${HTTP_BASE}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, brief }),
  });
  if (!response.ok) throw await failure(response, "Failed to create project");
  const data = await response.json();
  return data.project;
}

export async function deleteProject(projectId: string): Promise<void> {
  const response = await fetch(
    `${HTTP_BASE}/api/projects/${projectId}`,
    { method: "DELETE" },
  );
  if (!response.ok) throw await failure(response, "Failed to delete project");
}

export async function updateProject(
  projectId: string,
  patch: Partial<Pick<StudioProject, "name" | "brief" | "primaryModel" | "subagentModel">>,
): Promise<StudioProject> {
  const response = await fetch(`${HTTP_BASE}/api/projects/${projectId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!response.ok) throw await failure(response, "Failed to update project");
  const data = await response.json();
  return data.project;
}

export async function listIterations(
  projectId: string,
): Promise<StudioIteration[]> {
  const response = await fetch(
    `${HTTP_BASE}/api/projects/${projectId}/iterations`,
  );
  if (!response.ok) throw await failure(response, "Failed to load iterations");
  const data = await response.json();
  return data.iterations;
}

export function iterationUrl(
  projectId: string,
  iterationId: string,
): string {
  return `${HTTP_BASE}/api/projects/${projectId}/iterations/${iterationId}/files/index.html`;
}

export async function getAvailableModels(): Promise<string[]> {
  const response = await fetch(`${HTTP_BASE}/api/models`);
  if (!response.ok) return [];
  const data = await response.json();
  return data.models;
}

export async function getTranscript(
  projectId: string,
): Promise<StudioTranscriptMessage[]> {
  const response = await fetch(
    `${HTTP_BASE}/api/projects/${projectId}/transcript`,
  );
  if (!response.ok) throw await failure(response, "Failed to load transcript");
  const data = await response.json();
  return data.messages;
}

export async function startRun(
  projectId: string,
  text: string,
  settings: Record<string, unknown>,
  images: string[] = [],
): Promise<string> {
  const response = await fetch(
    `${HTTP_BASE}/api/projects/${projectId}/runs`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, settings, images }),
    },
  );
  if (!response.ok) throw await failure(response, "Failed to start run");
  const data = await response.json();
  return data.runId;
}

export async function cancelRun(projectId: string): Promise<void> {
  const response = await fetch(
    `${HTTP_BASE}/api/projects/${projectId}/cancel`,
    { method: "POST" },
  );
  if (!response.ok) throw await failure(response, "Nothing to cancel");
}

export interface ServicesStatus {
  state: "installing" | "running" | "stopped" | "crashed";
  error?: string | null;
  services: Array<{
    name: string;
    port: number;
    crashes: number;
    logs: string[];
  }>;
}

export async function getServicesStatus(
  projectId: string,
): Promise<ServicesStatus> {
  const response = await fetch(
    `${HTTP_BASE}/api/projects/${projectId}/services`,
  );
  if (!response.ok) throw await failure(response, "Failed to load services");
  return response.json();
}

export async function startServices(projectId: string): Promise<ServicesStatus> {
  const response = await fetch(
    `${HTTP_BASE}/api/projects/${projectId}/services/start`,
    { method: "POST" },
  );
  if (!response.ok) throw await failure(response, "Failed to start services");
  return response.json();
}

export async function stopServices(projectId: string): Promise<void> {
  const response = await fetch(
    `${HTTP_BASE}/api/projects/${projectId}/services/stop`,
    { method: "POST" },
  );
  if (!response.ok) throw await failure(response, "Failed to stop services");
}

export function workspaceUrl(projectId: string): string {
  return `${HTTP_BASE}/workspace/${projectId}/index.html`;
}

/** Origin of a running app served through the project preview gateway. */
export function appUrl(projectId: string): string {
  return `${HTTP_BASE}/api/projects/${projectId}/app/`;
}

export function projectSocketUrl(projectId: string): string {
  const wsBase = import.meta.env.VITE_WS_BACKEND_URL || "";
  const httpBase = import.meta.env.VITE_HTTP_BACKEND_URL || "";
  // Mirror the existing generate-code socket: default to same-origin so the
  // Vite dev proxy handles routing in dev.
  if (!wsBase && !httpBase) {
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${window.location.host}/ws/projects/${projectId}`;
  }
  if (wsBase) {
    return `${wsBase.replace(/\/$/, "")}/ws/projects/${projectId}`;
  }
  return `${httpBase.replace(/\/$/, "")}/ws/projects/${projectId}`.replace(
    /^http/,
    "ws",
  );
}

export type { StudioRunEvent };
