//! Claude plan usage limits. Claude Code passes `rate_limits` (5-hour and weekly windows) to its
//! statusline command; Houston points the statusline of the sessions it launches at a small script
//! that records that input, and the sidebar reads it back. The same input carries each session's
//! cost and context usage, which is kept per session id.

use std::collections::HashMap;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::OnceLock;
use tauri::{AppHandle, Manager};

struct Paths {
    script: PathBuf,
    capture: PathBuf,
    sessions: PathBuf,
}

static PATHS: OnceLock<Paths> = OnceLock::new();

/// Single-quotes a path for /bin/sh.
fn sh_quote(p: &PathBuf) -> String {
    format!("'{}'", p.display().to_string().replace('\'', r"'\''"))
}

pub fn init(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let dir = app.path().app_data_dir()?.join("claude");
    fs::create_dir_all(&dir)?;
    let script = dir.join("statusline.sh");
    let capture = dir.join("statusline.json");
    let sessions = dir.join("sessions");
    fs::create_dir_all(&sessions)?;
    // Only inputs carrying rate_limits update the limits capture: a fresh session reports none until
    // its first API response and must not wipe the last known values. Every input updates its
    // session's file; the id is checked so it can't name a path. Temp file + rename keeps reads whole.
    let body = format!(
        r#"#!/bin/sh
# Houston: records Claude Code's statusline input so the sidebar can show plan limits and session usage.
input=$(cat)
case "$input" in
  *'"rate_limits"'*) tmp={capture}.$$ && printf '%s' "$input" > "$tmp" && mv "$tmp" {capture} ;;
esac
sid=$(printf '%s' "$input" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([0-9a-fA-F-]*\)".*/\1/p' | head -n 1)
if [ -n "$sid" ]; then
  out={sessions}/"$sid".json
  printf '%s' "$input" > "$out.$$" && mv "$out.$$" "$out"
fi
"#,
        capture = sh_quote(&capture),
        sessions = sh_quote(&sessions),
    );
    fs::write(&script, body)?;
    fs::set_permissions(&script, fs::Permissions::from_mode(0o755))?;
    PATHS.set(Paths { script, capture, sessions }).ok();
    Ok(())
}

/// Shell command to use as Claude Code's `statusLine.command`.
#[tauri::command]
pub fn claude_status_line() -> Result<String, String> {
    PATHS.get().map(|p| sh_quote(&p.script)).ok_or_else(|| "limits not initialised".into())
}

/// The last `rate_limits` object Claude Code reported, if any.
#[tauri::command]
pub async fn claude_limits() -> Option<serde_json::Value> {
    let raw = fs::read_to_string(&PATHS.get()?.capture).ok()?;
    let mut input: serde_json::Value = serde_json::from_str(&raw).ok()?;
    Some(input.get_mut("rate_limits")?.take())
}

/// Cost and context usage per Claude Code session id, for the sessions that have reported any.
#[tauri::command]
pub async fn claude_session_stats(ids: Vec<String>) -> HashMap<String, serde_json::Value> {
    let Some(paths) = PATHS.get() else { return HashMap::new() };
    ids.into_iter()
        .filter(|id| id.chars().all(|c| c.is_ascii_hexdigit() || c == '-'))
        .filter_map(|id| {
            let raw = fs::read_to_string(paths.sessions.join(format!("{id}.json"))).ok()?;
            let input: serde_json::Value = serde_json::from_str(&raw).ok()?;
            let stats = serde_json::json!({
                "cost_usd": input.pointer("/cost/total_cost_usd"),
                "lines_added": input.pointer("/cost/total_lines_added"),
                "lines_removed": input.pointer("/cost/total_lines_removed"),
                "context_percent": input.pointer("/context_window/used_percentage"),
                "model": input.pointer("/model/display_name"),
            });
            Some((id, stats))
        })
        .collect()
}
