//! Claude plan usage limits. Claude Code passes `rate_limits` (5-hour and weekly windows) to its
//! statusline command; Houston points the statusline of the sessions it launches at a small script
//! that records that input, and the sidebar reads it back.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::OnceLock;
use tauri::{AppHandle, Manager};

struct Paths {
    script: PathBuf,
    capture: PathBuf,
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
    // Only inputs carrying rate_limits are kept: a fresh session reports none until its first API
    // response and must not wipe the last known values. Temp file + rename keeps reads whole.
    let body = format!(
        r#"#!/bin/sh
# Houston: records Claude Code's statusline input so the sidebar can show plan usage limits.
input=$(cat)
case "$input" in
  *'"rate_limits"'*) tmp={capture}.$$ && printf '%s' "$input" > "$tmp" && mv "$tmp" {capture} ;;
esac
"#,
        capture = sh_quote(&capture)
    );
    fs::write(&script, body)?;
    fs::set_permissions(&script, fs::Permissions::from_mode(0o755))?;
    PATHS.set(Paths { script, capture }).ok();
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
