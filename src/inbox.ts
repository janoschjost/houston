import { icon, light } from "./icons";
import type { Kind, PermissionPrompt } from "./session";

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** One session that needs the user. */
export interface InboxItem {
  id: string;
  name: string;
  project: string;
  color: string;
  kind: Kind;
  status: string;
  /** Last question or message, when it is not a permission dialog. */
  waitingFor: string;
  permission: PermissionPrompt | null;
}

export interface InboxActions {
  approve(id: string): void;
  deny(id: string): void;
  reply(id: string, text: string): void;
  open(id: string): void;
}

/** ⌘I overlay: every session waiting on the user in one list, answerable without leaving it. */
export class InboxPanel {
  readonly el: HTMLElement;
  private items: InboxItem[] = [];
  private key = "";
  /** Reply drafts survive re-renders while the list refreshes underneath. */
  private drafts = new Map<string, string>();
  private listEl: HTMLElement;
  private footEl: HTMLElement;
  private titleEl: HTMLElement;
  private safeBtn: HTMLButtonElement;

  constructor(private actions: InboxActions, private closed: () => void) {
    this.el = document.createElement("div");
    this.el.className = "palette-backdrop hidden";
    this.el.innerHTML = `<div class="palette inbox" role="dialog" aria-label="Approval inbox">
      <div class="pal-head inbox-head"><span class="inbox-title"></span><button class="pal-new" data-act="safe">Approve all safe</button></div>
      <div class="pal-list inbox-list"></div>
      <div class="pal-foot inbox-foot"></div>
    </div>`;
    this.titleEl = this.el.querySelector(".inbox-title")!;
    this.listEl = this.el.querySelector(".inbox-list")!;
    this.footEl = this.el.querySelector(".inbox-foot")!;
    this.safeBtn = this.el.querySelector("[data-act=safe]")!;
    this.el.addEventListener("mousedown", (e) => e.target === this.el && this.close());
    this.el.addEventListener("keydown", (e) => {
      e.stopPropagation();
      const t = e.target as HTMLElement;
      if (e.key === "Escape" || (e.metaKey && e.key.toLowerCase() === "i")) {
        e.preventDefault();
        this.close();
      } else if (e.key === "Enter" && t instanceof HTMLInputElement && t.dataset.reply && t.value.trim()) {
        e.preventDefault();
        this.actions.reply(t.dataset.reply, t.value.trim());
        this.drafts.delete(t.dataset.reply);
        t.value = "";
      }
    });
    this.el.addEventListener("input", (e) => {
      const t = e.target as HTMLInputElement;
      if (t.dataset.reply) this.drafts.set(t.dataset.reply, t.value);
    });
    this.el.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      if (t.closest("[data-act=safe]")) return this.approveSafe();
      const btn = t.closest<HTMLElement>("[data-do]");
      const id = btn?.dataset.id;
      if (!btn || !id) return;
      if (btn.dataset.do === "approve") this.actions.approve(id);
      else if (btn.dataset.do === "deny") this.actions.deny(id);
      else if (btn.dataset.do === "open") {
        this.close();
        this.actions.open(id);
      }
    });
  }

  get isOpen() {
    return !this.el.classList.contains("hidden");
  }

  open(items: InboxItem[], digest: string) {
    this.el.classList.remove("hidden");
    this.key = "";
    this.update(items, digest);
    (this.el.querySelector<HTMLElement>("[data-do=approve], input") ?? this.el).focus();
  }

  close() {
    this.el.classList.add("hidden");
    this.closed();
  }

  /** Re-renders from fresh data; skipped when nothing visible changed so typing is never interrupted. */
  update(items: InboxItem[], digest: string) {
    this.items = items;
    const key = JSON.stringify([items.map((i) => [i.id, i.status, i.waitingFor, i.permission]), digest]);
    if (key === this.key || !this.isOpen) return;
    this.key = key;
    const focused = document.activeElement as HTMLElement | null;
    const keep = focused && this.el.contains(focused) ? { id: focused.dataset.reply, pos: (focused as HTMLInputElement).selectionStart } : null;

    const safe = items.filter((i) => i.permission?.safe).length;
    this.titleEl.innerHTML = `${icon("inbox")} ${items.length ? `${items.length} waiting` : "Inbox clear"}`;
    this.safeBtn.textContent = `Approve all safe${safe ? ` (${safe})` : ""}`;
    this.safeBtn.disabled = !safe;
    this.listEl.innerHTML = items.length
      ? items.map((i) => this.row(i)).join("")
      : `<div class="pal-empty">Nothing is waiting on you.</div>`;
    this.footEl.innerHTML = `<span>${escapeHtml(digest)}</span><span class="right"><kbd>⏎</kbd> send reply</span><span><kbd>esc</kbd> close</span>`;

    if (keep?.id) {
      const input = this.listEl.querySelector<HTMLInputElement>(`input[data-reply="${CSS.escape(keep.id)}"]`);
      input?.focus();
      if (input && keep.pos != null) input.setSelectionRange(keep.pos, keep.pos);
    }
  }

  private row(i: InboxItem) {
    const p = i.permission;
    const body = p
      ? `<div class="ib-ask"><span class="ib-tool${p.safe ? " safe" : ""}">${escapeHtml(p.tool)}</span>${p.safe ? `<span class="ib-safe">read-only</span>` : ""}</div><code class="ib-detail">${escapeHtml(p.detail)}</code>`
      : `<div class="ib-said">${escapeHtml(i.waitingFor || "Finished and is waiting for your next instruction.")}</div>`;
    const actions = p
      ? `<button class="ib-btn go" data-do="approve" data-id="${i.id}">Approve</button><button class="ib-btn" data-do="deny" data-id="${i.id}">Deny</button>`
      : `<input class="ib-reply" data-reply="${i.id}" placeholder="Reply…" value="${escapeHtml(this.drafts.get(i.id) ?? "")}" spellcheck="false" autocomplete="off" aria-label="Reply to ${escapeHtml(i.name)}" />`;
    return `<div class="ib-row" data-status="${i.status}" style="--proj: ${i.color}">
      ${light(i.kind)}
      <div class="ib-body"><div class="ib-name"><b>${escapeHtml(i.name)}</b><span>${escapeHtml(i.project)}</span></div>${body}</div>
      <div class="ib-actions">${actions}<button class="ib-btn" data-do="open" data-id="${i.id}">Open</button></div>
    </div>`;
  }

  private approveSafe() {
    for (const i of this.items) if (i.permission?.safe) this.actions.approve(i.id);
  }
}
