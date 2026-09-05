import { invoke } from "@tauri-apps/api/core";

/** Normalize Rust command errors once at the IPC boundary. */
export async function native<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try { return await invoke<T>(command, args); }
  catch (error) { throw error instanceof Error ? error : new Error(String(error)); }
}
