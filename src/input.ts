import type { Completer, Item } from "./completion";

export interface InputHost {
  completer: Completer;
  cwd(): string;
  submit(command: string): void;
  sendControl(seq: string): void;
}

const KIND_GLYPH: Record<Item["kind"], string> = {
  cmd: "λ", dir: "▸", file: "·", git: "⎇", sub: "◆", script: "▶", hist: "⟲",
};

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Warp-style command editor: a transparent textarea over a highlighted mirror, with
 * history ghost text (→ accepts), Tab completion popup, ↑/↓ prefix history and ⌃R search.
 */
export class CommandInput {
  readonly el: HTMLElement;
  private ta: HTMLTextAreaElement;
  private mirror: HTMLElement;
  private popup: HTMLElement;
  private items: Item[] = [];
  private selected = 0;
  private range = { start: 0, end: 0 };
  private historyNav: { list: string[]; index: number; draft: string } | null = null;
  private request = 0;
  private mode: "complete" | "history" = "complete";

  constructor(private host: InputHost) {
    this.el = document.createElement("div");
    this.el.className = "cmd-input";
    this.el.innerHTML = `<div class="cmd-context"></div><span class="cmd-glyph">❯</span><div class="cmd-editor"><pre class="cmd-mirror"></pre><textarea rows="1" spellcheck="false" autocapitalize="off" autocomplete="off" autocorrect="off"></textarea></div><div class="cmd-popup"></div>`;
    this.ta = this.el.querySelector("textarea")!;
    this.mirror = this.el.querySelector(".cmd-mirror")!;
    this.popup = this.el.querySelector(".cmd-popup")!;

    this.ta.addEventListener("input", () => {
      this.historyNav = null;
      this.refresh();
      if (this.items.length) this.mode === "history" ? this.openHistorySearch() : this.openCompletion(false);
    });
    this.ta.addEventListener("keydown", (e) => this.onKey(e));
    this.ta.addEventListener("scroll", () => (this.mirror.scrollTop = this.ta.scrollTop));
    this.ta.addEventListener("blur", () => this.closePopup());
    this.ta.addEventListener("select", () => this.refresh());
    this.popup.addEventListener("mousedown", (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>("[data-i]");
      if (!row) return;
      e.preventDefault();
      this.selected = Number(row.dataset.i);
      this.accept();
    });
    this.refresh();
  }

  focus() {
    this.ta.focus();
  }

  /** Sets the context line (directory, git state) shown above the editor. */
  setContext(html: string) {
    const ctx = this.el.querySelector(".cmd-context")!;
    if (ctx.innerHTML !== html) ctx.innerHTML = html;
  }

  private get text() {
    return this.ta.value;
  }

  private setText(value: string, caret = value.length) {
    this.ta.value = value;
    this.ta.setSelectionRange(caret, caret);
    this.refresh();
  }

  private caretAtEnd() {
    return this.ta.selectionStart === this.ta.selectionEnd && this.ta.selectionEnd === this.text.length;
  }

  private ghost() {
    return this.caretAtEnd() ? this.host.completer.ghost(this.text) : "";
  }

  /** Re-renders the highlighted mirror (with ghost text) and resizes to content. */
  private refresh() {
    const text = this.text;
    let html = "";
    let pos = 0;
    for (const t of this.host.completer.lex(text)) {
      html += escapeHtml(text.slice(pos, t.start));
      html += `<span class="tok-${t.kind}">${escapeHtml(t.raw)}</span>`;
      pos = t.end;
    }
    html += escapeHtml(text.slice(pos));
    const ghost = this.ghost();
    if (ghost) html += `<span class="ghost">${escapeHtml(ghost)}</span>`;
    else if (!text) html += `<span class="ghost placeholder">type a command · ⇥ complete · ↑ history · ⌃R search</span>`;
    this.mirror.innerHTML = html + "\n";
    this.ta.style.height = "0px";
    this.ta.style.height = `${Math.min(this.ta.scrollHeight, 220)}px`;
    this.mirror.style.height = this.ta.style.height;
  }

  private onKey(e: KeyboardEvent) {
    const popupOpen = this.items.length > 0;
    if (e.ctrlKey && !e.metaKey && !e.altKey) {
      if (this.onControl(e.key.toLowerCase())) e.preventDefault();
      return;
    }
    switch (e.key) {
      case "Enter":
        if (e.shiftKey || e.altKey) return; // newline: multi-line command
        e.preventDefault();
        if (popupOpen) this.accept();
        else this.submit();
        return;
      case "Tab":
        e.preventDefault();
        if (popupOpen) e.shiftKey ? this.move(-1) : this.accept();
        else this.openCompletion(true);
        return;
      case "Escape":
        if (popupOpen) {
          e.preventDefault();
          this.closePopup();
        }
        return;
      case "ArrowUp":
        if (popupOpen) return e.preventDefault(), this.move(-1);
        if (!this.text.slice(0, this.ta.selectionStart).includes("\n")) e.preventDefault(), this.historyStep(1);
        return;
      case "ArrowDown":
        if (popupOpen) return e.preventDefault(), this.move(1);
        if (this.historyNav && !this.text.slice(this.ta.selectionEnd).includes("\n")) e.preventDefault(), this.historyStep(-1);
        return;
      case "ArrowRight":
      case "End": {
        const ghost = this.ghost();
        if (ghost && !e.shiftKey) {
          e.preventDefault();
          this.setText(this.text + ghost);
        }
        return;
      }
    }
  }

  /** Shell-like control keys; returns whether the key was handled. */
  private onControl(key: string): boolean {
    switch (key) {
      case "c":
        if (this.text) this.setText("");
        else this.host.sendControl("\x03");
        return true;
      case "d":
        if (this.text) return false;
        this.host.sendControl("\x04");
        return true;
      case "l":
        this.host.sendControl("\x0c");
        return true;
      case "r":
        this.openHistorySearch();
        return true;
      case "u":
        this.setText(this.text.slice(this.ta.selectionEnd), 0);
        return true;
      case "e": {
        const ghost = this.ghost();
        if (!ghost) return false;
        this.setText(this.text + ghost);
        return true;
      }
    }
    return false;
  }

  private submit() {
    const command = this.text;
    if (command.trim()) this.host.completer.record(command);
    this.historyNav = null;
    this.setText("");
    this.host.submit(command);
  }

  private historyStep(direction: 1 | -1) {
    if (!this.historyNav) {
      if (direction < 0) return;
      this.historyNav = { list: this.host.completer.historyMatches(this.text), index: -1, draft: this.text };
    }
    const nav = this.historyNav;
    const next = nav.index + direction;
    if (next >= nav.list.length) return;
    nav.index = next;
    if (next < 0) {
      this.historyNav = null;
      this.setText(nav.draft);
    } else {
      this.setText(nav.list[next]);
    }
  }

  private async openCompletion(explicit: boolean) {
    this.mode = "complete";
    const id = ++this.request;
    const caret = this.ta.selectionEnd;
    const result = await this.host.completer.complete(this.text, caret, this.host.cwd());
    if (id !== this.request) return; // a newer keystroke superseded this lookup
    const word = this.text.slice(result.start, result.end);
    if (explicit && result.items.length === 1) {
      this.range = result;
      this.items = result.items;
      this.selected = 0;
      return this.accept();
    }
    // Extend to the longest common prefix first, like a shell does.
    if (explicit && result.items.length > 1) {
      const prefix = result.items.map((i) => i.insert).reduce((a, b) => {
        let n = 0;
        while (n < a.length && a[n] === b[n]) n++;
        return a.slice(0, n);
      });
      if (prefix.length > word.length && prefix.startsWith(word)) {
        this.splice(result.start, result.end, prefix);
        result.end = result.start + prefix.length;
      }
    }
    this.range = result;
    this.showItems(result.items);
  }

  private openHistorySearch() {
    this.mode = "history";
    this.range = { start: 0, end: this.text.length };
    this.showItems(this.host.completer.searchHistory(this.text));
  }

  private showItems(items: Item[]) {
    this.items = items;
    this.selected = 0;
    if (!items.length) return this.closePopup();
    this.popup.innerHTML =
      items
        .map((it, i) => `<div class="cmd-item k-${it.kind}${i === 0 ? " sel" : ""}" data-i="${i}"><span class="k">${KIND_GLYPH[it.kind]}</span>${escapeHtml(it.label)}</div>`)
        .join("") + `<div class="cmd-popup-hint">⇥/⏎ accept · ↑↓ select · esc close · ${items.length} match${items.length === 1 ? "" : "es"}</div>`;
    this.popup.classList.add("open");
  }

  private move(delta: number) {
    const rows = this.popup.querySelectorAll<HTMLElement>(".cmd-item");
    rows[this.selected]?.classList.remove("sel");
    this.selected = (this.selected + delta + this.items.length) % this.items.length;
    rows[this.selected]?.classList.add("sel");
    rows[this.selected]?.scrollIntoView({ block: "nearest" });
  }

  private accept() {
    const item = this.items[this.selected];
    this.closePopup();
    if (!item) return;
    this.splice(this.range.start, this.range.end, item.insert + (item.open ? "" : " "));
    if (item.kind === "dir") this.openCompletion(false);
  }

  private splice(start: number, end: number, insert: string) {
    const text = this.text;
    this.setText(text.slice(0, start) + insert + text.slice(end), start + insert.length);
  }

  private closePopup() {
    this.request++;
    this.items = [];
    this.popup.classList.remove("open");
    this.popup.innerHTML = "";
  }
}
