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

/** Usage Claude Code last reported for one session; fields are null until it has a value. */
export interface SessionStats {
  cost_usd: number | null;
  lines_added: number | null;
  lines_removed: number | null;
  context_percent: number | null;
  model: string | null;
}

/** One step of a Claude session read from its transcript: a prompt, a tool call or a reply. */
export interface ActivityEvent {
  /** ISO 8601 timestamp. */
  ts: string;
  kind: "prompt" | "tool" | "reply";
  tool: string;
  summary: string;
  path: string | null;
  /** The tool changes `path`. */
  edit: boolean;
}

/** A file change a Claude session made. */
export interface FileEdit {
  path: string;
  ts: string;
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

/** An `alias` line from the user's .zshrc; non-editable ones expand `$` or backticks and are shown as written. */
export interface Alias {
  name: string;
  command: string;
  editable: boolean;
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
  gitDiff: (cwd: string) => invoke<string>("git_diff", { cwd }),
  gitHeadFile: (cwd: string, path: string) => invoke<string>("git_head_file", { cwd, path }),
  readProjectFile: (cwd: string, path: string) => invoke<string>("read_project_file", { cwd, path }),
  writeProjectFile: (cwd: string, path: string, content: string) => invoke<void>("write_project_file", { cwd, path, content }),
  launchDetached: (cwd: string, command: string) => invoke<void>("launch_detached", { cwd, command }),
  npmScripts: (cwd: string) => invoke<string[]>("npm_scripts", { cwd }),
  claudeSessionExists: (id: string) => invoke<boolean>("claude_session_exists", { id }),
  claudeStatusLine: () => invoke<string>("claude_status_line"),
  claudeLimits: () => invoke<RateLimits | null>("claude_limits"),
  claudeSessionStats: (ids: string[]) => invoke<Record<string, SessionStats>>("claude_session_stats", { ids }),
  claudeTimeline: (id: string) => invoke<ActivityEvent[]>("claude_timeline", { id }),
  claudeEdits: (ids: string[]) => invoke<Record<string, FileEdit[]>>("claude_edits", { ids }),
  remoteStart: () => invoke<{ url: string }>("remote_start"),
  remoteStop: () => invoke<void>("remote_stop"),
  remoteUpdate: (snapshot: string) => invoke<void>("remote_update", { snapshot }),
  loadState: <T>() => invoke<T | null>("load_state"),
  saveState: (state: unknown) => invoke<void>("save_state", { state }),
  listAliases: () => invoke<Alias[]>("list_aliases"),
  saveAlias: (original: string | null, name: string, command: string) => invoke<void>("save_alias", { original, name, command }),
  deleteAlias: (name: string) => invoke<void>("delete_alias", { name }),
};
