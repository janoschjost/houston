import { api, type ActivityEvent } from "./api";
import { icon } from "./icons";

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** How an event is grouped and filtered. */
type Cat = "prompt" | "edit" | "run" | "read" | "reply";

const CATS: { cat: Cat; label: string }[] = [
  { cat: "prompt", label: "Prompts" },
  { cat: "edit", label: "Edits" },
  { cat: "run", label: "Commands" },
  { cat: "read", label: "Reads" },
  { cat: "reply", label: "Replies" },
];

/** Rank when several events share one minimap slot: the most telling one wins. */
const PRIORITY: Cat[] = ["prompt", "edit", "run", "read", "reply"];

/** Minimap slots across the bar. */
const SLOTS = 240;

const category = (e: ActivityEvent): Cat =>
  e.kind === "prompt" ? "prompt" : e.kind === "reply" ? "reply" : e.edit ? "edit" : e.tool === "Bash" ? "run" : "read";

const clock = (ms: number) => {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

const elapsed = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `T+${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
};

interface Row {
  e: ActivityEvent;
  cat: Cat;
  at: number;
}

/** ⌘E overlay: everything a Claude session did, read from its transcript, with a minimap and a scrubber. */
export class TimelinePanel {
  readonly el: HTMLElement;
  private rows: Row[] = [];
  private shown: Row[] = [];
  private off = new Set<Cat>(["reply"]);
  private claudeId = "";
  private projectPath = "";
  private timer?: number;
  private renderedKey = "";
  private titleEl: HTMLElement;
  private chipsEl: HTMLElement;
  private mapEl: HTMLElement;
  private listEl: HTMLElement;
  private scrubEl: HTMLInputElement;
  private readoutEl: HTMLElement;

  constructor(private closed: () => void) {
    this.el = document.createElement("div");
    this.el.className = "palette-backdrop timeline-backdrop hidden";
    this.el.tabIndex = -1;
    this.el.innerHTML = `<div class="palette timeline" role="dialog" aria-label="Mission timeline">
      <div class="diff-head"><span class="diff-title tl-title"></span><button data-act="refresh" title="Refresh" aria-label="Refresh">${icon("refresh")}</button><button data-act="close" title="Close (esc)" aria-label="Close">${icon("close")}</button></div>
      <div class="tl-chips"></div>
      <div class="tl-map" title="Click to jump"></div>
      <div class="tl-list" tabindex="0"></div>
      <div class="tl-scrub"><input type="range" min="0" max="0" value="0" aria-label="Scrub through the mission" /><span class="tl-readout"></span></div>
    </div>`;
    this.titleEl = this.el.querySelector(".tl-title")!;
    this.chipsEl = this.el.querySelector(".tl-chips")!;
    this.mapEl = this.el.querySelector(".tl-map")!;
    this.listEl = this.el.querySelector(".tl-list")!;
    this.scrubEl = this.el.querySelector("input")!;
    this.readoutEl = this.el.querySelector(".tl-readout")!;
    this.el.addEventListener("mousedown", (e) => e.target === this.el && this.close());
    this.el.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape" || (e.metaKey && e.key.toLowerCase() === "e")) {
        e.preventDefault();
        this.close();
      }
    });
    this.el.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      const act = t.closest<HTMLElement>("[data-act]")?.dataset.act;
      if (act === "close") return this.close();
      if (act === "refresh") return void this.load();
      const cat = t.closest<HTMLElement>("[data-cat]")?.dataset.cat as Cat | undefined;
      if (cat) {
        if (this.off.has(cat)) this.off.delete(cat);
        else this.off.add(cat);
        this.renderedKey = "";
        return this.render(true);
      }
      const slot = t.closest<HTMLElement>("[data-first]")?.dataset.first;
      if (slot !== undefined) this.jump(Number(slot));
    });
    this.scrubEl.addEventListener("input", () => this.jump(Number(this.scrubEl.value), false));
  }

  get isOpen() {
    return !this.el.classList.contains("hidden");
  }

  open(name: string, color: string, projectPath: string, claudeId: string) {
    this.claudeId = claudeId;
    this.projectPath = projectPath;
    this.rows = [];
    this.renderedKey = "";
    this.titleEl.innerHTML = `${icon("timeline")} Timeline · <span style="color: ${color}">${escapeHtml(name)}</span>`;
    this.el.classList.remove("hidden");
    this.listEl.innerHTML = `<div class="pal-empty">Reading transcript…</div>`;
    this.el.focus();
    void this.load(true);
    // New events keep arriving while an agent works.
    this.timer = window.setInterval(() => void this.load(), 2000);
  }

  close() {
    clearInterval(this.timer);
    this.el.classList.add("hidden");
    this.closed();
  }

  private async load(first = false) {
    const id = this.claudeId;
    const events = await api.claudeTimeline(id).catch(() => [] as ActivityEvent[]);
    if (id !== this.claudeId || !this.isOpen) return;
    this.rows = events.map((e) => ({ e, cat: category(e), at: Date.parse(e.ts) || 0 }));
    this.render(first);
  }

  private render(jumpToEnd: boolean) {
    this.shown = this.rows.filter((r) => !this.off.has(r.cat));
    const key = `${this.rows.length}|${this.off.size}|${this.shown.length}`;
    if (key === this.renderedKey) return;
    this.renderedKey = key;

    const counts = new Map<Cat, number>();
    for (const r of this.rows) counts.set(r.cat, (counts.get(r.cat) ?? 0) + 1);
    this.chipsEl.innerHTML = CATS.map(({ cat, label }) => `<button class="tl-chip tl-${cat}${this.off.has(cat) ? " off" : ""}" data-cat="${cat}">${label} <b>${counts.get(cat) ?? 0}</b></button>`).join("");

    const list = this.listEl;
    const follow = jumpToEnd || list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    const t0 = this.rows[0]?.at ?? 0;
    const rel = (p: string) => (this.projectPath && p.startsWith(this.projectPath + "/") ? p.slice(this.projectPath.length + 1) : p);
    list.innerHTML = this.shown.length
      ? this.shown
          .map((r, i) => {
            const e = r.e;
            const tag = r.cat === "prompt" ? "PROMPT" : r.cat === "reply" ? "SAID" : r.cat === "edit" ? "EDIT" : r.cat === "run" ? "RUN" : (e.tool || "TOOL").toUpperCase();
            const text = e.path && r.cat !== "run" ? rel(e.path) : e.summary;
            return `<div class="tl-row tl-${r.cat}" data-i="${i}" title="${escapeHtml(e.summary)}"><span class="tl-time">${r.at ? clock(r.at) : ""}</span><span class="tl-tag">${escapeHtml(tag)}</span><span class="tl-text">${escapeHtml(text)}</span></div>`;
          })
          .join("")
      : `<div class="pal-empty">${this.rows.length ? "Everything is filtered out" : "Nothing recorded yet. The transcript fills as the agent works."}</div>`;

    // Minimap: one slot per slice of the mission, coloured by its most telling event.
    const t1 = this.rows.at(-1)?.at ?? t0;
    const span = Math.max(1, t1 - t0);
    const slots = new Map<number, { cat: Cat; first: number }>();
    this.shown.forEach((r, i) => {
      const slot = Math.min(SLOTS - 1, Math.floor(((r.at - t0) / span) * SLOTS));
      const cur = slots.get(slot);
      if (!cur) slots.set(slot, { cat: r.cat, first: i });
      else if (PRIORITY.indexOf(r.cat) < PRIORITY.indexOf(cur.cat)) cur.cat = r.cat;
    });
    this.mapEl.innerHTML = [...slots]
      .map(([slot, { cat, first }]) => `<i class="tl-${cat}" data-first="${first}" style="left: ${(slot / SLOTS) * 100}%"></i>`)
      .join("");

    this.scrubEl.max = String(Math.max(0, this.shown.length - 1));
    if (follow) {
      list.scrollTop = list.scrollHeight;
      this.scrubEl.value = this.scrubEl.max;
    }
    this.readout(Number(this.scrubEl.value));
  }

  /** Scrolls to an event, marks it and moves the scrubber and readout to it. */
  private jump(i: number, scroll = true) {
    const row = this.listEl.querySelector<HTMLElement>(`[data-i="${i}"]`);
    this.listEl.querySelector(".cur")?.classList.remove("cur");
    row?.classList.add("cur");
    if (scroll) row?.scrollIntoView({ block: "center" });
    else row?.scrollIntoView({ block: "nearest" });
    this.scrubEl.value = String(i);
    this.readout(i);
  }

  private readout(i: number) {
    const r = this.shown[i];
    const t0 = this.rows[0]?.at ?? 0;
    this.readoutEl.textContent = r ? `${elapsed(r.at - t0)} · ${i + 1}/${this.shown.length}` : "";
  }
}
