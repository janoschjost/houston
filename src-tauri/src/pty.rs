//! PTY lifecycle: spawn, stream output over a per-session channel, write, resize, kill.

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::mpsc::{channel, Sender};
use std::sync::Mutex;
use std::thread;
use tauri::{ipc::Channel, AppHandle, Manager, State};

struct Pty {
    master: Box<dyn MasterPty + Send>,
    /// Writes go through a dedicated thread: ordered, and never block the UI thread on a full PTY buffer.
    input: Sender<String>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

#[derive(Default)]
pub struct Ptys(Mutex<HashMap<String, Pty>>);

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PtyEvent {
    Data { data: String },
    Exit { code: Option<u32> },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnRequest {
    /// Unique per spawn, so a relaunch never collides with the exiting process.
    pty_id: String,
    program: String,
    args: Vec<String>,
    cwd: String,
    env: HashMap<String, String>,
    cols: u16,
    rows: u16,
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 }
}

/// Splits off the longest decodable prefix, keeping a trailing partial UTF-8 sequence for the next read.
fn take_utf8(pending: &mut Vec<u8>) -> String {
    let cut = match std::str::from_utf8(pending) {
        Err(e) if e.error_len().is_none() => e.valid_up_to(),
        _ => pending.len(),
    };
    let text = String::from_utf8_lossy(&pending[..cut]).into_owned();
    pending.drain(..cut);
    text
}

#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: State<'_, Ptys>,
    req: SpawnRequest,
    on_event: Channel<PtyEvent>,
) -> Result<(), String> {
    let pair = native_pty_system().openpty(size(req.cols, req.rows)).map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(&req.program);
    cmd.args(&req.args);
    cmd.cwd(&req.cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "Houston");
    // Apps launched from Finder get no locale, which breaks UTF-8 in shells and TUIs.
    if std::env::var_os("LANG").is_none() {
        cmd.env("LANG", "en_US.UTF-8");
    }
    for (k, v) in &req.env {
        cmd.env(k, v);
    }

    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let killer = child.clone_killer();
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let (input, inbox) = channel::<String>();
    thread::spawn(move || {
        for data in inbox {
            if writer.write_all(data.as_bytes()).and_then(|_| writer.flush()).is_err() {
                break;
            }
        }
    });

    let output = on_event.clone();
    thread::spawn(move || {
        let mut buf = [0u8; 65536];
        let mut pending = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    let data = take_utf8(&mut pending);
                    if !data.is_empty() && output.send(PtyEvent::Data { data }).is_err() {
                        break;
                    }
                }
            }
        }
    });

    let id = req.pty_id.clone();
    thread::spawn(move || {
        let code = child.wait().ok().map(|s| s.exit_code());
        app.state::<Ptys>().0.lock().unwrap().remove(&id);
        let _ = on_event.send(PtyEvent::Exit { code });
    });

    state.0.lock().unwrap().insert(req.pty_id, Pty { master: pair.master, input, killer });
    Ok(())
}

#[tauri::command]
pub fn pty_write(state: State<'_, Ptys>, pty_id: String, data: String) -> Result<(), String> {
    let ptys = state.0.lock().unwrap();
    let pty = ptys.get(&pty_id).ok_or("no such pty")?;
    pty.input.send(data).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(state: State<'_, Ptys>, pty_id: String, cols: u16, rows: u16) -> Result<(), String> {
    let ptys = state.0.lock().unwrap();
    let pty = ptys.get(&pty_id).ok_or("no such pty")?;
    pty.master.resize(size(cols, rows)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(state: State<'_, Ptys>, pty_id: String) {
    if let Some(mut pty) = state.0.lock().unwrap().remove(&pty_id) {
        let _ = pty.killer.kill();
    }
}
