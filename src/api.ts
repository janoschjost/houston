import { Channel, invoke } from "@tauri-apps/api/core";

export interface ShellInfo {
  shell: string;
  integrated: boolean;
  integrationDir: string;
  userZdotdir: string;
  home: string;
  commands: string[];
  history: string[];
}

export type PtyEvent = { kind: "data"; data: string } | { kind: "exit"; code: number | null };

export interface SpawnRequest {
  ptyId: string;
  program: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

/** One plan usage window as reported by Claude Code; `resets_at` is unix seconds. */
export interface LimitWindow {
  used_percentage: number;
  resets_at: number;
}

export interface RateLimits {
  five_hour?: LimitWindow;
  seven_day?: LimitWindow;
}

export interface PathItem {
  insert: string;
  label: string;
  dir: boolean;
}

export interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  staged: number;
  modified: number;
  untracked: number;
}

export const api = {
  shellInfo: () => invoke<ShellInfo>("shell_info"),
  spawn(req: SpawnRequest, onEvent: (e: PtyEvent) => void) {
    const channel = new Channel<PtyEvent>();
    channel.onmessage = onEvent;
    return invoke<void>("pty_spawn", { req, onEvent: channel });
  },
  write: (ptyId: string, data: string) => invoke<void>("pty_write", { ptyId, data }),
  resize: (ptyId: string, cols: number, rows: number) => invoke<void>("pty_resize", { ptyId, cols, rows }),
  kill: (ptyId: string) => invoke<void>("pty_kill", { ptyId }),
  completePath: (cwd: string, word: string, dirsOnly: boolean) =>
    invoke<PathItem[]>("complete_path", { cwd, word, dirsOnly }),
  gitRefs: (cwd: string) => invoke<string[]>("git_refs", { cwd }),
  gitStatus: (cwd: string) => invoke<GitStatus | null>("git_status", { cwd }),
  npmScripts: (cwd: string) => invoke<string[]>("npm_scripts", { cwd }),
  claudeSessionExists: (id: string) => invoke<boolean>("claude_session_exists", { id }),
  claudeStatusLine: () => invoke<string>("claude_status_line"),
  claudeLimits: () => invoke<RateLimits | null>("claude_limits"),
  loadState: <T>() => invoke<T | null>("load_state"),
  saveState: (state: unknown) => invoke<void>("save_state", { state }),
};
