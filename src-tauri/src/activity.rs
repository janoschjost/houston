//! What a Claude Code session has done, read from its transcript (`~/.claude/projects/*/<id>.jsonl`):
//! the prompts it was given, the tools it ran and what it said. Feeds the mission timeline and the
//! conflict radar. Transcripts only ever grow, so each is parsed once and then only from where the last
//! read stopped.

use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::Mutex;

/// Events kept per session; older ones drop off the front.
const MAX_EVENTS: usize = 3000;
/// Lines longer than this (pasted screenshots) are skipped rather than parsed.
const MAX_LINE: usize = 4 * 1024 * 1024;

#[derive(Clone, Serialize)]
pub struct Event {
    /// ISO 8601 timestamp as written by Claude Code.
    ts: String,
    /// `prompt` (user message), `tool` (tool call) or `reply` (assistant text).
    kind: &'static str,
    /// Tool name for `tool` events.
    tool: String,
    summary: String,
    /// File the tool reads or writes, when it names one.
    path: Option<String>,
    /// The tool changes the file.
    edit: bool,
}

#[derive(Serialize)]
pub struct Edit {
    path: String,
    ts: String,
}

#[derive(Default)]
struct Cache {
    file: Option<PathBuf>,
    offset: u64,
    events: Vec<Event>,
}

static CACHE: Mutex<Option<HashMap<String, Cache>>> = Mutex::new(None);

fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default()
}

fn find_transcript(id: &str) -> Option<PathBuf> {
    let name = format!("{id}.jsonl");
    fs::read_dir(home().join(".claude/projects"))
        .ok()?
        .flatten()
        .map(|d| d.path().join(&name))
        .find(|p| p.is_file())
}

fn clip(s: &str, max: usize) -> String {
    let line = s.trim().lines().next().unwrap_or("").trim();
    if line.chars().count() > max {
        let mut out: String = line.chars().take(max - 1).collect();
        out.push('…');
        out
    } else {
        line.to_string()
    }
}

/// Turns one transcript line into timeline events.
fn parse_line(line: &str, out: &mut Vec<Event>) {
    let Ok(v) = serde_json::from_str::<Value>(line) else { return };
    let kind = v.get("type").and_then(Value::as_str).unwrap_or("");
    if (kind != "user" && kind != "assistant") || v.get("isMeta").and_then(Value::as_bool) == Some(true) || v.get("isSidechain").and_then(Value::as_bool) == Some(true) {
        return;
    }
    let ts = v.get("timestamp").and_then(Value::as_str).unwrap_or("").to_string();
    let content = v.pointer("/message/content");
    let blocks: Vec<&Value> = match content {
        Some(Value::Array(a)) => a.iter().collect(),
        _ => vec![],
    };
    if kind == "user" {
        let text = match content {
            Some(Value::String(s)) => s.clone(),
            _ => blocks.iter().filter(|b| b["type"] == "text").filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join("\n"),
        };
        // Slash-command echoes and system reminders are wrapped in tags; real prompts are not.
        if !text.trim().is_empty() && !text.trim_start().starts_with('<') {
            out.push(Event { ts, kind: "prompt", tool: String::new(), summary: clip(&text, 200), path: None, edit: false });
        }
        return;
    }
    let mut said = false;
    for b in blocks {
        match b["type"].as_str() {
            Some("text") if !said => {
                if let Some(t) = b["text"].as_str().filter(|t| !t.trim().is_empty()) {
                    said = true;
                    out.push(Event { ts: ts.clone(), kind: "reply", tool: String::new(), summary: clip(t, 200), path: None, edit: false });
                }
            }
            Some("tool_use") => {
                let name = b["name"].as_str().unwrap_or("tool").to_string();
                let input = &b["input"];
                let path = ["file_path", "notebook_path", "path"].iter().find_map(|k| input[*k].as_str()).map(str::to_string);
                let summary = match name.as_str() {
                    "Bash" => clip(input["command"].as_str().unwrap_or(""), 160),
                    "Grep" | "Glob" => clip(input["pattern"].as_str().unwrap_or(""), 160),
                    "Task" | "Agent" => clip(input["description"].as_str().unwrap_or(""), 160),
                    "WebFetch" => clip(input["url"].as_str().unwrap_or(""), 160),
                    "WebSearch" => clip(input["query"].as_str().unwrap_or(""), 160),
                    _ => path.clone().unwrap_or_default(),
                };
                let edit = matches!(name.as_str(), "Edit" | "Write" | "MultiEdit" | "NotebookEdit");
                out.push(Event { ts: ts.clone(), kind: "tool", tool: name, summary, path, edit });
            }
            _ => {}
        }
    }
}

/// Reads whatever the transcript gained since the last call, then hands `f` the session's events.
fn with_events<T>(id: &str, f: impl FnOnce(&[Event]) -> T) -> Option<T> {
    if !id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        return None;
    }
    let mut guard = CACHE.lock().ok()?;
    let cache = guard.get_or_insert_with(HashMap::new).entry(id.to_string()).or_default();
    if cache.file.as_ref().map_or(true, |p| !p.is_file()) {
        cache.file = find_transcript(id);
        cache.offset = 0;
        cache.events.clear();
    }
    let path = cache.file.clone()?;
    let mut file = File::open(&path).ok()?;
    let len = file.metadata().ok()?.len();
    if len < cache.offset {
        cache.offset = 0;
        cache.events.clear();
    }
    if len > cache.offset {
        file.seek(SeekFrom::Start(cache.offset)).ok()?;
        let mut buf = Vec::new();
        file.take(len - cache.offset).read_to_end(&mut buf).ok()?;
        // Only whole lines count; a half-written last line is read again next time.
        if let Some(end) = buf.iter().rposition(|&b| b == b'\n') {
            for line in buf[..end].split(|&b| b == b'\n') {
                if line.len() <= MAX_LINE {
                    if let Ok(s) = std::str::from_utf8(line) {
                        parse_line(s, &mut cache.events);
                    }
                }
            }
            cache.offset += end as u64 + 1;
            if cache.events.len() > MAX_EVENTS {
                let drop = cache.events.len() - MAX_EVENTS;
                cache.events.drain(..drop);
            }
        }
    }
    Some(f(&cache.events))
}

/// Everything a session did, oldest first.
#[tauri::command]
pub async fn claude_timeline(id: String) -> Vec<Event> {
    with_events(&id, |e| e.to_vec()).unwrap_or_default()
}

/// The most recent file changes per session id, for spotting two agents on the same file.
#[tauri::command]
pub async fn claude_edits(ids: Vec<String>) -> HashMap<String, Vec<Edit>> {
    ids.into_iter()
        .filter_map(|id| {
            let edits = with_events(&id, |events| {
                let mut recent: Vec<Edit> = events
                    .iter()
                    .rev()
                    .filter(|e| e.edit)
                    .filter_map(|e| Some(Edit { path: e.path.clone()?, ts: e.ts.clone() }))
                    .take(100)
                    .collect();
                recent.reverse();
                recent
            })?;
            Some((id, edits))
        })
        .collect()
}
