import { ask, message, open as pick } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { api, type Remote, type SftpConfig, type SshHost } from "./api";
import { icon } from "./icons";
import { escapeHtml } from "./html";
import { shellQuote, type ProjectRec } from "./session";

const child = (dir: string, name: string) => (dir === "/" ? `/${name}` : `${dir}/${name}`);
const parent = (dir: string) => dir.replace(/\/[^/]*$/, "") || "/";
const baseName = (path: string) => path.split("/").filter(Boolean).pop() ?? path;

function size(bytes: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes, u = 0;
  while (n >= 1024 && u < units.length - 1) (n /= 1024, u++);
  return `${u === 0 ? n : n.toFixed(n < 10 ? 1 : 0)} ${units[u]}`;
}

/** A local modification time the way `ls -l` shows remote ones: time within the last half year, else the year. */
function lsDate(ms: number) {
  const d = new Date(ms);
  const day = `${d.toLocaleString("en-US", { month: "short" })} ${String(d.getDate()).padStart(2, "0")}`;
  const recent = Date.now() - ms < 182 * 86_400_000;
  return `${day} ${recent ? `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` : d.getFullYear()}`;
}

/** A name for a new folder or a rename: one path segment. */
function validName(name: string) {
  return name && name !== "." && name !== ".." && !name.includes("/") && !/[\r\n]/.test(name);
}

/** Who and where, as shown in the panel title. */
export function remoteLabel(r: Remote) {
  return `${r.user ? `${r.user}@` : ""}${r.host}${r.port && r.port !== 22 ? `:${r.port}` : ""}`;
}

interface Entry {
  name: string;
  kind: "d" | "l" | "f";
  size: number;
  modified: string;
}

type Side = "local" | "remote";

/** One side of the panel: a folder listing with a cursor and a selection. */
class Pane {
  path = "";
  entries: Entry[] = [];
  cursor = 0;
  /** Anchor of a shift-click range. */
  anchor = 0;
  selected = new Set<string>();
  error = "";
  loading = false;
  /** Counts listings so a slow, superseded one is dropped. */
  loads = 0;
  constructor(readonly side: Side) {}

  /** The selection, or the entry under the cursor when nothing is selected. */
  picked(): Entry[] {
    const chosen = this.entries.filter((e) => this.selected.has(e.name));
    return chosen.length ? chosen : this.entries[this.cursor] ? [this.entries[this.cursor]] : [];
  }
}

interface Transfer {
  id: number;
  remote: Remote;
  /** Runs after a successful transfer. */
  done?: () => void;
  direction: "up" | "down";
  /** Absolute source paths. */
  sources: string[];
  /** Absolute destination folder. */
  target: string;
  state: "queued" | "running" | "done" | "failed";
  error?: string;
}

/** A remote file open in a local app, watched so saved changes can go back to the server. */
interface Edit {
  remote: Remote;
  /** Absolute remote path. */
  path: string;
  /** The temporary local copy. */
  local: string;
  /** Local modification time already handled. */
  mtime: number;
  /** The server's size and date as of the last download or upload, to notice someone else's changes. */
  seen?: { size: number; modified: string };
  /** An upload prompt is showing. */
  asking?: boolean;
}

/** How often edited copies are checked for saved changes, in milliseconds. */
const EDIT_POLL = 1500;

interface FilesContext {
  closed(): void;
  /** Stores (or with `undefined` removes) a project's connection. */
  saveConnection(project: ProjectRec, config: SftpConfig | undefined): void;
  /** Opens an SSH terminal on the connection. */
  terminal(project: ProjectRec, remote: Remote): void;
}

/**
 * Two-pane SFTP client for a project: its folder on the left, the server on the right, a transfer queue below.
 * Connection details are saved per project; a password goes to the Keychain.
 */
export class FilesPanel {
  readonly el: HTMLElement;
  private project?: ProjectRec;
  private remote?: SftpConfig;
  /** Whether this connection is the project's own, so the settings form edits it. */
  private own = false;
  private panes = { local: new Pane("local"), remote: new Pane("remote") };
  private active: Side = "remote";
  /** Remote change running right now (rename, delete, new folder); such actions wait for each other. */
  private busy = "";
  private notice = "";
  private queue: Transfer[] = [];
  private transferIds = 0;
  private transferring = false;
  private edits: Edit[] = [];
  private watching?: number;
  /** Last folders per project and side, so reopening the panel returns there. */
  private lastPath = new Map<string, string>();
  /** Inline name form: a new folder, or renaming an entry. */
  private naming?: { kind: "mkdir" } | { kind: "rename"; entry: Entry };
  private hosts: SshHost[] = [];
  private titleEl: HTMLElement;
  private settingsEl: HTMLFormElement;
  private nameForm: HTMLFormElement;
  private nameEl: HTMLInputElement;
  private queueEl: HTMLElement;
  private statusEl: HTMLElement;

  constructor(private ctx: FilesContext) {
    this.el = document.createElement("div");
    this.el.className = "palette-backdrop files-backdrop hidden";
    const pane = (side: Side) => `<section class="fpane" data-side="${side}">
      <div class="fpane-head">
        <span class="fpane-label">${side === "local" ? "Local" : "Remote"}</span>
        <nav class="files-crumbs" aria-label="${side} path"></nav>
        <button data-files="up" title="Parent folder (⌫)">${icon("up")}</button>
        <button data-files="refresh" title="Refresh">${icon("refresh")}</button>
        ${side === "remote" ? `<button data-files="mkdir" title="New folder">${icon("project")}</button>` : `<button data-files="finder" title="Reveal in Finder">${icon("find")}</button>`}
        <button class="fpane-go" data-files="transfer" title="${side === "local" ? "Upload selection to the remote folder (⏎ on a file)" : "Download selection to the local folder (⏎ on a file)"}">${side === "local" ? `${icon("upload")}<span>Upload</span>` : `${icon("download")}<span>Download</span>`}</button>
      </div>
      <div class="files-list" role="listbox" aria-multiselectable="true" tabindex="-1"></div>
    </section>`;
    this.el.innerHTML = `<div class="palette files" role="dialog" aria-label="SFTP">
      <div class="files-head">
        ${icon("server")}<span class="files-host"></span>
        <span class="files-spacer"></span>
        <button data-files="terminal" title="Open an SSH terminal on this connection">${icon("shell")}<span>Terminal</span></button>
        <button data-files="settings" title="Connection settings">${icon("edit")}<span>Connection</span></button>
        <button data-files="close" title="Close (esc)">${icon("close")}</button>
      </div>
      <form class="files-settings hidden" autocomplete="off">
        <div class="fs-grid">
          <label class="fs-host">Host<input name="host" list="files-hosts" required spellcheck="false" placeholder="example.com or a ~/.ssh/config host" /></label>
          <label class="fs-port">Port<input name="port" inputmode="numeric" spellcheck="false" placeholder="22" /></label>
          <label>User<input name="user" spellcheck="false" placeholder="from ~/.ssh/config" /></label>
          <label>Password<input name="password" type="password" /></label>
          <label class="fs-key">Key file<span class="fs-row"><input name="identity" spellcheck="false" placeholder="optional, e.g. ~/.ssh/id_ed25519" /><button type="button" data-files="pick-key">Choose…</button></span></label>
          <label>Remote folder<input name="path" spellcheck="false" placeholder="login directory" /></label>
        </div>
        <label class="fs-forget hidden"><input type="checkbox" name="forget" /> Forget the saved password</label>
        <p class="fs-note">The password is stored in your macOS Keychain, never in Houston's files. Agent keys and ~/.ssh/config apply as in your terminal.</p>
        <div class="pal-actions"><span class="pal-error"></span><button type="button" data-files="remove-connection">Remove</button><button type="button" data-files="cancel-settings">Cancel</button><button type="submit" class="pal-save">Save &amp; connect</button></div>
        <datalist id="files-hosts"></datalist>
      </form>
      <form class="files-form hidden"><label><span></span><input spellcheck="false" autocomplete="off" /></label><button type="button" data-files="cancel">Cancel</button><button type="submit" class="pal-save">Save</button></form>
      <div class="files-panes">${pane("local")}${pane("remote")}</div>
      <div class="files-queue hidden" aria-label="Transfers"></div>
      <div class="pal-foot"><span class="files-status" role="status"></span><span><kbd>⇥</kbd> switch side</span><span><kbd>⏎</kbd> open / transfer</span><span><kbd>⌘E</kbd> view / edit</span><span><kbd>⌫</kbd> up</span><span><kbd>⌘⌫</kbd> delete</span><span><kbd>esc</kbd> close</span></div>
    </div>`;
    this.titleEl = this.el.querySelector(".files-host")!;
    this.settingsEl = this.el.querySelector(".files-settings")!;
    this.nameForm = this.el.querySelector(".files-form")!;
    this.nameEl = this.nameForm.querySelector("input")!;
    this.queueEl = this.el.querySelector(".files-queue")!;
    this.statusEl = this.el.querySelector(".files-status")!;

    this.el.addEventListener("mousedown", (e) => e.target === this.el && this.close());
    this.el.addEventListener("keydown", (e) => this.onKey(e));
    // A click on a bare part of the panel, or a closed dialog, leaves focus on the page body; keys
    // (esc above all) still belong to the panel then, not to the terminal underneath.
    window.addEventListener(
      "keydown",
      (e) => {
        if (this.isOpen && !this.el.contains(e.target as Node)) this.onKey(e);
      },
      true,
    );
    this.nameForm.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.submitName();
    });
    this.settingsEl.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.saveSettings();
    });
    this.el.addEventListener("click", (e) => this.onClick(e));
    // Files dropped from Finder upload into the remote folder.
    void getCurrentWebview().onDragDropEvent((event) => {
      if (!this.isOpen || !this.remote) return;
      const target = this.el.querySelector(".fpane[data-side=remote]")!;
      if (event.payload.type === "over" || event.payload.type === "enter") target.classList.add("drop");
      else target.classList.remove("drop");
      if (event.payload.type === "drop" && event.payload.paths.length && this.panes.remote.path) void this.enqueue("up", event.payload.paths);
    });
  }

  get isOpen() {
    return !this.el.classList.contains("hidden");
  }

  /** Opens the project's own connection, or its settings when it has none yet. */
  open(project: ProjectRec) {
    this.show(project, project.sftp, true);
  }

  /** Opens a connection that is not the project's own, e.g. an SSH session's host. */
  openRemote(project: ProjectRec, remote: Remote) {
    this.show(project, remote, false);
  }

  private show(project: ProjectRec, remote: SftpConfig | undefined, own: boolean) {
    const switched = project !== this.project || remote?.host !== this.remote?.host || own !== this.own;
    this.project = project;
    this.remote = remote;
    this.own = own;
    this.el.classList.remove("hidden");
    this.stopNaming();
    if (switched) {
      this.panes = { local: new Pane("local"), remote: new Pane("remote") };
      this.notice = "";
    }
    this.active = "remote";
    this.renderTitle();
    void this.load("local", this.lastPath.get(`${project.id}:local`) ?? project.path);
    if (remote) {
      this.hideSettings();
      void this.load("remote", this.lastPath.get(this.remoteKey()) ?? remote.path ?? "");
    } else {
      this.showSettings();
    }
    this.render();
  }

  close() {
    this.el.classList.add("hidden");
    this.ctx.closed();
  }

  private remoteKey() {
    return `${this.project!.id}:${this.remote ? remoteLabel(this.remote) : ""}`;
  }

  private renderTitle() {
    this.titleEl.innerHTML = `${escapeHtml(this.project?.name ?? "")}<span>${this.remote ? escapeHtml(remoteLabel(this.remote)) : "new SFTP connection"}</span>`;
    this.el.querySelector<HTMLElement>("[data-files=terminal]")!.hidden = !this.remote;
    this.el.querySelector<HTMLElement>("[data-files=settings]")!.hidden = !this.own;
  }

  // ── connection settings ─────────────────────────────────────────────

  private showSettings() {
    const f = this.settingsEl.elements as unknown as Record<string, HTMLInputElement>;
    const r = this.own ? this.remote : undefined;
    f.host.value = r?.host ?? "";
    f.port.value = r?.port ? String(r.port) : "";
    f.user.value = r?.user ?? "";
    f.password.value = "";
    f.password.placeholder = r?.secret ? "saved in Keychain — leave empty to keep" : "optional with a key or agent";
    f.identity.value = r?.identity ?? "";
    f.path.value = r?.path ?? "";
    f.forget.checked = false;
    this.settingsEl.querySelector(".fs-forget")!.classList.toggle("hidden", !r?.secret);
    this.settingsEl.querySelector<HTMLElement>("[data-files=remove-connection]")!.hidden = !r;
    this.settingsEl.querySelector<HTMLElement>("[data-files=cancel-settings]")!.hidden = !r;
    this.settingsEl.querySelector(".pal-error")!.textContent = "";
    this.settingsEl.classList.remove("hidden");
    this.el.querySelector(".files")!.classList.add("configuring");
    f.host.focus();
    void api.sshHosts().then((hosts) => {
      this.hosts = hosts;
      this.settingsEl.querySelector("datalist")!.innerHTML = this.hosts.map((h) => `<option value="${escapeHtml(h.name)}">${escapeHtml(`${h.user ? `${h.user}@` : ""}${h.hostname ?? h.name}`)}</option>`).join("");
    }, () => {});
  }

  private hideSettings() {
    this.settingsEl.classList.add("hidden");
    this.el.querySelector(".files")!.classList.remove("configuring");
  }

  private async saveSettings() {
    const project = this.project!;
    const f = this.settingsEl.elements as unknown as Record<string, HTMLInputElement>;
    const fail = (text: string) => void (this.settingsEl.querySelector(".pal-error")!.textContent = text);
    const host = f.host.value.trim();
    const port = f.port.value.trim();
    const path = f.path.value.trim().replace(/(.)\/+$/, "$1");
    if (!host || /\s/.test(host) || host.startsWith("-")) return fail("Enter a host name without spaces.");
    if (port && !(/^\d+$/.test(port) && +port > 0 && +port < 65536)) return fail("The port is a number from 1 to 65535.");
    if (/\s/.test(f.user.value.trim())) return fail("The user name has no spaces.");
    if (path && !path.startsWith("/")) return fail("The remote folder is an absolute path, like /var/www.");
    const old = this.remote;
    const config: SftpConfig = { host };
    if (port) config.port = +port;
    if (f.user.value.trim()) config.user = f.user.value.trim();
    if (f.identity.value.trim()) config.identity = f.identity.value.trim();
    if (path) config.path = path;
    try {
      if (f.password.value) {
        await api.sftpSavePassword(project.id, f.password.value);
        config.secret = project.id;
      } else if (old?.secret && f.forget.checked) {
        await api.sftpForgetPassword(old.secret);
      } else if (old?.secret) {
        config.secret = old.secret;
      }
    } catch (e) {
      return fail(String(e));
    }
    f.password.value = "";
    this.ctx.saveConnection(project, config);
    this.lastPath.delete(this.remoteKey());
    this.remote = config;
    this.panes.remote = new Pane("remote");
    this.hideSettings();
    this.renderTitle();
    this.active = "remote";
    await this.load("remote", config.path ?? "");
  }

  private async removeConnection() {
    const project = this.project!;
    if (!(await ask(`Remove the SFTP connection of ${project.name}?${this.remote?.secret ? "\n\nIts saved password is removed from the Keychain too." : ""}`, { title: "Houston", kind: "warning", okLabel: "Remove" }))) return;
    if (this.remote?.secret) await api.sftpForgetPassword(this.remote.secret).catch(() => {});
    this.ctx.saveConnection(project, undefined);
    this.remote = undefined;
    this.close();
  }

  // ── listing ─────────────────────────────────────────────────────────

  /** Lists `path` on one side (empty remote path: the login directory). */
  private async load(side: Side, path: string) {
    const pane = this.panes[side];
    const load = ++pane.loads;
    pane.loading = true;
    pane.error = "";
    this.render();
    try {
      let listed: { path: string; entries: Entry[] };
      if (side === "local") {
        const entries = await api.localList(path);
        listed = { path, entries: entries.map((e) => ({ name: e.name, kind: e.kind, size: e.size, modified: e.mtime ? lsDate(e.mtime) : "" })) };
      } else {
        if (!this.remote) return;
        listed = await api.sftpList(this.remote, path);
      }
      if (load !== pane.loads || this.panes[side] !== pane) return;
      const from = pane.path;
      const same = listed.path === from;
      pane.path = listed.path;
      this.lastPath.set(side === "local" ? `${this.project!.id}:local` : this.remoteKey(), listed.path);
      // Folders first, then by name, dotfiles with the rest.
      pane.entries = listed.entries.sort((a, b) => Number(b.kind === "d") - Number(a.kind === "d") || a.name.localeCompare(b.name));
      if (same) {
        // A refresh keeps the cursor and the selection where they still apply.
        const names = new Set(pane.entries.map((e) => e.name));
        pane.selected = new Set([...pane.selected].filter((n) => names.has(n)));
      } else {
        // Going up puts the cursor on the folder we came from.
        const cameFrom = pane.entries.findIndex((e) => child(pane.path, e.name) === from);
        pane.cursor = pane.anchor = cameFrom >= 0 ? cameFrom : 0;
        pane.selected.clear();
      }
    } catch (e) {
      if (load !== pane.loads || this.panes[side] !== pane) return;
      pane.error = String(e);
    }
    pane.loading = false;
    this.render();
  }

  private async activate(side: Side, entry: Entry | undefined) {
    if (!entry) return;
    const pane = this.panes[side];
    // A symlink may point at a folder or a file; on the remote side it is tried as a folder first.
    if (entry.kind === "d" || (entry.kind === "l" && side === "remote")) return this.load(side, child(pane.path, entry.name));
    await this.transfer(side, [entry]);
  }

  // ── transfers ───────────────────────────────────────────────────────

  /** Copies entries from `side` into the other side's current folder. */
  private async transfer(side: Side, entries = this.panes[side].picked()) {
    if (!entries.length || !this.remote) return;
    const from = this.panes[side];
    await this.enqueue(side === "local" ? "up" : "down", entries.map((e) => child(from.path, e.name)));
  }

  private async enqueue(direction: Transfer["direction"], sources: string[]) {
    const to = this.panes[direction === "up" ? "remote" : "local"];
    if (!to.path) return;
    // sftp overwrites silently; ask before replacing anything that is already there.
    const names = new Set(to.entries.map((e) => e.name));
    const clashes = sources.map(baseName).filter((n) => names.has(n));
    const where = direction === "up" ? `${to.path} on ${this.remote!.host}` : to.path;
    if (clashes.length && !(await ask(`Replace ${clashes.length === 1 ? clashes[0] : `${clashes.length} items`} in ${where}?\n\n${clashes.slice(0, 8).join("\n")}${clashes.length > 8 ? "\n…" : ""}`, { title: "Houston", kind: "warning", okLabel: "Replace" }))) {
      return this.focusList();
    }
    this.push({ remote: this.remote!, direction, sources, target: to.path });
    this.focusList();
  }

  private push(job: Omit<Transfer, "id" | "state">) {
    this.queue.push({ ...job, id: ++this.transferIds, state: "queued" });
    this.render();
    void this.runQueue();
  }

  /** Works through the queue one transfer at a time, refreshing whichever side received files. */
  private async runQueue() {
    if (this.transferring) return;
    this.transferring = true;
    for (let job = this.queue.find((t) => t.state === "queued"); job; job = this.queue.find((t) => t.state === "queued")) {
      job.state = "running";
      const remote = job.remote;
      this.render();
      try {
        if (job.direction === "up") await api.sftpUpload(remote, job.target, job.sources);
        else for (const source of job.sources) await api.sftpDownload(remote, source, child(job.target, baseName(source)));
        job.state = "done";
        job.done?.();
      } catch (e) {
        job.state = "failed";
        job.error = String(e);
      }
      const side: Side = job.direction === "up" ? "remote" : "local";
      const shown = side === "local" || (this.remote && remoteLabel(this.remote) === remoteLabel(remote));
      if (shown && this.panes[side].path === job.target) await this.load(side, job.target);
      this.render();
    }
    this.transferring = false;
  }

  // ── view & edit ─────────────────────────────────────────────────────

  /** FileZilla's View/Edit: opens a remote file in its local app and offers to upload each saved change. */
  private async edit(entry: Entry | undefined) {
    const remote = this.remote;
    if (!remote || !entry || entry.kind === "d") return;
    const path = child(this.panes.remote.path, entry.name);
    const open = this.edits.find((e) => e.path === path && remoteLabel(e.remote) === remoteLabel(remote));
    if (open) return void api.editReopen(open.local).catch((e) => this.say(String(e)));
    this.say(`Opening ${entry.name}…`, false);
    try {
      const local = await api.sftpEdit(remote, path);
      const mtime = (await api.editMtime(local)) ?? Date.now();
      this.edits.push({ remote, path, local, mtime, seen: { size: entry.size, modified: entry.modified } });
      this.say(`Editing ${entry.name}: each save is offered for upload`, false);
      this.watching ??= window.setInterval(() => void this.checkEdits(), EDIT_POLL);
    } catch (e) {
      this.say(String(e));
    }
  }

  private say(text: string, error = true) {
    this.notice = text;
    this.render();
    this.statusEl.classList.toggle("err", error);
  }

  private async checkEdits() {
    for (const edit of [...this.edits]) {
      if (edit.asking) continue;
      const mtime = await api.editMtime(edit.local).catch(() => null);
      if (mtime === null) {
        this.edits = this.edits.filter((e) => e !== edit);
        this.render();
      } else if (mtime > edit.mtime) {
        edit.mtime = mtime;
        edit.asking = true;
        await this.offerUpload(edit).finally(() => (edit.asking = false));
      }
    }
    if (!this.edits.length && this.watching !== undefined) {
      clearInterval(this.watching);
      this.watching = undefined;
    }
  }

  /** The server's current size and date of an edited file, if it can be listed. */
  private async remoteState(edit: Edit) {
    const listing = await api.sftpList(edit.remote, parent(edit.path)).catch(() => undefined);
    const entry = listing?.entries.find((e) => e.name === baseName(edit.path));
    return entry && { size: entry.size, modified: entry.modified };
  }

  private async offerUpload(edit: Edit) {
    const name = baseName(edit.path);
    const now = await this.remoteState(edit);
    const theirs = edit.seen && now && (now.size !== edit.seen.size || now.modified !== edit.seen.modified);
    const warning = theirs ? "\n\nThe file on the server has changed since you opened it. Uploading replaces those changes." : !now ? "\n\nThe file is not on the server any more (or could not be checked); uploading creates it again." : "";
    const upload = await ask(`${name} was saved. Upload it to ${edit.remote.host}:${edit.path}?${warning}`, {
      title: "Houston",
      kind: theirs ? "warning" : "info",
      okLabel: "Upload",
      cancelLabel: "Not now",
    });
    if (!upload) return;
    this.push({
      remote: edit.remote,
      direction: "up",
      sources: [edit.local],
      target: parent(edit.path),
      done: () => void this.remoteState(edit).then((state) => (edit.seen = state)),
    });
  }

  // ── remote changes ──────────────────────────────────────────────────

  /** Runs one change on the server, then lists the remote folder again. */
  private async change(label: string, run: () => Promise<void>) {
    if (this.busy) return;
    this.busy = label;
    this.notice = "";
    this.render();
    let error = "";
    try {
      await run();
    } catch (e) {
      error = String(e);
    }
    this.busy = "";
    await this.load("remote", this.panes.remote.path);
    if (error) this.notice = error;
    this.render();
  }

  private async remove(entries: Entry[]) {
    const remote = this.remote;
    const pane = this.panes.remote;
    if (this.busy || !remote || !entries.length) return;
    const folders = entries.filter((e) => e.kind === "d").length;
    const what = entries.length === 1 ? child(pane.path, entries[0].name) : `${entries.length} items in ${pane.path}`;
    const note = folders ? `\n\n${folders === 1 && entries.length === 1 ? "The folder is" : "Folders are"} deleted with everything in ${folders === 1 && entries.length === 1 ? "it" : "them"}. This cannot be undone.` : "\n\nThis cannot be undone.";
    if (!(await ask(`Delete ${what} on ${remote.host}?${note}`, { title: "Houston", kind: "warning", okLabel: "Delete" }))) return this.focusList();
    await this.change(`Deleting ${entries.length === 1 ? entries[0].name : `${entries.length} items`}…`, async () => {
      for (const e of entries) await api.sftpRemove(remote, child(pane.path, e.name), e.kind === "d");
    });
  }

  private startNaming(naming: NonNullable<FilesPanel["naming"]>) {
    if (this.busy || !this.remote) return;
    this.naming = naming;
    this.nameForm.classList.remove("hidden");
    this.nameForm.querySelector("label span")!.textContent = naming.kind === "mkdir" ? "New folder" : `Rename ${naming.entry.name}`;
    this.nameEl.value = naming.kind === "rename" ? naming.entry.name : "";
    this.nameEl.focus();
    this.nameEl.select();
  }

  private stopNaming() {
    this.naming = undefined;
    this.nameForm.classList.add("hidden");
    this.focusList();
  }

  private async submitName() {
    const naming = this.naming;
    const remote = this.remote;
    const pane = this.panes.remote;
    const name = this.nameEl.value.trim();
    if (!naming || !remote) return;
    if (!validName(name)) return void message("Use a name without slashes.", { title: "Houston", kind: "error" });
    if (naming.kind === "rename" && name === naming.entry.name) return this.stopNaming();
    if (pane.entries.some((e) => e.name === name)) return void message(`${name} already exists here.`, { title: "Houston", kind: "error" });
    this.stopNaming();
    const target = child(pane.path, name);
    if (naming.kind === "mkdir") await this.change(`Creating ${name}…`, () => api.sftpMkdir(remote, target));
    else await this.change(`Renaming ${naming.entry.name}…`, () => api.sftpRename(remote, child(pane.path, naming.entry.name), target));
    const i = pane.entries.findIndex((e) => e.name === name);
    if (i >= 0) {
      pane.cursor = pane.anchor = i;
      pane.selected = new Set([name]);
      this.render();
    }
  }

  // ── input ───────────────────────────────────────────────────────────

  private onClick(e: MouseEvent) {
    const t = e.target as HTMLElement;
    const action = t.closest<HTMLElement>("[data-files]")?.dataset.files;
    const sideEl = t.closest<HTMLElement>("[data-side]");
    const side = sideEl?.dataset.side as Side | undefined;
    if (side && side !== this.active) {
      this.active = side;
      this.render();
    }
    const crumb = t.closest<HTMLElement>("[data-crumb]");
    if (crumb && side) return void this.load(side, crumb.dataset.crumb!);
    const row = t.closest<HTMLElement>("[data-i]");
    const pane = side ? this.panes[side] : undefined;
    const entry = row && pane ? pane.entries[Number(row.dataset.i)] : undefined;
    if (action === "close") this.close();
    else if (action === "settings") this.settingsEl.classList.contains("hidden") ? this.showSettings() : this.hideSettings();
    else if (action === "cancel-settings") (this.hideSettings(), this.focusList());
    else if (action === "remove-connection") void this.removeConnection();
    else if (action === "pick-key") void this.pickKey();
    else if (action === "terminal" && this.remote) (this.close(), this.ctx.terminal(this.project!, this.remote));
    else if (action === "cancel") this.stopNaming();
    else if (action === "clear-queue") (this.queue = this.queue.filter((q) => q.state === "queued" || q.state === "running"), this.render());
    else if (side && pane && action === "up") void this.load(side, parent(pane.path));
    else if (side && pane && action === "refresh") void this.load(side, pane.path);
    else if (action === "mkdir") this.startNaming({ kind: "mkdir" });
    else if (side && action === "transfer") void this.transfer(side);
    else if (pane && action === "finder") void api.launchDetached(pane.path, entry ? `open -R ${shellQuote(child(pane.path, entry.name))}` : "open .");
    else if (entry && action === "edit") void this.edit(entry);
    else if (action === "reopen") {
      const edit = this.edits[Number(t.closest<HTMLElement>("[data-edit]")!.dataset.edit)];
      if (edit) void api.editReopen(edit.local).catch((err) => this.say(String(err)));
    } else if (entry && action === "rename") this.startNaming({ kind: "rename", entry });
    else if (entry && action === "delete") void this.remove(pane!.selected.has(entry.name) ? pane!.picked() : [entry]);
    else if (side && entry && action === "row-transfer") void this.transfer(side, pane!.selected.has(entry.name) ? pane!.picked() : [entry]);
    else if (side && pane && row && entry && !action) {
      // The first click re-renders the list, so a double-click is read from the click count.
      if (e.detail >= 2 && !e.metaKey && !e.shiftKey) return void this.activate(side, entry);
      this.select(pane, Number(row.dataset.i), e.metaKey ? "toggle" : e.shiftKey ? "range" : "only");
    }
  }

  private select(pane: Pane, i: number, how: "only" | "toggle" | "range") {
    const name = pane.entries[i]?.name;
    if (name === undefined) return;
    if (how === "toggle") {
      if (!pane.selected.delete(name)) pane.selected.add(name);
      pane.anchor = i;
    } else if (how === "range") {
      const [a, b] = [Math.min(pane.anchor, i), Math.max(pane.anchor, i)];
      pane.selected = new Set(pane.entries.slice(a, b + 1).map((e) => e.name));
    } else {
      pane.selected = new Set([name]);
      pane.anchor = i;
    }
    pane.cursor = i;
    this.render();
  }

  private async pickKey() {
    const picked = await pick({ title: "Private key file", defaultPath: `${this.project?.path ?? ""}`, multiple: false, directory: false });
    if (typeof picked === "string") (this.settingsEl.elements.namedItem("identity") as HTMLInputElement).value = picked;
  }

  private onKey(e: KeyboardEvent) {
    // Keys stay inside the panel so app shortcuts and terminals don't react underneath.
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      if (this.naming) this.stopNaming();
      else if (!this.settingsEl.classList.contains("hidden") && this.remote) (this.hideSettings(), this.focusList());
      else this.close();
      return;
    }
    if (this.naming || (e.target as HTMLElement).closest("form")) return;
    const pane = this.panes[this.active];
    const current = pane.entries[pane.cursor];
    const move = (d: number) => {
      e.preventDefault();
      if (!pane.entries.length) return;
      const i = Math.max(0, Math.min(pane.entries.length - 1, pane.cursor + d));
      this.select(pane, i, e.shiftKey ? "range" : "only");
    };
    if (e.key === "ArrowDown") move(1);
    else if (e.key === "ArrowUp") move(-1);
    else if (e.key === "Tab") {
      e.preventDefault();
      this.active = this.active === "local" ? "remote" : "local";
      this.render();
    } else if (e.key === "e" && e.metaKey && this.active === "remote") {
      e.preventDefault();
      void this.edit(current);
    } else if (e.key === "a" && e.metaKey) {
      e.preventDefault();
      pane.selected = new Set(pane.entries.map((x) => x.name));
      this.render();
    } else if (e.key === "Enter" && current) {
      e.preventDefault();
      // Enter on a folder opens it; with several items selected it transfers them all.
      if (pane.selected.size > 1) void this.transfer(this.active);
      else void this.activate(this.active, current);
    } else if (e.key === "Backspace" && e.metaKey && this.active === "remote") {
      e.preventDefault();
      void this.remove(pane.picked());
    } else if (e.key === "Backspace") {
      e.preventDefault();
      void this.load(this.active, parent(pane.path));
    }
  }

  private focusList() {
    if (this.isOpen && !this.naming && this.settingsEl.classList.contains("hidden")) this.el.querySelector<HTMLElement>(`.fpane[data-side=${this.active}] .files-list`)?.focus();
  }

  // ── rendering ───────────────────────────────────────────────────────

  private renderPane(pane: Pane) {
    const root = this.el.querySelector<HTMLElement>(`.fpane[data-side=${pane.side}]`)!;
    root.classList.toggle("active", pane.side === this.active);
    root.classList.toggle("loading", pane.loading);
    const crumbsEl = root.querySelector<HTMLElement>(".files-crumbs")!;
    let crumbs = `<button data-crumb="/">/</button>`;
    let at = "";
    for (const part of pane.path.split("/").filter(Boolean)) {
      at += `/${part}`;
      crumbs += `<button data-crumb="${escapeHtml(at)}">${escapeHtml(part)}</button><span>/</span>`;
    }
    crumbsEl.innerHTML = pane.path ? crumbs : "";
    crumbsEl.scrollLeft = crumbsEl.scrollWidth;
    root.querySelector<HTMLButtonElement>("[data-files=transfer]")!.disabled = !this.remote || !pane.entries.length;
    pane.cursor = Math.min(pane.cursor, Math.max(0, pane.entries.length - 1));
    const glyph = { d: icon("project"), l: icon("alias"), f: icon("changes") };
    const remote = pane.side === "remote";
    const rowActions = remote
      ? `<button data-files="row-transfer" title="Download">${icon("download")}</button><button data-files="edit" title="View / edit (⌘E)">${icon("edit")}</button><button data-files="rename" title="Rename">${icon("rename")}</button><button data-files="delete" title="Delete (⌘⌫)">${icon("close")}</button>`
      : `<button data-files="row-transfer" title="Upload">${icon("upload")}</button><button data-files="finder" title="Reveal in Finder">${icon("find")}</button><span></span><span></span>`;
    const listEl = root.querySelector<HTMLElement>(".files-list")!;
    listEl.innerHTML =
      remote && !this.remote
        ? `<div class="pal-empty">Set up the connection above.</div>`
        : pane.error && !pane.entries.length
          ? `<div class="pal-empty files-error">${escapeHtml(pane.error)}</div>`
          : pane.entries.length
            ? pane.entries
                .map((e, i) => {
                  const sel = pane.selected.has(e.name);
                  const editable = remote && e.kind !== "d";
                  return `<div class="files-row${editable ? "" : " no-edit"}${i === pane.cursor ? " cur" : ""}${sel ? " sel" : ""}" data-i="${i}" data-kind="${e.kind}" role="option" aria-selected="${sel}">
                    ${glyph[e.kind]}<span class="files-name" title="${escapeHtml(e.name)}">${escapeHtml(e.name)}${e.kind === "l" ? " ↗" : ""}</span>
                    <span class="files-size">${e.kind === "d" ? "" : size(e.size)}</span><span class="files-date">${escapeHtml(e.modified)}</span>${rowActions}
                  </div>`;
                })
                .join("")
            : `<div class="pal-empty">${pane.loading ? "Loading…" : "Empty folder"}</div>`;
    listEl.querySelector(".cur")?.scrollIntoView({ block: "nearest" });
  }

  private renderQueue() {
    this.queueEl.classList.toggle("hidden", !this.queue.length && !this.edits.length);
    const finished = this.queue.some((q) => q.state === "done" || q.state === "failed");
    const label = { queued: "waiting", running: "copying…", done: "done", failed: "failed" };
    const editing = this.edits
      .map((e, i) => `<div class="fq-row fq-edit" data-edit="${i}" data-files="reopen" title="Open ${escapeHtml(e.path)} again">
          ${icon("edit")}<span class="fq-what">${escapeHtml(baseName(e.path))}</span><span class="fq-to">${escapeHtml(e.remote.host)}:${escapeHtml(e.path)}</span><span class="fq-state">editing · saves upload</span>
        </div>`)
      .join("");
    this.queueEl.innerHTML = `<div class="fq-head"><span>Transfers${this.edits.length ? " & open files" : ""}</span>${finished ? `<button data-files="clear-queue">Clear finished</button>` : ""}</div>${editing}${this.queue
      .slice()
      .reverse()
      .map((q) => {
        const what = q.sources.length === 1 ? baseName(q.sources[0]) : `${q.sources.length} items`;
        return `<div class="fq-row" data-state="${q.state}" title="${escapeHtml(q.error ?? q.sources.join("\n"))}">
          ${icon(q.direction === "up" ? "upload" : "download")}<span class="fq-what">${escapeHtml(what)}</span><span class="fq-to">→ ${escapeHtml(q.target)}</span><span class="fq-state">${q.state === "failed" ? escapeHtml(q.error!.split("\n")[0]) : label[q.state]}</span>
        </div>`;
      })
      .join("")}`;
  }

  private render() {
    this.renderPane(this.panes.local);
    this.renderPane(this.panes.remote);
    this.renderQueue();
    const running = this.queue.filter((q) => q.state === "running" || q.state === "queued").length;
    const sel = this.panes[this.active].selected.size;
    this.statusEl.textContent = this.busy || this.notice || (running ? `${running} transfer${running === 1 ? "" : "s"} in progress` : sel > 1 ? `${sel} selected` : "");
    this.statusEl.classList.toggle("err", !this.busy && !!this.notice);
    this.el.querySelector(".files")!.classList.toggle("busy", !!this.busy);
    // Keyboard focus follows the active side, unless a form or button has it.
    if (!this.el.contains(document.activeElement) || document.activeElement?.classList.contains("files-list")) this.focusList();
  }
}
