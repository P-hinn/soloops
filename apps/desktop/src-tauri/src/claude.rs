//! Wiring soloops into Claude.
//!
//! Claude Desktop reads its connectors from a JSON file, Claude Code keeps its
//! own and has a CLI for it. Both live on this machine, so the app can do what
//! would otherwise be typed by hand — including the part nobody remembers:
//! absolute paths to node and tsx. The connector is started by Claude, not
//! from a terminal, and inherits a bare PATH in which nvm does not exist.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Map, Value};

/// The MCP server inside the repository, and the runner that starts it.
const ENTRY: &str = "apps/mcp/src/index.ts";
const TSX: &str = "node_modules/tsx/dist/cli.mjs";
/// The name the connector carries in both configs.
const NAME: &str = "soloops";

#[derive(Serialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Wiring {
    Missing,
    /// Registered, but not with the command we would write — an old path, for
    /// instance, after the repository moved.
    Stale,
    Connected,
    /// Nothing there to write into: Claude Desktop is not installed, or the
    /// CLI is missing.
    Unavailable,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub desktop: Wiring,
    pub code: Wiring,
    pub desktop_config: String,
    pub dir: String,
    /// Exactly what would be written. The interface shows it for the cases
    /// this app cannot reach — Claude on another machine.
    pub spec: Option<Value>,
    /// Set when nothing can be written at all; then the interface explains
    /// instead of offering a button.
    pub problem: Option<String>,
    pub claude_running: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub ok: bool,
    /// false also means "was already right" — nothing was touched.
    pub changed: bool,
    pub message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub desktop: Outcome,
    pub code: Outcome,
    /// Claude Desktop reads the file only when it starts.
    pub restart_needed: bool,
    /// It was not running, so it was simply opened.
    pub opened: bool,
}

// --- Where things live ------------------------------------------------------

fn home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default())
}

fn desktop_config_path() -> PathBuf {
    home().join("Library/Application Support/Claude/claude_desktop_config.json")
}

/// Claude Code's user scope. Reading it is only for the display — writing goes
/// through the CLI, which owns the format.
fn code_config_path() -> PathBuf {
    home().join(".claude.json")
}

/// Finds a program the way a terminal would. A login shell has the first word
/// because that is where nvm and the Claude CLI live; the fixed places are the
/// fallback for a shell that reports nothing.
fn find_program(name: &str, fallbacks: &[&str]) -> Option<PathBuf> {
    if let Ok(out) = Command::new("/bin/zsh")
        .args(["-lc", &format!("command -v {name}")])
        .output()
    {
        let found = PathBuf::from(String::from_utf8_lossy(&out.stdout).trim());
        if found.is_file() {
            return Some(found);
        }
    }
    fallbacks
        .iter()
        .map(PathBuf::from)
        .find(|path| path.is_file())
}

fn node_bin() -> Option<PathBuf> {
    find_program("node", &["/opt/homebrew/bin/node", "/usr/local/bin/node"])
}

fn claude_cli() -> Option<PathBuf> {
    find_program("claude", &[])
}

fn claude_running() -> bool {
    Command::new("/usr/bin/pgrep")
        .args(["-x", "Claude"])
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false)
}

// --- What gets written ------------------------------------------------------

/// The connector entry. Absolute paths throughout, and the API port from the
/// .env — a connector that points at the wrong port answers every call with a
/// connection error.
fn spec(dir: &Path, api_port: u16) -> Result<Value, String> {
    let node = node_bin().ok_or("node wurde nicht gefunden.")?;
    let tsx = dir.join(TSX);
    let entry = dir.join(ENTRY);
    if !tsx.is_file() {
        return Err(format!(
            "{} fehlt. Einmal `npm install` im Repository laufen lassen.",
            tsx.display()
        ));
    }
    if !entry.is_file() {
        return Err(format!(
            "{} fehlt. Liegt das Repository noch unter {}?",
            entry.display(),
            dir.display()
        ));
    }
    Ok(json!({
        "command": node.to_string_lossy(),
        "args": [tsx.to_string_lossy(), entry.to_string_lossy()],
        "env": { "SOLOOPS_URL": format!("http://localhost:{api_port}") },
    }))
}

fn read_json_object(path: &Path) -> Map<String, Value> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
}

fn wiring(config: &Map<String, Value>, want: &Value) -> Wiring {
    match config
        .get("mcpServers")
        .and_then(|servers| servers.get(NAME))
    {
        None => Wiring::Missing,
        Some(found) if found == want => Wiring::Connected,
        Some(_) => Wiring::Stale,
    }
}

fn write_atomic(path: &Path, value: &Value) -> Result<(), String> {
    let text = serde_json::to_string_pretty(value).map_err(|err| err.to_string())? + "\n";
    let tmp = path.with_extension("json.soloops-tmp");
    std::fs::write(&tmp, text).map_err(|err| format!("Schreiben fehlgeschlagen: {err}"))?;
    std::fs::rename(&tmp, path).map_err(|err| format!("Ersetzen fehlgeschlagen: {err}"))
}

/// Puts the connector into Claude Desktop's config. Returns whether anything
/// changed — an entry that is already right is left alone.
fn write_desktop(want: &Value) -> Result<bool, String> {
    let path = desktop_config_path();
    let folder = path.parent().ok_or("Pfad ohne Verzeichnis")?;
    if !folder.is_dir() {
        return Err("Claude Desktop ist auf diesem Mac nicht eingerichtet.".into());
    }

    let mut root = read_json_object(&path);
    // An unreadable file would silently be replaced by an empty object — and
    // a user's preferences are not ours to drop.
    if root.is_empty() && std::fs::read_to_string(&path).is_ok_and(|text| !text.trim().is_empty()) {
        return Err(
            "Die Config von Claude Desktop ließ sich nicht lesen — hier wird nichts überschrieben."
                .into(),
        );
    }
    if root
        .get("mcpServers")
        .is_some_and(|value| !value.is_object())
    {
        return Err("`mcpServers` in der Config ist kein Objekt. Bitte von Hand nachsehen.".into());
    }

    {
        let servers = root
            .entry("mcpServers".to_string())
            .or_insert_with(|| json!({}));
        let servers = servers.as_object_mut().ok_or("unerwartete Struktur")?;
        if servers.get(NAME) == Some(want) {
            return Ok(false);
        }
        if path.is_file() {
            let backup = path.with_extension("json.soloops-backup");
            std::fs::copy(&path, &backup).map_err(|err| format!("Backup fehlgeschlagen: {err}"))?;
        }
        servers.insert(NAME.to_string(), want.clone());
    }

    write_atomic(&path, &Value::Object(root))?;
    Ok(true)
}

/// Registers the connector with Claude Code — user scope, so that it is there
/// in every project and not only in the repository.
fn write_code(dir: &Path, want: &Value) -> Result<bool, String> {
    let cli = claude_cli()
        .ok_or("Die claude-CLI wurde nicht gefunden — Claude Code bleibt unverdrahtet.")?;
    if wiring(&read_json_object(&code_config_path()), want) == Wiring::Connected {
        return Ok(false);
    }
    // add-json refuses a name that already exists; removing first is what
    // makes the button repeatable.
    let _ = Command::new(&cli)
        .args(["mcp", "remove", NAME, "-s", "user"])
        .current_dir(dir)
        .output();
    let out = Command::new(&cli)
        .args(["mcp", "add-json", NAME, &want.to_string(), "-s", "user"])
        .current_dir(dir)
        .output()
        .map_err(|err| err.to_string())?;
    if out.status.success() {
        return Ok(true);
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    let stdout = String::from_utf8_lossy(&out.stdout);
    let detail = [stderr.trim(), stdout.trim()]
        .into_iter()
        .find(|text| !text.is_empty())
        .unwrap_or("unbekannt")
        .lines()
        .last()
        .unwrap_or("unbekannt")
        .to_string();
    Err(detail)
}

// --- The three things the interface asks for ---------------------------------

pub fn status(dir: &Path, api_port: u16) -> Status {
    let (spec_value, problem) = match spec(dir, api_port) {
        Ok(value) => (Some(value), None),
        Err(err) => (None, Some(err)),
    };

    let desktop = match (&spec_value, desktop_config_path().parent()) {
        (Some(want), Some(folder)) if folder.is_dir() => {
            wiring(&read_json_object(&desktop_config_path()), want)
        }
        _ => Wiring::Unavailable,
    };
    let code = match (&spec_value, claude_cli()) {
        (Some(want), Some(_)) => wiring(&read_json_object(&code_config_path()), want),
        _ => Wiring::Unavailable,
    };

    Status {
        desktop,
        code,
        desktop_config: desktop_config_path().to_string_lossy().to_string(),
        dir: dir.to_string_lossy().to_string(),
        spec: spec_value,
        problem,
        claude_running: claude_running(),
    }
}

pub fn connect(dir: &Path, api_port: u16) -> Report {
    let want = match spec(dir, api_port) {
        Ok(value) => value,
        Err(err) => {
            let blocked = |message: &str| Outcome {
                ok: false,
                changed: false,
                message: message.to_string(),
            };
            return Report {
                desktop: blocked(&err),
                code: blocked(&err),
                restart_needed: false,
                opened: false,
            };
        }
    };

    let desktop = outcome(write_desktop(&want), "Claude Desktop");
    let code = outcome(write_code(dir, &want), "Claude Code");

    // Claude Desktop reads the file at startup only: if it is not running we
    // just open it, otherwise the interface offers the restart.
    let running = claude_running();
    let opened = desktop.ok && !running && open_claude();

    Report {
        restart_needed: desktop.changed && running,
        opened,
        desktop,
        code,
    }
}

fn outcome(result: Result<bool, String>, label: &str) -> Outcome {
    match result {
        Ok(true) => Outcome {
            ok: true,
            changed: true,
            message: format!("{label}: Connector eingetragen."),
        },
        Ok(false) => Outcome {
            ok: true,
            changed: false,
            message: format!("{label}: war schon richtig eingetragen."),
        },
        Err(err) => Outcome {
            ok: false,
            changed: false,
            message: err,
        },
    }
}

fn open_claude() -> bool {
    Command::new("/usr/bin/open")
        .args(["-a", "Claude"])
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

/// Quit and open again, so that a running Claude Desktop picks up the new
/// config. AppleScript asks politely; a stubborn app gets a SIGTERM.
pub fn restart_desktop() -> Result<(), String> {
    if claude_running() {
        let _ = Command::new("/usr/bin/osascript")
            .args(["-e", "tell application \"Claude\" to quit"])
            .status();
        if !wait_until_gone(Duration::from_secs(12)) {
            let _ = Command::new("/usr/bin/pkill")
                .args(["-x", "Claude"])
                .status();
            if !wait_until_gone(Duration::from_secs(5)) {
                return Err(
                    "Claude Desktop beendet sich nicht. Bitte von Hand neu starten.".into(),
                );
            }
        }
    }
    if open_claude() {
        Ok(())
    } else {
        Err("Claude Desktop konnte nicht gestartet werden.".into())
    }
}

fn wait_until_gone(limit: Duration) -> bool {
    let deadline = Instant::now() + limit;
    while Instant::now() < deadline {
        if !claude_running() {
            return true;
        }
        thread::sleep(Duration::from_millis(400));
    }
    !claude_running()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(entry: Value) -> Map<String, Value> {
        json!({ "preferences": { "theme": "dark" }, "mcpServers": { NAME: entry } })
            .as_object()
            .unwrap()
            .clone()
    }

    #[test]
    fn no_entry_means_not_connected() {
        let want = json!({ "command": "/usr/bin/node", "args": ["x"] });
        let empty = json!({ "preferences": {} }).as_object().unwrap().clone();
        assert!(wiring(&empty, &want) == Wiring::Missing);
    }

    #[test]
    fn the_very_same_entry_counts_as_connected() {
        let want = json!({ "command": "/usr/bin/node", "args": ["x"] });
        assert!(wiring(&config(want.clone()), &want) == Wiring::Connected);
    }

    #[test]
    fn an_old_path_is_stale_not_connected() {
        let want = json!({ "command": "/usr/bin/node", "args": ["neu"] });
        let old = json!({ "command": "/usr/bin/node", "args": ["alt"] });
        assert!(wiring(&config(old), &want) == Wiring::Stale);
    }
}
