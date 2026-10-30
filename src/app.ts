import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, message, open } from "@tauri-apps/plugin-dialog";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { AliasPalette } from "./aliases";
import { api, type FileEdit, type GitStatus, type LimitWindow, type RateLimits, type ShellInfo } from "./api";
import { Completer } from "./completion";
import { DiffPanel } from "./diff";
import { InboxPanel, type InboxItem } from "./inbox";
import { fillIcons, icon, light, mark } from "./icons";
import { BriefDialog, CommandPalette, ContextMenu, type Command, type MenuItem } from "./palette";
import { TimelinePanel } from "./timeline";
import { STATUS_LABEL, Session, currentProjectColor, nextProjectColor, shellQuote, shortPath, type Kind, type ProjectRec, type SessionRec } from "./session";

/** Split shows two sessions side by side. */
type Layout = "focus" | "grid" | "split";

/** Relative sizes (fr) of a tiled layout's columns and rows. */
interface Tracks {
  cols: number[];
  rows: number[];
}

/** Optional setup for a new session. */
interface Launch {
  name?: string;
  /** Shell command run at the first prompt. */
  command?: string;
  /** Opening prompt for a Claude agent. */
  prompt?: string;
}

interface Persisted {
  version: 1;
  projects: ProjectRec[];
  sessions: SessionRec[];
  selectedId?: string;
  layout: Layout;
  sidebarHidden?: boolean;
  /** Dragged sidebar width in pixels; unset uses the stylesheet default. */
  sidebarWidth?: number;
  /** The two sessions of the split layout. */
  split?: string[];
  /** Project the grid is limited to; unset shows every session. */
  gridProject?: string;
  /** Resized track sizes per layout shape, e.g. "grid:3x2". */
  tracks?: Record<string, Tracks>;
  /** The remote status page was switched on. */
  remote?: boolean;
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function countdown(ms: number) {
  const m = Math.ceil(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d${h % 24}h`;
}

/** Approximate xterm cell size at 13px IBM Plex Mono, used to size grid panes. */
const CELL_W = 7.8;
const CELL_H = 15;

/** Column count that lets every pane show the largest share of an 80×24 terminal. */
function gridColumns(n: number, width: number, height: number) {
  let best = 1;
  let bestScore = -1;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const score = Math.min(width / cols / (80 * CELL_W), height / rows / (24 * CELL_H));
    if (score > bestScore) [best, bestScore] = [cols, score];
  }
  return best;
}

/** How recently two agents must both have changed a file for it to count as an overlap, in milliseconds. */
const OVERLAP_WINDOW = 30 * 60_000;

/** Editor CLIs offered for "Open in …", in order of preference. */
const EDITORS = ["cursor", "code", "zed", "subl"];

/** Smallest width or height a resized grid track can be dragged to, in pixels. */
const MIN_TRACK = 160;

/** Range the sidebar can be dragged across, in pixels. */
const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 600;

/** Uncommitted-change counts for a project badge, e.g. "+2 ~5 ?1"; empty when clean. */
function gitBadge(g?: GitStatus | null) {
  if (!g) return "";
  return [[g.staged, "+"], [g.modified, "~"], [g.untracked, "?"]]
    .filter(([n]) => n)
    .map(([n, mark]) => `${mark}${n}`)
    .join(" ");
}

/** Session name from the first line of an opening prompt. */
function briefName(prompt: string) {
  const line = prompt.split("\n")[0].replace(/\s+/g, " ").trim();
  return line.length > 48 ? line.slice(0, 47) + "…" : line;
}

/** Remaining share of a usage window; a window whose reset time has passed is full again. */
function fuelLeft(w: LimitWindow) {
  return w.resets_at * 1000 > Date.now() ? Math.max(0, Math.round(100 - w.used_percentage)) : 100;
}

const fuelTone = (left: number) => (left <= 10 ? "l-red" : left <= 30 ? "l-amber" : "");

/** One window as a labelled gauge: name and reset countdown above, % left on the right, a thin bar below. */
function renderTank(label: string, w: LimitWindow) {
  const left = fuelLeft(w);
  const msLeft = w.resets_at * 1000 - Date.now();
  return `<div class="tank ${fuelTone(left)}" title="${100 - left}% used">
    <div class="l-row"><span>${label}<span class="l-reset">${msLeft > 0 ? `T−${countdown(msLeft)}` : "full"}</span></span><span class="l-left">${left}% left</span></div>
    <div class="l-bar"><i style="width: ${left}%"></i></div>
  </div>`;
}

function renderLimits(limits: RateLimits | null) {
  const windows = [
    ["5h limit", limits?.five_hour],
    ["Week", limits?.seven_day],
  ].filter((e): e is [string, LimitWindow] => !!e[1]);
  if (!windows.length) return `<div class="l-empty">Claude limits show once a Claude session responds</div>`;
  return windows.map(([label, w]) => renderTank(label, w)).join("");
}

/** Context use of a Claude session as a rounded percent and its warning tier; empty until reported. */
function ctxTier(s: Session) {
  const pct = s.stats?.context_percent;
  return pct == null ? "" : `${Math.round(pct)}${pct >= 85 ? "h" : pct >= 60 ? "m" : "l"}`;
}

/** Thin bar under a sidebar row showing how full the session's context is. */
function ctxBar(s: Session) {
  const pct = s.stats?.context_percent;
  if (pct == null) return "";
  return `<i class="sess-ctx" data-tier="${pct >= 85 ? "high" : pct >= 60 ? "mid" : "low"}" style="width: ${Math.min(100, Math.round(pct))}%" title="Context ${Math.round(pct)}% used"></i>`;
}

const overlapTitle = (s: Session) => `Also changed by another agent:\n${s.overlaps.map((o) => `${o.path.split("/").pop()} ↔ ${o.with}`).join("\n")}`;

/** Faint flight-dynamics backdrop behind the splash: orbit plot plus corner readouts. */
const HUD = (projects: number) => `<div class="hud" aria-hidden="true">
  <svg viewBox="0 0 1000 600" preserveAspectRatio="xMidYMid slice">
    <circle cx="500" cy="300" r="46" class="hud-body" />
    <ellipse cx="500" cy="300" rx="330" ry="120" transform="rotate(-14 500 300)" />
    <ellipse cx="500" cy="300" rx="440" ry="190" transform="rotate(-14 500 300)" class="hud-dash" />
    <path d="M 120 560 Q 360 120 860 170" class="hud-dash" />
    <line x1="500" y1="0" x2="500" y2="600" class="hud-axis" />
    <line x1="0" y1="300" x2="1000" y2="300" class="hud-axis" />
    <circle cx="820" cy="220" r="4" class="hud-mark" />
    <text x="832" y="216">TLI BURN</text>
    <circle cx="178" cy="380" r="3" class="hud-mark" />
    <text x="190" y="392">PERIGEE 405 KM</text>
  </svg>
  <div class="hud-corner tl">TRAJ  LEO-2<br>INC   51.64°<br>APO   412 KM<br>PER   405 KM</div>
  <div class="hud-corner tr">FDO    GO<br>GNC    GO<br>EECOM  GO<br>CAPCOM GO</div>
  <div class="hud-corner bl">LAT  29.5502° N<br>LON  95.0970° W<br>JSC  BLDG 30</div>
  <div class="hud-corner br">PROJECTS ${String(projects).padStart(2, "0")}<br>SESSIONS 00<br>LINK     NOMINAL</div>
</div>`;

/** Shortcut cheat-sheet on the home screen. */
const HOME_KEYS: [string, string][] = [
  ["⇧⌘H", "home"], ["⌘O", "add project"],
  ["⌘N", "new Claude session"], ["⌘T", "open shell"],
  ["⌘G", "grid / focus"], ["⌘1-9", "jump to session"],
  ["⌘W", "terminate session"], ["⌘J", "next waiting"],
  ["⌘B", "toggle sidebar"], ["⌘P", "command palette"],
  ["⌘\\", "split view"], ["⌘F", "find in terminal"],
  ["⌘D", "show changes"], ["⌘I", "approval inbox"],
  ["⌘E", "mission timeline"], ["⇧⌘P", "aliases / servers"],
];

export class App {
  private projects: ProjectRec[] = [];
  private sessions: Session[] = [];
  private selectedId?: string;
  /** Project that "new session" targets when nothing is selected in it. */
  private activeProjectId?: string;
  private layout: Layout = "focus";
  /** The home screen covers the stage; it also shows by itself while there are no sessions. */
  private home = false;
  private homeHtml = "";
  private sidebarHidden = false;
  private sidebarWidth?: number;
  private completer = new Completer();
  private saveTimer?: number;
  private sidebarKey = "";
  private badge = 0;
  private notifyAllowed = false;
  /** Sidebar re-renders are paused while a session name is being edited in place. */
  private renaming = false;
  /** Sidebar re-renders are paused while a session row is dragged to a new position. */
  private reordering = false;
  /** Swallows the click that ends a row drag. */
  private suppressClick = false;
  /** Session selected before the current one; split view pairs them. */
  private prevSelectedId?: string;
  private splitIds: string[] = [];
  private gridProjectId?: string;
  private tracks: Record<string, Tracks> = {};
  /** Shape key and sizes of the tiled layout on screen. */
  private shape = { key: "", tracks: { cols: [1], rows: [1] } as Tracks };
  private projectGit = new Map<string, GitStatus | null>();
  /** Session ids, most recently selected first, for ordering the palette. */
  private recent: string[] = [];
  private limits: RateLimits | null = null;
  /** Address of the remote status page while it is on. */
  private remoteUrl?: string;
  private lastSnapshot = 0;
  /** Overlaps already announced, so each is notified once. */
  private overlapSeen = new Set<string>();
  private aliases = new AliasPalette({
    connect: (alias) => this.newSession("shell", undefined, { name: alias.name, command: alias.name }),
    defined: (name) => this.completer.addCommand(name),
  });
  private palette = new CommandPalette(() => this.selected?.focus());
  private brief = new BriefDialog();
  private diff = new DiffPanel(() => this.selected?.focus());
  private menu = new ContextMenu();
  private timeline = new TimelinePanel(() => this.selected?.focus());
  private inbox = new InboxPanel(
    {
      approve: (id) => this.answer(id, (s) => s.approve()),
      deny: (id) => this.answer(id, (s) => s.deny()),
      reply: (id, text) => this.answer(id, (s) => s.reply(text)),
      open: (id) => this.select(id),
    },
    () => this.selected?.focus(),
  );

  constructor(private shell: ShellInfo) {
    this.completer.load(shell);
    document.body.append(this.aliases.el, this.palette.el, this.brief.el, this.diff.el, this.timeline.el, this.inbox.el, this.menu.el);
  }

  private get overlayOpen() {
    return this.aliases.isOpen || this.palette.isOpen || this.brief.isOpen || this.diff.isOpen || this.timeline.isOpen || this.inbox.isOpen;
  }

  async start() {
    const saved = await api.loadState<Persisted>().catch(() => null);
    if (saved) {
      this.projects = [];
      // Projects saved before colours existed get one in their original order.
      for (const p of saved.projects) this.projects.push({ ...p, color: p.color ? currentProjectColor(p.color) : nextProjectColor(this.projects) });
      this.layout = saved.layout ?? "focus";
      this.sidebarHidden = saved.sidebarHidden ?? false;
      this.sidebarWidth = saved.sidebarWidth;
      this.splitIds = saved.split ?? [];
      this.gridProjectId = saved.gridProject;
      this.tracks = saved.tracks ?? {};
      for (const rec of saved.sessions) {
        const project = this.projects.find((p) => p.id === rec.projectId);
        // Sessions from before auto-naming still carry their placeholder name.
        if (rec.kind === "claude" && rec.autoName === undefined && /^agent-\d+$/.test(rec.name)) rec.autoName = true;
        if (project) this.sessions.push(this.makeSession(rec, project));
      }
      this.orderSessions();
      this.selectedId = this.sessions.find((s) => s.rec.id === saved.selectedId)?.rec.id ?? this.sessions[0]?.rec.id;
    }
    this.bindChrome();
    new ResizeObserver(() => this.layoutGrid()).observe($("#stage"));
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) document.querySelectorAll<SVGSVGElement>("#backdrop svg").forEach((svg) => svg.pauseAnimations());
    this.renderAll();
    setInterval(() => this.tick(), 400);
    this.pollLimits();
    setInterval(() => this.pollLimits(), 15_000);
    this.pollUsage();
    setInterval(() => this.pollUsage(), 5_000);
    this.notifyAllowed = (await isPermissionGranted()) || (await requestPermission()) === "granted";
    if (saved?.remote) void this.startRemote(false);
  }

  // ── state ────────────────────────────────────────────────────────────

  private get selected() {
    return this.sessions.find((s) => s.rec.id === this.selectedId);
  }

  private makeSession(rec: SessionRec, project: ProjectRec) {
    return new Session(rec, project, {
      shell: this.shell,
      completer: this.completer,
      changed: () => this.renderSidebar(),
      persist: () => this.save(),
      isSelected: (s) => s.rec.id === this.selectedId,
      failed: (s, command, code) => {
        if (this.watching(s)) return;
        this.notify(`${s.rec.name} · ${s.project.name}`, `failed (exit ${code}): ${command}`);
      },
      exited: (s, code) => {
        if (code === null || code === 0 || this.watching(s)) return;
        this.notify(`${s.rec.name} · ${s.project.name}`, `exited with code ${code}`);
      },
    });
  }

  /** Keeps sessions grouped in sidebar order (by project, then creation), which ⌘1–9, ⌘[ / ⌘] and the grid follow. */
  private orderSessions() {
    const rank = (s: Session) => this.projects.indexOf(s.project);
    this.sessions.sort((a, b) => rank(a) - rank(b));
  }

  private save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      const state: Persisted = {
        version: 1,
        projects: this.projects,
        sessions: this.sessions.map((s) => s.rec),
        selectedId: this.selectedId,
        layout: this.layout,
        sidebarHidden: this.sidebarHidden,
        sidebarWidth: this.sidebarWidth,
        split: this.splitIds,
        gridProject: this.gridProjectId,
        tracks: this.tracks,
        remote: !!this.remoteUrl,
      };
      api.saveState(state).catch((e) => console.error("save failed", e));
    }, 300);
  }

  private async addProject(): Promise<ProjectRec | undefined> {
    const path = await open({ directory: true, multiple: false, title: "Add project folder" });
    if (typeof path !== "string") return;
    let project = this.projects.find((p) => p.path === path);
    if (!project) {
      project = { id: crypto.randomUUID(), path, name: path.split("/").filter(Boolean).pop() ?? path, color: nextProjectColor(this.projects) };
      this.projects.push(project);
      this.save();
    }
    this.activeProjectId = project.id;
    this.renderAll();
    return project;
  }

  /** The given project, else the one in use, else the first; asks for a folder when there is none. */
  private async resolveProject(projectId?: string) {
    return (
      this.projects.find((p) => p.id === projectId) ??
      this.selected?.project ??
      this.projects.find((p) => p.id === this.activeProjectId) ??
      this.projects[0] ??
      (await this.addProject())
    );
  }

  /** Asks for an opening prompt, then launches a Claude agent with it. */
  private async newAgent(projectId?: string) {
    const project = await this.resolveProject(projectId);
    if (!project) return;
    const prompt = await this.brief.ask(project.name, project.color);
    if (prompt === null) return this.selected?.focus();
    this.newSession("claude", project.id, { prompt });
  }

  private async newSession(kind: Kind, projectId?: string, launch: Launch = {}) {
    const project = await this.resolveProject(projectId);
    if (!project) return;
    const siblings = this.sessions.filter((s) => s.project.id === project.id && s.rec.kind === kind).length;
    const rec: SessionRec = {
      id: crypto.randomUUID(),
      projectId: project.id,
      kind,
      name: launch.name ?? (kind === "claude" ? (launch.prompt ? briefName(launch.prompt) : "new agent") : `tty-${String(siblings + 1).padStart(2, "0")}`),
      autoName: kind === "claude" || undefined,
      claudeId: kind === "claude" ? crypto.randomUUID() : undefined,
      createdAt: Date.now(),
    };
    const session = this.makeSession(rec, project);
    session.startCommand = launch.command;
    session.prompt = launch.prompt || undefined;
    this.sessions.push(session);
    this.orderSessions();
    project.collapsed = false;
    this.select(rec.id);
    this.save();
  }

  private select(id: string | undefined) {
    this.home = false;
    if (id !== this.selectedId) this.prevSelectedId = this.selectedId;
    // In split view the newly selected session takes the place of the one that had focus.
    if (this.layout === "split" && id && !this.splitIds.includes(id)) {
      const slot = this.splitIds.indexOf(this.selectedId ?? "");
      this.splitIds[slot < 0 ? 1 : slot] = id;
    }
    this.selectedId = id;
    if (id) this.recent = [id, ...this.recent.filter((r) => r !== id)];
    const s = this.selected;
    // A project grid follows the selection to its project.
    if (s && this.gridProjectId) this.gridProjectId = s.project.id;
    // Selecting a docked session brings it back into the grid.
    if (s && this.layout === "grid" && s.rec.collapsed) s.rec.collapsed = false;
    if (s) {
      this.activeProjectId = s.project.id;
      s.needsAttention = false;
    }
    this.renderAll();
    s?.focus();
    this.save();
  }

  private async closeSession(s: Session | undefined) {
    if (!s) return;
    // Idle sessions close without asking; a Claude conversation stays resumable either way.
    if (s.busy && !(await ask(`Terminate ${s.rec.name} in ${s.project.name}?${s.rec.kind === "claude" ? "\n\nThe conversation stays saved in Claude Code." : ""}`, { title: "Houston", kind: "warning", okLabel: "Terminate" }))) {
      return;
    }
    const index = this.sessions.indexOf(s);
    this.sessions.splice(index, 1);
    let next = this.sessions[Math.min(index, this.sessions.length - 1)]?.rec.id;
    const slot = this.splitIds.indexOf(s.rec.id);
    if (slot >= 0) {
      this.splitIds.splice(slot, 1);
      if (this.layout === "split") {
        if (this.splitIds.length < 2) this.layout = "focus";
        else next = this.splitIds[Math.min(slot, this.splitIds.length - 1)];
      }
    }
    s.dispose();
    if (this.selectedId === s.rec.id) this.select(next);
    else this.renderAll();
    this.save();
  }

  private removeProject(id: string) {
    if (this.sessions.some((s) => s.project.id === id)) return;
    this.projects = this.projects.filter((p) => p.id !== id);
    this.renderAll();
    this.save();
  }

  private rename(s: Session, name: string) {
    const clean = name.trim();
    if (clean && clean !== s.rec.name) {
      s.rec.name = clean;
      s.rec.autoName = false;
    }
    s.render();
    this.renderAll();
    this.save();
  }

  private cycle(delta: number) {
    if (!this.sessions.length) return;
    const i = this.sessions.findIndex((s) => s.rec.id === this.selectedId);
    this.select(this.sessions[(i + delta + this.sessions.length) % this.sessions.length].rec.id);
  }

  /** Selects the next session awaiting input after the current one, wrapping around. */
  private nextWaiting() {
    const i = this.sessions.findIndex((s) => s.rec.id === this.selectedId);
    const order = [...this.sessions.slice(i + 1), ...this.sessions.slice(0, i + 1)];
    const next = order.find((s) => s.status === "attention");
    if (next) this.select(next.rec.id);
  }

  private toggleCollapsed(project: ProjectRec) {
    project.collapsed = !project.collapsed;
    this.renderAll();
    this.save();
  }

  private setSidebarHidden(hidden: boolean) {
    this.sidebarHidden = hidden;
    $("#app").classList.toggle("no-sidebar", hidden);
    this.save();
  }

  /** Applies a sidebar width clamped to its range; undefined restores the stylesheet default. */
  private setSidebarWidth(px?: number) {
    this.sidebarWidth = px === undefined ? undefined : Math.round(Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, px)));
    const app = $("#app");
    if (this.sidebarWidth === undefined) app.style.removeProperty("--sidebar-w");
    else app.style.setProperty("--sidebar-w", `${this.sidebarWidth}px`);
  }

  /** Drags the sidebar's right edge to resize it; the grid refits through the stage's ResizeObserver. */
  private dragSidebar(e: PointerEvent, handle: HTMLElement) {
    const start = e.clientX;
    const width = $("#sidebar").getBoundingClientRect().width;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add("dragging");
    const move = (ev: PointerEvent) => this.setSidebarWidth(width + ev.clientX - start);
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      handle.classList.remove("dragging");
      this.save();
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  }

  /** Renames the selected session in place, revealing its sidebar row first. */
  private renameSelected() {
    const s = this.selected;
    if (!s) return;
    if (this.sidebarHidden) this.setSidebarHidden(false);
    if (s.project.collapsed) this.toggleCollapsed(s.project);
    const label = document.querySelector<HTMLElement>(`[data-rename="${s.rec.id}"]`);
    if (label) this.startRename(label, s);
  }

  /** Shows the selected session next to the previously selected one, or leaves split view. */
  private toggleSplit() {
    if (this.layout === "split") return this.setLayout("focus");
    const current = this.selected;
    if (!current || this.sessions.length < 2) return;
    const partner =
      this.sessions.find((s) => s.rec.id === this.prevSelectedId && s !== current) ??
      this.sessions[(this.sessions.indexOf(current) + 1) % this.sessions.length];
    this.splitIds = [partner.rec.id, current.rec.id];
    this.setLayout("split");
  }

  /**
   * Drops a session on a pane of the stage. In focus view it splits the shown session with it; in split view it
   * is inserted before/after the pane (or takes its place, swapping if it already shows); in a grid it swaps places.
   */
  private dropOnStage(s: Session, target: Session, mode: "before" | "after" | "replace") {
    if (this.layout === "grid") {
      if (target.project !== s.project) return;
      s.rec.collapsed = false;
      if (mode === "replace") {
        const [a, b] = [this.sessions.indexOf(s), this.sessions.indexOf(target)];
        [this.sessions[a], this.sessions[b]] = [target, s];
        this.save();
      } else this.moveSession(s, target, mode === "after");
      return this.select(s.rec.id);
    }
    const ids = this.layout === "split" ? this.splitIds.filter((id) => this.sessions.some((x) => x.rec.id === id)) : [target.rec.id];
    if (mode === "replace") {
      const from = ids.indexOf(s.rec.id), at = ids.indexOf(target.rec.id);
      if (from >= 0) ids[from] = target.rec.id;
      ids[at] = s.rec.id;
    } else {
      const rest = ids.filter((id) => id !== s.rec.id);
      rest.splice(rest.indexOf(target.rec.id) + (mode === "after" ? 1 : 0), 0, s.rec.id);
      ids.splice(0, ids.length, ...rest);
    }
    this.splitIds = ids;
    this.layout = "split";
    this.gridProjectId = undefined;
    this.select(s.rec.id);
  }

  /** Sessions the grid covers, docked ones included: the grid's project, else all. */
  private gridSessions() {
    const own = this.sessions.filter((s) => s.project.id === this.gridProjectId);
    return own.length ? own : this.sessions;
  }

  /** Parks a grid pane in the dock, handing the selection to a pane still on stage. */
  private collapse(s: Session) {
    s.rec.collapsed = true;
    const next = this.visibleSessions()[0];
    if (s === this.selected && next) return this.select(next.rec.id);
    this.renderAll();
    this.save();
  }

  /** Moves a session before or after another of its project's sessions; the sidebar, grid and ⌘1–9 follow that order. */
  private moveSession(s: Session, target: Session, after: boolean) {
    this.sessions.splice(this.sessions.indexOf(s), 1);
    this.sessions.splice(this.sessions.indexOf(target) + (after ? 1 : 0), 0, s);
    this.save();
  }

  /** Sessions on stage for the current layout; a split left with one session shows the selection alone. */
  private visibleSessions() {
    if (this.layout === "grid") return this.gridSessions().filter((s) => !s.rec.collapsed);
    if (this.layout === "split") {
      const pair = this.splitIds.map((id) => this.sessions.find((s) => s.rec.id === id)).filter((s): s is Session => !!s);
      if (pair.length >= 2) return pair;
    }
    return this.sessions.filter((s) => s.rec.id === this.selectedId);
  }

  /** `project` limits the grid to that project's sessions. */
  private setLayout(layout: Layout, project?: ProjectRec) {
    this.home = false;
    this.flip(() => this.applyLayout(layout, project));
  }

  /** Runs a layout change and glides every pane from its old rectangle to its new one (FLIP). */
  private flip(change: () => void) {
    const panes = () => [...document.querySelectorAll<HTMLElement>("#stage > .pane")];
    const before = new Map(panes().map((p) => [p.dataset.id!, p.getBoundingClientRect()]));
    change();
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timing = { duration: 240, easing: "cubic-bezier(.3, .7, .2, 1)" };
    for (const p of panes()) {
      const from = before.get(p.dataset.id!);
      const to = p.getBoundingClientRect();
      if (!from) {
        p.animate([{ opacity: 0, transform: "scale(.97)" }, { opacity: 1, transform: "none" }], timing);
      } else if (Math.abs(from.left - to.left) + Math.abs(from.top - to.top) + Math.abs(from.width - to.width) + Math.abs(from.height - to.height) > 1) {
        const move = `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})`;
        p.animate([{ transform: move, transformOrigin: "top left" }, { transform: "none", transformOrigin: "top left" }], timing);
      }
    }
  }

  private applyLayout(layout: Layout, project?: ProjectRec) {
    this.layout = layout;
    this.gridProjectId = layout === "grid" ? project?.id : undefined;
    if (project && this.selected?.project !== project) {
      const first = this.sessions.find((s) => s.project === project);
      if (first) return this.select(first.rec.id);
    }
    this.renderAll();
    this.selected?.focus();
    this.save();
  }

  /** True while the user is looking at the session: the app has focus and the session is on stage. */
  private watching(s: Session) {
    return document.hasFocus() && !this.homeShown && this.visibleSessions().includes(s);
  }

  /** Native notification, when allowed. Only things that need the user get here: a session waiting, or a failure. */
  private notify(title: string, body: string) {
    if (this.notifyAllowed) sendNotification({ title, body });
  }

  private tick() {
    const now = performance.now();
    const appFocused = document.hasFocus();
    const visible = this.homeShown ? [] : this.visibleSessions();
    for (const s of this.sessions) {
      // A finished shell command is not worth an interruption (a failing one is, see `failed`); a waiting agent is.
      if (s.tick(now, appFocused && visible.includes(s)) && !appFocused && s.rec.kind === "claude") {
        this.notify(`${s.rec.name} · ${s.project.name}`, s.permission ? `needs approval: ${s.waitingFor}` : s.waitingFor || `${s.rec.name} is awaiting input`);
      }
    }
    const waiting = this.sessions.filter((s) => s.status === "attention").length;
    if (waiting !== this.badge) {
      this.badge = waiting;
      getCurrentWindow().setBadgeCount(waiting || undefined).catch(() => {});
      const pill = $("#waiting-pill");
      pill.dataset.status = "attention";
      pill.innerHTML = `${light()}${waiting} waiting`;
      pill.classList.toggle("hidden", !waiting);
    }
    this.renderSidebar();
    this.renderCrumbs();
    this.renderDock();
    if (this.inbox.isOpen) this.inbox.update(this.inboxItems(), this.digest());
    if (this.remoteUrl && Date.now() - this.lastSnapshot > 2000) this.pushSnapshot();
  }

  // ── inbox, timeline, remote ──────────────────────────────────────────

  /** Sessions that need the user: parked after finishing, or showing a permission dialog right now. */
  private inboxItems(): InboxItem[] {
    return this.sessions
      .filter((s) => s.status === "attention" || (s.permission && s.status !== "exited"))
      .map((s) => ({
        id: s.rec.id,
        name: s.rec.name,
        project: s.project.name,
        color: s.project.color,
        kind: s.rec.kind,
        status: s.status,
        waitingFor: s.waitingFor,
        permission: s.permission,
      }));
  }

  /** One line on what the fleet has cost so far, from Claude Code's reported session totals. */
  private digest() {
    const spent = this.sessions.filter((s) => s.stats?.cost_usd != null);
    const total = spent.reduce((sum, s) => sum + (s.stats?.cost_usd ?? 0), 0);
    const w = this.limits?.five_hour;
    return `$${total.toFixed(2)} across ${spent.length} agent${spent.length === 1 ? "" : "s"}${w ? ` · 5h limit ${fuelLeft(w)}% left` : ""}`;
  }

  /** Runs an answer on a session from the inbox and refreshes the list. */
  private answer(id: string, act: (s: Session) => void) {
    const s = this.sessions.find((x) => x.rec.id === id);
    if (!s) return;
    act(s);
    s.needsAttention = false;
    s.permission = null;
    s.waitingFor = "";
    this.inbox.update(this.inboxItems(), this.digest());
  }

  private openInbox() {
    this.inbox.open(this.inboxItems(), this.digest());
  }

  private openTimeline(s = this.selected) {
    if (!s?.rec.claudeId) return;
    this.timeline.open(s.rec.name, s.project.color, s.project.path, s.rec.claudeId);
  }

  private sendDigest() {
    const top = this.sessions
      .filter((s) => s.stats?.cost_usd != null)
      .sort((a, b) => (b.stats!.cost_usd ?? 0) - (a.stats!.cost_usd ?? 0))
      .slice(0, 3)
      .map((s) => `${s.rec.name} $${s.stats!.cost_usd!.toFixed(2)}`)
      .join(" · ");
    this.notify("Houston cost digest", `${this.digest()}${top ? `\n${top}` : ""}`);
  }

  private async toggleRemote() {
    if (this.remoteUrl) {
      await api.remoteStop().catch(() => {});
      this.remoteUrl = undefined;
      this.save();
      this.sidebarKey = "";
      this.renderSidebar();
      return void message("Remote glance is off.", { title: "Houston" });
    }
    await this.startRemote(true);
  }

  private async startRemote(announce: boolean) {
    try {
      this.remoteUrl = (await api.remoteStart()).url;
    } catch (err) {
      return void message(`Could not start the status page: ${err}`, { title: "Houston", kind: "error" });
    }
    this.save();
    this.pushSnapshot();
    this.sidebarKey = "";
    this.renderSidebar();
    if (!announce) return;
    await navigator.clipboard.writeText(this.remoteUrl).catch(() => {});
    await message(
      `${this.remoteUrl}\n\nCopied to your clipboard. Open it on a phone on the same network.\n\nAnyone with this link can see session names, status and the last question each agent asked (read-only). Turn it off from the palette.`,
      { title: "Remote glance", kind: "info" },
    );
  }

  /** Fleet state for the remote page. */
  private pushSnapshot() {
    this.lastSnapshot = Date.now();
    const l = this.limits;
    const limits = [l?.five_hour && `5h limit ${fuelLeft(l.five_hour)}% left`, l?.seven_day && `week ${fuelLeft(l.seven_day)}% left`].filter(Boolean).join(" · ");
    const snapshot = {
      updated: this.lastSnapshot,
      waiting: this.sessions.filter((s) => s.status === "attention").length,
      working: this.sessions.filter((s) => s.status === "working").length,
      cost: this.sessions.reduce((sum, s) => sum + (s.stats?.cost_usd ?? 0), 0),
      limits,
      sessions: this.sessions.map((s) => ({
        name: s.rec.name,
        project: s.project.name,
        color: s.project.color,
        status: s.status,
        waitingFor: s.waitingFor,
        ctx: s.stats?.context_percent ?? null,
      })),
    };
    api.remoteUpdate(JSON.stringify(snapshot)).catch(() => {});
  }

  // ── rendering ────────────────────────────────────────────────────────

  private renderAll() {
    this.sidebarKey = "";
    this.renderSidebar();
    this.renderStage();
    this.renderHome();
    this.renderCrumbs();
    this.renderDock();
  }

  private renderSidebar() {
    const home = this.shell.home;
    const key = JSON.stringify([
      this.projects.map((p) => [p.id, p.collapsed]),
      this.activeProjectId,
      this.selectedId,
      this.sessions.map((s) => [s.rec.name, s.status, s.title, s.cwd, s.runningCommand, s.waitingFor, ctxTier(s), s.overlaps.length]),
      this.projects.map((p) => gitBadge(this.projectGit.get(p.id))),
      !!this.remoteUrl,
    ]);
    if (key === this.sidebarKey || this.renaming || this.reordering) return;
    this.sidebarKey = key;
    this.renderHome();

    const html = this.projects
      .map((p) => {
        const mine = this.sessions.filter((s) => s.project.id === p.id);
        // Sessions that need the user float to the top of their project; shortcut numbers keep the real order.
        const rows = [...mine]
          .sort((a, b) => Number(b.status === "attention") - Number(a.status === "attention"))
          .map((s) => {
            const index = this.sessions.indexOf(s) + 1;
            const status = STATUS_LABEL[s.status];
            const sub =
              s.status === "attention" && s.waitingFor
                ? s.waitingFor
                : s.rec.kind === "claude" ? (!s.rec.autoName && s.title) || "claude code" : s.runningCommand ? `⟫ ${s.runningCommand}` : shortPath(s.cwd, home);
            return `<div class="sess${s.rec.id === this.selectedId ? " sel" : ""}" data-status="${s.status}" data-select="${s.rec.id}">
              ${light(s.rec.kind, `${s.rec.kind === "claude" ? "Claude" : "Shell"} · ${status}`)}
              <div class="sess-body">
                <div class="sess-line"><span class="sess-name" data-rename="${s.rec.id}">${escapeHtml(s.rec.name)}</span>${s.overlaps.length ? `<span class="sess-warn" title="${escapeHtml(overlapTitle(s))}">${icon("warn")}${s.overlaps.length}</span>` : ""}</div>
                <div class="sess-sub" title="${escapeHtml(sub)}">${escapeHtml(sub)}</div>
              </div>
              <div class="sess-tail">
                <span class="sess-key">${index <= 9 ? `⌘${index}` : ""}</span>
                <span class="sess-actions">
                  <button class="sess-close" data-close="${s.rec.id}" title="Close session">${icon("close")}</button>
                </span>
              </div>
              ${ctxBar(s)}
            </div>`;
          })
          .join("");
        const waiting = mine.filter((s) => s.status === "attention").length;
        const summary = `${mine.length} session${mine.length === 1 ? "" : "s"}${waiting ? ` · ${waiting} waiting` : ""}`;
        const badge = gitBadge(this.projectGit.get(p.id));
        return `<section class="proj${p.id === this.activeProjectId ? " active" : ""}${p.collapsed ? " collapsed" : ""}${waiting ? " has-waiting" : ""}" style="--proj: ${p.color}">
          <div class="proj-head" data-project="${p.id}">
            <button class="proj-toggle" data-collapse="${p.id}" title="${p.collapsed ? "Expand" : "Collapse"}" aria-expanded="${!p.collapsed}">${icon("chevron")}</button>
            <div class="proj-title">
              <span class="proj-name">${escapeHtml(p.name)}</span>
              ${p.collapsed ? `<span class="proj-path proj-summary${waiting ? " waiting" : ""}">${summary}</span>` : `<span class="proj-path" title="${escapeHtml(p.path)}">${escapeHtml(shortPath(p.path, home))}</span>`}
            </div>
            ${waiting && !p.collapsed ? `<span class="proj-wait" title="${waiting} waiting">${waiting}</span>` : ""}
            ${badge ? `<button class="proj-git" data-diff="${p.id}" title="Show uncommitted changes (⌘D)">${badge}</button>` : ""}
            <span class="proj-actions">
              ${mine.length ? `<button data-grid="${p.id}" title="Open in grid">${icon("grid")}</button>` : ""}
              <button data-new="claude" data-pid="${p.id}" title="New Claude agent">${icon("agent")}</button>
              <button data-new="shell" data-pid="${p.id}" title="New shell">${icon("shell")}</button>
              ${mine.length ? `<button aria-disabled="true" title="Close its sessions first">${icon("close")}</button>` : `<button data-remove="${p.id}" title="Remove project">${icon("close")}</button>`}
            </span>
          </div>
          ${p.collapsed ? "" : rows || `<div class="proj-empty">no sessions</div>`}
        </section>`;
      })
      .join("");
    $("#projects").innerHTML = html || `<div class="side-empty">No projects yet<br><span>⌘O to add one</span></div>`;

    $("#telemetry").innerHTML = (["working", "attention", "idle", "exited"] as const)
      .map((st) => {
        const n = this.sessions.filter((s) => s.status === st).length;
        const label = `${n} ${STATUS_LABEL[st].toLowerCase()}`;
        return n ? `<span data-status="${st}" title="${label}" aria-label="${label}">${light()}${n}</span>` : "";
      })
      .join("") + (this.remoteUrl ? `<span class="t-remote" title="Remote glance is on">${icon("remote")}remote</span>` : "");
  }

  /** Remaining plan usage per window, refreshed from what Claude Code last reported. */
  private async pollLimits() {
    const limits = await api.claudeLimits().catch(() => null);
    this.limits = limits;
    $("#limits").innerHTML = renderLimits(limits);
  }

  /** Refreshes each project's uncommitted changes, each Claude session's cost and context use, and file overlaps. */
  private async pollUsage() {
    const ids = this.sessions.flatMap((s) => (s.rec.claudeId ? [s.rec.claudeId] : []));
    const live = this.sessions.filter((s) => s.rec.claudeId && s.status !== "exited" && s.status !== "dormant");
    const [stats, edits] = await Promise.all([
      ids.length ? api.claudeSessionStats(ids).catch(() => ({})) : {},
      live.length ? api.claudeEdits(live.map((s) => s.rec.claudeId!)).catch(() => ({})) : {},
      ...this.projects.map(async (p) => this.projectGit.set(p.id, await api.gitStatus(p.path).catch(() => null))),
    ]);
    for (const s of this.sessions) {
      const next = s.rec.claudeId ? (stats as Record<string, Session["stats"]>)[s.rec.claudeId] : undefined;
      if (next) s.stats = next;
      s.projectGit = this.projectGit.get(s.project.id) ?? null;
      s.render();
    }
    this.findOverlaps(live, edits as Record<string, FileEdit[]>);
    this.renderSidebar();
  }

  /** Conflict radar: files that two live agents both changed lately. */
  private findOverlaps(live: Session[], edits: Record<string, FileEdit[]>) {
    const cutoff = Date.now() - OVERLAP_WINDOW;
    const touched = new Map<string, Session[]>();
    for (const s of live) {
      for (const e of edits[s.rec.claudeId!] ?? []) {
        if (!(Date.parse(e.ts) > cutoff)) continue;
        const list = touched.get(e.path) ?? [];
        if (!list.includes(s)) list.push(s);
        touched.set(e.path, list);
      }
    }
    for (const s of this.sessions) s.overlaps = [];
    const current = new Set<string>();
    for (const [path, list] of touched) {
      if (list.length < 2) continue;
      for (const s of list) s.overlaps.push({ path, with: list.filter((o) => o !== s).map((o) => o.rec.name).join(", ") });
      const key = `${path}|${list.map((s) => s.rec.id).sort().join(",")}`;
      current.add(key);
      if (!this.overlapSeen.has(key) && !document.hasFocus()) {
        this.notify(`Overlap in ${list[0].project.name}`, `${list.map((s) => s.rec.name).join(" and ")} both changed ${path.split("/").pop()}`);
      }
    }
    this.overlapSeen = current;
    for (const s of live) s.render();
  }

  private get homeShown() {
    return this.home || !this.sessions.length;
  }

  private showHome() {
    this.home = true;
    (document.activeElement as HTMLElement | null)?.blur();
    this.renderHome();
    this.renderCrumbs();
  }

  private homeClick(e: MouseEvent) {
    const t = e.target as HTMLElement;
    const data = (attr: string) => t.closest<HTMLElement>(`[${attr}]`)?.getAttribute(attr) ?? undefined;
    if (data("data-select")) return this.select(data("data-select"));
    const kind = data("data-new");
    if (kind === "claude") return this.newAgent(data("data-pid"));
    if (kind) return this.newSession(kind as Kind, data("data-pid"));
    const changed = this.projects.find((p) => p.id === data("data-diff"));
    if (changed) return this.showChanges(changed);
    if (data("data-act") === "add-project") return this.addProject();
    if (data("data-act") === "inbox") return this.openInbox();
  }

  /** The landing screen: what needs you, every project with its sessions, and what you touched last. */
  private renderHome() {
    const el = $("#home");
    const shown = this.homeShown;
    el.classList.toggle("hidden", !shown);
    this.syncBackdrop();
    if (!shown) return;
    const home = this.shell.home;
    const sub = (s: Session) =>
      s.status === "attention" && s.waitingFor
        ? s.waitingFor
        : s.rec.kind === "claude" ? (!s.rec.autoName && s.title) || "claude code" : s.runningCommand ? `⟫ ${s.runningCommand}` : shortPath(s.cwd, home);
    const row = (s: Session, withProject: boolean) => `<button class="home-row" data-status="${s.status}" data-select="${s.rec.id}" style="--proj: ${s.project.color}">
      ${light(s.rec.kind, `${s.rec.kind === "claude" ? "Claude" : "Shell"} · ${STATUS_LABEL[s.status]}`)}
      <span class="home-row-name">${escapeHtml(s.rec.name)}</span>
      ${withProject ? `<span class="home-row-proj">${escapeHtml(s.project.name)}</span>` : ""}
      <span class="home-row-sub">${escapeHtml(sub(s))}</span>
    </button>`;

    const count = (st: Session["status"]) => this.sessions.filter((s) => s.status === st).length;
    const stats = (["working", "attention", "idle", "exited"] as const)
      .map((st) => `<div class="home-stat" data-status="${st}">${light()}<b>${count(st)}</b><span>${STATUS_LABEL[st]}</span></div>`)
      .join("");

    const waiting = this.sessions.filter((s) => s.status === "attention");
    const recent = this.recent
      .map((id) => this.sessions.find((s) => s.rec.id === id))
      .filter((s): s is Session => !!s && s.status !== "attention")
      .slice(0, 5);

    const projects = this.projects
      .map((p) => {
        const mine = this.sessions.filter((s) => s.project.id === p.id);
        const badge = gitBadge(this.projectGit.get(p.id));
        const chips = mine
          .map((s) => `<button class="home-chip" data-status="${s.status}" data-select="${s.rec.id}" title="${escapeHtml(sub(s))}">${light(s.rec.kind, STATUS_LABEL[s.status])}${escapeHtml(s.rec.name)}</button>`)
          .join("");
        return `<article class="home-proj" style="--proj: ${p.color}">
          <div class="home-proj-head">
            <div class="home-proj-title"><span class="home-proj-name">${escapeHtml(p.name)}</span><span class="home-proj-path" title="${escapeHtml(p.path)}">${escapeHtml(shortPath(p.path, home))}</span></div>
            ${badge ? `<button class="proj-git" data-diff="${p.id}" title="Show uncommitted changes (⌘D)">${badge}</button>` : ""}
          </div>
          <div class="home-chips">${chips || `<span class="home-none">no sessions</span>`}</div>
          <div class="home-proj-foot">
            <button data-new="claude" data-pid="${p.id}" class="btn-claude">${icon("agent")}Claude</button>
            <button data-new="shell" data-pid="${p.id}">${icon("shell")}Shell</button>
          </div>
        </article>`;
      })
      .join("");

    const html = `<div class="home-inner">
      <header class="home-head">${mark()}<div class="home-name">Houston</div><div class="home-sub">Mission control for Claude Code · v0.1</div></header>
      ${this.sessions.length ? `<div class="home-stats">${stats}</div>` : ""}
      ${waiting.length ? `<section class="home-sec home-wait"><h2>Needs you <button data-act="inbox" class="home-link">Approval inbox <kbd>⌘I</kbd></button></h2>${waiting.map((s) => row(s, true)).join("")}</section>` : ""}
      <section class="home-sec"><h2>Projects <button data-act="add-project" class="home-link">${icon("project")}Add project <kbd>⌘O</kbd></button></h2>
        ${projects ? `<div class="home-projs">${projects}</div>` : `<p class="home-none">No projects yet. Add a folder to start a mission.</p>`}
      </section>
      ${recent.length ? `<section class="home-sec"><h2>Jump back in</h2>${recent.map((s) => row(s, true)).join("")}</section>` : ""}
      <section class="home-sec"><h2>Shortcuts</h2><div class="splash-keys">${HOME_KEYS.map(([k, d]) => `<div><kbd>${k}</kbd> ${d}</div>`).join("")}</div></section>
    </div>`;
    if (html !== this.homeHtml) {
      this.homeHtml = html;
      el.innerHTML = html;
    }
  }

  private renderCrumbs() {
    const s = this.homeShown ? undefined : this.selected;
    const html = this.homeShown
      ? `<span class="c-sess">Home</span>`
      : s
      ? `<span class="c-proj" style="--proj: ${s.project.color}">${escapeHtml(s.project.name)}</span> <span class="c-dim">/</span> <span class="c-sess">${escapeHtml(s.rec.name)}</span> <span class="c-dim c-path">${escapeHtml(shortPath(s.cwd, this.shell.home))}</span>`
      : `<span class="c-dim">No active mission</span>`;
    const el = $("#crumbs");
    if (el.innerHTML !== html) el.innerHTML = html;
  }

  /** Chips for the grid's collapsed sessions; clicking one restores it. */
  private renderDock() {
    const docked = this.layout === "grid" ? this.gridSessions().filter((s) => s.rec.collapsed) : [];
    const html = docked
      .map((s) => `<button class="dock-item" data-status="${s.status}" data-restore="${s.rec.id}" style="--proj: ${s.project.color}" title="Restore ${escapeHtml(s.rec.name)} · ${STATUS_LABEL[s.status]}">${light(s.rec.kind)}${escapeHtml(s.rec.name)}</button>`)
      .join("");
    const el = $("#dock");
    if (el.innerHTML !== html) el.innerHTML = html;
    el.classList.toggle("hidden", !docked.length);
  }

  /** The blueprint backdrop shows on the home screen and the empty stage; behind terminals it is reduced to the bare grid. */
  private syncBackdrop() {
    const wrap = $(".stage-wrap");
    wrap.classList.toggle("has-panes", this.sessions.length > 0);
    wrap.classList.toggle("home-up", this.homeShown);
    const calm = (this.sessions.length > 0 && !this.homeShown) || matchMedia("(prefers-reduced-motion: reduce)").matches;
    document.querySelectorAll<SVGSVGElement>("#backdrop svg").forEach((svg) => (calm ? svg.pauseAnimations() : svg.unpauseAnimations()));
  }

  private renderStage() {
    const stage = $("#stage");
    document.querySelectorAll<HTMLElement>("[data-layout]").forEach((b) => b.classList.toggle("on", b.dataset.layout === this.layout));
    this.syncBackdrop();
    if (!this.sessions.length) {
      stage.className = "stage empty";
      stage.innerHTML = HUD(this.projects.length);
      return;
    }
    stage.querySelectorAll(".hud").forEach((el) => el.remove());
    const visible = this.visibleSessions();
    // Split is a two-pane grid and shares its styling.
    stage.className = `stage ${this.layout === "focus" ? "focus" : `grid${this.layout === "split" ? " split" : ""}`}`;
    for (const s of this.sessions) {
      if (!visible.includes(s)) s.el.remove();
    }
    for (const s of visible) {
      s.el.classList.toggle("sel", s.rec.id === this.selectedId);
      s.attach(stage);
    }
    // Keep DOM order matching session order in the grid.
    for (const s of visible) stage.appendChild(s.el);
    this.layoutGrid();
  }

  /** Fits grid columns to the stage, applying any resized track sizes; the last pane spans cells left empty in its row. */
  private layoutGrid() {
    const stage = $("#stage");
    if (stage.classList.contains("empty")) return;
    const panes = [...stage.querySelectorAll<HTMLElement>(":scope > .pane")];
    const cols = this.layout === "grid" ? gridColumns(panes.length, stage.clientWidth, stage.clientHeight) : Math.max(1, panes.length);
    const rows = Math.max(1, Math.ceil(panes.length / cols));
    const key = `${this.layout}:${cols}x${rows}`;
    this.shape = { key, tracks: structuredClone(this.tracks[key]) ?? { cols: Array(cols).fill(1), rows: Array(rows).fill(1) } };
    this.applyTracks();
    const spare = (cols - (panes.length % cols)) % cols;
    panes.forEach((el, i) => (el.style.gridColumn = i === panes.length - 1 && spare ? `span ${spare + 1}` : ""));
    this.placeGutters();
  }

  private applyTracks() {
    const stage = $("#stage");
    const fr = (f: number) => `minmax(0, ${f}fr)`;
    stage.style.gridTemplateColumns = this.shape.tracks.cols.map(fr).join(" ");
    stage.style.gridTemplateRows = this.shape.tracks.rows.map(fr).join(" ");
  }

  /** Drag handles over the gaps between tiled panes; a column handle stops above a last row with no gap there. */
  private placeGutters() {
    const stage = $("#stage");
    const panes = [...stage.querySelectorAll<HTMLElement>(":scope > .pane")];
    const { cols, rows } = { cols: this.shape.tracks.cols.length, rows: this.shape.tracks.rows.length };
    const wanted = new Map<string, [number, number, number, number]>();
    if (this.layout !== "focus" && panes.length > 1) {
      const box = stage.getBoundingClientRect();
      const rect = (i: number) => panes[i].getBoundingClientRect();
      const lastRow = panes.length - (rows - 1) * cols;
      for (let c = 0; c < cols - 1; c++) {
        const left = rect(c), right = rect(c + 1);
        const bottom = rect(c < lastRow - 1 ? (rows - 1) * cols + c : (rows - 2) * cols + c).bottom;
        wanted.set(`col:${c}`, [(left.right + right.left) / 2 - box.left, left.top - box.top, 0, bottom - left.top]);
      }
      for (let r = 0; r < rows - 1; r++) {
        const above = rect(r * cols), below = rect((r + 1) * cols);
        wanted.set(`row:${r}`, [above.left - box.left, (above.bottom + below.top) / 2 - box.top, box.right - box.left - 2 * (above.left - box.left), 0]);
      }
    }
    for (const g of stage.querySelectorAll<HTMLElement>(":scope > .gutter")) if (!wanted.has(g.dataset.gutter!)) g.remove();
    for (const [key, [x, y, w, h]] of wanted) {
      let g = stage.querySelector<HTMLElement>(`:scope > .gutter[data-gutter="${key}"]`);
      if (!g) {
        g = document.createElement("div");
        g.className = `gutter ${key.split(":")[0]}`;
        g.dataset.gutter = key;
        g.title = "Drag to resize · double-click to reset";
        stage.appendChild(g);
      }
      Object.assign(g.style, { left: `${x}px`, top: `${y}px`, width: w ? `${w}px` : "", height: h ? `${h}px` : "" });
    }
  }

  /** Moves the boundary between two tracks with the pointer, keeping both at least MIN_TRACK wide. */
  private dragGutter(e: PointerEvent, gutter: HTMLElement) {
    const [axis, n] = gutter.dataset.gutter!.split(":");
    const i = Number(n);
    const stage = $("#stage");
    const sizes = axis === "col" ? this.shape.tracks.cols : this.shape.tracks.rows;
    const css = getComputedStyle(stage);
    const inner = axis === "col"
      ? stage.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight)
      : stage.clientHeight - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom);
    const gap = parseFloat(axis === "col" ? css.columnGap : css.rowGap) || 0;
    const pxPerFr = (inner - gap * (sizes.length - 1)) / sizes.reduce((a, b) => a + b, 0);
    const [a, b] = [sizes[i], sizes[i + 1]];
    const min = Math.min(MIN_TRACK / pxPerFr, (a + b) / 2);
    const start = axis === "col" ? e.clientX : e.clientY;
    e.preventDefault();
    gutter.setPointerCapture(e.pointerId);
    gutter.classList.add("dragging");
    const move = (ev: PointerEvent) => {
      const d = Math.max(min - a, Math.min(b - min, ((axis === "col" ? ev.clientX : ev.clientY) - start) / pxPerFr));
      sizes[i] = a + d;
      sizes[i + 1] = b - d;
      this.applyTracks();
      this.placeGutters();
    };
    const up = () => {
      gutter.removeEventListener("pointermove", move);
      gutter.removeEventListener("pointerup", up);
      gutter.removeEventListener("pointercancel", up);
      gutter.classList.remove("dragging");
      this.tracks[this.shape.key] = structuredClone(this.shape.tracks);
      this.save();
    };
    gutter.addEventListener("pointermove", move);
    gutter.addEventListener("pointerup", up);
    gutter.addEventListener("pointercancel", up);
  }

  /**
   * Drags a sidebar row to a new position among its project's sessions; the grid and ⌘1–9 follow that order.
   * Dropping it on a pane of the stage splits or rearranges the view instead.
   */
  private dragSession(e: PointerEvent) {
    const t = e.target as HTMLElement;
    const row = t.closest<HTMLElement>(".sess");
    const s = this.sessions.find((x) => x.rec.id === row?.dataset.select);
    if (!row || !s || e.button !== 0 || t.closest("button, input")) return;
    const [startX, startY] = [e.clientX, e.clientY];
    let drop: { s: Session; after: boolean } | null = null;
    let onStage: { s: Session; mode: "before" | "after" | "replace" } | null = null;
    let ghost: ReturnType<typeof this.dragGhost> | undefined;
    const clear = () =>
      document.querySelectorAll(".drop-before, .drop-after, .drop-replace").forEach((el) => el.classList.remove("drop-before", "drop-after", "drop-replace"));
    const move = (ev: PointerEvent) => {
      if (!this.reordering && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
      this.reordering = true;
      ghost ??= this.dragGhost(s);
      ghost.move(ev);
      row.classList.add("dragging");
      clear();
      drop = null;
      onStage = null;
      const hit = document.elementFromPoint(ev.clientX, ev.clientY);
      const pane = hit?.closest<HTMLElement>("#stage .pane");
      if (pane) {
        const target = this.sessions.find((x) => x.rec.id === pane.dataset.id);
        if (target && target !== s && (this.layout !== "grid" || target.project === s.project)) {
          onStage = { s: target, mode: this.stageZone(ev, pane) };
          pane.classList.add(`drop-${onStage.mode}`);
        }
        return;
      }
      const over = hit?.closest<HTMLElement>(".sess");
      const target = this.sessions.find((x) => x.rec.id === over?.dataset.select);
      if (!over || !target || target === s || target.project !== s.project) return;
      const r = over.getBoundingClientRect();
      drop = { s: target, after: ev.clientY > r.top + r.height / 2 };
      over.classList.add(drop.after ? "drop-after" : "drop-before");
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      clear();
      ghost?.end();
      row.classList.remove("dragging");
      if (!this.reordering) return;
      this.reordering = false;
      this.suppressClick = true;
      setTimeout(() => (this.suppressClick = false));
      if (onStage) return this.dropOnStage(s, onStage.s, onStage.mode);
      if (drop) this.moveSession(s, drop.s, drop.after);
      this.renderAll();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  /** A chip with the session's name that follows the pointer while dragging; blocks text selection until `end()`. */
  private dragGhost(s: Session) {
    const el = document.createElement("div");
    el.className = "drag-ghost";
    el.style.setProperty("--proj", s.project.color);
    el.innerHTML = `${light(s.rec.kind)}<span>${escapeHtml(s.rec.name)}</span>`;
    const noSelect = (e: Event) => e.preventDefault();
    document.addEventListener("selectstart", noSelect);
    document.body.classList.add("is-dragging");
    document.body.appendChild(el);
    window.getSelection()?.removeAllRanges();
    return {
      move: (ev: PointerEvent) => (el.style.transform = `translate(${ev.clientX + 14}px, ${ev.clientY + 14}px)`),
      end: () => {
        el.remove();
        document.removeEventListener("selectstart", noSelect);
        document.body.classList.remove("is-dragging");
      },
    };
  }

  /** Where a pointer is on a pane: its left/right edge inserts beside it, the middle (split view only) replaces it. */
  private stageZone(ev: PointerEvent, pane: HTMLElement) {
    const r = pane.getBoundingClientRect();
    const f = (ev.clientX - r.left) / r.width;
    if (this.layout === "grid") return "replace";
    if (this.layout === "split" && f >= 0.3 && f <= 0.7) return "replace";
    return f < 0.5 ? "before" : "after";
  }

  /** Drags a pane by its header onto another pane to rearrange the grid or split view. */
  private dragPane(e: PointerEvent) {
    const t = e.target as HTMLElement;
    const pane = t.closest<HTMLElement>(".pane");
    const s = this.sessions.find((x) => x.rec.id === pane?.dataset.id);
    if (this.layout === "focus" || !pane || !s || e.button !== 0 || !t.closest(".pane-header") || t.closest("button")) return;
    const [startX, startY] = [e.clientX, e.clientY];
    let dragging = false;
    let ghost: ReturnType<typeof this.dragGhost> | undefined;
    let drop: { s: Session; mode: "before" | "after" | "replace" } | null = null;
    const clear = () => document.querySelectorAll(".drop-before, .drop-after, .drop-replace").forEach((el) => el.classList.remove("drop-before", "drop-after", "drop-replace"));
    const move = (ev: PointerEvent) => {
      if (!dragging && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
      dragging = true;
      ghost ??= this.dragGhost(s);
      ghost.move(ev);
      pane.classList.add("dragging");
      clear();
      drop = null;
      const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>(".pane");
      const target = this.sessions.find((x) => x.rec.id === over?.dataset.id);
      if (!over || !target || target === s || (this.layout === "grid" && target.project !== s.project)) return;
      drop = { s: target, mode: this.stageZone(ev, over) };
      over.classList.add(`drop-${drop.mode}`);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      clear();
      ghost?.end();
      pane.classList.remove("dragging");
      if (!drop) return;
      this.dropOnStage(s, drop.s, drop.mode);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  // ── commands ─────────────────────────────────────────────────────────

  private showChanges(p = this.selected?.project ?? this.projects.find((x) => x.id === this.activeProjectId)) {
    if (p) this.diff.open(p.name, p.path, p.color);
  }

  /** Project actions shared by its right-click menu and the command palette; `null` separates groups. */
  private async projectActions(p: ProjectRec): Promise<(MenuItem | null)[]> {
    const editor = EDITORS.find((c) => this.shell.commands.includes(c));
    const scripts = await api.npmScripts(p.path).catch(() => [] as string[]);
    const hasSessions = this.sessions.some((s) => s.project === p);
    return [
      ...(hasSessions ? [{ label: "Open in grid", run: () => this.setLayout("grid", p) }] : []),
      { label: "Show changes", hint: "⌘D", run: () => this.showChanges(p) },
      ...(editor ? [{ label: `Open in ${editor}`, run: () => api.launchDetached(p.path, `${editor} .`) }] : []),
      { label: "Reveal in Finder", run: () => api.launchDetached(p.path, "open .") },
      { label: "Copy path", run: () => navigator.clipboard.writeText(p.path) },
      { label: "Open pull request", run: () => this.newSession("shell", p.id, { name: "pull request", command: "gh pr view --web || gh pr create --web" }) },
      ...(scripts.length ? [null, ...scripts.map((name) => ({ label: `npm run ${name}`, run: () => this.newSession("shell", p.id, { name, command: `npm run ${shellQuote(name)}` }) }))] : []),
    ];
  }

  private async projectMenu(e: MouseEvent, p: ProjectRec) {
    e.preventDefault();
    const hasSessions = this.sessions.some((s) => s.project === p);
    this.menu.show(e.clientX, e.clientY, [
      { label: "New Claude agent…", run: () => this.newAgent(p.id) },
      { label: "New shell", run: () => this.newSession("shell", p.id) },
      null,
      ...(await this.projectActions(p)),
      ...(hasSessions ? [] : [null, { label: "Remove project", run: () => this.removeProject(p.id) }]),
    ]);
  }

  private async openPalette() {
    // Most recently used first, the session in front of you last: the one you want is usually the one before it.
    const rank = (s: Session) => {
      const i = this.recent.indexOf(s.rec.id);
      return s === this.selected ? this.recent.length + 1 : i < 0 ? this.recent.length : i;
    };
    const commands: Command[] = [
      ...[...this.sessions]
        .sort((a, b) => rank(a) - rank(b))
        .map((s) => {
          const i = this.sessions.indexOf(s);
          return {
            label: s.rec.name,
            detail: `${s.project.name} · ${STATUS_LABEL[s.status]}${s.waitingFor ? ` · ${s.waitingFor}` : ""}`,
            hint: i < 9 ? `⌘${i + 1}` : undefined,
            color: s.project.color,
            group: "Sessions",
            session: { kind: s.rec.kind, status: s.status },
            preview: () => s.snapshot(8),
            run: () => this.select(s.rec.id),
          };
        }),
      { group: "Actions", label: "Home", hint: "⇧⌘H", run: () => this.showHome() },
      { group: "Actions", label: "New Claude agent…", hint: "⌘N", run: () => this.newAgent() },
      { group: "Actions", label: "New shell", hint: "⌘T", run: () => this.newSession("shell") },
      { group: "Actions", label: "Add project…", hint: "⌘O", run: () => this.addProject() },
      { group: "Actions", label: "Approval inbox", detail: `${this.inboxItems().length} waiting`, hint: "⌘I", run: () => this.openInbox() },
      { group: "Actions", label: "Mission timeline", detail: "what this agent did", hint: "⌘E", run: () => this.openTimeline() },
      { group: "Actions", label: "Terminate session", hint: "⌘W", run: () => this.closeSession(this.selected) },
      { group: "Actions", label: "Find in terminal", hint: "⌘F", run: () => this.selected?.openSearch() },
      { group: "Actions", label: this.layout === "grid" ? "Focus view" : "Grid view", hint: "⌘G", run: () => this.setLayout(this.layout === "grid" ? "focus" : "grid") },
      { group: "Actions", label: this.layout === "split" ? "Leave split view" : "Split view", hint: "⌘\\", run: () => this.toggleSplit() },
      { group: "Actions", label: "Next waiting session", hint: "⌘J", run: () => this.nextWaiting() },
      { group: "Actions", label: "Toggle sidebar", hint: "⌘B", run: () => this.setSidebarHidden(!this.sidebarHidden) },
      { group: "Actions", label: "Aliases…", hint: "⌘⇧P", run: () => this.aliases.open() },
      { group: "Actions", label: "Send cost digest", detail: this.digest(), run: () => this.sendDigest() },
      { group: "Actions", label: this.remoteUrl ? "Remote glance: turn off" : "Remote glance: turn on…", detail: "read-only status page for your phone", run: () => this.toggleRemote() },
    ];
    const perProject = await Promise.all(this.projects.map(async (p) => ({ p, actions: await this.projectActions(p) })));
    for (const { p, actions } of perProject) {
      for (const a of actions) if (a) commands.push({ group: "Projects", label: a.label, detail: p.name, hint: a.hint, color: p.color, run: a.run });
    }
    this.palette.open(commands);
  }

  // ── input ────────────────────────────────────────────────────────────

  private bindChrome() {
    $("#brand-mark").outerHTML = mark();
    fillIcons();
    $("#home-link").addEventListener("click", () => this.showHome());
    $("#home").addEventListener("click", (e) => this.homeClick(e));
    $("#toggle-sidebar").addEventListener("click", () => this.setSidebarHidden(!this.sidebarHidden));
    $("#app").classList.toggle("no-sidebar", this.sidebarHidden);
    this.setSidebarWidth(this.sidebarWidth);
    const sidebarHandle = $("#sidebar-gutter");
    sidebarHandle.addEventListener("pointerdown", (e) => this.dragSidebar(e, sidebarHandle));
    sidebarHandle.addEventListener("dblclick", () => {
      this.setSidebarWidth(undefined);
      this.save();
    });
    $("#waiting-pill").addEventListener("click", () => this.openInbox());
    $("#add-project").addEventListener("click", () => this.addProject());
    $("#open-aliases").addEventListener("click", () => this.aliases.open());
    $("#new-claude").addEventListener("click", () => this.newAgent());
    $("#new-shell").addEventListener("click", () => this.newSession("shell"));
    document.querySelectorAll<HTMLElement>("[data-layout]").forEach((b) =>
      b.addEventListener("click", () => (b.dataset.layout === "split" ? this.layout !== "split" && this.toggleSplit() : this.setLayout(b.dataset.layout as Layout))),
    );

    $("#projects").addEventListener("pointerdown", (e) => this.dragSession(e));
    $("#projects").addEventListener("contextmenu", (e) => {
      const p = this.projects.find((x) => x.id === (e.target as HTMLElement).closest<HTMLElement>("[data-project]")?.dataset.project);
      if (p) this.projectMenu(e, p);
    });
    $("#projects").addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      // Clicks inside the rename field must not select the row, which would blur and commit it.
      if (this.suppressClick || t.closest(".rename")) return;
      const data = (attr: string) => t.closest<HTMLElement>(`[${attr}]`)?.getAttribute(attr) ?? undefined;
      const sessionById = (id?: string) => this.sessions.find((s) => s.rec.id === id);
      const project = this.projects.find((p) => p.id === data("data-collapse"));
      if (project) return this.toggleCollapsed(project);
      if (data("data-new") === "claude") return this.newAgent(data("data-pid"));
      if (data("data-new")) return this.newSession(data("data-new") as Kind, data("data-pid"));
      const gridded = this.projects.find((p) => p.id === data("data-grid"));
      if (gridded) return this.layout === "grid" && this.gridProjectId === gridded.id ? this.setLayout("focus") : this.setLayout("grid", gridded);
      const changed = this.projects.find((p) => p.id === data("data-diff"));
      if (changed) return this.showChanges(changed);
      if (data("data-remove")) return this.removeProject(data("data-remove")!);
      if (data("data-close")) return this.closeSession(sessionById(data("data-close")));
      // The first click re-renders the sidebar, so a double-click is read from the click count
      // rather than a dblclick event, which may not fire across the replaced row.
      const row = t.closest(".sess");
      const label = row?.querySelector<HTMLElement>("[data-rename]");
      const named = sessionById(label?.dataset.rename);
      if (e.detail === 2 && label && named) return this.startRename(label, named);
      if (data("data-select")) return this.select(data("data-select"));
      const head = this.projects.find((p) => p.id === data("data-project"));
      if (head) {
        this.activeProjectId = head.id;
        this.toggleCollapsed(head);
      }
    });

    $("#stage").addEventListener("mousedown", (e) => {
      const pane = (e.target as HTMLElement).closest<HTMLElement>(".pane");
      if (pane && pane.dataset.id !== this.selectedId) {
        this.prevSelectedId = this.selectedId;
        this.selectedId = pane.dataset.id;
        this.activeProjectId = this.selected?.project.id;
        this.sessions.forEach((s) => s.el.classList.toggle("sel", s.rec.id === this.selectedId));
        this.renderSidebar();
        this.renderCrumbs();
        this.save();
      }
    });
    $("#stage").addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      if (t.closest("[data-action=relaunch]")) this.selected?.launch();
      if (t.closest("[data-action=maximize]")) this.setLayout("focus");
      const pane = this.sessions.find((s) => s.rec.id === t.closest<HTMLElement>(".pane")?.dataset.id);
      if (pane && t.closest("[data-action=collapse]")) this.collapse(pane);
      if (pane && t.closest("[data-action=diff]")) this.showChanges(pane.project);
      if (pane && t.closest("[data-action=timeline]")) this.openTimeline(pane);
      if (pane && t.closest("[data-action=terminate]")) this.closeSession(pane);
    });
    $("#dock").addEventListener("click", (e) => {
      const id = (e.target as HTMLElement).closest<HTMLElement>("[data-restore]")?.dataset.restore;
      if (id) this.select(id);
    });
    $("#stage").addEventListener("pointerdown", (e) => {
      const gutter = (e.target as HTMLElement).closest<HTMLElement>(".gutter");
      if (gutter) this.dragGutter(e, gutter);
      else this.dragPane(e);
    });
    $("#stage").addEventListener("dblclick", (e) => {
      const t = e.target as HTMLElement;
      if (t.closest(".gutter")) {
        delete this.tracks[this.shape.key];
        this.layoutGrid();
        this.save();
      } else if (t.closest(".pane-header") && this.layout !== "focus") this.setLayout("focus");
    });

    // Capture phase so shortcuts win over the terminal and input editor.
    window.addEventListener(
      "keydown",
      (e) => {
        // Open palettes and dialogs handle their own keys.
        if (!e.metaKey || e.ctrlKey || e.altKey || this.overlayOpen) return;
        const key = e.key.toLowerCase();
        const actions: Record<string, () => unknown> = {
          n: () => this.newAgent(),
          t: () => this.newSession("shell"),
          o: () => this.addProject(),
          p: () => this.openPalette(),
          f: () => this.selected?.openSearch(),
          d: () => this.showChanges(),
          i: () => this.openInbox(),
          e: () => this.openTimeline(),
          "\\": () => this.toggleSplit(),
          w: () => this.closeSession(this.selected),
          g: () => this.setLayout(this.layout === "grid" ? "focus" : "grid"),
          k: () => this.selected?.clear(),
          r: () => this.selected?.status === "exited" && this.selected.launch(),
          "[": () => this.cycle(-1),
          "]": () => this.cycle(1),
          j: () => this.nextWaiting(),
          b: () => this.setSidebarHidden(!this.sidebarHidden),
        };
        const shifted: Record<string, () => unknown> = { r: () => this.renameSelected(), p: () => this.aliases.open(), h: () => this.showHome() };
        let action = (e.shiftKey ? shifted : actions)[key];
        if (/^[1-9]$/.test(key)) action = () => this.sessions[Number(key) - 1] && this.select(this.sessions[Number(key) - 1].rec.id);
        if (!action) return;
        e.preventDefault();
        e.stopPropagation();
        action();
      },
      true,
    );
    window.addEventListener("focus", () => !this.homeShown && this.selected?.focus());
  }

  private startRename(label: HTMLElement, s: Session) {
    const input = document.createElement("input");
    input.className = "rename";
    input.value = s.rec.name;
    this.renaming = true;
    label.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (commit: boolean) => {
      if (done) return;
      done = true;
      this.renaming = false;
      this.rename(s, commit ? input.value : s.rec.name);
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") finish(true);
      if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
  }
}
