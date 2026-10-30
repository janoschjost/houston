//! Remote glance: an opt-in, read-only status page on the local network, so a phone can show how the
//! fleet is doing. The app pushes a JSON snapshot of the sessions; the server hands it out, and a tiny
//! page that polls it, to anyone whose request carries the secret token. Nothing can be sent back.

use serde::Serialize;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Manager};

const PORT: u16 = 7373;

struct Server {
    stop: Arc<AtomicBool>,
}

static SERVER: Mutex<Option<Server>> = Mutex::new(None);
static SNAPSHOT: Mutex<String> = Mutex::new(String::new());

#[derive(Serialize)]
pub struct RemoteInfo {
    url: String,
}

/// The secret that must accompany every request; created on first use and kept across restarts.
fn token(app: &AppHandle) -> Result<String, String> {
    let file = app.path().app_data_dir().map_err(|e| e.to_string())?.join("remote_token");
    if let Ok(t) = fs::read_to_string(&file) {
        if t.trim().len() >= 16 {
            return Ok(t.trim().to_string());
        }
    }
    let mut bytes = [0u8; 16];
    fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut bytes)).map_err(|e| e.to_string())?;
    let t: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    fs::create_dir_all(file.parent().unwrap()).map_err(|e| e.to_string())?;
    fs::write(&file, &t).map_err(|e| e.to_string())?;
    Ok(t)
}

/// The address other devices on the network reach this machine at.
fn lan_ip() -> String {
    UdpSocket::bind("0.0.0.0:0")
        .and_then(|s| s.connect("8.8.8.8:80").and_then(|_| s.local_addr()))
        .map(|a| a.ip().to_string())
        .unwrap_or_else(|_| "127.0.0.1".into())
}

const PAGE: &str = r##"<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#0d0f12">
<title>Houston</title><style>
:root{color-scheme:dark}*{box-sizing:border-box}
body{margin:0;padding:20px 16px 40px;background:#0d0f12;color:#e3e7ed;font:15px/1.4 -apple-system,system-ui,sans-serif}
h1{margin:0 0 4px;font:600 18px/1 "Arial Narrow",sans-serif;letter-spacing:.3em}
.sub{color:#8b94a1;font:11px ui-monospace,Menlo,monospace;letter-spacing:.08em;margin-bottom:18px}
.sum{display:flex;gap:10px;margin-bottom:16px}.sum div{flex:1;padding:10px 12px;border:1px solid #23282f;border-radius:8px;background:#121519}
.sum b{display:block;font-size:24px}.sum span{color:#8b94a1;font-size:11px;text-transform:uppercase;letter-spacing:.12em}
.sum .w b{color:#f3c86f}.sum .k b{color:#8fd8b4}
.s{padding:11px 12px;border:1px solid #23282f;border-left:3px solid var(--c);border-radius:8px;background:#121519;margin-bottom:8px}
.s .n{font-weight:600}.s .p{color:#8b94a1;font-size:12px}.s .m{margin-top:4px;font-size:13px;color:#c9d0da}
.s .t{float:right;font:11px ui-monospace,Menlo,monospace;color:var(--st)}
.l{margin-top:16px;color:#8b94a1;font:11px ui-monospace,Menlo,monospace}
</style></head><body><h1>HOUSTON</h1><div class="sub" id="sub">connecting…</div>
<div class="sum"><div class="w"><b id="w">–</b><span>waiting</span></div><div class="k"><b id="k">–</b><span>working</span></div><div><b id="c">–</b><span>cost</span></div></div>
<div id="list"></div><div class="l" id="lim"></div>
<script>
const T=new URLSearchParams(location.search).get("t")||"";
const ST={working:["#8fd8b4","WORKING"],attention:["#f3c86f","AWAITING GO"],idle:["#8b94a1","STANDBY"],booting:["#a9b8ff","LAUNCHING"],exited:["#f08a83","EXITED"],dormant:["#a9b8ff","PRE-LAUNCH"]};
const el=(t,c,x)=>{const e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e};
async function tick(){try{
const r=await fetch("status.json?t="+encodeURIComponent(T),{cache:"no-store"});if(!r.ok)throw 0;const d=await r.json();
document.getElementById("sub").textContent="MISSION CONTROL · updated "+new Date(d.updated).toLocaleTimeString();
document.getElementById("w").textContent=d.waiting;document.getElementById("k").textContent=d.working;
document.getElementById("c").textContent="$"+d.cost.toFixed(2);
const list=document.getElementById("list");list.replaceChildren();
for(const s of d.sessions){const [c,l]=ST[s.status]||ST.idle;const row=el("div","s");row.style.setProperty("--c",s.color);row.style.setProperty("--st",c);
row.append(el("span","t",l),el("div","n",s.name),el("div","p",s.project+(s.ctx!=null?" · ctx "+Math.round(s.ctx)+"%":"")));
if(s.waitingFor)row.append(el("div","m",s.waitingFor));list.append(row)}
document.getElementById("lim").textContent=d.limits||""}catch(e){document.getElementById("sub").textContent="offline – retrying"}}
tick();setInterval(tick,3000);
</script></body></html>"##;

fn respond(stream: &mut TcpStream, status: &str, ctype: &str, body: &str) {
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body.as_bytes());
}

fn handle(mut stream: TcpStream, token: &str) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    // Read the whole request head; closing with unread bytes would reset the connection under the client.
    let mut buf = [0u8; 8192];
    let mut n = 0;
    while n < buf.len() && !buf[..n].windows(4).any(|w| w == b"\r\n\r\n") {
        match stream.read(&mut buf[n..]) {
            Ok(0) | Err(_) => break,
            Ok(k) => n += k,
        }
    }
    let req = String::from_utf8_lossy(&buf[..n]);
    let target = req.lines().next().and_then(|l| l.strip_prefix("GET ")).and_then(|l| l.split(' ').next()).unwrap_or("");
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    // Constant-ish time is unnecessary on a LAN, but compare the whole token, never a prefix.
    let authorised = query.split('&').any(|kv| kv.strip_prefix("t=") == Some(token));
    if !authorised {
        return respond(&mut stream, "403 Forbidden", "text/plain", "forbidden");
    }
    match path {
        "/" => respond(&mut stream, "200 OK", "text/html; charset=utf-8", PAGE),
        "/status.json" => {
            let body = SNAPSHOT.lock().map(|s| s.clone()).unwrap_or_default();
            let body = if body.is_empty() { "{\"updated\":0,\"waiting\":0,\"working\":0,\"cost\":0,\"sessions\":[]}".into() } else { body };
            respond(&mut stream, "200 OK", "application/json", &body)
        }
        _ => respond(&mut stream, "404 Not Found", "text/plain", "not found"),
    }
}

/// Starts serving (or reports the running server) and returns the URL to open on a phone.
#[tauri::command]
pub fn remote_start(app: AppHandle) -> Result<RemoteInfo, String> {
    let token = token(&app)?;
    let mut server = SERVER.lock().map_err(|e| e.to_string())?;
    let listener = match server.as_ref() {
        Some(_) => None,
        None => Some(TcpListener::bind(("0.0.0.0", PORT)).or_else(|_| TcpListener::bind(("0.0.0.0", 0))).map_err(|e| e.to_string())?),
    };
    let port = match &listener {
        Some(l) => l.local_addr().map_err(|e| e.to_string())?.port(),
        None => 0,
    };
    if let Some(listener) = listener {
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        let tok = token.clone();
        thread::spawn(move || {
            while !flag.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let _ = stream.set_nonblocking(false);
                        let tok = tok.clone();
                        thread::spawn(move || handle(stream, &tok));
                    }
                    Err(_) => thread::sleep(Duration::from_millis(100)),
                }
            }
        });
        *server = Some(Server { stop });
        PORT_USED.store(port, Ordering::Relaxed);
    }
    let port = if port == 0 { PORT_USED.load(Ordering::Relaxed) } else { port };
    Ok(RemoteInfo { url: format!("http://{}:{port}/?t={token}", lan_ip()) })
}

static PORT_USED: std::sync::atomic::AtomicU16 = std::sync::atomic::AtomicU16::new(0);

#[tauri::command]
pub fn remote_stop() {
    if let Ok(mut server) = SERVER.lock() {
        if let Some(s) = server.take() {
            s.stop.store(true, Ordering::Relaxed);
        }
    }
    if let Ok(mut s) = SNAPSHOT.lock() {
        s.clear();
    }
}

/// Latest fleet snapshot (JSON) for the page to show.
#[tauri::command]
pub fn remote_update(snapshot: String) {
    if SERVER.lock().map(|s| s.is_some()).unwrap_or(false) {
        if let Ok(mut s) = SNAPSHOT.lock() {
            *s = snapshot;
        }
    }
}
