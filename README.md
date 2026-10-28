<p align="center">
  <img src=".github/assets/banner.svg" alt="Houston — mission control for your Claude Code agents" width="100%">
</p>

<p align="center">
  <img alt="Tauri 2" src="https://img.shields.io/badge/Tauri-2-6fa8dc?style=flat-square&labelColor=0b0e14">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5-6fa8dc?style=flat-square&labelColor=0b0e14">
  <img alt="Rust" src="https://img.shields.io/badge/Rust-backend-d4977a?style=flat-square&labelColor=0b0e14">
  <img alt="xterm.js" src="https://img.shields.io/badge/xterm.js-6-a39bc4?style=flat-square&labelColor=0b0e14">
  <img alt="macOS" src="https://img.shields.io/badge/platform-macOS-8fbf8f?style=flat-square&labelColor=0b0e14">
</p>

```
   .            *        .        ·            .         *
        ·      HOUSTON, WE HAVE  6  AGENTS IN FLIGHT        .
  *        .            ·        .          *          ·
```

**Houston** is a native desktop app for running many [Claude Code](https://claude.com/claude-code) sessions
and shells side by side, grouped by project. Every agent gets its own terminal, a live status light, and
a name taken from what it's actually working on. When an agent finishes or needs you, Houston tells you.

<p align="center">
  <img src=".github/assets/console.svg" alt="Houston window: sidebar with sessions, Claude Code pane" width="100%">
</p>

## Flight systems

| | |
|---|---|
| 🛰️ **Projects & sessions** | Add project folders, then launch Claude Code agents (`CC`) and shells (`SH`) inside them. Everything is restored after a restart. |
| 🏷️ **Self-naming agents** | New agents name themselves after the topic Claude Code puts in the terminal title (`✳ Fix login redirect loop`). Double-click to rename. Your name sticks. |
| 🚦 **Live telemetry** | Each session shows a status light: launching, working, waiting for you, or idle. The sidebar counts how many are working and waiting. |
| 🔔 **Attention signals** | If work finishes while you're looking elsewhere, you get a macOS notification and a dock badge with the number of waiting sessions. |
| ♻️ **Resumable conversations** | Every agent has a fixed Claude Code session id, so closing Houston never loses a conversation. It resumes where it stopped. |
| ⛽ **Plan limits** | Houston routes Claude Code's statusline through a tiny script and shows how much of your 5-hour and weekly limits is left. |
| ⌨️ **Warp-style shell input** | zsh sessions get a command editor with syntax highlighting, history ghost text, `Tab` completion (commands, paths, git refs, npm scripts) and `⌃R` search. |
| 🧭 **Focus, grid & split** | Look at one pane at a time, all of them in a grid, or two side by side. Drag the gaps to resize panes (double-click resets), and drag sidebar rows to reorder. |
| ✍️ **Mission briefs** | `⌘N` asks for an opening prompt, so a new agent starts working (and is named) right away. |
| 💬 **Waiting previews** | A waiting agent shows its last question or message in the sidebar and in the notification. |
| 💵 **Session usage** | Each Claude session shows its cost and context use, taken from Claude Code's statusline. |
| 🧾 **Changes** | Projects with uncommitted work show a `+2 ~5 ?1` badge; click it (or `⌘D`) for a file-by-file diff. |
| 🔎 **Find & palette** | `⌘F` searches a terminal's scrollback; `⌘P` jumps to any session, project action or command. |
| 🖱️ **Project actions** | Right-click a project to open it in your editor or Finder, run an npm script, or open a pull request. |

## Controls

| Keys | Action | | Keys | Action |
|---|---|---|---|---|
| `⌘O` | add project | | `⌘G` | toggle grid / focus |
| `⌘N` | new Claude agent (with brief) | | `⌘\` | toggle split view |
| `⌘T` | new shell | | `⌘1`–`⌘9` | jump to session |
| `⌘W` | close session | | `⌘[` / `⌘]` | previous / next session |
| `⌘R` / `⏎` | relaunch an exited session | | `⌘K` | clear terminal |
| `⌘J` | next waiting session | | `⇧⏎` | newline in Claude's prompt |
| `⌘⇧R` | rename session | | `⌘B` | toggle sidebar |
| `⌘P` | command palette | | `⌘F` | find in terminal |
| `⌘⇧P` | aliases | | `⌘D` | show uncommitted changes |

## Launch sequence

```text
T-3  ▸ prerequisites   macOS · Node 18+ · Rust (stable) · Claude Code CLI on your PATH
T-2  ▸ fuel up         npm install
T-1  ▸ ignition        npm run tauri dev
T-0  ▸ liftoff 🚀       npm run tauri build   →  src-tauri/target/release/bundle/macos/Houston.app
```

## Under the hood

```
 ┌──────────────────────── Houston.app ────────────────────────┐
 │  src/          TypeScript UI (Vite, xterm.js + WebGL)       │
 │   ├ app.ts       sidebar, layout, shortcuts, persistence    │
 │   ├ session.ts   one pane: PTY, status tracking, naming     │
 │   └ input.ts     Warp-style command editor + completion     │
 │                         ▲  Tauri IPC  ▼                     │
 │  src-tauri/    Rust backend                                 │
 │   ├ pty.rs       spawns and streams pseudo-terminals        │
 │   ├ shell.rs     zsh integration (OSC 6973), git, state     │
 │   └ limits.rs    statusline capture for plan limits         │
 └─────────────────────────────────────────────────────────────┘
```

- Claude sessions run `claude --session-id <uuid>` (later `--resume <uuid>`) in your interactive login shell,
  so `PATH` and environment match your normal terminal.
- Shell sessions load your own zsh config through a wrapper `ZDOTDIR`, which adds hooks that report prompt,
  command and directory changes to Houston.
- Session state is stored in Houston's app data directory and written atomically.

<p align="center"><sub>🪐 &nbsp; Ground control to major agent. &nbsp; 🚀</sub></p>
