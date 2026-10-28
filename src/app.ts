import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { AliasPalette } from "./aliases";
import { api, type GitStatus, type LimitWindow, type RateLimits, type ShellInfo } from "./api";
import { Completer } from "./completion";
import { DiffPanel } from "./diff";
import { BriefDialog, CommandPalette, ContextMenu, type Command, type MenuItem } from "./palette";
import { STATUS_LABEL, Session, nextProjectColor, shellQuote, shortPath, statsLabel, type Kind, type ProjectRec, type SessionRec } from "./session";

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
  /** The two sessions of the split layout. */
  split?: string[];
  /** Resized track sizes per layout shape, e.g. "grid:3x2". */
  tracks?: Record<string, Tracks>;
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const LOGO = String.raw`██╗  ██╗ ██████╗ ██╗   ██╗███████╗████████╗ ██████╗ ███╗   ██╗
██║  ██║██╔═══██╗██║   ██║██╔════╝╚══██╔══╝██╔═══██╗████╗  ██║
███████║██║   ██║██║   ██║███████╗   ██║   ██║   ██║██╔██╗ ██║
██╔══██║██║   ██║██║   ██║╚════██║   ██║   ██║   ██║██║╚██╗██║
██║  ██║╚██████╔╝╚██████╔╝███████║   ██║   ╚██████╔╝██║ ╚████║
╚═╝  ╚═╝ ╚═════╝  ╚═════╝ ╚══════╝   ╚═╝    ╚═════╝ ╚═╝  ╚═══╝`;

function countdown(ms: number) {
  const m = Math.ceil(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d${h % 24}h`;
}

/** Approximate xterm cell size at 13px JetBrains Mono, used to size grid panes. */
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

/** Editor CLIs offered for "Open in …", in order of preference. */
const EDITORS = ["cursor", "code", "zed", "subl"];

/** Smallest width or height a resized grid track can be dragged to, in pixels. */
const MIN_TRACK = 160;

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

const FUEL_CELLS = 20;

/** Remaining share of a usage window; a window whose reset time has passed is full again. */
function fuelLeft(w: LimitWindow) {
  return w.resets_at * 1000 > Date.now() ? Math.max(0, Math.round(100 - w.used_percentage)) : 100;
}

const fuelTone = (left: number) => (left <= 10 ? "l-red" : left <= 30 ? "l-amber" : "l-green");

function renderTank(label: string, w: LimitWindow) {
  const left = fuelLeft(w);
  const msLeft = w.resets_at * 1000 - Date.now();
  const lit = Math.round((left / 100) * FUEL_CELLS);
  const cells = Array.from({ length: FUEL_CELLS }, (_, i) => `<i${i < lit ? ` class="on"` : ""}></i>`).join("");
  return `<div class="tank ${fuelTone(left)}" title="${100 - left}% used">
    <span class="l-label">${label}</span>
    <span class="l-cells">${cells}</span>
    <span class="l-left">${left}%</span>
    <span class="l-reset">${msLeft > 0 ? `T−${countdown(msLeft)}` : "FULL"}</span>
  </div>`;
}

function renderLimits(limits: RateLimits | null) {
  const windows = [
    ["5H", limits?.five_hour],
    ["WK", limits?.seven_day],
  ].filter((e): e is [string, LimitWindow] => !!e[1]);
  if (!windows.length) {
    return `<div class="l-head"><span>◆ Claude limits</span><span>no telemetry</span></div>
      <div class="l-empty">reported once a Claude session responds</div>`;
  }
  const low = Math.min(...windows.map(([, w]) => fuelLeft(w)));
  const status = low <= 10 ? `<span class="l-warn l-red">⚠ Low fuel</span>` : low <= 30 ? `<span class="l-amber">Fuel low</span>` : `<span>Nominal</span>`;
  return `<div class="l-head"><span>◆ Claude limits</span>${status}</div>
    ${windows.map(([label, w]) => renderTank(label, w)).join("")}
    <div class="l-scale"><span>E</span><span>½</span><span>F</span></div>`;
}

/** Ringed planet with an orbiting moon and rocket, as in the README banner. */
const PLANET = `<svg class="planet" viewBox="0 0 360 200" aria-hidden="true">
  <defs>
    <radialGradient id="pl-body" cx="34%" cy="28%" r="80%"><stop offset="0" stop-color="#b8ecff"/><stop offset=".35" stop-color="#5bb4e6"/><stop offset=".7" stop-color="#4868c4"/><stop offset="1" stop-color="#33296e"/></radialGradient>
    <radialGradient id="pl-moon" cx="34%" cy="30%" r="75%"><stop offset="0" stop-color="#ffd8c2"/><stop offset=".6" stop-color="#e5917a"/><stop offset="1" stop-color="#94504a"/></radialGradient>
    <radialGradient id="pl-glow" r="50%"><stop offset="0" stop-color="#4fb3ff" stop-opacity=".3"/><stop offset="1" stop-color="#4fb3ff" stop-opacity="0"/></radialGradient>
    <linearGradient id="pl-ring" x1="110" x2="250" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#b79cf5"/><stop offset=".5" stop-color="#f29bb8"/><stop offset="1" stop-color="#f5c983"/></linearGradient>
    <linearGradient id="pl-flame" x1="0" x2="1"><stop offset="0" stop-color="#f5c983" stop-opacity="0"/><stop offset=".6" stop-color="#f5c983"/><stop offset="1" stop-color="#fff1c9"/></linearGradient>
    <clipPath id="pl-globe"><circle cx="180" cy="100" r="42"/></clipPath>
    <path id="pl-orbit" d="M 180 100 m -130 0 a 130 46 -12 1 0 260 0 a 130 46 -12 1 0 -260 0"/>
  </defs>
  <circle cx="180" cy="100" r="96" fill="url(#pl-glow)"/>
  <circle cx="180" cy="100" r="62" fill="none" stroke="#7fd0ff" stroke-opacity=".2" stroke-width="4" stroke-dasharray=".8 9.94"/>
  <use href="#pl-orbit" fill="none" stroke="#7fd0ff" stroke-opacity=".22" stroke-dasharray="2 6"/>
  <ellipse cx="180" cy="100" rx="172" ry="64" transform="rotate(-12 180 100)" fill="none" stroke="#7fd0ff" stroke-opacity=".12" stroke-dasharray="1 8"/>
  <g transform="rotate(-12 180 100)">
    <path d="M 110 100 a 70 15 0 0 1 140 0" fill="none" stroke="url(#pl-ring)" stroke-width="3" stroke-opacity=".45" stroke-linecap="round"/>
    <circle cx="180" cy="100" r="42" fill="url(#pl-body)"/>
    <g clip-path="url(#pl-globe)" fill="none" stroke="#e0f6ff" stroke-opacity=".22">
      <ellipse cx="180" cy="100" rx="23" ry="42"/><ellipse cx="180" cy="100" rx="42" ry="9"/>
    </g>
    <path d="M 250 100 a 70 15 0 0 1 -140 0" fill="none" stroke="url(#pl-ring)" stroke-width="3" stroke-linecap="round"/>
  </g>
  <circle r="8" fill="url(#pl-moon)"><animateMotion dur="26s" repeatCount="indefinite" path="M 180 100 m -172 0 a 172 64 -12 1 0 344 0 a 172 64 -12 1 0 -344 0"/></circle>
  <g>
    <animateMotion dur="12s" repeatCount="indefinite" rotate="auto"><mpath href="#pl-orbit"/></animateMotion>
    <g transform="translate(-11 0) scale(.8)">
      <path d="M -20 0 L 0 -4 L 0 4 Z" fill="url(#pl-flame)"><animate attributeName="d" values="M -20 0 L 0 -4 L 0 4 Z;M -28 0 L 0 -4 L 0 4 Z;M -20 0 L 0 -4 L 0 4 Z" dur=".25s" repeatCount="indefinite"/></path>
      <path d="M 0 -6 L 18 -6 Q 30 0 18 6 L 0 6 Z" fill="#d5d8de"/>
      <circle cx="15" cy="0" r="2.6" fill="#6fa8dc"/>
      <path d="M 2 -6 L -4 -12 L 8 -6 Z M 2 6 L -4 12 L 8 6 Z" fill="#d4977a"/>
    </g>
  </g>
</svg>`;

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

export class App {
  private projects: ProjectRec[] = [];
  private sessions: Session[] = [];
  private selectedId?: string;
  /** Project that "new session" targets when nothing is selected in it. */
  private activeProjectId?: string;
  private layout: Layout = "focus";
  private sidebarHidden = false;
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
  private tracks: Record<string, Tracks> = {};
  /** Shape key and sizes of the tiled layout on screen. */
  private shape = { key: "", tracks: { cols: [1], rows: [1] } as Tracks };
  private projectGit = new Map<string, GitStatus | null>();
  private aliases = new AliasPalette({
    connect: (alias) => this.newSession("shell", undefined, { name: alias.name, command: alias.name }),
    defined: (name) => this.completer.addCommand(name),
  });
  private palette = new CommandPalette(() => this.selected?.focus());
  private brief = new BriefDialog();
  private diff = new DiffPanel(() => this.selected?.focus());
  private menu = new ContextMenu();

  constructor(private shell: ShellInfo) {
    this.completer.load(shell);
    document.body.append(this.aliases.el, this.palette.el, this.brief.el, this.diff.el, this.menu.el);
  }

  private get overlayOpen() {
    return this.aliases.isOpen || this.palette.isOpen || this.brief.isOpen || this.diff.isOpen;
  }

  async start() {
    const saved = await api.loadState<Persisted>().catch(() => null);
    if (saved) {
      this.projects = [];
      // Projects saved before colours existed get one in their original order.
      for (const p of saved.projects) this.projects.push({ ...p, color: p.color ?? nextProjectColor(this.projects) });
      this.layout = saved.layout ?? "focus";
      this.sidebarHidden = saved.sidebarHidden ?? false;
      this.splitIds = saved.split ?? [];
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
        split: this.splitIds,
        tracks: this.tracks,
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
    if (id !== this.selectedId) this.prevSelectedId = this.selectedId;
    // In split view the newly selected session takes the place of the one that had focus.
    if (this.layout === "split" && id && !this.splitIds.includes(id)) {
      const slot = this.splitIds.indexOf(this.selectedId ?? "");
      this.splitIds[slot < 0 ? 1 : slot] = id;
    }
    this.selectedId = id;
    const s = this.selected;
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
    if (this.layout === "split" && this.splitIds.includes(s.rec.id)) this.layout = "focus";
    s.dispose();
    if (this.selectedId === s.rec.id) this.select(this.sessions[Math.min(index, this.sessions.length - 1)]?.rec.id);
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

  /** Sessions on stage for the current layout; a split missing a session shows the selection alone. */
  private visibleSessions() {
    if (this.layout === "grid") return this.sessions;
    if (this.layout === "split") {
      const pair = this.splitIds.map((id) => this.sessions.find((s) => s.rec.id === id)).filter((s): s is Session => !!s);
      if (pair.length === 2) return pair;
    }
    return this.sessions.filter((s) => s.rec.id === this.selectedId);
  }

  private setLayout(layout: Layout) {
    this.layout = layout;
    this.renderAll();
    this.selected?.focus();
    this.save();
  }

  private tick() {
    const now = performance.now();
    const appFocused = document.hasFocus();
    const visible = this.visibleSessions();
    for (const s of this.sessions) {
      if (s.tick(now, appFocused && visible.includes(s)) && !appFocused && this.notifyAllowed) {
        const what = s.rec.kind === "claude" ? "is awaiting input" : `finished: ${s.runningCommand || "command"}`;
        sendNotification({ title: `${s.rec.name} · ${s.project.name}`, body: s.waitingFor || `${s.rec.name} ${what}` });
      }
    }
    const waiting = this.sessions.filter((s) => s.status === "attention").length;
    if (waiting !== this.badge) {
      this.badge = waiting;
      getCurrentWindow().setBadgeCount(waiting || undefined).catch(() => {});
      const pill = $("#waiting-pill");
      pill.textContent = `${waiting} waiting`;
      pill.classList.toggle("hidden", !waiting);
    }
    this.renderSidebar();
    this.renderCrumbs();
  }

  // ── rendering ────────────────────────────────────────────────────────

  private renderAll() {
    this.sidebarKey = "";
    this.renderSidebar();
    this.renderStage();
    this.renderCrumbs();
  }

  private renderSidebar() {
    const home = this.shell.home;
    const key = JSON.stringify([
      this.projects.map((p) => [p.id, p.collapsed]),
      this.activeProjectId,
      this.selectedId,
      this.sessions.map((s) => [s.rec.name, s.status, s.title, s.cwd, s.runningCommand, s.waitingFor, s.stats?.cost_usd]),
      this.projects.map((p) => gitBadge(this.projectGit.get(p.id))),
    ]);
    if (key === this.sidebarKey || this.renaming || this.reordering) return;
    this.sidebarKey = key;

    const html = this.projects
      .map((p) => {
        const mine = this.sessions.filter((s) => s.project.id === p.id);
        const rows = mine
          .map((s) => {
            const index = this.sessions.indexOf(s) + 1;
            const status = STATUS_LABEL[s.status];
            const sub =
              s.status === "attention" && s.waitingFor
                ? s.waitingFor
                : s.rec.kind === "claude" ? (!s.rec.autoName && s.title) || "claude code" : s.runningCommand ? `⟫ ${s.runningCommand}` : shortPath(s.cwd, home);
            const cost = s.stats?.cost_usd != null ? `$${s.stats.cost_usd.toFixed(2)}` : "";
            return `<div class="sess${s.rec.id === this.selectedId ? " sel" : ""}" data-status="${s.status}" data-select="${s.rec.id}">
              <span class="dot" role="img" aria-label="${status}" title="${status}"></span>
              <div class="sess-body">
                <div class="sess-line"><span class="sess-name" data-rename="${s.rec.id}">${escapeHtml(s.rec.name)}</span><span class="tag tag-${s.rec.kind}">${s.rec.kind === "claude" ? "CC" : "SH"}</span>${cost ? `<span class="sess-cost" title="${escapeHtml(statsLabel(s.stats))}">${cost}</span>` : ""}</div>
                <div class="sess-sub" title="${escapeHtml(sub)}">${escapeHtml(sub)}</div>
              </div>
              <span class="sess-key">${index <= 9 ? `⌘${index}` : ""}</span>
              <button class="sess-edit" data-edit="${s.rec.id}" title="Rename (⌘⇧R)">✎</button>
              <button class="sess-close" data-close="${s.rec.id}" title="Close session">×</button>
            </div>`;
          })
          .join("");
        const waiting = mine.filter((s) => s.status === "attention").length;
        const summary = `${mine.length} session${mine.length === 1 ? "" : "s"}${waiting ? ` · ${waiting} waiting` : ""}`;
        const badge = gitBadge(this.projectGit.get(p.id));
        return `<section class="proj${p.id === this.activeProjectId ? " active" : ""}${p.collapsed ? " collapsed" : ""}" style="--proj: ${p.color}">
          <div class="proj-head" data-project="${p.id}">
            <button class="proj-toggle" data-collapse="${p.id}" title="${p.collapsed ? "Expand" : "Collapse"}" aria-expanded="${!p.collapsed}">▾</button>
            <span class="proj-name">${escapeHtml(p.name)}</span>
            ${p.collapsed ? `<span class="proj-path proj-summary${waiting ? " waiting" : ""}">${summary}</span>` : `<span class="proj-path">${escapeHtml(shortPath(p.path, home))}</span>`}
            ${badge ? `<button class="proj-git" data-diff="${p.id}" title="Show uncommitted changes (⌘D)">${badge}</button>` : ""}
            <span class="proj-actions">
              <button data-new="claude" data-pid="${p.id}" title="New Claude agent">✽</button>
              <button data-new="shell" data-pid="${p.id}" title="New shell">›_</button>
              ${mine.length ? `<button aria-disabled="true" title="Close its sessions first">×</button>` : `<button data-remove="${p.id}" title="Remove project">×</button>`}
            </span>
          </div>
          ${p.collapsed ? "" : rows || `<div class="proj-empty">no sessions</div>`}
        </section>`;
      })
      .join("");
    $("#projects").innerHTML = html || `<div class="side-empty">No projects yet<br><span>⌘O to add one</span></div>`;

    const count = (st: string) => this.sessions.filter((s) => s.status === st).length;
    const exited = count("exited");
    $("#telemetry").innerHTML = `<span>${count("working")} working</span><span class="t-attention">${count("attention")} waiting</span><span>${count("idle")} standby</span>${exited ? `<span class="t-exited">${exited} exited</span>` : ""}`;
  }

  /** Remaining plan usage per window, refreshed from what Claude Code last reported. */
  private async pollLimits() {
    const limits = await api.claudeLimits().catch(() => null);
    $("#limits").innerHTML = renderLimits(limits);
  }

  /** Refreshes each project's uncommitted changes and each Claude session's cost and context use. */
  private async pollUsage() {
    const ids = this.sessions.flatMap((s) => (s.rec.claudeId ? [s.rec.claudeId] : []));
    const [stats] = await Promise.all([
      ids.length ? api.claudeSessionStats(ids).catch(() => ({})) : {},
      ...this.projects.map(async (p) => this.projectGit.set(p.id, await api.gitStatus(p.path).catch(() => null))),
    ]);
    for (const s of this.sessions) {
      const next = s.rec.claudeId ? (stats as Record<string, Session["stats"]>)[s.rec.claudeId] : undefined;
      if (next) {
        s.stats = next;
        s.render();
      }
    }
    this.renderSidebar();
  }

  private renderCrumbs() {
    const s = this.selected;
    const html = s
      ? `<span class="c-proj" style="--proj: ${s.project.color}">${escapeHtml(s.project.name)}</span> <span class="c-dim">▸</span> <span class="c-sess">${escapeHtml(s.rec.name)}</span> <span class="c-dim">· ${escapeHtml(shortPath(s.cwd, this.shell.home))}</span>`
      : `<span class="c-dim">No active mission</span>`;
    const el = $("#crumbs");
    if (el.innerHTML !== html) el.innerHTML = html;
  }

  private renderStage() {
    const stage = $("#stage");
    document.querySelectorAll<HTMLElement>("[data-layout]").forEach((b) => b.classList.toggle("on", b.dataset.layout === this.layout));
    if (!this.sessions.length) {
      stage.className = "stage empty";
      stage.innerHTML = `${HUD(this.projects.length)}<div class="splash">${PLANET}<pre class="logo">${LOGO}</pre>
        <div class="splash-sub">Mission control for Claude Code · v0.1</div>
        <div class="splash-keys">
          <div><kbd>⌘O</kbd> add project</div><div><kbd>⌘N</kbd> new Claude session</div>
          <div><kbd>⌘T</kbd> open shell</div><div><kbd>⌘G</kbd> grid / focus</div>
          <div><kbd>⌘1-9</kbd> jump to session</div><div><kbd>⌘W</kbd> close session</div>
          <div><kbd>⌘J</kbd> next waiting</div><div><kbd>⌘B</kbd> toggle sidebar</div>
          <div><kbd>⌘P</kbd> command palette</div><div><kbd>⌘\\</kbd> split view</div>
          <div><kbd>⌘F</kbd> find in terminal</div><div><kbd>⌘D</kbd> show changes</div>
          <div><kbd>⌘⇧P</kbd> aliases / servers</div>
        </div></div>`;
      if (matchMedia("(prefers-reduced-motion: reduce)").matches) stage.querySelector<SVGSVGElement>(".planet")?.pauseAnimations();
      return;
    }
    stage.querySelectorAll(".splash, .hud").forEach((el) => el.remove());
    const visible = this.visibleSessions();
    // Split is a two-pane grid and shares its styling.
    stage.className = `stage ${this.layout === "focus" ? "focus" : "grid"}`;
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

  /** Drags a sidebar row to a new position among its project's sessions; the grid and ⌘1–9 follow that order. */
  private dragSession(e: PointerEvent) {
    const t = e.target as HTMLElement;
    const row = t.closest<HTMLElement>(".sess");
    const s = this.sessions.find((x) => x.rec.id === row?.dataset.select);
    if (!row || !s || e.button !== 0 || t.closest("button, input")) return;
    const startY = e.clientY;
    let drop: { s: Session; after: boolean } | null = null;
    const clear = () => document.querySelectorAll(".drop-before, .drop-after").forEach((el) => el.classList.remove("drop-before", "drop-after"));
    const move = (ev: PointerEvent) => {
      if (!this.reordering && Math.abs(ev.clientY - startY) < 5) return;
      this.reordering = true;
      row.classList.add("dragging");
      clear();
      drop = null;
      const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>(".sess");
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
      row.classList.remove("dragging");
      if (!this.reordering) return;
      this.reordering = false;
      this.suppressClick = true;
      setTimeout(() => (this.suppressClick = false));
      if (drop) {
        this.sessions.splice(this.sessions.indexOf(s), 1);
        this.sessions.splice(this.sessions.indexOf(drop.s) + (drop.after ? 1 : 0), 0, s);
        this.save();
      }
      this.renderAll();
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
    return [
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
    const commands: Command[] = [
      ...this.sessions.map((s, i) => ({
        label: s.rec.name,
        detail: `${s.project.name} · ${s.rec.kind === "claude" ? "Claude" : "shell"} · ${STATUS_LABEL[s.status]}`,
        hint: i < 9 ? `⌘${i + 1}` : undefined,
        color: s.project.color,
        run: () => this.select(s.rec.id),
      })),
      { label: "New Claude agent…", hint: "⌘N", run: () => this.newAgent() },
      { label: "New shell", hint: "⌘T", run: () => this.newSession("shell") },
      { label: "Add project…", hint: "⌘O", run: () => this.addProject() },
      { label: "Find in terminal", hint: "⌘F", run: () => this.selected?.openSearch() },
      { label: this.layout === "grid" ? "Focus view" : "Grid view", hint: "⌘G", run: () => this.setLayout(this.layout === "grid" ? "focus" : "grid") },
      { label: this.layout === "split" ? "Leave split view" : "Split view", hint: "⌘\\", run: () => this.toggleSplit() },
      { label: "Next waiting session", hint: "⌘J", run: () => this.nextWaiting() },
      { label: "Toggle sidebar", hint: "⌘B", run: () => this.setSidebarHidden(!this.sidebarHidden) },
      { label: "Aliases…", hint: "⌘⇧P", run: () => this.aliases.open() },
    ];
    const perProject = await Promise.all(this.projects.map(async (p) => ({ p, actions: await this.projectActions(p) })));
    for (const { p, actions } of perProject) {
      for (const a of actions) if (a) commands.push({ label: a.label, detail: p.name, hint: a.hint, color: p.color, run: a.run });
    }
    this.palette.open(commands);
  }

  // ── input ────────────────────────────────────────────────────────────

  private bindChrome() {
    $("#app").classList.toggle("no-sidebar", this.sidebarHidden);
    $("#waiting-pill").addEventListener("click", () => this.nextWaiting());
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
      if (this.suppressClick) return;
      const t = e.target as HTMLElement;
      const data = (attr: string) => t.closest<HTMLElement>(`[${attr}]`)?.getAttribute(attr) ?? undefined;
      const sessionById = (id?: string) => this.sessions.find((s) => s.rec.id === id);
      const project = this.projects.find((p) => p.id === data("data-collapse"));
      if (project) return this.toggleCollapsed(project);
      const editing = sessionById(data("data-edit"));
      const label = editing && t.closest(".sess")?.querySelector<HTMLElement>("[data-rename]");
      if (editing && label) return this.startRename(label, editing);
      if (data("data-new") === "claude") return this.newAgent(data("data-pid"));
      if (data("data-new")) return this.newSession(data("data-new") as Kind, data("data-pid"));
      const changed = this.projects.find((p) => p.id === data("data-diff"));
      if (changed) return this.showChanges(changed);
      if (data("data-remove")) return this.removeProject(data("data-remove")!);
      if (data("data-close")) return this.closeSession(sessionById(data("data-close")));
      if (data("data-select")) return this.select(data("data-select"));
      if (data("data-project")) {
        this.activeProjectId = data("data-project");
        this.renderAll();
      }
    });
    $("#projects").addEventListener("dblclick", (e) => {
      const target = (e.target as HTMLElement).closest<HTMLElement>("[data-rename]");
      const s = this.sessions.find((x) => x.rec.id === target?.dataset.rename);
      if (target && s) this.startRename(target, s);
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
    });
    $("#stage").addEventListener("pointerdown", (e) => {
      const gutter = (e.target as HTMLElement).closest<HTMLElement>(".gutter");
      if (gutter) this.dragGutter(e, gutter);
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
        const shifted: Record<string, () => unknown> = { r: () => this.renameSelected(), p: () => this.aliases.open() };
        let action = (e.shiftKey ? shifted : actions)[key];
        if (/^[1-9]$/.test(key)) action = () => this.sessions[Number(key) - 1] && this.select(this.sessions[Number(key) - 1].rec.id);
        if (!action) return;
        e.preventDefault();
        e.stopPropagation();
        action();
      },
      true,
    );
    window.addEventListener("focus", () => this.selected?.focus());
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
