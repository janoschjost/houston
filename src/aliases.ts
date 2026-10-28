import { ask } from "@tauri-apps/plugin-dialog";
import { api, type Alias } from "./api";

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface AliasPaletteContext {
  /** Opens a shell that runs the alias. */
  connect(alias: Alias): void;
  /** Called after an alias is added or renamed so new shells highlight it. */
  defined(name: string): void;
}

/** ⌘P overlay listing the aliases in .zshrc: filter, connect, add, edit and delete. */
export class AliasPalette {
  readonly el: HTMLElement;
  private aliases: Alias[] = [];
  private shown: Alias[] = [];
  private index = 0;
  /** Alias being edited; null while adding a new one, undefined while just listing. */
  private editing?: Alias | null;
  private filterEl: HTMLInputElement;
  private listEl: HTMLElement;
  private formEl: HTMLFormElement;
  private errorEl: HTMLElement;

  constructor(private ctx: AliasPaletteContext) {
    this.el = document.createElement("div");
    this.el.className = "palette-backdrop hidden";
    this.el.innerHTML = `<div class="palette" role="dialog" aria-label="Aliases">
      <div class="pal-head">
        <input class="pal-filter" placeholder="Filter aliases…" spellcheck="false" autocomplete="off" aria-label="Filter aliases" />
        <button class="pal-new" type="button">+ New</button>
      </div>
      <div class="pal-list" role="listbox"></div>
      <form class="pal-form hidden">
        <label>Name<input name="name" spellcheck="false" autocomplete="off" placeholder="prod-web" /></label>
        <label>Command<input name="command" spellcheck="false" autocomplete="off" placeholder="ssh deploy@10.0.0.12" /></label>
        <div class="pal-actions"><span class="pal-error" role="alert"></span><button type="button" data-cancel>Cancel</button><button type="submit" class="pal-save">Save to .zshrc</button></div>
      </form>
      <div class="pal-foot"><span><kbd>⏎</kbd> connect</span><span><kbd>⌘E</kbd> edit</span><span><kbd>⌘⌫</kbd> delete</span><span><kbd>esc</kbd> close</span></div>
    </div>`;
    this.filterEl = this.el.querySelector(".pal-filter")!;
    this.listEl = this.el.querySelector(".pal-list")!;
    this.formEl = this.el.querySelector(".pal-form")!;
    this.errorEl = this.el.querySelector(".pal-error")!;

    this.el.addEventListener("mousedown", (e) => e.target === this.el && this.close());
    this.el.addEventListener("keydown", (e) => this.onKey(e));
    this.filterEl.addEventListener("input", () => {
      this.index = 0;
      this.renderList();
    });
    this.el.querySelector(".pal-new")!.addEventListener("click", () => this.edit(null));
    this.el.querySelector("[data-cancel]")!.addEventListener("click", () => this.list());
    this.formEl.addEventListener("submit", (e) => {
      e.preventDefault();
      this.save();
    });
    this.listEl.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      const alias = this.shown[Number(t.closest<HTMLElement>("[data-i]")?.dataset.i)];
      if (!alias) return;
      if (t.closest("[data-edit]")) this.edit(alias);
      else if (t.closest("[data-delete]")) this.remove(alias);
      else this.connect(alias);
    });
  }

  get isOpen() {
    return !this.el.classList.contains("hidden");
  }

  async open() {
    this.el.classList.remove("hidden");
    this.filterEl.value = "";
    this.index = 0;
    this.list();
    await this.reload();
  }

  close() {
    this.el.classList.add("hidden");
  }

  /** Re-reads .zshrc, so edits made outside Houston show up too. */
  private async reload() {
    try {
      this.aliases = await api.listAliases();
      this.listEl.dataset.error = "";
    } catch (e) {
      this.aliases = [];
      this.listEl.dataset.error = String(e);
    }
    this.renderList();
  }

  private renderList() {
    const q = this.filterEl.value.trim().toLowerCase();
    this.shown = this.aliases.filter((a) => !q || a.name.toLowerCase().includes(q) || a.command.toLowerCase().includes(q));
    this.index = Math.min(this.index, Math.max(0, this.shown.length - 1));
    const error = this.listEl.dataset.error;
    this.listEl.innerHTML = this.shown.length
      ? this.shown
          .map(
            (a, i) => `<div class="pal-row${i === this.index ? " sel" : ""}" data-i="${i}" role="option" aria-selected="${i === this.index}">
              <span class="pal-name">${escapeHtml(a.name)}</span>
              <code class="pal-cmd" title="${escapeHtml(a.command)}">${escapeHtml(a.command)}</code>
              ${a.editable ? `<button data-edit title="Edit (⌘E)">✎</button>` : `<span class="pal-ro" title="Uses shell expansions; edit it in .zshrc">ro</span>`}
              <button data-delete title="Delete (⌘⌫)">×</button>
            </div>`,
          )
          .join("")
      : `<div class="pal-empty">${error ? escapeHtml(error) : q ? "No matching alias" : "No aliases in .zshrc yet"}</div>`;
    this.listEl.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
  }

  /** Back to the filterable list. */
  private list() {
    this.editing = undefined;
    this.formEl.classList.add("hidden");
    this.filterEl.disabled = false;
    this.filterEl.focus();
  }

  private edit(alias: Alias | null) {
    if (alias && !alias.editable) return;
    this.editing = alias;
    this.formEl.classList.remove("hidden");
    this.filterEl.disabled = true;
    this.errorEl.textContent = "";
    const name = this.formEl.elements.namedItem("name") as HTMLInputElement;
    (this.formEl.elements.namedItem("command") as HTMLInputElement).value = alias?.command ?? "";
    name.value = alias?.name ?? "";
    name.focus();
    name.select();
  }

  private async save() {
    const name = (this.formEl.elements.namedItem("name") as HTMLInputElement).value.trim();
    const command = (this.formEl.elements.namedItem("command") as HTMLInputElement).value.trim();
    try {
      await api.saveAlias(this.editing?.name ?? null, name, command);
    } catch (e) {
      this.errorEl.textContent = String(e);
      return;
    }
    this.ctx.defined(name);
    await this.reload();
    this.index = Math.max(0, this.shown.findIndex((a) => a.name === name));
    this.renderList();
    this.list();
  }

  private async remove(alias: Alias) {
    if (!(await ask(`Delete alias ${alias.name} from .zshrc?\n\n${alias.command}`, { title: "Houston", kind: "warning", okLabel: "Delete" }))) return;
    try {
      await api.deleteAlias(alias.name);
    } catch (e) {
      this.listEl.dataset.error = String(e);
    }
    await this.reload();
    this.filterEl.focus();
  }

  private connect(alias: Alias) {
    this.close();
    this.ctx.connect(alias);
  }

  private onKey(e: KeyboardEvent) {
    // Keys stay inside the palette so app shortcuts and terminals don't react underneath.
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      if (this.editing !== undefined) this.list();
      else this.close();
      return;
    }
    if (this.editing !== undefined) return;
    const current = this.shown[this.index];
    const move = (d: number) => {
      e.preventDefault();
      if (!this.shown.length) return;
      this.index = (this.index + d + this.shown.length) % this.shown.length;
      this.renderList();
    };
    if (e.key === "ArrowDown") move(1);
    else if (e.key === "ArrowUp") move(-1);
    else if (e.key === "Enter" && current) {
      e.preventDefault();
      this.connect(current);
    } else if (e.metaKey && e.key.toLowerCase() === "e" && current) {
      e.preventDefault();
      this.edit(current);
    } else if (e.metaKey && e.key === "Backspace" && current) {
      e.preventDefault();
      this.remove(current);
    } else if (e.metaKey && e.key.toLowerCase() === "p") {
      e.preventDefault();
      this.close();
    }
  }
}
