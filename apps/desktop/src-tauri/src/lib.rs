//! soloops as a window instead of a browser tab.
//!
//! The app renders nothing of its own: it shows the same interface that runs
//! at http://localhost. What it adds is the frame — menu bar, keyboard
//! shortcuts, tray — and starting the containers, so that nobody has to open
//! a terminal first.
//!
//! The loaded page deliberately gets no access to Tauri APIs. Everything the
//! app can do happens here in Rust; what reaches the interface is JavaScript
//! that could just as well be typed into the console.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use tauri::menu::{
    AboutMetadata, CheckMenuItem, CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder,
    SubmenuBuilder,
};
use tauri::tray::TrayIconBuilder;
use tauri::{
    AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent, Wry,
};

mod activity;
mod backup;
mod claude;
mod followups;
mod http;
mod sync;
mod tracker;

/// The modules in sidebar order — Cmd+1 through Cmd+9.
const SECTIONS: [(&str, &str, &str); 9] = [
    ("go-dashboard", "Übersicht", "/"),
    ("go-calendar", "Kalender", "/calendar"),
    ("go-inbox", "Eingang", "/inbox"),
    ("go-leads", "Leads", "/leads"),
    ("go-projects", "Projekte", "/projects"),
    ("go-clients", "Kunden", "/clients"),
    ("go-time", "Zeiten", "/time"),
    ("go-invoices", "Rechnungen", "/invoices"),
    ("go-settings", "Einstellungen", "/settings"),
];

/// What the menu commands need to know.
struct Runtime {
    dir: PathBuf,
    web_port: u16,
    api_port: u16,
    /// Until the first successful load the window shows the splash screen.
    /// Navigation and fetching would do nothing there and are skipped.
    loaded: Arc<AtomicBool>,
    /// Is recording on? The sampler thread reads this on every tick, so that
    /// "off" takes effect at once and not on the next start.
    activity: Arc<AtomicBool>,
    /// The same switch lives in the menu and in the tray. Both check marks
    /// have to follow when either one is clicked.
    activity_items: Mutex<Vec<CheckMenuItem<Wry>>>,
    /// The SERVICE_TOKEN out of the .env. The widget talks to the API through
    /// here and never sees the token itself — it is a local page without a
    /// login, and a page that holds the service token is a page that can do
    /// everything.
    token: Option<String>,
    /// Where the widget sits, whether it is unfolded, whether it is on.
    tracker: Mutex<tracker::State>,
    /// While the widget is being dragged. Unix seconds of the last move, 0
    /// when it is at rest. The guard thread reads this and keeps its hands
    /// off — a window being dragged across a screen boundary is reported as
    /// hidden for a moment, and the guard used to answer that by snapping it
    /// back to its anchor, every three seconds, which is exactly what a
    /// flickering widget looks like.
    ///
    /// A timestamp and not a flag: if a `pointerup` is ever lost, a flag
    /// would stay set and disable the guard for the rest of the session.
    tracker_drag: Arc<AtomicU64>,
    /// Menu and tray again, same reason as above.
    tracker_items: Mutex<Vec<CheckMenuItem<Wry>>>,
    /// Where the snapshots go, how often, and how the last run went.
    backup: Mutex<backup::State>,
    /// A snapshot or a restore is running. Both take a while and neither may
    /// start twice — a second `pg_dump` into the same staging folder would
    /// write over the first one's dump.
    backup_busy: Arc<AtomicBool>,
    /// What to tell the window about the last run, in words. Not persisted:
    /// it is the answer to a button that was just pressed.
    backup_note: Mutex<String>,
    /// The home directory, for the iCloud path. Read once — it does not
    /// change while the app runs, and `std::env::var` per poll is a syscall
    /// for nothing.
    home: PathBuf,
}

// --- Project and ports ------------------------------------------------------

/// Where the repository lives. A .app has no working directory, so the path
/// is baked in at build time; SOLOOPS_DIR overrides it should the directory
/// move later on.
fn project_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("SOLOOPS_DIR") {
        return PathBuf::from(dir);
    }
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../.."))
}

/// One value from the .env. Not a full parser — line, equals sign, rest,
/// quotes off. There is nothing more complicated in that file.
fn env_value(dir: &Path, key: &str) -> Option<String> {
    let text = std::fs::read_to_string(dir.join(".env")).ok()?;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('#') {
            continue;
        }
        let Some(rest) = line
            .strip_prefix(key)
            .and_then(|rest| rest.strip_prefix('='))
        else {
            continue;
        };
        let value = rest.trim().trim_matches('"').trim_matches('\'').to_string();
        if !value.is_empty() {
            return Some(value);
        }
    }
    None
}

fn port_from_env(dir: &Path, key: &str, fallback: u16) -> u16 {
    env_value(dir, key)
        .and_then(|value| value.parse().ok())
        .unwrap_or(fallback)
}

fn port_open(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(400)).is_ok()
}

/// An open port does not yet mean the API answers requests — Fastify binds
/// earlier than Prisma connects.
fn api_healthy(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(500)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    if stream
        .write_all(b"GET /health HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut head = [0u8; 64];
    match stream.read(&mut head) {
        Ok(n) if n > 12 => String::from_utf8_lossy(&head[..n]).contains(" 200 "),
        _ => false,
    }
}

// --- Docker -----------------------------------------------------------------

/// Inside a .app, PATH has shrunk to /usr/bin:/bin — Docker is never there.
/// So look in the places it is known to live.
fn docker_bin() -> Option<PathBuf> {
    let home = std::env::var("HOME").unwrap_or_default();
    [
        PathBuf::from("/usr/local/bin/docker"),
        PathBuf::from("/opt/homebrew/bin/docker"),
        PathBuf::from(format!("{home}/.docker/bin/docker")),
        PathBuf::from("/Applications/Docker.app/Contents/Resources/bin/docker"),
    ]
    .into_iter()
    .find(|path| path.is_file())
}

fn daemon_running(docker: &Path) -> bool {
    Command::new(docker)
        .args(["info", "--format", "{{.ServerVersion}}"])
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false)
}

fn compose(docker: &Path, dir: &Path, args: &[&str]) -> Result<(), String> {
    let out = Command::new(docker)
        .arg("compose")
        .args(args)
        .current_dir(dir)
        .output()
        .map_err(|err| err.to_string())?;
    if out.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    Err(stderr
        .trim()
        .lines()
        .last()
        .unwrap_or("unbekannt")
        .to_string())
}

// --- Ports ------------------------------------------------------------------

/// The port list comes from `scripts/ports.sh`. Docker attribution, filtering
/// and killing therefore exist in exactly one place — the same rules apply in
/// the terminal and here.
fn ports_script(dir: &Path, args: &[&str]) -> Result<String, String> {
    let script = dir.join("scripts/ports.sh");
    if !script.is_file() {
        return Err(format!(
            "{} wurde nicht gefunden. Liegt das Repository noch unter {}?",
            script.display(),
            dir.display()
        ));
    }

    let home = std::env::var("HOME").unwrap_or_default();
    let output = Command::new("/bin/bash")
        .arg(&script)
        .args(args)
        .current_dir(dir)
        // A .app starts with a nearly empty PATH. Without this line the
        // script would find neither docker nor lsof — and would mistake
        // containers for ordinary processes.
        .env(
            "PATH",
            format!(
                "/usr/local/bin:/opt/homebrew/bin:{home}/.docker/bin:/usr/bin:/bin:/usr/sbin:/sbin"
            ),
        )
        .output()
        .map_err(|err| err.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(stderr
            .trim()
            .lines()
            .last()
            .unwrap_or("unbekannt")
            .to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[tauri::command]
fn list_ports(state: tauri::State<Runtime>) -> Result<String, String> {
    ports_script(&state.dir, &["--json"])
}

#[tauri::command]
fn kill_port(port: u16, state: tauri::State<Runtime>) -> Result<String, String> {
    ports_script(&state.dir, &["kill", &port.to_string()])
}

/// A second window, deliberately small. It shows what `npm run ports` shows.
fn open_backup_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("backup") {
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.eval("typeof load === 'function' && load()");
        return;
    }

    let _ = WebviewWindowBuilder::new(app, "backup", WebviewUrl::App("backup.html".into()))
        .title("Backup & iCloud")
        .inner_size(760.0, 620.0)
        .min_inner_size(560.0, 420.0)
        .build();
}

fn open_ports_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("ports") {
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.eval("typeof load === 'function' && load()");
        return;
    }

    let _ = WebviewWindowBuilder::new(app, "ports", WebviewUrl::App("ports.html".into()))
        .title("Offene Ports")
        .inner_size(760.0, 520.0)
        .min_inner_size(560.0, 320.0)
        .build();
}

// --- Claude ------------------------------------------------------------------

/// The repository path as a config may keep it: without the `../..` that
/// `project_dir` carries around from the build.
fn tidy_dir(dir: &Path) -> PathBuf {
    dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf())
}

#[tauri::command]
fn claude_status(state: tauri::State<Runtime>) -> claude::Status {
    claude::status(&tidy_dir(&state.dir), state.api_port)
}

#[tauri::command]
fn claude_connect(state: tauri::State<Runtime>) -> claude::Report {
    claude::connect(&tidy_dir(&state.dir), state.api_port)
}

#[tauri::command]
fn claude_restart_desktop() -> Result<(), String> {
    claude::restart_desktop()
}

// --- The widget --------------------------------------------------------------

/// Port and token, or the reason there is nothing to talk to.
fn credentials(state: &Runtime) -> Result<(u16, String), String> {
    let token = state
        .token
        .clone()
        .ok_or("kein SERVICE_TOKEN in der .env — ohne den nimmt die API nichts an")?;
    Ok((state.api_port, token))
}

/// An error from the API reads as the API wrote it: `{ "error": "..." }`.
/// A status code alone tells the person in front of the widget nothing.
fn unwrap_api(status: u16, body: String) -> Result<String, String> {
    if (200..300).contains(&status) {
        return Ok(body);
    }
    let message = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|value| {
            value
                .get("error")
                .and_then(|error| error.as_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| format!("API antwortet mit {status}"));
    Err(message)
}

fn api_get(state: &Runtime, path: &str) -> Result<String, String> {
    let (port, token) = credentials(state)?;
    let (status, body) = http::get(port, &token, "desktop", path)?;
    unwrap_api(status, body)
}

fn api_post(state: &Runtime, path: &str, body: &str) -> Result<String, String> {
    let (port, token) = credentials(state)?;
    let (status, body) = http::post(port, &token, "desktop", path, body)?;
    unwrap_api(status, body)
}

/// Ids go into a path, so they may be ids and nothing else. A cuid is
/// letters and digits; anything else is not worth asking the API about.
fn plain_id(id: &str) -> Result<&str, String> {
    if !id.is_empty() && id.chars().all(|ch| ch.is_ascii_alphanumeric()) {
        Ok(id)
    } else {
        Err("unbrauchbare Kennung".to_string())
    }
}

#[tauri::command]
fn tracker_state(state: tauri::State<Runtime>) -> tracker::State {
    state.tracker.lock().expect("tracker state").clone()
}

/// While dragging. Fire and forget from the page — the answer is the window
/// having moved, and waiting for it would cost a frame per pixel.
#[tauri::command]
fn tracker_place(x: f64, y: f64, app: AppHandle) {
    let state = app.state::<Runtime>();
    state.tracker_drag.store(now_secs(), Ordering::SeqCst);
    if let Some(window) = app.get_webview_window("tracker") {
        tracker::place_at(&window, x, y);
    }
}

/// After letting go of the drag: pick the nearest resting place, move there,
/// remember it.
#[tauri::command]
fn tracker_snap(app: AppHandle) -> Result<tracker::Anchor, String> {
    let window = app
        .get_webview_window("tracker")
        .ok_or("das Widget ist nicht offen")?;
    let state = app.state::<Runtime>();
    // The drag is over before the snap, so the guard is awake again for
    // whatever the snap itself does.
    state.tracker_drag.store(0, Ordering::SeqCst);

    let mut current = state.tracker.lock().expect("tracker state");
    let (anchor, screen) =
        tracker::dropped_on(&window, current.expanded).ok_or("kein Bildschirm gefunden")?;
    current.anchor = anchor;
    // Which screen it was dropped on, so it comes back there after a restart.
    current.screen = screen;
    tracker::snap_to(&window, &current);
    tracker::save_state(&state.dir, &current);
    Ok(anchor)
}

/// Folding out and in. The anchor is reapplied, so a pill in the bottom
/// right grows upwards instead of off the screen.
#[tauri::command]
fn tracker_expand(expanded: bool, app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("tracker")
        .ok_or("das Widget ist nicht offen")?;
    let state = app.state::<Runtime>();
    let mut current = state.tracker.lock().expect("tracker state");
    current.expanded = expanded;
    tracker::apply(&window, &current);
    tracker::save_state(&state.dir, &current);
    Ok(())
}

#[tauri::command]
fn tracker_hide(app: AppHandle) {
    set_tracker(&app, false);
}

// --- Backups ----------------------------------------------------------------

/// Everything the backup window shows, in one answer.
#[derive(serde::Serialize)]
struct BackupStatus {
    state: backup::State,
    /// The folder in use, resolved — the window shows a path, not a `~`.
    folder: String,
    suggested: String,
    /// Does it exist yet? A folder that was never created is the normal
    /// state before the first run, not an error.
    folder_exists: bool,
    snapshots: Vec<backup::Snapshot>,
    busy: bool,
    note: String,
    /// Without Docker there is no database to dump, and saying so beats a
    /// failing snapshot every day at three in the morning.
    docker: bool,
}

#[tauri::command]
fn backup_status(state: tauri::State<Runtime>) -> BackupStatus {
    let current = state.backup.lock().expect("backup state").clone();
    let folder = backup::folder(&current, &state.home);
    BackupStatus {
        folder_exists: folder.is_dir(),
        folder: folder.to_string_lossy().into_owned(),
        suggested: backup::suggested(&state.home)
            .to_string_lossy()
            .into_owned(),
        snapshots: backup::snapshots(&current, &state.home),
        busy: state.backup_busy.load(Ordering::SeqCst),
        note: state
            .backup_note
            .lock()
            .map(|n| n.clone())
            .unwrap_or_default(),
        docker: docker_bin().is_some(),
        state: current,
    }
}

/// Change the settings. Every field is sent every time — the window holds
/// the whole form, so a partial update would only invite the two to drift.
#[tauri::command]
fn backup_configure(
    enabled: bool,
    folder: String,
    every_hours: u64,
    keep: usize,
    state: tauri::State<Runtime>,
) -> Result<(), String> {
    let mut current = state.backup.lock().expect("backup state");
    current.enabled = enabled;
    current.folder = folder.trim().to_string();
    // A day at most of lost work, and at least a quarter of an hour between
    // runs: an interval of zero would mean "every tick".
    current.every_hours = every_hours.clamp(0, 24 * 7);
    // Never zero — see backup::rotate, which would then delete everything.
    current.keep = keep.clamp(1, 365);
    backup::save_state(&state.dir, &current);
    Ok(())
}

/// What a run needs, assembled from the state. Fails while Docker is away:
/// a snapshot without the database is not a snapshot.
fn backup_plan(state: &Runtime) -> Result<backup::Plan, String> {
    Ok(backup::Plan {
        dir: state.dir.clone(),
        home: state.home.clone(),
        docker: docker_bin().ok_or("Docker nicht gefunden")?,
    })
}

/// Take a snapshot now, on a thread.
///
/// `pg_dump` and `tar` take seconds to tens of seconds. Doing that in the
/// command would block the main thread, and a frozen window during a backup
/// is how you end up never making one.
#[tauri::command]
fn backup_now(app: AppHandle) -> Result<(), String> {
    let state = app.state::<Runtime>();
    if state.backup_busy.swap(true, Ordering::SeqCst) {
        return Err("laeuft schon".to_string());
    }
    let plan = match backup_plan(&state) {
        Ok(plan) => plan,
        Err(err) => {
            state.backup_busy.store(false, Ordering::SeqCst);
            return Err(err);
        }
    };
    let current = state.backup.lock().expect("backup state").clone();

    thread::spawn(move || {
        let outcome = backup::run(&plan, &current);
        let state = app.state::<Runtime>();
        finish_backup(&state, outcome);
    });
    Ok(())
}

/// Put a snapshot back. Destructive, and the window asks twice before it
/// gets here.
#[tauri::command]
fn backup_restore(name: String, app: AppHandle) -> Result<(), String> {
    if !backup::is_snapshot(&name) {
        return Err("kein Snapshot dieser App".to_string());
    }
    let state = app.state::<Runtime>();
    if state.backup_busy.swap(true, Ordering::SeqCst) {
        return Err("laeuft schon".to_string());
    }
    let plan = match backup_plan(&state) {
        Ok(plan) => plan,
        Err(err) => {
            state.backup_busy.store(false, Ordering::SeqCst);
            return Err(err);
        }
    };
    let current = state.backup.lock().expect("backup state").clone();

    thread::spawn(move || {
        let result = backup::restore(&plan, Path::new(&name), &current);
        let state = app.state::<Runtime>();
        if let Ok(mut note) = state.backup_note.lock() {
            *note = match &result {
                Ok(()) => format!("{name} wiederhergestellt — Oberflaeche neu laden"),
                Err(err) => format!("Wiederherstellung fehlgeschlagen: {err}"),
            };
        }
        if let Err(err) = &result {
            eprintln!("[backup] restore: {err}");
        }
        state.backup_busy.store(false, Ordering::SeqCst);
    });
    Ok(())
}

/// Write down how a run went, in the state file and in words.
fn finish_backup(state: &Runtime, outcome: Result<u64, String>) {
    {
        let mut current = state.backup.lock().expect("backup state");
        match &outcome {
            Ok(bytes) => {
                current.last_run = now_secs();
                current.last_bytes = *bytes;
                current.last_error = String::new();
            }
            // The timestamp stays where it was: a failed attempt is not a
            // backup, and the next tick should try again rather than wait
            // out the interval.
            Err(err) => current.last_error = err.clone(),
        }
        backup::save_state(&state.dir, &current);
    }
    if let Ok(mut note) = state.backup_note.lock() {
        *note = match &outcome {
            Ok(bytes) => format!("Snapshot abgelegt ({})", human_bytes(*bytes)),
            Err(err) => format!("Fehlgeschlagen: {err}"),
        };
    }
    if let Err(err) = &outcome {
        eprintln!("[backup] {err}");
    }
    state.backup_busy.store(false, Ordering::SeqCst);
}

/// A Finder dialog for the folder, through AppleScript.
///
/// `async` on purpose: the dialog blocks until something is clicked, and a
/// synchronous command would block the main thread with it — which would
/// freeze the window the dialog was opened from.
#[tauri::command]
async fn backup_choose_folder() -> Result<String, String> {
    let out = Command::new("/usr/bin/osascript")
        .args([
            "-e",
            "POSIX path of (choose folder with prompt \"Ordner fuer die soloops-Backups\")",
        ])
        .output()
        .map_err(|err| format!("Dialog nicht startbar: {err}"))?;
    if !out.status.success() {
        // Cancelling is not a failure, and it is the usual way out.
        return Ok(String::new());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Show the backup folder in the Finder — the one thing this window cannot
/// do itself, and the quickest way to check that iCloud has it.
#[tauri::command]
fn backup_reveal(state: tauri::State<Runtime>) -> Result<(), String> {
    let current = state.backup.lock().expect("backup state").clone();
    let folder = backup::folder(&current, &state.home);
    std::fs::create_dir_all(&folder).map_err(|err| format!("Ordner nicht nutzbar: {err}"))?;
    Command::new("/usr/bin/open")
        .arg(&folder)
        .spawn()
        .map_err(|err| format!("Finder nicht startbar: {err}"))?;
    Ok(())
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Bytes as something a person reads off a window.
fn human_bytes(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["B", "KB", "MB", "GB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

/// The clock behind the automatic snapshot.
///
/// Checks every minute rather than sleeping out the interval: the folder may
/// be chosen, or the schedule changed, without the app being restarted, and
/// a thread that is asleep for a day would not notice until tomorrow.
fn spawn_backup_schedule(app: AppHandle) {
    thread::spawn(move || loop {
        thread::sleep(backup::TICK);
        let state = app.state::<Runtime>();
        if state.backup_busy.load(Ordering::SeqCst) {
            continue;
        }
        let current = match state.backup.lock() {
            Ok(current) => current.clone(),
            Err(_) => continue,
        };
        if !backup::due(&current, now_secs()) {
            continue;
        }
        let Ok(plan) = backup_plan(&state) else {
            // Docker is not running. Normal while the Mac has just started,
            // so the next tick simply tries again.
            continue;
        };
        state.backup_busy.store(true, Ordering::SeqCst);
        let outcome = backup::run(&plan, &current);
        finish_backup(&state, outcome);
    });
}

#[tauri::command]
fn timer_status(state: tauri::State<Runtime>) -> Result<String, String> {
    api_get(&state, "/api/time/running")
}

/// Clients and their projects, with the hours that are not on an invoice
/// yet — the list the widget unfolds into.
#[tauri::command]
fn timer_projects(state: tauri::State<Runtime>) -> Result<String, String> {
    api_get(&state, "/api/projects?status=ACTIVE")
}

#[tauri::command]
fn timer_start(
    project_id: String,
    description: String,
    state: tauri::State<Runtime>,
) -> Result<String, String> {
    let body = serde_json::json!({
        "projectId": project_id,
        "description": description,
        "source": "TIMER",
    })
    .to_string();
    api_post(&state, "/api/time/start", &body)
}

#[tauri::command]
fn timer_stop(state: tauri::State<Runtime>) -> Result<String, String> {
    api_post(&state, "/api/time/stop", "{}")
}

/// What has been committed in the window of this booking. The widget shows
/// the count while the clock runs — that is the repository half of the
/// feature made visible.
#[tauri::command]
fn timer_commits(entry_id: String, state: tauri::State<Runtime>) -> Result<String, String> {
    let id = plain_id(&entry_id)?;
    api_get(&state, &format!("/api/time/{id}/commits"))
}

/// Is the widget on screen? Asked of macOS, not of the state file.
fn tracker_on_screen(app: &AppHandle) -> bool {
    app.get_webview_window("tracker")
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false)
}

/// Bring the widget back when macOS took it away.
///
/// It is a normal window, and macOS hides an app's windows all together:
/// Cmd+H, "Hide Others" from another app, an app going fullscreen. A status
/// widget that has to be fetched back by hand is one nobody trusts, so it
/// returns on its own — but only while it is switched on. Switching it off
/// stays a decision, and `State.visible` is where that decision lives.
/// How long after the last drag event the guard stays out of the way. Long
/// enough to cover the gap between two pointer moves, short enough that a
/// lost `pointerup` costs one cycle and not the session.
const DRAG_GRACE_SECS: u64 = 3;

fn spawn_tracker_guard(app: AppHandle) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(3));
        let state = app.state::<Runtime>();
        let wanted = state
            .tracker
            .lock()
            .map(|current| current.visible)
            .unwrap_or(false);
        if !wanted {
            continue;
        }
        if tracker_on_screen(&app) {
            continue;
        }
        // Being dragged — including across a screen boundary, where macOS
        // reports the window as hidden for a moment. Putting it back on its
        // anchor now would take it out from under the pointer.
        let last_move = state.tracker_drag.load(Ordering::SeqCst);
        if last_move > 0 && now_secs().saturating_sub(last_move) < DRAG_GRACE_SECS {
            continue;
        }
        // Build it when it is missing entirely, not only when it is hidden:
        // a window that failed to open once would otherwise stay missing for
        // the rest of the session, with the menu insisting it is on.
        let dir = app.state::<Runtime>().dir.clone();
        if let Err(err) = tracker::open(&app, &dir) {
            eprintln!("[widget] kommt nicht zurueck: {err}");
        }
    });
}

/// Show or hide the widget, and keep both check marks and the file in step.
fn set_tracker(app: &AppHandle, visible: bool) {
    let state = app.state::<Runtime>();
    let mut current = state.tracker.lock().expect("tracker state");
    current.visible = visible;
    tracker::save_state(&state.dir, &current);

    if let Ok(items) = state.tracker_items.lock() {
        for item in items.iter() {
            let _ = item.set_checked(visible);
        }
    }

    if visible {
        let dir = state.dir.clone();
        drop(current);
        match tracker::open(app, &dir) {
            Ok(_) => eprintln!("[widget] sichtbar"),
            // Silently doing nothing is what made this look like a dead
            // menu entry; a window that refuses to be built says so.
            Err(err) => eprintln!("[widget] laesst sich nicht oeffnen: {err}"),
        }
    } else if let Some(window) = app.get_webview_window("tracker") {
        let _ = window.hide();
        eprintln!("[widget] ausgeblendet");
    }
}

// --- Talking to the interface -----------------------------------------------

/// A JavaScript string without serde. It is only text for the splash screen.
fn js_string(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => {}
            c if (c as u32) < 0x20 => out.push(' '),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn status(window: &WebviewWindow, text: &str, bad: bool) {
    let _ = window.eval(&format!(
        "window.soloopsStatus && window.soloopsStatus({}, {})",
        js_string(text),
        bad
    ));
}

// --- Startup -----------------------------------------------------------------

/// Runs in a thread of its own: bring the containers up, wait, then load the
/// interface. The splash screen reports what is happening along the way.
fn boot(
    window: WebviewWindow,
    dir: PathBuf,
    web_port: u16,
    api_port: u16,
    loaded: Arc<AtomicBool>,
) {
    if !(port_open(web_port) && api_healthy(api_port)) {
        let Some(docker) = docker_bin() else {
            status(
                &window,
                "Docker wurde nicht gefunden.\nBitte Docker Desktop installieren oder die Container von Hand starten: npm run up",
                true,
            );
            return;
        };

        if !daemon_running(&docker) {
            status(&window, "Docker Desktop startet …", false);
            let _ = Command::new("/usr/bin/open")
                .args(["-ga", "Docker"])
                .status();
            let deadline = Instant::now() + Duration::from_secs(120);
            while Instant::now() < deadline && !daemon_running(&docker) {
                thread::sleep(Duration::from_secs(2));
            }
            if !daemon_running(&docker) {
                status(&window, "Docker Desktop antwortet nicht.", true);
                return;
            }
        }

        status(&window, "Container starten …", false);
        if let Err(err) = compose(&docker, &dir, &["up", "-d"]) {
            status(
                &window,
                &format!("docker compose ist gescheitert:\n{err}"),
                true,
            );
            return;
        }
    }

    status(&window, "warte auf die API …", false);
    let deadline = Instant::now() + Duration::from_secs(240);
    while Instant::now() < deadline {
        if port_open(web_port) && api_healthy(api_port) {
            let url = format!("http://localhost:{web_port}/");
            match url.parse() {
                Ok(parsed) => {
                    let _ = window.navigate(parsed);
                    loaded.store(true, Ordering::SeqCst);
                }
                Err(_) => status(&window, "Die Adresse der Oberflaeche ist ungueltig.", true),
            }
            return;
        }
        thread::sleep(Duration::from_millis(600));
    }

    status(
        &window,
        "Die Oberflaeche antwortet nicht.\nLogs ansehen: npm run logs",
        true,
    );
}

// --- Menu commands ------------------------------------------------------------

fn handle_menu(app: &AppHandle, id: &str) {
    if id == "ports" {
        open_ports_window(app);
        return;
    }

    // Its own window, like the ports: it has to work while the containers
    // are still starting — a restore is what you do before they can.
    if id == "backup" {
        open_backup_window(app);
        return;
    }

    // From the tray, and it may not wait for the interface to be there.
    if id == "quit" {
        app.exit(0);
        return;
    }

    let state = app.state::<Runtime>();

    // The widget is its own window and needs neither the interface nor a
    // loaded page — from the tray it has to work while the containers are
    // still starting.
    if id == "tracker-toggle" {
        // Against what is on screen, not against what the file remembers.
        // The two can drift apart — a window hidden with the rest of the app,
        // a check mark macOS flipped on its own — and then a toggle that
        // trusts the file switches in the direction nothing happens in.
        set_tracker(app, !tracker_on_screen(app));
        return;
    }

    // The switch needs no window — it should work from the tray even while
    // the interface has not loaded yet.
    if id == "activity-toggle" {
        let on = !state.activity.load(Ordering::SeqCst);
        state.activity.store(on, Ordering::SeqCst);
        if let Ok(items) = state.activity_items.lock() {
            for item in items.iter() {
                let _ = item.set_checked(on);
            }
        }
        return;
    }

    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    match id {
        "show" => {
            let _ = window.show();
            let _ = window.set_focus();
        }
        "reload" => {
            if state.loaded.load(Ordering::SeqCst) {
                let _ = window.eval("location.reload()");
            }
        }
        "home" => {
            if state.loaded.load(Ordering::SeqCst) {
                let url = format!("http://localhost:{}/", state.web_port);
                if let Ok(parsed) = url.parse() {
                    let _ = window.navigate(parsed);
                }
            }
        }
        "sync-mail" => {
            if !state.loaded.load(Ordering::SeqCst) {
                return;
            }
            let _ = window.show();
            let _ = window.set_focus();
            // The login sits in the interface's localStorage — so the fetch
            // happens over there and not here.
            let _ = window.eval(
                r#"(async () => {
                     const token = localStorage.getItem('soloops.token')
                     if (!token) { location.assign('/login'); return }
                     await fetch('/api/mail/sync', {
                       method: 'POST',
                       headers: { Authorization: 'Bearer ' + token },
                     }).catch(() => {})
                     location.assign('/inbox')
                   })()"#,
            );
        }
        "stack-stop" => {
            let dir = state.dir.clone();
            thread::spawn(move || {
                if let Some(docker) = docker_bin() {
                    let _ = compose(&docker, &dir, &["stop"]);
                }
            });
        }
        _ => {
            let Some((_, _, path)) = SECTIONS.iter().find(|(menu_id, _, _)| *menu_id == id) else {
                return;
            };
            if !state.loaded.load(Ordering::SeqCst) {
                return;
            }
            let _ = window.show();
            let _ = window.set_focus();
            // pushState rather than location.assign: the Vue router listens
            // for popstate, so the switch stays a jump without a reload.
            let _ = window.eval(&format!(
                "history.pushState({{}}, '', {}); dispatchEvent(new PopStateEvent('popstate'))",
                js_string(path)
            ));
        }
    }
}

// --- Assembly -----------------------------------------------------------------

/// The "record activity" check mark. Menu and tray each get one; the shared
/// state lives in the Runtime so that both show the same thing.
fn activity_item(app: &AppHandle) -> tauri::Result<CheckMenuItem<Wry>> {
    let state = app.state::<Runtime>();
    let item = CheckMenuItemBuilder::with_id("activity-toggle", "Aktivität aufzeichnen")
        .checked(state.activity.load(Ordering::SeqCst))
        .build(app)?;
    if let Ok(mut items) = state.activity_items.lock() {
        items.push(item.clone());
    }
    Ok(item)
}

/// The "Zeit-Widget" check mark, in the menu and in the tray.
fn tracker_item(app: &AppHandle) -> tauri::Result<CheckMenuItem<Wry>> {
    let state = app.state::<Runtime>();
    let checked = state.tracker.lock().expect("tracker state").visible;
    let item = CheckMenuItemBuilder::with_id("tracker-toggle", "Zeit-Widget")
        .checked(checked)
        .build(app)?;
    if let Ok(mut items) = state.tracker_items.lock() {
        items.push(item.clone());
    }
    Ok(item)
}

fn build_menu(app: &AppHandle) -> tauri::Result<()> {
    let about = AboutMetadata {
        name: Some("soloops".into()),
        version: Some(env!("CARGO_PKG_VERSION").into()),
        comments: Some("Selbst gehostetes Betriebssystem für die Solo-Selbstständigkeit.".into()),
        ..Default::default()
    };

    let app_menu = SubmenuBuilder::new(app, "soloops")
        .about(Some(about))
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    // Without these entries Cmd+C and Cmd+V do not work in the WebView:
    // macOS routes those shortcuts through the menu.
    let edit_menu = SubmenuBuilder::new(app, "Bearbeiten")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let reload = MenuItemBuilder::with_id("reload", "Neu laden")
        .accelerator("CmdOrCtrl+R")
        .build(app)?;
    let home = MenuItemBuilder::with_id("home", "Zur Übersicht")
        .accelerator("CmdOrCtrl+Shift+H")
        .build(app)?;
    let ports = MenuItemBuilder::with_id("ports", "Offene Ports …")
        .accelerator("CmdOrCtrl+Shift+P")
        .build(app)?;
    let backup = MenuItemBuilder::with_id("backup", "Backup & iCloud …").build(app)?;
    let track = activity_item(app)?;
    let widget = tracker_item(app)?;
    widget.set_accelerator(Some("CmdOrCtrl+Shift+Z"))?;
    let view_menu = SubmenuBuilder::new(app, "Ansicht")
        .item(&reload)
        .item(&home)
        .separator()
        .item(&ports)
        .item(&backup)
        .item(&widget)
        .item(&track)
        .separator()
        .fullscreen()
        .build()?;

    let mut go = SubmenuBuilder::new(app, "Gehe zu");
    for (index, (id, label, _)) in SECTIONS.iter().enumerate() {
        let item = MenuItemBuilder::with_id(*id, *label)
            .accelerator(format!("CmdOrCtrl+{}", index + 1))
            .build(app)?;
        go = go.item(&item);
    }
    let sync = MenuItemBuilder::with_id("sync-mail", "Postfach abrufen")
        .accelerator("CmdOrCtrl+Shift+M")
        .build(app)?;
    let go_menu = go.separator().item(&sync).build()?;

    let window_menu = SubmenuBuilder::new(app, "Fenster")
        .minimize()
        .separator()
        .close_window()
        .build()?;

    let menu = MenuBuilder::new(app)
        .items(&[&app_menu, &edit_menu, &view_menu, &go_menu, &window_menu])
        .build()?;
    app.set_menu(menu)?;
    Ok(())
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItemBuilder::with_id("show", "soloops zeigen").build(app)?;
    let sync = MenuItemBuilder::with_id("sync-mail", "Postfach abrufen").build(app)?;
    let reload = MenuItemBuilder::with_id("reload", "Neu laden").build(app)?;
    let ports = MenuItemBuilder::with_id("ports", "Offene Ports …").build(app)?;
    let backup = MenuItemBuilder::with_id("backup", "Backup & iCloud …").build(app)?;
    let track = activity_item(app)?;
    let widget = tracker_item(app)?;
    let stop = MenuItemBuilder::with_id("stack-stop", "Container stoppen").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "soloops beenden").build(app)?;

    let menu = MenuBuilder::new(app)
        .items(&[&show, &sync, &reload, &ports, &backup])
        .separator()
        .items(&[&widget, &track])
        .separator()
        .items(&[&stop, &quit])
        .build()?;

    let mut tray = TrayIconBuilder::with_id("main").menu(&menu);
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    // No `on_menu_event` here on purpose. Tauri keeps one list of menu
    // listeners for the whole app and calls every one of them for every
    // event, wherever the menu sits — a handler on the tray as well as the
    // one on the builder means each click is handled twice. For "Neu laden"
    // that is merely wasteful; for a check mark it is the difference between
    // switching and not, which is why the widget could not be switched off.
    tray.build(app)?;
    Ok(())
}

/// Start the sampler. Without a SERVICE_TOKEN there is no point — the API
/// would accept nothing, so measuring at all would be pointless.
fn start_sampler(dir: &Path, api_port: u16, enabled: Arc<AtomicBool>) {
    let Some(token) = env_value(dir, "SERVICE_TOKEN") else {
        eprintln!("[activity] kein SERVICE_TOKEN in der .env — Aufzeichnung bleibt aus");
        return;
    };
    let cfg = activity::Config::from_env(
        api_port,
        token,
        env_value(dir, "ACTIVITY_SAMPLE_SECONDS").and_then(|value| value.parse().ok()),
        env_value(dir, "ACTIVITY_PRIVATE_APPS"),
        dir.join("data/activity-pending.jsonl"),
    );
    activity::spawn(cfg, enabled);
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            list_ports,
            kill_port,
            claude_status,
            claude_connect,
            claude_restart_desktop,
            tracker_state,
            tracker_place,
            tracker_snap,
            tracker_expand,
            tracker_hide,
            backup_status,
            backup_configure,
            backup_now,
            backup_restore,
            backup_choose_folder,
            backup_reveal,
            timer_status,
            timer_projects,
            timer_start,
            timer_stop,
            timer_commits
        ])
        .on_menu_event(|app, event| handle_menu(app, event.id().as_ref()))
        .on_window_event(|window, event| {
            // The red cross closes the window but does not end the
            // background — that keeps the tray reachable. Quit: Cmd+Q.
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Cmd+W on the widget means "put it away", not "throw it
                // out" — and the check marks have to agree, otherwise the
                // menu claims it is on while nothing is on screen.
                if window.label() == "tracker" {
                    api.prevent_close();
                    set_tracker(&window.app_handle().clone(), false);
                    return;
                }
                // Only the main window lives on in the background; the ports
                // window may close like any other.
                if window.label() != "main" {
                    return;
                }
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let dir = project_dir();
            let web_port = port_from_env(&dir, "WEB_PORT", 5174);
            let api_port = port_from_env(&dir, "API_PORT", 3000);
            let loaded = Arc::new(AtomicBool::new(false));

            // Recording is a deliberate decision: off by default, and it
            // needs the Accessibility permission before it can do anything.
            let tracking = matches!(
                env_value(&dir, "ACTIVITY_TRACKING").as_deref(),
                Some("true") | Some("1")
            );
            let activity = Arc::new(AtomicBool::new(tracking));

            // Read once at startup: the widget asks the API several times a
            // minute, and re-reading the .env for every poll would be a file
            // read for nothing.
            let token = env_value(&dir, "SERVICE_TOKEN");
            let widget = tracker::load_state(&dir);
            let widget_visible = widget.visible;
            let snapshots = backup::load_state(&dir);
            let home = std::env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_default();

            app.manage(Runtime {
                dir: dir.clone(),
                web_port,
                api_port,
                loaded: loaded.clone(),
                activity: activity.clone(),
                activity_items: Mutex::new(Vec::new()),
                token,
                tracker: Mutex::new(widget),
                tracker_items: Mutex::new(Vec::new()),
                backup: Mutex::new(snapshots),
                tracker_drag: Arc::new(AtomicU64::new(0)),
                backup_busy: Arc::new(AtomicBool::new(false)),
                backup_note: Mutex::new(String::new()),
                home,
            });

            build_menu(&handle)?;
            build_tray(&handle)?;

            // The widget comes back the way it was left. Before the boot
            // thread, deliberately: it says "no timer" until the API answers,
            // which is more honest than an empty screen.
            if widget_visible {
                let _ = tracker::open(&handle, &dir);
            }
            spawn_tracker_guard(handle.clone());
            spawn_backup_schedule(handle.clone());

            start_sampler(&dir, api_port, activity);

            // Reminders for due follow-ups. Needs nothing but the token —
            // and without one the API would not answer anyway.
            if let Some(token) = env_value(&dir, "SERVICE_TOKEN") {
                followups::spawn(followups::Config {
                    api_port,
                    token: token.clone(),
                });

                // The iPhone's postbox in iCloud Drive. Does nothing until
                // the iOS app has run once on this Apple ID.
                if let Some(home) = std::env::var_os("HOME") {
                    sync::spawn(sync::Config {
                        api_port,
                        token,
                        home: PathBuf::from(home),
                    });
                }
            }

            if let Some(window) = app.get_webview_window("main") {
                thread::spawn(move || boot(window, dir, web_port, api_port, loaded));
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("soloops konnte nicht starten");
}
