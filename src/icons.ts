import type { Kind } from "./session";

/** Line icons on a 24-unit grid; stroke weight and colour come from `.ic` in the stylesheet. */
const PATHS = {
  agent: "M12 3.5v17M3.5 12h17M6 6l12 12M18 6L6 18",
  shell: "M5 7l5 5-5 5M12.5 17.5H19",
  project: "M3.5 5.5h6l2 3h9v10h-17z",
  alias: "M12 3c3 2.8 4.2 6 4.2 9.6V16H7.8v-3.4C7.8 9 9 5.8 12 3zM10 19.5h4M12 9.5v1.5",
  changes: "M6.5 3.5h8l3 3v14h-11zM12 8.5v6M9 11.5h6M9 17h6",
  find: "M16.5 10.5a6 6 0 1 1-12 0 6 6 0 0 1 12 0zM15 15l5 5",
  focus: "M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5",
  grid: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  split: "M4 4.5h16v15H4zM12 4.5v15",
  limits: "M4 17a8 8 0 1 1 16 0M12 17l4-5M4 20.5h16",
  close: "M6.5 6.5l11 11M17.5 6.5l-11 11",
  collapse: "M6 13.5h12",
  chevron: "M7 9.5l5 5 5-5",
  edit: "M4.5 19.5h4l10-10-4-4-10 10zM13 7l4 4",
  refresh: "M19 12a7 7 0 1 1-2.05-4.95M19.5 4v4h-4",
} as const;

export type IconName = keyof typeof PATHS;

export const icon = (name: IconName) => `<svg class="ic ic-${name}" viewBox="0 0 24 24" aria-hidden="true"><path d="${PATHS[name]}"/></svg>`;

/**
 * Houston's mark: a planet with tilted meridians inside a ticked ring, and one satellite whose halo cuts the
 * ring. The same drawing is the app icon, the boot screen and the sidebar brand; status lights reuse its ring
 * and satellite.
 */
export function mark() {
  return `<svg class="mk" viewBox="0 0 100 100" aria-hidden="true">
    <circle cx="50" cy="50" r="40" class="mk-draw" pathLength="1" transform="rotate(-90 50 50)"/>
    <path d="M50 4v10M50 86v10M4 50h10M86 50h10" class="mk-tick"/>
    <circle cx="50" cy="50" r="16" class="mk-body mk-draw" pathLength="1"/>
    <g transform="rotate(-14 50 50)" class="mk-faint"><ellipse cx="50" cy="50" rx="16" ry="4.5"/><ellipse cx="50" cy="50" rx="6.5" ry="16"/></g>
    <g class="mk-sat"><circle cx="50" cy="10" r="5"/></g>
  </svg>`;
}

/** Glyph in the middle of a status light that says what kind of session it is. */
const KIND_GLYPH: Record<Kind, string> = {
  claude: "M8 5.3v5.4M5.3 8h5.4M6.1 6.1l3.8 3.8M9.9 6.1l-3.8 3.8",
  shell: "M6.4 5.7l2.3 2.3-2.3 2.3",
};

/**
 * Status light: the mark's ring and satellite at 16px. The ring and satellite carry the state, taken from
 * the nearest `[data-status]` ancestor; the centre carries the kind, a coral spark for Claude agents and an
 * ink prompt for shells. Without a kind (e.g. counts across all sessions) the centre stays empty.
 */
export function light(kind?: Kind, label?: string) {
  const attrs = label ? `role="img" aria-label="${label}"` : `aria-hidden="true"`;
  const title = label ? `<title>${label}</title>` : "";
  const glyph = kind ? `<path class="st-kind" d="${KIND_GLYPH[kind]}"/>` : "";
  return `<svg class="st${kind ? ` st-${kind}` : ""}" viewBox="0 0 16 16" ${attrs}>${title}<circle class="st-ring" cx="8" cy="8" r="5.5" pathLength="1" transform="rotate(-90 8 8)"/>${glyph}<g class="st-sat"><circle cx="8" cy="2.5" r="2.2"/></g></svg>`;
}

/** Fills every `[data-icon]` element under `root` with its icon, ahead of the element's own text. */
export function fillIcons(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>("[data-icon]").forEach((el) => {
    if (!el.querySelector(":scope > .ic")) el.insertAdjacentHTML("afterbegin", icon(el.dataset.icon as IconName));
  });
}
