//! Reads and edits the `alias name=value` lines in the user's .zshrc, one alias per line.
//! Edits are line-local so the rest of the file is kept byte for byte.

use serde::Serialize;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Serialize)]
pub struct Alias {
    name: String,
    command: String,
    /// False when the value expands `$`/backticks at definition time; rewriting it would change its meaning.
    editable: bool,
}

/// One parsed `alias` line: indentation and trailing comment are kept when it is rewritten.
struct Line {
    indent: String,
    name: String,
    command: String,
    editable: bool,
    comment: String,
}

/// Serializes read-modify-write cycles on the file.
static LOCK: Mutex<()> = Mutex::new(());

/// The real file behind ~/.zshrc, so a symlinked dotfile is edited where it lives instead of being replaced.
fn zshrc() -> PathBuf {
    let path = crate::shell::user_zdotdir().join(".zshrc");
    fs::canonicalize(&path).unwrap_or(path)
}

fn valid_name(name: &str) -> bool {
    !name.is_empty() && !name.starts_with('-') && name.chars().all(|c| c.is_ascii_alphanumeric() || "_.:@+-".contains(c))
}

/// Parses a single shell word (quotes and escapes resolved); returns the value, whether it is
/// free of expansions, and the unparsed rest of the line.
fn parse_word(s: &str) -> Option<(String, bool, &str)> {
    let mut out = String::new();
    let mut literal = true;
    let mut chars = s.char_indices().peekable();
    while let Some(&(i, c)) = chars.peek() {
        match c {
            ' ' | '\t' | ';' | '&' | '|' | '#' => return Some((out, literal, &s[i..])),
            '\'' => {
                chars.next();
                loop {
                    match chars.next()? {
                        (_, '\'') => break,
                        (_, ch) => out.push(ch),
                    }
                }
            }
            '"' => {
                chars.next();
                loop {
                    match chars.next()? {
                        (_, '"') => break,
                        (_, '\\') => {
                            let (_, next) = chars.next()?;
                            if !"$`\"\\".contains(next) {
                                out.push('\\');
                            }
                            out.push(next);
                        }
                        (_, ch) => {
                            literal &= ch != '$' && ch != '`';
                            out.push(ch);
                        }
                    }
                }
            }
            '\\' => {
                chars.next();
                out.push(chars.next()?.1);
            }
            _ => {
                chars.next();
                literal &= c != '$' && c != '`';
                out.push(c);
            }
        }
    }
    Some((out, literal, ""))
}

fn parse_line(line: &str) -> Option<Line> {
    let rest = line.trim_start();
    let indent = &line[..line.len() - rest.len()];
    let rest = rest.strip_prefix("alias")?;
    let rest = rest.strip_prefix([' ', '\t'])?.trim_start();
    let (name, value) = rest.split_once('=')?;
    if !valid_name(name) {
        return None;
    }
    let (word, literal, rest) = parse_word(value)?;
    let tail = rest.trim();
    // Only a trailing comment may follow; `alias a=b c=d` or `alias a=b; cmd` are left alone.
    if !tail.is_empty() && !tail.starts_with('#') {
        return None;
    }
    let comment = if tail.is_empty() { String::new() } else { format!(" {tail}") };
    // Expanding values are shown as written, quotes included.
    let command = if literal { word } else { value[..value.len() - rest.len()].to_string() };
    Some(Line { indent: indent.to_string(), name: name.to_string(), command, editable: literal, comment })
}

fn format_line(indent: &str, name: &str, command: &str, comment: &str) -> String {
    format!("{indent}alias {name}='{}'{comment}", command.replace('\'', r"'\''"))
}

fn read() -> Result<String, String> {
    match fs::read_to_string(zshrc()) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("cannot read .zshrc: {e}")),
    }
}

/// Atomic replace that keeps the file mode, after saving the previous version next to it.
fn write(text: &str) -> Result<(), String> {
    let file = zshrc();
    let mode = fs::metadata(&file).map(|m| m.permissions().mode()).unwrap_or(0o644);
    if file.exists() {
        fs::copy(&file, file.with_extension("houston-bak")).map_err(|e| format!("cannot back up .zshrc: {e}"))?;
    }
    let tmp = file.with_extension("houston-tmp");
    fs::write(&tmp, text)
        .and_then(|_| fs::set_permissions(&tmp, fs::Permissions::from_mode(mode)))
        .and_then(|_| fs::rename(&tmp, &file))
        .map_err(|e| format!("cannot write .zshrc: {e}"))
}

/// Last definition wins in zsh, so each name maps to its last line.
fn last_definition(lines: &[&str], name: &str) -> Option<(usize, Line)> {
    lines.iter().enumerate().rev().find_map(|(i, l)| parse_line(l).filter(|p| p.name == name).map(|p| (i, p)))
}

fn join(lines: &[String], trailing_newline: bool) -> String {
    let mut text = lines.join("\n");
    if trailing_newline && !text.is_empty() {
        text.push('\n');
    }
    text
}

/// Aliases defined in .zshrc, in file order, one entry per name.
#[tauri::command]
pub async fn list_aliases() -> Result<Vec<Alias>, String> {
    let text = read()?;
    let mut aliases: Vec<Alias> = Vec::new();
    for p in text.lines().filter_map(parse_line) {
        aliases.retain(|a| a.name != p.name);
        aliases.push(Alias { name: p.name, command: p.command, editable: p.editable });
    }
    Ok(aliases)
}

/// Adds an alias (`original` None) or rewrites the definition of `original`, possibly renaming it.
#[tauri::command]
pub async fn save_alias(original: Option<String>, name: String, command: String) -> Result<(), String> {
    let name = name.trim();
    let command = command.trim();
    if !valid_name(name) {
        return Err("Name may only use letters, digits and _ . : @ + -".into());
    }
    if command.is_empty() || command.contains(['\n', '\r']) {
        return Err("Command must be a single non-empty line".into());
    }
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let text = read()?;
    let lines: Vec<&str> = text.lines().collect();
    if original.as_deref() != Some(name) && last_definition(&lines, name).is_some() {
        return Err(format!("An alias named {name} already exists"));
    }
    let mut out: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
    match original {
        Some(orig) => {
            let (i, old) = last_definition(&lines, &orig).ok_or(format!("{orig} is no longer defined in .zshrc"))?;
            if !old.editable {
                return Err(format!("{orig} uses shell expansions; edit it in .zshrc directly"));
            }
            out[i] = format_line(&old.indent, name, command, &old.comment);
        }
        None => out.push(format_line("", name, command, "")),
    }
    write(&join(&out, true))
}

/// Removes every definition of the alias so no earlier one takes over.
#[tauri::command]
pub async fn delete_alias(name: String) -> Result<(), String> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let text = read()?;
    let kept: Vec<String> = text.lines().filter(|l| parse_line(l).map_or(true, |p| p.name != name)).map(str::to_string).collect();
    write(&join(&kept, text.ends_with('\n')))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed(line: &str) -> Option<(String, String, bool, String)> {
        parse_line(line).map(|p| (p.name, p.command, p.editable, p.comment))
    }

    #[test]
    fn parses_common_forms() {
        assert_eq!(parsed("alias prod='ssh root@10.0.0.1'"), Some(("prod".into(), "ssh root@10.0.0.1".into(), true, "".into())));
        assert_eq!(parsed("  alias db=\"ssh -p 2222 db\" # staging"), Some(("db".into(), "ssh -p 2222 db".into(), true, " # staging".into())));
        assert_eq!(parsed("alias ll=ls\\ -la"), Some(("ll".into(), "ls -la".into(), true, "".into())));
        assert_eq!(parsed("alias q='echo '\\''hi'\\'''"), Some(("q".into(), "echo 'hi'".into(), true, "".into())));
    }

    #[test]
    fn expansions_are_read_only_and_raw() {
        assert_eq!(parsed("alias me=\"ssh $USER@box\""), Some(("me".into(), "\"ssh $USER@box\"".into(), false, "".into())));
    }

    #[test]
    fn skips_other_lines() {
        for line in ["# alias x='y'", "alias -g G='| grep'", "alias a=b c=d", "alias a=b; echo", "aliases=1", "alias 'x=y'"] {
            assert!(parse_line(line).is_none(), "{line}");
        }
    }

    #[test]
    fn round_trips_quotes() {
        let line = format_line("  ", "q", "echo 'hi' \"there\"", " # c");
        assert_eq!(parsed(&line), Some(("q".into(), "echo 'hi' \"there\"".into(), true, " # c".into())));
    }
}

#[cfg(test)]
mod file_tests {
    use super::*;
    use tauri::async_runtime::block_on;

    #[test]
    fn edits_only_alias_lines() {
        let dir = std::env::temp_dir().join(format!("houston-alias-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        std::env::set_var("ZDOTDIR", &dir);
        let rc = dir.join(".zshrc");
        fs::write(&rc, "export A=1\n  alias web='ssh web' # prod\nalias old=x\nalias old=y\n").unwrap();

        block_on(save_alias(Some("web".into()), "web1".into(), "ssh it's".into())).unwrap();
        block_on(save_alias(None, "db".into(), "ssh db".into())).unwrap();
        assert!(block_on(save_alias(None, "db".into(), "dup".into())).is_err());
        block_on(delete_alias("old".into())).unwrap();
        assert_eq!(fs::read_to_string(&rc).unwrap(), "export A=1\n  alias web1='ssh it'\\''s' # prod\nalias db='ssh db'\n");
        assert_eq!(fs::read_to_string(dir.join(".zshrc.houston-bak")).unwrap(), "export A=1\n  alias web1='ssh it'\\''s' # prod\nalias old=x\nalias old=y\nalias db='ssh db'\n");
        let names: Vec<String> = block_on(list_aliases()).unwrap().into_iter().map(|a| a.name).collect();
        assert_eq!(names, ["web1", "db"]);
        fs::remove_dir_all(&dir).unwrap();
    }
}
