//! SSH hosts from ~/.ssh/config, and remote files over SFTP.
//!
//! Everything goes through the system OpenSSH client, so the user's config, keys, agent and jump hosts apply.
//! Terminals and the file panel share one multiplexed connection per host. Passwords saved for a project live in
//! the macOS Keychain and reach ssh through its askpass hook, so they never appear in arguments or files.

use security_framework::passwords;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const SSH: &str = "/usr/bin/ssh";
const SFTP: &str = "/usr/bin/sftp";

#[derive(Serialize, Debug, PartialEq)]
pub struct SshHost {
    name: String,
    hostname: Option<String>,
    user: Option<String>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct RemoteEntry {
    name: String,
    /// "d" directory, "l" symlink, "f" anything else.
    kind: &'static str,
    size: u64,
    /// As the server's listing shows it, e.g. "Mar 04 12:30".
    modified: String,
}

#[derive(Serialize)]
pub struct RemoteListing {
    /// The directory listed, absolute.
    path: String,
    entries: Vec<RemoteEntry>,
}

// ── ~/.ssh/config ──────────────────────────────────────────────────────

fn ssh_dir() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".ssh")
}

/// `*` and `?` wildcard match, as ssh uses for Include file names.
fn wildcard(pattern: &[u8], name: &[u8]) -> bool {
    match (pattern.first(), name.first()) {
        (None, None) => true,
        (Some(b'*'), _) => wildcard(&pattern[1..], name) || (!name.is_empty() && wildcard(pattern, &name[1..])),
        (Some(b'?'), Some(_)) => wildcard(&pattern[1..], &name[1..]),
        (Some(p), Some(n)) if p == n => wildcard(&pattern[1..], &name[1..]),
        _ => false,
    }
}

/// Files an `Include` argument names: relative to ~/.ssh, with wildcards in the file name.
fn include_paths(arg: &str) -> Vec<PathBuf> {
    let path = match arg.strip_prefix("~/") {
        Some(rest) => ssh_dir().parent().unwrap_or(Path::new("/")).join(rest),
        None if arg.starts_with('/') => PathBuf::from(arg),
        None => ssh_dir().join(arg),
    };
    let Some(file) = path.file_name().and_then(|f| f.to_str()).filter(|f| f.contains(['*', '?'])) else {
        return vec![path];
    };
    let mut found: Vec<PathBuf> = path
        .parent()
        .and_then(|dir| fs::read_dir(dir).ok())
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| wildcard(file.as_bytes(), e.file_name().as_encoded_bytes()))
        .map(|e| e.path())
        .collect();
    found.sort();
    found
}

/// Concrete `Host` names in a config (wildcard patterns are templates, not hosts), with the HostName and User
/// of their block. Includes are followed a few levels deep.
fn parse_config(text: &str, depth: u8, out: &mut Vec<SshHost>) {
    // Indices into `out` of the hosts the current block applies to.
    let mut block: Vec<usize> = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (key, rest) = line.split_once(|c: char| c.is_whitespace() || c == '=').unwrap_or((line, ""));
        let rest = rest.trim_start_matches(|c: char| c.is_whitespace() || c == '=').trim();
        let value = rest.trim_matches('"').to_string();
        match key.to_ascii_lowercase().as_str() {
            "host" => {
                block.clear();
                for name in rest.split_whitespace().map(|n| n.trim_matches('"')) {
                    if name.contains(['*', '?', '!']) || name.starts_with('-') {
                        continue;
                    }
                    let i = out.iter().position(|h| h.name == name).unwrap_or_else(|| {
                        out.push(SshHost { name: name.to_string(), hostname: None, user: None });
                        out.len() - 1
                    });
                    block.push(i);
                }
            }
            "match" => block.clear(),
            // First value wins in ssh_config.
            "hostname" => block.iter().for_each(|&i| {
                out[i].hostname.get_or_insert_with(|| value.clone());
            }),
            "user" => block.iter().for_each(|&i| {
                out[i].user.get_or_insert_with(|| value.clone());
            }),
            "include" if depth < 4 => {
                for arg in rest.split_whitespace() {
                    for path in include_paths(arg) {
                        if let Ok(text) = fs::read_to_string(path) {
                            parse_config(&text, depth + 1, out);
                        }
                    }
                }
            }
            _ => {}
        }
    }
}

#[tauri::command]
pub async fn ssh_hosts() -> Vec<SshHost> {
    let mut hosts = Vec::new();
    if let Ok(text) = fs::read_to_string(ssh_dir().join("config")) {
        parse_config(&text, 0, &mut hosts);
    }
    hosts
}

// ── connection ─────────────────────────────────────────────────────────

/// Where to connect: a ~/.ssh/config host or a plain address, with optional overrides of its config.
#[derive(Deserialize, Debug, Default)]
pub struct Remote {
    host: String,
    port: Option<u16>,
    user: Option<String>,
    /// Private key file to log in with.
    identity: Option<String>,
    /// Keychain account holding the password, when one is saved.
    secret: Option<String>,
}

/// Keychain service of saved SFTP passwords; the account is the project id.
const KEYCHAIN_SERVICE: &str = "Houston SFTP";
/// Set on ssh's askpass helper (Houston itself) to the keychain account whose password it should answer with.
pub const ASKPASS_ENV: &str = "HOUSTON_ASKPASS";

/// Private directory for the connection sockets. Short (unix socket paths are limited to 104 bytes, and ssh
/// appends a random suffix while it sets one up) and owned by the user alone, so nobody can plant a socket.
fn control_dir() -> Result<PathBuf, String> {
    let uid = fs::metadata(std::env::var("HOME").unwrap_or_default()).map_err(|e| e.to_string())?.uid();
    let dir = PathBuf::from(format!("/tmp/houston-{uid}"));
    match fs::DirBuilder::new().mode(0o700).create(&dir) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(format!("{}: {e}", dir.display())),
    }
    let meta = fs::symlink_metadata(&dir).map_err(|e| e.to_string())?;
    if !meta.is_dir() || meta.uid() != uid || meta.permissions().mode() & 0o077 != 0 {
        return Err(format!("{} is not a private directory of yours; remove it and try again", dir.display()));
    }
    Ok(dir)
}

/// A value ssh reads as one config token: no line breaks or quotes, and no whitespace unless `spaces`.
fn check_value(what: &str, value: &str, spaces: bool) -> Result<(), String> {
    if value.is_empty() || value.contains(['"', '\\']) || value.chars().any(|c| c.is_control() || (!spaces && c.is_whitespace())) {
        return Err(format!("not a valid {what}: {value:?}"));
    }
    Ok(())
}

/// A host name ssh will read as a host, never as an option.
fn check_host(host: &str) -> Result<(), String> {
    check_value("host name", host, false)?;
    if host.starts_with('-') {
        return Err(format!("not a valid host name: {host:?}"));
    }
    Ok(())
}

/// Options and environment shared by ssh and sftp for `r`, ending with the destination. Terminals and the file
/// panel share one multiplexed connection per host, port and user. With a saved password, ssh asks Houston
/// for it instead of a terminal, so a fresh connection never needs typing; without one, a background sftp
/// never prompts and relies on keys, the agent, or a connection a terminal already logged in.
fn connection(r: &Remote, interactive: bool) -> Result<(Vec<String>, Vec<(String, String)>), String> {
    check_host(&r.host)?;
    let dir = control_dir()?;
    let mut opts = vec![
        "ControlMaster=auto".to_string(),
        format!("ControlPath={}/%C", dir.display()),
        "ControlPersist=10m".into(),
        // Like FileZilla's first-connect prompt, minus the prompt: a new host's key is remembered, a changed one refused.
        "StrictHostKeyChecking=accept-new".into(),
        "ConnectTimeout=15".into(),
        "ServerAliveInterval=15".into(),
        "ServerAliveCountMax=3".into(),
    ];
    if let Some(port) = r.port {
        opts.push(format!("Port={port}"));
    }
    if let Some(user) = r.user.as_deref().filter(|u| !u.is_empty()) {
        check_value("user name", user, false)?;
        opts.push(format!("User={user}"));
    }
    if let Some(key) = r.identity.as_deref().filter(|k| !k.is_empty()) {
        check_value("key file", key, true)?;
        let key = key.strip_prefix("~/").map(|rest| format!("{}/{rest}", std::env::var("HOME").unwrap_or_default())).unwrap_or(key.to_string());
        opts.push(format!("IdentityFile=\"{key}\""));
        opts.push("IdentitiesOnly=yes".into());
    }
    let mut env = Vec::new();
    match r.secret.as_deref().filter(|s| !s.is_empty()) {
        Some(account) => {
            check_value("keychain account", account, false)?;
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            env.push(("SSH_ASKPASS".into(), exe.display().to_string()));
            env.push(("SSH_ASKPASS_REQUIRE".into(), "force".into()));
            env.push((ASKPASS_ENV.into(), account.to_string()));
            opts.push("NumberOfPasswordPrompts=1".into());
        }
        None if !interactive => opts.push("BatchMode=yes".into()),
        None => {}
    }
    let mut args: Vec<String> = opts.into_iter().flat_map(|o| ["-o".to_string(), o]).collect();
    args.extend(["--".to_string(), r.host.clone()]);
    Ok((args, env))
}

#[derive(Serialize)]
pub struct SshCommand {
    argv: Vec<String>,
    env: HashMap<String, String>,
}

/// Program, arguments and environment of an interactive SSH session to `remote`.
#[tauri::command]
pub async fn ssh_command(remote: Remote) -> Result<SshCommand, String> {
    let (args, env) = connection(&remote, true)?;
    let mut argv = vec![SSH.to_string()];
    argv.extend(args);
    Ok(SshCommand { argv, env: env.into_iter().collect() })
}

// ── saved passwords ────────────────────────────────────────────────────

#[tauri::command]
pub async fn sftp_save_password(account: String, password: String) -> Result<(), String> {
    check_value("keychain account", &account, false)?;
    passwords::set_generic_password(KEYCHAIN_SERVICE, &account, password.as_bytes()).map_err(|e| format!("could not save the password in the Keychain: {e}"))
}

#[tauri::command]
pub async fn sftp_forget_password(account: String) -> Result<(), String> {
    match passwords::delete_generic_password(KEYCHAIN_SERVICE, &account) {
        Err(e) if e.code() != ERR_SEC_ITEM_NOT_FOUND => Err(format!("could not remove the password from the Keychain: {e}")),
        _ => Ok(()),
    }
}

const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

/// Houston run as ssh's askpass helper: prints the saved password when ssh asks for one. Anything else ssh
/// might ask (a key passphrase, a one-time code) gets no answer, so it fails instead of receiving the password.
pub fn askpass(account: &str) -> i32 {
    let prompt = std::env::args().nth(1).unwrap_or_default().to_lowercase();
    if !prompt.contains("password") {
        return 1;
    }
    match passwords::get_generic_password(KEYCHAIN_SERVICE, account) {
        Ok(password) => {
            let mut out = std::io::stdout();
            if out.write_all(&password).and_then(|_| out.write_all(b"\n")).is_ok() {
                0
            } else {
                1
            }
        }
        Err(_) => 1,
    }
}

// ── sftp ───────────────────────────────────────────────────────────────

/// A path as one sftp batch argument. Inside double quotes sftp takes wildcards literally, so only quotes
/// and backslashes need escaping.
fn quote(path: &str) -> Result<String, String> {
    if path.contains(['\n', '\r']) {
        return Err("paths with line breaks are not supported".into());
    }
    Ok(format!("\"{}\"", path.replace('\\', "\\\\").replace('"', "\\\"")))
}

/// Remote paths are absolute, so a name can never be read as a command option.
fn remote(path: &str) -> Result<String, String> {
    if !path.starts_with('/') {
        return Err(format!("not an absolute remote path: {path}"));
    }
    quote(path)
}

/// Runs an sftp batch against `r`; stops at the first failing command. Returns stdout.
fn sftp(r: &Remote, batch: &str) -> Result<String, String> {
    let (args, env) = connection(r, false)?;
    let mut child = Command::new(SFTP)
        .args(["-q", "-b", "-"])
        .args(args)
        .envs(env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not run sftp: {e}"))?;
    child.stdin.take().expect("piped stdin").write_all(batch.as_bytes()).map_err(|e| e.to_string())?;
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    if out.status.success() {
        return Ok(stdout);
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    let message = stderr.lines().map(str::trim).filter(|l| !l.is_empty()).collect::<Vec<_>>().join("\n");
    if message.contains("Permission denied") && r.secret.is_none() {
        return Err(format!("{message}\n\nSave a password or key file in the connection settings, or log in from an SSH terminal first; the file panel then shares that connection."));
    }
    if message.contains("REMOTE HOST IDENTIFICATION HAS CHANGED") || message.contains("Host key verification failed") {
        return Err(format!("{message}\n\nThe server's host key is not the one remembered in ~/.ssh/known_hosts. If the server was really reinstalled, remove its old entry with: ssh-keygen -R {}", r.host));
    }
    Err(if message.is_empty() { format!("sftp exited with {}", out.status) } else { message })
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// One `ls -lan` row, in OpenSSH's fixed layout: mode, links, uid, gid, size, three date fields, then the name
/// after a single space (so names keep their own spaces).
fn parse_entry(line: &str) -> Option<RemoteEntry> {
    let mut rest = line;
    let mut fields = Vec::with_capacity(8);
    for _ in 0..8 {
        rest = rest.trim_start_matches(' ');
        let end = rest.find(' ')?;
        fields.push(&rest[..end]);
        rest = &rest[end..];
    }
    let name = rest.strip_prefix(' ')?;
    if name.is_empty() || name == "." || name == ".." {
        return None;
    }
    let kind = match fields[0].as_bytes().first()? {
        b'd' => "d",
        b'l' => "l",
        _ => "f",
    };
    Some(RemoteEntry { name: name.to_string(), kind, size: fields[4].parse().ok()?, modified: fields[5..8].join(" ") })
}

fn parse_listing(stdout: &str) -> Option<RemoteListing> {
    let mut path = None;
    let mut entries = Vec::new();
    for line in stdout.lines() {
        if line.starts_with("sftp> ") {
            continue; // batch mode echoes each command
        }
        if let Some(dir) = line.strip_prefix("Remote working directory: ") {
            path = Some(dir.to_string());
        } else if let Some(entry) = parse_entry(line) {
            entries.push(entry);
        }
    }
    Some(RemoteListing { path: path?, entries })
}

fn list(r: &Remote, path: &str) -> Result<RemoteListing, String> {
    let cd = if path.is_empty() { String::new() } else { format!("cd {}\n", remote(path)?) };
    let out = sftp(r, &format!("{cd}pwd\nls -lan\n"))?;
    parse_listing(&out).ok_or_else(|| "unexpected sftp output".to_string())
}

fn child_path(dir: &str, name: &str) -> String {
    if dir == "/" { format!("/{name}") } else { format!("{dir}/{name}") }
}

/// Batch lines deleting `dir` and everything below it, deepest first. Symlinks are removed, never followed.
fn tree_removal(r: &Remote, dir: &str, batch: &mut String) -> Result<(), String> {
    for entry in list(r, dir)?.entries {
        let path = child_path(dir, &entry.name);
        if entry.kind == "d" {
            tree_removal(r, &path, batch)?;
        } else {
            *batch += &format!("rm {}\n", remote(&path)?);
        }
    }
    *batch += &format!("rmdir {}\n", remote(dir)?);
    Ok(())
}

/// Lists a directory; an empty `path` lists the login directory.
#[tauri::command]
pub async fn sftp_list(remote: Remote, path: String) -> Result<RemoteListing, String> {
    blocking(move || list(&remote, &path)).await
}

/// Copies a remote file or directory (recursively) to `local`.
#[tauri::command]
pub async fn sftp_download(remote: Remote, path: String, local: String) -> Result<(), String> {
    blocking(move || {
        if !local.starts_with('/') {
            return Err(format!("not an absolute local path: {local}"));
        }
        sftp(&remote, &format!("get -pR {} {}\n", self::remote(&path)?, quote(&local)?)).map(drop)
    })
    .await
}

/// Copies local files and folders into the remote directory `dir`, keeping their names.
#[tauri::command]
pub async fn sftp_upload(remote: Remote, dir: String, locals: Vec<String>) -> Result<(), String> {
    blocking(move || {
        let mut batch = format!("cd {}\n", self::remote(&dir)?);
        for local in &locals {
            if !local.starts_with('/') {
                return Err(format!("not an absolute local path: {local}"));
            }
            batch += &format!("put -pR {}\n", quote(local)?);
        }
        sftp(&remote, &batch).map(drop)
    })
    .await
}

#[tauri::command]
pub async fn sftp_mkdir(remote: Remote, path: String) -> Result<(), String> {
    blocking(move || sftp(&remote, &format!("mkdir {}\n", self::remote(&path)?)).map(drop)).await
}

/// Deletes a file, or a directory with everything in it.
#[tauri::command]
pub async fn sftp_remove(remote: Remote, path: String, dir: bool) -> Result<(), String> {
    blocking(move || {
        if path == "/" {
            return Err("refusing to delete /".into());
        }
        let mut batch = String::new();
        if dir {
            tree_removal(&remote, &path, &mut batch)?;
        } else {
            batch = format!("rm {}\n", self::remote(&path)?);
        }
        sftp(&remote, &batch).map(drop)
    })
    .await
}

#[tauri::command]
pub async fn sftp_rename(remote: Remote, from: String, to: String) -> Result<(), String> {
    blocking(move || sftp(&remote, &format!("rename {} {}\n", self::remote(&from)?, self::remote(&to)?)).map(drop)).await
}

// ── view & edit ────────────────────────────────────────────────────────

/// Private folder of remote files opened for editing. Like FileZilla's temporary copies, it is emptied when
/// Houston starts; a changed copy is offered for upload while Houston runs.
fn edit_root() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default()).join("Library/Caches/Houston/sftp-edit")
}

pub fn clear_edits() {
    let _ = fs::remove_dir_all(edit_root());
}

/// A path inside the edit folder, so these commands never touch other local files.
fn edit_copy(local: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(local);
    if !path.starts_with(edit_root()) || path.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err(format!("not an edited copy: {local}"));
    }
    Ok(path)
}

/// Opens a file in the app macOS assigns to it, or the default text editor when none is.
fn open_in_app(path: &Path) -> Result<(), String> {
    let run = |args: &[&std::ffi::OsStr]| Command::new("/usr/bin/open").args(args).stdout(Stdio::null()).stderr(Stdio::null()).status().map(|s| s.success()).unwrap_or(false);
    if run(&[path.as_os_str()]) || run(&["-t".as_ref(), path.as_os_str()]) {
        Ok(())
    } else {
        Err(format!("could not open {}", path.display()))
    }
}

/// Downloads a remote file into its own private folder and opens it; returns the local copy.
#[tauri::command]
pub async fn sftp_edit(remote: Remote, path: String) -> Result<String, String> {
    blocking(move || {
        let name = path.rsplit('/').next().unwrap_or_default();
        if name.is_empty() || name == "." || name == ".." {
            return Err(format!("not a file: {path}"));
        }
        static COUNT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis());
        let dir = edit_root().join(format!("{stamp}-{}", COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
        fs::DirBuilder::new().recursive(true).mode(0o700).create(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        let local = dir.join(name);
        let local_str = local.to_str().ok_or("unsupported file name")?;
        sftp(&remote, &format!("get -p {} {}\n", self::remote(&path)?, quote(local_str)?))?;
        open_in_app(&local)?;
        Ok(local_str.to_string())
    })
    .await
}

/// Opens an edited copy again.
#[tauri::command]
pub async fn edit_reopen(local: String) -> Result<(), String> {
    open_in_app(&edit_copy(&local)?)
}

/// Modification time of an edited copy in unix milliseconds; `None` once it is gone.
#[tauri::command]
pub async fn edit_mtime(local: String) -> Result<Option<u64>, String> {
    let path = edit_copy(&local)?;
    Ok(fs::metadata(path).ok().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64))
}

// ── local side ─────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct LocalEntry {
    name: String,
    /// "d" directory (or a symlink to one), "l" other symlink, "f" anything else.
    kind: &'static str,
    size: u64,
    /// Unix milliseconds.
    mtime: u64,
}

/// A local directory for the file panel's left side.
#[tauri::command]
pub async fn local_list(path: String) -> Result<Vec<LocalEntry>, String> {
    blocking(move || {
        let mut out = Vec::new();
        for entry in fs::read_dir(&path).map_err(|e| format!("{path}: {e}"))?.flatten() {
            let Ok(meta) = entry.metadata() else { continue };
            let kind = if meta.is_dir() {
                "d"
            } else if meta.file_type().is_symlink() {
                if fs::metadata(entry.path()).map(|m| m.is_dir()).unwrap_or(false) { "d" } else { "l" }
            } else {
                "f"
            };
            let mtime = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64);
            out.push(LocalEntry { name: entry.file_name().to_string_lossy().into_owned(), kind, size: meta.len(), mtime });
        }
        Ok(out)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_hosts_skip_patterns_and_keep_first_values() {
        let mut hosts = Vec::new();
        parse_config(
            "Host web db\n  HostName 10.0.0.1\n  User deploy\n  User other\nHost *\n  User nobody\nhost=live\n HostName = \"example.com\"\nMatch all\n User x\n",
            0,
            &mut hosts,
        );
        let h = |name: &str, hostname: Option<&str>, user: Option<&str>| SshHost {
            name: name.into(),
            hostname: hostname.map(Into::into),
            user: user.map(Into::into),
        };
        assert_eq!(hosts, vec![h("web", Some("10.0.0.1"), Some("deploy")), h("db", Some("10.0.0.1"), Some("deploy")), h("live", Some("example.com"), None)]);
    }

    #[test]
    fn wildcards() {
        assert!(wildcard(b"*.conf", b"work.conf"));
        assert!(wildcard(b"h?st", b"host"));
        assert!(!wildcard(b"*.conf", b"work.config"));
    }

    #[test]
    fn listing_rows() {
        let out = "sftp> pwd\nRemote working directory: /home/me\nsftp> ls -lan\n\
            drwxr-xr-x    5 1000     1000         4096 Mar 04 12:30 .\n\
            drwxr-xr-x    3 0        0            4096 Jan 01  2024 ..\n\
            -rw-r--r--    1 1000     1000          220 Jan 01  2024 my  file.txt\n\
            lrwxrwxrwx    1 1000     1000            9 Mar 04 12:30 www\n\
            drwx------    2 1000     1000         4096 Mar 04 12:30 .ssh\n\
            -rw-r--r--    ? janosch  wheel           2 Nov  1 09:37 qu\"o\\te.txt\n";
        let l = parse_listing(out).unwrap();
        assert_eq!(l.path, "/home/me");
        assert_eq!(l.entries.len(), 4);
        assert_eq!(l.entries[3], RemoteEntry { name: r#"qu"o\te.txt"#.into(), kind: "f", size: 2, modified: "Nov 1 09:37".into() });
        assert_eq!(l.entries[0], RemoteEntry { name: "my  file.txt".into(), kind: "f", size: 220, modified: "Jan 01 2024".into() });
        assert_eq!(l.entries[1].kind, "l");
        assert_eq!(l.entries[2].name, ".ssh");
    }

    #[test]
    fn quoting() {
        assert_eq!(quote(r#"/a "b"\c*"#).unwrap(), r#""/a \"b\"\\c*""#);
        assert!(remote("relative").is_err());
        assert!(quote("/a\nb").is_err());
        assert!(check_host("-oProxyCommand=x").is_err());
    }

    #[test]
    fn connection_options() {
        let r = Remote { host: "example.com".into(), port: Some(2222), user: Some("deploy".into()), identity: Some("/k/my key".into()), secret: None };
        let (args, env) = connection(&r, false).unwrap();
        let joined = args.join(" ");
        assert!(joined.contains("-o Port=2222") && joined.contains("-o User=deploy") && joined.contains("-o IdentityFile=\"/k/my key\""));
        assert!(joined.contains("BatchMode=yes") && env.is_empty());
        assert_eq!(&args[args.len() - 2..], ["--", "example.com"]);

        let saved = Remote { host: "h".into(), secret: Some("p1".into()), ..Default::default() };
        let (args, env) = connection(&saved, false).unwrap();
        assert!(!args.join(" ").contains("BatchMode"));
        assert!(env.iter().any(|(k, v)| k == ASKPASS_ENV && v == "p1"));

        let bad = |r: Remote| connection(&r, true).is_err();
        assert!(bad(Remote { host: "h".into(), user: Some("a b".into()), ..Default::default() }));
        assert!(bad(Remote { host: "h".into(), identity: Some("/k\"x".into()), ..Default::default() }));
        assert!(bad(Remote { host: "h\nProxyCommand x".into(), ..Default::default() }));
    }

    #[test]
    fn edit_copies_stay_in_their_folder() {
        let inside = edit_root().join("1-0/index.php");
        assert!(edit_copy(inside.to_str().unwrap()).is_ok());
        assert!(edit_copy("/etc/passwd").is_err());
        assert!(edit_copy(edit_root().join("../../x").to_str().unwrap()).is_err());
    }
}
