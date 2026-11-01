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

/** A concrete `Host` from ~/.ssh/config. */
export interface SshHost {
  name: string;
  hostname: string | null;
  user: string | null;
}

/** Where an SSH session or the file panel connects: a ~/.ssh/config host or an address, with overrides. */
export interface Remote {
  host: string;
  port?: number;
  user?: string;
  /** Private key file. */
  identity?: string;
  /** Keychain account of the saved password. */
  secret?: string;
}

/** A project's saved SFTP connection. */
export interface SftpConfig extends Remote {
  /** Remote folder the file panel opens in; the login directory when unset. */
  path?: string;
}

export interface LocalEntry {
  name: string;
  /** Directory (or a link to one), other symlink, or file. */
  kind: "d" | "l" | "f";
  size: number;
  /** Unix milliseconds. */
  mtime: number;
}

export interface RemoteEntry {
  name: string;
  /** Directory, symlink or file. */
  kind: "d" | "l" | "f";
  size: number;
  /** As the server lists it, e.g. "Mar 04 12:30". */
  modified: string;
}

export interface RemoteListing {
  /** The directory listed, absolute. */
  path: string;
  entries: RemoteEntry[];
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
  /** Fails without writing when the file no longer holds `expected`. */
  writeProjectFile: (cwd: string, path: string, expected: string, content: string) =>
    invoke<void>("write_project_file", { cwd, path, expected, content }),
  launchDetached: (cwd: string, command: string) => invoke<void>("launch_detached", { cwd, command }),
  npmScripts: (cwd: string) => invoke<string[]>("npm_scripts", { cwd }),
  installedApps: (names: string[]) => invoke<string[]>("installed_apps", { names }),
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
  sshHosts: () => invoke<SshHost[]>("ssh_hosts"),
  /** Argv and environment of an interactive ssh to `remote` that shares its connection with the file panel. */
  sshCommand: (remote: Remote) => invoke<{ argv: string[]; env: Record<string, string> }>("ssh_command", { remote }),
  /** An empty `path` lists the login directory. */
  sftpList: (remote: Remote, path: string) => invoke<RemoteListing>("sftp_list", { remote, path }),
  sftpDownload: (remote: Remote, path: string, local: string) => invoke<void>("sftp_download", { remote, path, local }),
  sftpUpload: (remote: Remote, dir: string, locals: string[]) => invoke<void>("sftp_upload", { remote, dir, locals }),
  sftpMkdir: (remote: Remote, path: string) => invoke<void>("sftp_mkdir", { remote, path }),
  /** A directory goes with everything in it. */
  sftpRemove: (remote: Remote, path: string, dir: boolean) => invoke<void>("sftp_remove", { remote, path, dir }),
  sftpRename: (remote: Remote, from: string, to: string) => invoke<void>("sftp_rename", { remote, from, to }),
  /** Saves a password in the macOS Keychain under `account`, for `Remote.secret`. */
  sftpSavePassword: (account: string, password: string) => invoke<void>("sftp_save_password", { account, password }),
  sftpForgetPassword: (account: string) => invoke<void>("sftp_forget_password", { account }),
  /** Downloads a remote file to a private temporary copy and opens it in its app; returns the copy's path. */
  sftpEdit: (remote: Remote, path: string) => invoke<string>("sftp_edit", { remote, path }),
  editReopen: (local: string) => invoke<void>("edit_reopen", { local }),
  /** Unix milliseconds; `null` once the copy is gone. */
  editMtime: (local: string) => invoke<number | null>("edit_mtime", { local }),
  localList: (path: string) => invoke<LocalEntry[]>("local_list", { path }),
};
