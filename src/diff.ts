import { api } from "./api";
import { icon } from "./icons";

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Lines rendered per file; the rest of a very large diff is cut off. */
const MAX_LINES = 4000;

interface FileDiff {
  path: string;
  status: "added" | "deleted" | "renamed" | "modified";
  added: number;
  removed: number;
  binary: boolean;
  /** Hunk lines, from the first "@@". */
  lines: string[];
}

/** Splits `git diff` output into files. */
export function parseDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  for (const chunk of text.split(/^diff --git /m).slice(1)) {
    const lines = chunk.split("\n");
    const start = lines.findIndex((l) => l.startsWith("@@"));
    const header = start < 0 ? lines : lines.slice(0, start);
    const field = (prefix: string) => header.find((l) => l.startsWith(prefix))?.slice(prefix.length);
    const strip = (p?: string) => (p && p !== "/dev/null" ? p.replace(/^[ab]\//, "") : undefined);
    const path = field("rename to ") ?? strip(field("+++ ")) ?? strip(field("--- ")) ?? lines[0].replace(/^a\/(.*) b\/.*$/, "$1");
    const hunks = lines.slice(header.length).filter((l, i, all) => l || i < all.length - 1);
    files.push({
      path,
      status: field("new file") !== undefined ? "added" : field("deleted file") !== undefined ? "deleted" : field("rename to ") ? "renamed" : "modified",
      added: hunks.filter((l) => l.startsWith("+")).length,
      removed: hunks.filter((l) => l.startsWith("-")).length,
      binary: header.some((l) => l.startsWith("Binary files")),
      lines: hunks,
    });
  }
  return files;
}

const STATUS_MARK = { added: "A", deleted: "D", renamed: "R", modified: "M" };

const LINE_HEIGHT = 17;

/** Lines of `b` that differ from `a`, and the lines of `a` removed before each index of `b`. */
export function lineDiff(a: string[], b: string[]) {
  const added = new Set<number>();
  const removed = new Map<number, string[]>();
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) (endA--, endB--);
  const n = endA - start, m = endB - start;
  if (n * m > 4_000_000) {
    for (let j = start; j < endB; j++) added.add(j);
    if (n) removed.set(start, a.slice(start, endA));
    return { added, removed };
  }
  const w = m + 1, t = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) t[i * w + j] = a[start + i] === b[start + j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[start + i] === b[start + j]) (i++, j++);
    else if (j < m && (i === n || t[i * w + j + 1] >= t[(i + 1) * w + j])) added.add(start + j++);
    else {
      const k = start + j;
      if (!removed.has(k)) removed.set(k, []);
      removed.get(k)!.push(a[start + i++]);
    }
  }
  return { added, removed };
}

/** Overlay showing a project's uncommitted changes: file list on the left, the selected file on the right, editable in place. */
export class DiffPanel {
  readonly el: HTMLElement;
  private files: FileDiff[] = [];
  private index = 0;
  private cwd = "";
  private listEl: HTMLElement;
  private bodyEl: HTMLElement;
  private titleEl: HTMLElement;
  /** "edit" shows the file as an editor with change markers; "hunks" the plain diff. */
  private mode: "edit" | "hunks" = "edit";
  /** Bumped on every file switch so a slow read cannot land in the wrong file. */
  private token = 0;
  /** Pending autosave of the open editor. */
  private flushEdit: (() => Promise<void>) | null = null;

  /** `closed` runs whenever the panel closes, e.g. to give the terminal its focus back. */
  constructor(private closed: () => void) {
    this.el = document.createElement("div");
    this.el.className = "palette-backdrop diff-backdrop hidden";
    this.el.innerHTML = `<div class="diff" role="dialog" aria-label="Changes">
      <div class="diff-head"><span class="diff-title"></span><button data-refresh title="Refresh">${icon("refresh")}</button><button data-close title="Close (esc)">${icon("close")}</button></div>
      <div class="diff-main"><div class="diff-files" role="listbox"></div><div class="diff-body"></div></div>
    </div>`;
    this.listEl = this.el.querySelector(".diff-files")!;
    this.bodyEl = this.el.querySelector(".diff-body")!;
    this.titleEl = this.el.querySelector(".diff-title")!;
    this.el.tabIndex = -1;
    this.el.addEventListener("mousedown", (e) => e.target === this.el && this.close());
    this.el.querySelector("[data-close]")!.addEventListener("click", () => this.close());
    this.el.querySelector("[data-refresh]")!.addEventListener("click", () => this.load());
    this.listEl.addEventListener("click", (e) => {
      const i = Number((e.target as HTMLElement).closest<HTMLElement>("[data-i]")?.dataset.i);
      if (!Number.isNaN(i)) this.go(i);
    });
    this.bodyEl.addEventListener("click", async (e) => {
      if (!(e.target as HTMLElement).closest("[data-toggle]")) return;
      await this.flushEdit?.();
      this.mode = this.mode === "edit" ? "hunks" : "edit";
      this.show(this.index);
    });
    this.el.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if ((e.target as HTMLElement).tagName === "TEXTAREA") {
        if (e.key === "Escape") this.close();
        else if (e.key === "s" && e.metaKey) this.flushEdit?.();
        else if (e.key === "Tab" && !e.shiftKey && !e.metaKey && !e.ctrlKey) document.execCommand("insertText", false, "  ");
        else return;
        e.preventDefault();
        return;
      }
      const step = e.key === "ArrowDown" || e.key === "j" ? 1 : e.key === "ArrowUp" || e.key === "k" ? -1 : 0;
      if (e.key === "Escape") this.close();
      else if (step && this.files.length) this.go((this.index + step + this.files.length) % this.files.length);
      else return;
      e.preventDefault();
    });
  }

  get isOpen() {
    return !this.el.classList.contains("hidden");
  }

  async open(name: string, cwd: string, color: string) {
    this.cwd = cwd;
    this.titleEl.innerHTML = `<span style="color: ${color}">${escapeHtml(name)}</span> <span class="c-dim">· uncommitted changes</span>`;
    this.el.classList.remove("hidden");
    this.el.focus();
    this.index = 0;
    await this.load();
  }

  async close() {
    await this.flushEdit?.();
    this.flushEdit = null;
    this.token++;
    this.el.classList.add("hidden");
    this.closed();
  }

  private async go(index: number) {
    if (index === this.index && this.flushEdit) return;
    await this.flushEdit?.();
    this.show(index);
  }

  /** Reads the diff again; `keepBody` leaves the open editor alone and only refreshes the file list. */
  private async load(keepBody = false) {
    await this.flushEdit?.();
    const path = this.files[this.index]?.path;
    if (!keepBody) {
      this.listEl.innerHTML = `<div class="pal-empty">Reading diff…</div>`;
      this.bodyEl.innerHTML = "";
    }
    try {
      this.files = parseDiff(await api.gitDiff(this.cwd));
    } catch (e) {
      this.files = [];
      this.listEl.innerHTML = `<div class="pal-empty">${escapeHtml(String(e))}</div>`;
      return;
    }
    // An edit that reverts a file to HEAD empties its entry; the editor stays until the user moves on.
    if (keepBody && !this.files.some((f) => f.path === path)) return;
    if (!this.files.length) {
      this.listEl.innerHTML = `<div class="pal-empty">Working tree clean</div>`;
      this.bodyEl.innerHTML = "";
      this.flushEdit = null;
      return;
    }
    const at = Math.max(0, this.files.findIndex((f) => f.path === path));
    if (keepBody) {
      this.index = at;
      this.renderList();
    } else this.show(at);
  }

  private renderList() {
    this.listEl.innerHTML = this.files
      .map((f, i) => {
        const slash = f.path.lastIndexOf("/") + 1;
        return `<div class="diff-file${i === this.index ? " sel" : ""}" data-i="${i}" role="option" aria-selected="${i === this.index}" title="${escapeHtml(f.path)}">
          <span class="df-mark df-${f.status}">${STATUS_MARK[f.status]}</span>
          <span class="df-path"><span class="c-dim">${escapeHtml(f.path.slice(0, slash))}</span>${escapeHtml(f.path.slice(slash))}</span>
          <span class="df-add">${f.added ? `+${f.added}` : ""}</span><span class="df-del">${f.removed ? `−${f.removed}` : ""}</span>
        </div>`;
      })
      .join("");
    this.listEl.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
  }

  private show(index: number) {
    this.index = index;
    this.flushEdit = null;
    const token = ++this.token;
    this.renderList();
    const f = this.files[index];
    const editable = !f.binary && f.status !== "deleted";
    const bar = (extra: string) =>
      `<div class="diff-bar"><span class="c-dim">${escapeHtml(f.path)}</span>${extra}${editable ? `<button data-toggle>${this.mode === "edit" ? "Show hunks" : "Edit"}</button>` : ""}</div>`;
    if (editable && this.mode === "edit") {
      this.bodyEl.innerHTML = bar("") + `<div class="pal-empty">Reading file…</div>`;
      Promise.all([api.readProjectFile(this.cwd, f.path), api.gitHeadFile(this.cwd, f.path)])
        .then(([text, head]) => token === this.token && this.renderEditor(f, text, head, bar))
        .catch((e) => token === this.token && (this.bodyEl.innerHTML = bar("") + `<div class="pal-empty">${escapeHtml(String(e))}</div>`));
      return;
    }
    const cls = (l: string) => (l.startsWith("@@") ? "dl-hunk" : l.startsWith("+") ? "dl-add" : l.startsWith("-") ? "dl-del" : l.startsWith("\\") ? "dl-note" : "");
    const body = f.binary
      ? `<div class="pal-empty">Binary file</div>`
      : f.lines
          .slice(0, MAX_LINES)
          .map((l) => `<div class="${cls(l)}">${escapeHtml(l) || " "}</div>`)
          .join("") + (f.lines.length > MAX_LINES ? `<div class="dl-note">… ${f.lines.length - MAX_LINES} more lines</div>` : "");
    this.bodyEl.innerHTML = `${bar("")}<pre>${body}</pre>`;
    this.bodyEl.scrollTop = 0;
  }

  /**
   * The file as a plain editor, PhpStorm-style: changed lines are tinted and marked in the gutter, a red marker
   * where lines were removed opens their old text, and edits save on their own shortly after typing stops.
   */
  private renderEditor(f: FileDiff, text: string, head: string, bar: (extra: string) => string) {
    this.bodyEl.innerHTML = `${bar(`<span class="ed-state c-dim"></span>`)}
      <div class="ed"><div class="ed-wrap"><div class="ed-gutter"></div><div class="ed-stack"><div class="ed-mirror"></div><textarea class="ed-area" spellcheck="false" wrap="off" autocapitalize="off" autocomplete="off"></textarea></div></div></div>`;
    const scroller = this.bodyEl.querySelector<HTMLElement>(".ed")!;
    const wrap = this.bodyEl.querySelector<HTMLElement>(".ed-wrap")!;
    const gutter = this.bodyEl.querySelector<HTMLElement>(".ed-gutter")!;
    const mirror = this.bodyEl.querySelector<HTMLElement>(".ed-mirror")!;
    const area = this.bodyEl.querySelector<HTMLTextAreaElement>(".ed-area")!;
    const state = this.bodyEl.querySelector<HTMLElement>(".ed-state")!;
    const headLines = head.split("\n");
    let saved = text;
    let timer: number | undefined;
    let diffTimer: number | undefined;
    let diff = lineDiff(headLines, text.split("\n"));
    const gutterWidth = () => `${Math.max(3, String(area.value.split("\n").length).length + 1)}ch`;

    const paint = () => {
      const lines = area.value.split("\n");
      mirror.innerHTML = lines.map((l, i) => `<div class="${diff.added.has(i) ? "ed-l add" : "ed-l"}">${escapeHtml(l) || " "}</div>`).join("");
      gutter.style.width = gutterWidth();
      gutter.innerHTML = lines
        .map((_, i) => `<div class="ed-ln${diff.added.has(i) ? " add" : ""}${diff.removed.has(i) ? " del" : ""}" data-ln="${i}">${i + 1}</div>`)
        .join("");
      // lines removed after the last line sit on the final row
      if (diff.removed.has(lines.length)) gutter.lastElementChild?.classList.add("del-after");
    };
    const status = (s: string) => (state.textContent = s);
    const save = async () => {
      window.clearTimeout(timer);
      if (area.value === saved) return;
      const value = area.value;
      try {
        await api.writeProjectFile(this.cwd, f.path, value);
        saved = value;
        status("saved");
        this.load(true);
      } catch (e) {
        status(`save failed: ${e}`);
      }
    };
    this.flushEdit = save;

    area.value = text;
    paint();
    area.addEventListener("input", () => {
      status("editing…");
      window.clearTimeout(timer);
      timer = window.setTimeout(save, 700);
      window.clearTimeout(diffTimer);
      paint();
      diffTimer = window.setTimeout(() => {
        diff = lineDiff(headLines, area.value.split("\n"));
        paint();
      }, 150);
    });
    area.addEventListener("blur", () => save());
    gutter.addEventListener("click", (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>(".ed-ln");
      const open = wrap.querySelector(".ed-old");
      if (open) open.remove();
      if (!row || (!row.classList.contains("del") && !row.classList.contains("del-after"))) return;
      const key = row.classList.contains("del") ? Number(row.dataset.ln) : area.value.split("\n").length;
      const box = document.createElement("pre");
      box.className = "ed-old";
      box.style.left = `${gutter.offsetWidth + 8}px`;
      box.style.top = `${8 + Number(row.dataset.ln) * LINE_HEIGHT}px`;
      box.textContent = (diff.removed.get(key) ?? []).join("\n");
      box.addEventListener("click", () => box.remove());
      wrap.appendChild(box);
    });
    const first = [...diff.added, ...diff.removed.keys()].sort((a, b) => a - b)[0] ?? 0;
    scroller.scrollTop = Math.max(0, first - 4) * LINE_HEIGHT;
    area.focus({ preventScroll: true });
    const offset = text.split("\n").slice(0, first).join("\n").length + (first ? 1 : 0);
    area.setSelectionRange(offset, offset);
  }
}
