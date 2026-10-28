//! Everything the frontend needs from the user's shell environment and filesystem:
//! zsh integration files, login PATH + known commands, history, and completion lookups.

use serde::Serialize;
use std::collections::{BTreeSet, HashSet};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use std::{env, fs, thread};
use tauri::{AppHandle, Manager};

/// Wraps the user's zsh startup files and adds hooks that report prompt/exec/cwd via OSC 6973.
const ZSHENV: &str = r#"# Houston shell integration
HOUSTON_ZDOTDIR="$ZDOTDIR"
ZDOTDIR="${HOUSTON_USER_ZDOTDIR:-$HOME}"
[[ -f "$ZDOTDIR/.zshenv" ]] && source "$ZDOTDIR/.zshenv"
HOUSTON_USER_ZDOTDIR="$ZDOTDIR"
ZDOTDIR="$HOUSTON_ZDOTDIR"
"#;

const ZPROFILE: &str = r#"ZDOTDIR="$HOUSTON_USER_ZDOTDIR"
[[ -f "$ZDOTDIR/.zprofile" ]] && source "$ZDOTDIR/.zprofile"
ZDOTDIR="$HOUSTON_ZDOTDIR"
"#;

// ZDOTDIR is left pointing at the user's directory so .zlogin and child shells behave normally.
const ZSHRC: &str = r#"ZDOTDIR="$HOUSTON_USER_ZDOTDIR"
HISTFILE="$ZDOTDIR/.zsh_history"
[[ -f "$ZDOTDIR/.zshrc" ]] && source "$ZDOTDIR/.zshrc"
unset HOUSTON_ZDOTDIR
_houston_precmd() { printf '\e]6973;prompt;%s\a\e]6973;cwd;%s\a' "$?" "$PWD" }
_houston_preexec() { printf '\e]6973;exec;%s\a' "${1//[$'\a\e']/}" }
autoload -Uz add-zsh-hook
add-zsh-hook precmd _houston_precmd
add-zsh-hook preexec _houston_preexec
# Houston draws its own command input, so the shell prompt stays hidden while waiting and
# only marks each submitted command in the scrollback. Added last so it wins over prompt themes.
_houston_hide_prompt() { PROMPT='' RPROMPT='' }
_houston_mark_command() { PROMPT='%F{8}❯%f ' RPROMPT=''; zle reset-prompt }
add-zsh-hook precmd _houston_hide_prompt
autoload -Uz add-zle-hook-widget
add-zle-hook-widget line-finish _houston_mark_command
"#;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellInfo {
    shell: String,
    /// True when the shell is zsh and gets the Houston integration (prompt tracking, command input).
    integrated: bool,
    integration_dir: String,
    user_zdotdir: String,
    home: String,
    commands: Vec<String>,
    history: Vec<String>,
}

static INTEGRATION_DIR: OnceLock<PathBuf> = OnceLock::new();
static INFO: OnceLock<ShellInfo> = OnceLock::new();

pub fn init(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let dir = app.path().app_data_dir()?.join("zsh");
    fs::create_dir_all(&dir)?;
    for (name, body) in [(".zshenv", ZSHENV), (".zprofile", ZPROFILE), (".zshrc", ZSHRC)] {
        fs::write(dir.join(name), body)?;
    }
    INTEGRATION_DIR.set(dir).ok();
    // Warm the login-shell probe off the main thread; it can take a second.
    thread::spawn(info);
    Ok(())
}

fn home() -> PathBuf {
    env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"))
}

/// Where the user's own zsh startup files live.
pub fn user_zdotdir() -> PathBuf {
    env::var("ZDOTDIR").map(PathBuf::from).unwrap_or_else(|_| home())
}

fn info() -> &'static ShellInfo {
    INFO.get_or_init(|| {
        let shell = env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let integrated = shell.ends_with("zsh");
        let user_zdotdir = user_zdotdir();
        let (path, mut names) = probe_login_shell(&shell, integrated);
        names.extend(path_executables(&path));
        ShellInfo {
            integrated,
            integration_dir: INTEGRATION_DIR.get().map(|d| d.display().to_string()).unwrap_or_default(),
            history: if integrated { read_zsh_history(&user_zdotdir.join(".zsh_history")) } else { vec![] },
            user_zdotdir: user_zdotdir.display().to_string(),
            home: home().display().to_string(),
            commands: names.into_iter().collect(),
            shell,
        }
    })
}

/// Asks an interactive login shell for its PATH and (zsh only) aliases, builtins, keywords and functions.
fn probe_login_shell(shell: &str, zsh: bool) -> (String, BTreeSet<String>) {
    let script = if zsh {
        r#"print -r -- "__HOUSTON_PATH__$PATH"; for c in ${(k)aliases} ${(k)builtins} ${(k)reswords} ${(k)functions}; do print -r -- "__HOUSTON_CMD__$c"; done"#
    } else {
        r#"echo "__HOUSTON_PATH__$PATH""#
    };
    let mut names = BTreeSet::new();
    let mut path = env::var("PATH").unwrap_or_default();
    let Ok(mut child) = Command::new(shell)
        .args(["-l", "-i", "-c", script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return (path, names);
    };
    // Drain stdout concurrently so a large function list can't fill the pipe and stall the shell.
    let mut stdout = child.stdout.take().expect("piped stdout");
    let reader = thread::spawn(move || {
        let mut out = Vec::new();
        let _ = std::io::Read::read_to_end(&mut stdout, &mut out);
        out
    });
    // A misbehaving rc file must not hang startup.
    let deadline = Instant::now() + Duration::from_secs(8);
    while child.try_wait().ok().flatten().is_none() {
        if Instant::now() > deadline {
            let _ = child.kill();
            break;
        }
        thread::sleep(Duration::from_millis(25));
    }
    let _ = child.wait();
    let out = reader.join().unwrap_or_default();
    for line in String::from_utf8_lossy(&out).lines() {
        if let Some(p) = line.strip_prefix("__HOUSTON_PATH__") {
            path = p.to_string();
        } else if let Some(c) = line.strip_prefix("__HOUSTON_CMD__") {
            if !c.starts_with('_') && !c.contains(|ch: char| ch.is_whitespace()) {
                names.insert(c.to_string());
            }
        }
    }
    (path, names)
}

fn path_executables(path: &str) -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    for dir in path.split(':').filter(|d| !d.is_empty()) {
        let Ok(entries) = fs::read_dir(dir) else { continue };
        for entry in entries.flatten() {
            let Ok(meta) = fs::metadata(entry.path()) else { continue };
            if meta.is_file() && meta.permissions().mode() & 0o111 != 0 {
                names.insert(entry.file_name().to_string_lossy().into_owned());
            }
        }
    }
    names
}

/// Parses zsh's (possibly extended, metafied) history file into unique commands, oldest first.
fn read_zsh_history(file: &Path) -> Vec<String> {
    let Ok(raw) = fs::read(file) else { return vec![] };
    let mut bytes = Vec::with_capacity(raw.len());
    let mut it = raw.into_iter();
    while let Some(b) = it.next() {
        if b == 0x83 {
            if let Some(n) = it.next() {
                bytes.push(n ^ 0x20);
            }
        } else {
            bytes.push(b);
        }
    }
    let text = String::from_utf8_lossy(&bytes);
    let mut entries: Vec<String> = Vec::new();
    let mut current = String::new();
    for line in text.lines() {
        let line = if current.is_empty() {
            match line.strip_prefix(": ").and_then(|l| l.split_once(';')) {
                Some((_, cmd)) => cmd,
                None => line,
            }
        } else {
            line
        };
        if let Some(cont) = line.strip_suffix('\\') {
            current.push_str(cont);
            current.push('\n');
            continue;
        }
        current.push_str(line);
        let cmd = std::mem::take(&mut current);
        if !cmd.trim().is_empty() {
            entries.push(cmd);
        }
    }
    // Keep the most recent occurrence of each command.
    let mut seen = HashSet::new();
    let mut unique: Vec<String> = entries.into_iter().rev().filter(|c| seen.insert(c.clone())).take(5000).collect();
    unique.reverse();
    unique
}

#[tauri::command]
pub async fn shell_info() -> ShellInfo {
    tauri::async_runtime::spawn_blocking(|| info().clone()).await.expect("shell probe panicked")
}

#[derive(Serialize)]
pub struct PathItem {
    insert: String,
    label: String,
    dir: bool,
}

fn unescape(word: &str) -> String {
    let mut out = String::new();
    let mut chars = word.chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' => out.extend(chars.next()),
            '\'' | '"' => {}
            _ => out.push(c),
        }
    }
    out
}

fn escape(name: &str) -> String {
    name.chars()
        .flat_map(|c| {
            let special = " '\"\\()[]{}&;|<>$`!*?#~".contains(c);
            special.then_some('\\').into_iter().chain([c])
        })
        .collect()
}

/// Lists filesystem entries completing `word` (shell-escaped, relative to `cwd`, `~` aware).
#[tauri::command]
pub async fn complete_path(cwd: String, word: String, dirs_only: bool) -> Vec<PathItem> {
    let (dir_part, base) = match word.rfind('/') {
        Some(i) => (&word[..=i], &word[i + 1..]),
        None => ("", word.as_str()),
    };
    let dir_plain = unescape(dir_part);
    let resolved = if let Some(rest) = dir_plain.strip_prefix('~') {
        home().join(rest.trim_start_matches('/'))
    } else if dir_plain.starts_with('/') {
        PathBuf::from(&dir_plain)
    } else {
        Path::new(&cwd).join(&dir_plain)
    };
    let base = unescape(base).to_lowercase();
    let show_hidden = base.starts_with('.');
    let Ok(entries) = fs::read_dir(&resolved) else { return vec![] };
    let mut items: Vec<PathItem> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            if (!show_hidden && name.starts_with('.')) || !name.to_lowercase().starts_with(&base) {
                return None;
            }
            let dir = fs::metadata(e.path()).map(|m| m.is_dir()).unwrap_or(false);
            if dirs_only && !dir {
                return None;
            }
            let suffix = if dir { "/" } else { "" };
            Some(PathItem { insert: format!("{dir_part}{}{suffix}", escape(&name)), label: format!("{name}{suffix}"), dir })
        })
        .collect();
    items.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| a.label.to_lowercase().cmp(&b.label.to_lowercase())));
    items.truncate(300);
    items
}

#[tauri::command]
pub async fn git_refs(cwd: String) -> Vec<String> {
    Command::new("git")
        .args(["-C", &cwd, "for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes", "refs/tags"])
        .stderr(Stdio::null())
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).lines().map(str::to_string).collect())
        .unwrap_or_default()
}

#[derive(Serialize, Default)]
pub struct GitStatus {
    branch: String,
    ahead: u32,
    behind: u32,
    staged: u32,
    modified: u32,
    untracked: u32,
}

/// Branch and working-tree summary for the prompt context line; None outside a repository.
#[tauri::command]
pub async fn git_status(cwd: String) -> Option<GitStatus> {
    let out = Command::new("git")
        .args(["-C", &cwd, "--no-optional-locks", "status", "--porcelain=v2", "--branch"])
        .stderr(Stdio::null())
        .output()
        .ok()
        .filter(|o| o.status.success())?;
    let mut s = GitStatus::default();
    let mut oid = "";
    let text = String::from_utf8_lossy(&out.stdout);
    for line in text.lines() {
        if let Some(head) = line.strip_prefix("# branch.head ") {
            s.branch = head.to_string();
        } else if let Some(o) = line.strip_prefix("# branch.oid ") {
            oid = o;
        } else if let Some(ab) = line.strip_prefix("# branch.ab ") {
            let mut parts = ab.split(' ').map(|n| n.trim_start_matches(['+', '-']).parse().unwrap_or(0));
            s.ahead = parts.next().unwrap_or(0);
            s.behind = parts.next().unwrap_or(0);
        } else if line.starts_with('?') {
            s.untracked += 1;
        } else if let Some(xy) = line.get(2..4).filter(|_| line.starts_with(['1', '2', 'u'])) {
            let (x, y) = (xy.as_bytes()[0], xy.as_bytes()[1]);
            s.staged += (x != b'.') as u32;
            s.modified += (y != b'.') as u32;
        }
    }
    if s.branch == "(detached)" {
        s.branch = oid.get(..7).unwrap_or(oid).to_string();
    }
    Some(s)
}

/// Upper bound on the diff text sent to the UI; a huge generated file must not freeze the panel.
const DIFF_LIMIT: usize = 4 << 20;

/// Unified diff of the working tree against HEAD, with untracked files shown as additions.
#[tauri::command]
pub async fn git_diff(cwd: String) -> String {
    let git = |args: &[&str]| {
        Command::new("git")
            .args(["-C", &cwd, "--no-optional-locks"])
            .args(args)
            .stderr(Stdio::null())
            .output()
            .ok()
    };
    // A repository without commits has no HEAD; its staged and unstaged changes are then the whole diff.
    let mut diff = git(&["diff", "HEAD", "--no-color", "--no-ext-diff"])
        .filter(|o| o.status.success())
        .or_else(|| git(&["diff", "--no-color", "--no-ext-diff"]))
        .map(|o| o.stdout)
        .unwrap_or_default();
    let untracked = git(&["ls-files", "--others", "--exclude-standard", "-z"]).map(|o| o.stdout).unwrap_or_default();
    for file in untracked.split(|&b| b == 0).filter(|f| !f.is_empty()) {
        if diff.len() > DIFF_LIMIT {
            break;
        }
        let file = String::from_utf8_lossy(file);
        // --no-index exits 1 when the files differ, which they always do here.
        if let Some(o) = git(&["diff", "--no-color", "--no-ext-diff", "--no-index", "--", "/dev/null", &file]) {
            diff.extend(o.stdout);
        }
    }
    diff.truncate(DIFF_LIMIT);
    String::from_utf8_lossy(&diff).into_owned()
}

/// Runs a command in the user's login shell without a terminal, e.g. opening an editor or Finder.
#[tauri::command]
pub async fn launch_detached(cwd: String, command: String) -> Result<(), String> {
    let mut child = Command::new(&info().shell)
        .args(["-l", "-c", &command])
        .current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    thread::spawn(move || child.wait());
    Ok(())
}

#[tauri::command]
pub async fn npm_scripts(cwd: String) -> Vec<String> {
    fs::read_to_string(Path::new(&cwd).join("package.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("scripts")?.as_object().map(|m| m.keys().cloned().collect()))
        .unwrap_or_default()
}

/// Whether Claude Code has a transcript for this session id (so it can be resumed).
#[tauri::command]
pub async fn claude_session_exists(id: String) -> bool {
    let file = format!("{id}.jsonl");
    fs::read_dir(home().join(".claude/projects"))
        .map(|dirs| dirs.flatten().any(|d| d.path().join(&file).is_file()))
        .unwrap_or(false)
}

fn state_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("state.json"))
}

#[tauri::command]
pub async fn load_state(app: AppHandle) -> Result<Option<serde_json::Value>, String> {
    match fs::read_to_string(state_file(&app)?) {
        Ok(s) => serde_json::from_str(&s).map(Some).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Atomic write (temp file + rename) so a crash mid-save never corrupts the session list.
#[tauri::command]
pub async fn save_state(app: AppHandle, state: serde_json::Value) -> Result<(), String> {
    let file = state_file(&app)?;
    let tmp = file.with_extension("json.tmp");
    let body = serde_json::to_vec_pretty(&state).map_err(|e| e.to_string())?;
    fs::write(&tmp, body).and_then(|_| fs::rename(&tmp, &file)).map_err(|e| e.to_string())
}
