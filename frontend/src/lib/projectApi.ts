export interface ProjectFiles { revision: string; files: Record<string, string> }
export interface FileDifference { path: string; kind: string; diff: string }
export interface ProjectOptions {
  favorite: boolean; archived: boolean; trashed: boolean;
}
const base = import.meta.env.VITE_HTTP_BACKEND_URL || "";
export async function projectRequest<T>(id: string, path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(`${base}/api/v1/projects/${id}/${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(typeof detail.detail === "string" ? detail.detail : "The operation could not be completed.");
  }
  return response.json();
}
export const projectExportUrl = (id: string) => `${base}/api/v1/projects/${id}/export`;
