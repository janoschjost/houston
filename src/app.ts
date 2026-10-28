import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { api, type LimitWindow, type RateLimits, type ShellInfo } from "./api";
import { Completer } from "./completion";
import { Session, shortPath, type Kind, type ProjectRec, type SessionRec } from "./session";

type Layout = "focus" | "grid";

interface Persisted {
  version: 1;
  projects: ProjectRec[];
  sessions: SessionRec[];
  selectedId?: string;
  layout: Layout;
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
  private completer = new Completer();
  private saveTimer?: number;
  private sidebarKey = "";
  private badge = 0;
  private notifyAllowed = false;
  /** Sidebar re-renders are paused while a session name is being edited in place. */
  private renaming = false;

  constructor(private shell: ShellInfo) {
    this.completer.load(shell);
  }

  async start() {
    const saved = await api.loadState<Persisted>().catch(() => null);
    if (saved) {
      this.projects = saved.projects;
      this.layout = saved.layout ?? "focus";
      for (const rec of saved.sessions) {
        const project = this.projects.find((p) => p.id === rec.projectId);
        // Sessions from before auto-naming still carry their placeholder name.
        if (rec.kind === "claude" && rec.autoName === undefined && /^agent-\d+$/.test(rec.name)) rec.autoName = true;
        if (project) this.sessions.push(this.makeSession(rec, project));
      }
      this.selectedId = this.sessions.find((s) => s.rec.id === saved.selectedId)?.rec.id ?? this.sessions[0]?.rec.id;
    }
    this.bindChrome();
    this.renderAll();
    setInterval(() => this.tick(), 400);
    this.pollLimits();
    setInterval(() => this.pollLimits(), 15_000);
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

  private save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      const state: Persisted = {
        version: 1,
        projects: this.projects,
        sessions: this.sessions.map((s) => s.rec),
        selectedId: this.selectedId,
        layout: this.layout,
      };
      api.saveState(state).catch((e) => console.error("save failed", e));
    }, 300);
  }

  private async addProject(): Promise<ProjectRec | undefined> {
    const path = await open({ directory: true, multiple: false, title: "Add project folder" });
    if (typeof path !== "string") return;
    let project = this.projects.find((p) => p.path === path);
    if (!project) {
      project = { id: crypto.randomUUID(), path, name: path.split("/").filter(Boolean).pop() ?? path };
      this.projects.push(project);
      this.save();
    }
    this.activeProjectId = project.id;
    this.renderAll();
    return project;
  }

  private async newSession(kind: Kind, projectId?: string) {
    let project: ProjectRec | undefined =
      this.projects.find((p) => p.id === projectId) ??
      this.selected?.project ??
      this.projects.find((p) => p.id === this.activeProjectId) ??
      this.projects[0];
    project ??= await this.addProject();
    if (!project) return;
    const siblings = this.sessions.filter((s) => s.project.id === project.id && s.rec.kind === kind).length;
    const rec: SessionRec = {
      id: crypto.randomUUID(),
      projectId: project.id,
      kind,
      name: kind === "claude" ? "new agent" : `tty-${String(siblings + 1).padStart(2, "0")}`,
      autoName: kind === "claude" || undefined,
      claudeId: kind === "claude" ? crypto.randomUUID() : undefined,
      createdAt: Date.now(),
    };
    this.sessions.push(this.makeSession(rec, project));
    this.select(rec.id);
    this.save();
  }

  private select(id: string | undefined) {
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
    const live = s.status !== "exited" && s.status !== "dormant";
    if (live && !(await ask(`Terminate ${s.rec.name} in ${s.project.name}?${s.rec.kind === "claude" ? "\n\nThe conversation stays saved in Claude Code." : ""}`, { title: "Houston", kind: "warning", okLabel: "Terminate" }))) {
      return;
    }
    const index = this.sessions.indexOf(s);
    this.sessions.splice(index, 1);
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

  private setLayout(layout: Layout) {
    this.layout = layout;
    this.renderAll();
    this.selected?.focus();
    this.save();
  }

  private tick() {
    const now = performance.now();
    const appFocused = document.hasFocus();
    for (const s of this.sessions) {
      const visible = this.layout === "grid" || s.rec.id === this.selectedId;
      if (s.tick(now, appFocused && visible) && !appFocused && this.notifyAllowed) {
        const what = s.rec.kind === "claude" ? "is awaiting input" : `finished: ${s.runningCommand || "command"}`;
        sendNotification({ title: `${s.rec.name} · ${s.project.name}`, body: `${s.rec.name} ${what}` });
      }
    }
    const waiting = this.sessions.filter((s) => s.status === "attention").length;
    if (waiting !== this.badge) {
      this.badge = waiting;
      getCurrentWindow().setBadgeCount(waiting || undefined).catch(() => {});
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
      this.projects.map((p) => p.id),
      this.activeProjectId,
      this.selectedId,
      this.sessions.map((s) => [s.rec.name, s.status, s.title, s.cwd, s.runningCommand]),
    ]);
    if (key === this.sidebarKey || this.renaming) return;
    this.sidebarKey = key;

    let n = 0;
    const html = this.projects
      .map((p) => {
        const mine = this.sessions.filter((s) => s.project.id === p.id);
        const rows = mine
          .map((s) => {
            const index = this.sessions.indexOf(s) + 1;
            const sub = s.rec.kind === "claude" ? (!s.rec.autoName && s.title) || "claude code" : s.runningCommand ? `⟫ ${s.runningCommand}` : shortPath(s.cwd, home);
            n++;
            return `<div class="sess${s.rec.id === this.selectedId ? " sel" : ""}" data-status="${s.status}" data-select="${s.rec.id}">
              <span class="dot"></span>
              <div class="sess-body">
                <div class="sess-line"><span class="sess-name" data-rename="${s.rec.id}">${escapeHtml(s.rec.name)}</span><span class="tag tag-${s.rec.kind}">${s.rec.kind === "claude" ? "CC" : "SH"}</span></div>
                <div class="sess-sub">${escapeHtml(sub)}</div>
              </div>
              <span class="sess-key">${index <= 9 ? `⌘${index}` : ""}</span>
              <button class="sess-close" data-close="${s.rec.id}" title="Close session">×</button>
            </div>`;
          })
          .join("");
        return `<section class="proj${p.id === this.activeProjectId ? " active" : ""}">
          <div class="proj-head" data-project="${p.id}">
            <span class="proj-name">${escapeHtml(p.name)}</span>
            <span class="proj-path">${escapeHtml(shortPath(p.path, home))}</span>
            <span class="proj-actions">
              <button data-new="claude" data-pid="${p.id}" title="New Claude session">✦</button>
              <button data-new="shell" data-pid="${p.id}" title="New shell">›_</button>
              ${mine.length ? "" : `<button data-remove="${p.id}" title="Remove project">×</button>`}
            </span>
          </div>
          ${rows || `<div class="proj-empty">no sessions</div>`}
        </section>`;
      })
      .join("");
    $("#projects").innerHTML = html || `<div class="side-empty">No projects yet<br><span>⌘O to add one</span></div>`;

    const count = (st: string) => this.sessions.filter((s) => s.status === st).length;
    $("#telemetry").innerHTML = `<span>${count("working")} working</span><span class="t-attention">${count("attention")} waiting</span><span>${n - count("working") - count("attention")} standby</span>`;
  }

  /** Remaining plan usage per window, refreshed from what Claude Code last reported. */
  private async pollLimits() {
    const limits = await api.claudeLimits().catch(() => null);
    $("#limits").innerHTML = renderLimits(limits);
  }

  private renderCrumbs() {
    const s = this.selected;
    const html = s
      ? `<span class="c-proj">${escapeHtml(s.project.name)}</span> <span class="c-dim">▸</span> <span class="c-sess">${escapeHtml(s.rec.name)}</span> <span class="c-dim">· ${escapeHtml(shortPath(s.cwd, this.shell.home))}</span>`
      : `<span class="c-dim">No active mission</span>`;
    const el = $("#crumbs");
    if (el.innerHTML !== html) el.innerHTML = html;
  }

  private renderStage() {
    const stage = $("#stage");
    document.querySelectorAll<HTMLElement>("[data-layout]").forEach((b) => b.classList.toggle("on", b.dataset.layout === this.layout));
    if (!this.sessions.length) {
      stage.className = "stage empty";
      stage.innerHTML = `${HUD(this.projects.length)}<div class="splash"><pre class="logo">${LOGO}</pre>
        <div class="splash-sub">Mission control for Claude Code · v0.1</div>
        <div class="splash-keys">
          <div><kbd>⌘O</kbd> add project</div><div><kbd>⌘N</kbd> new Claude session</div>
          <div><kbd>⌘T</kbd> open shell</div><div><kbd>⌘G</kbd> grid / focus</div>
          <div><kbd>⌘1-9</kbd> jump to session</div><div><kbd>⌘W</kbd> close session</div>
        </div></div>`;
      return;
    }
    stage.querySelectorAll(".splash, .hud").forEach((el) => el.remove());
    const visible = this.layout === "grid" ? this.sessions : this.sessions.filter((s) => s.rec.id === this.selectedId);
    stage.className = `stage ${this.layout}`;
    const cols = this.layout === "grid" ? Math.ceil(Math.sqrt(visible.length)) : 1;
    stage.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    for (const s of this.sessions) {
      if (!visible.includes(s)) s.el.remove();
    }
    for (const s of visible) {
      s.el.classList.toggle("sel", s.rec.id === this.selectedId);
      s.attach(stage);
    }
    // Keep DOM order matching session order in the grid.
    for (const s of visible) stage.appendChild(s.el);
  }

  // ── input ────────────────────────────────────────────────────────────

  private bindChrome() {
    $("#add-project").addEventListener("click", () => this.addProject());
    $("#new-claude").addEventListener("click", () => this.newSession("claude"));
    $("#new-shell").addEventListener("click", () => this.newSession("shell"));
    document.querySelectorAll<HTMLElement>("[data-layout]").forEach((b) =>
      b.addEventListener("click", () => this.setLayout(b.dataset.layout as Layout)),
    );

    $("#projects").addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      const data = (attr: string) => t.closest<HTMLElement>(`[${attr}]`)?.getAttribute(attr) ?? undefined;
      const sessionById = (id?: string) => this.sessions.find((s) => s.rec.id === id);
      if (data("data-new")) return this.newSession(data("data-new") as Kind, data("data-pid"));
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
        this.selectedId = pane.dataset.id;
        this.activeProjectId = this.selected?.project.id;
        this.sessions.forEach((s) => s.el.classList.toggle("sel", s.rec.id === this.selectedId));
        this.renderSidebar();
        this.renderCrumbs();
        this.save();
      }
    });
    $("#stage").addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("[data-action=relaunch]")) this.selected?.launch();
    });
    $("#stage").addEventListener("dblclick", (e) => {
      if ((e.target as HTMLElement).closest(".pane-header") && this.layout === "grid") this.setLayout("focus");
    });

    // Capture phase so shortcuts win over the terminal and input editor.
    window.addEventListener(
      "keydown",
      (e) => {
        if (!e.metaKey || e.ctrlKey || e.altKey) return;
        const key = e.key.toLowerCase();
        const actions: Record<string, () => unknown> = {
          n: () => this.newSession("claude"),
          t: () => this.newSession("shell"),
          o: () => this.addProject(),
          w: () => this.closeSession(this.selected),
          g: () => this.setLayout(this.layout === "grid" ? "focus" : "grid"),
          k: () => this.selected?.clear(),
          r: () => this.selected?.status === "exited" && this.selected.launch(),
          "[": () => this.cycle(-1),
          "]": () => this.cycle(1),
        };
        let action = e.shiftKey ? undefined : actions[key];
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
