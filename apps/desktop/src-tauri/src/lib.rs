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
use std::sync::atomic::{AtomicBool, Ordering};
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
    /// Until the first successful load the window shows the splash screen.
    /// Navigation and fetching would do nothing there and are skipped.
    loaded: Arc<AtomicBool>,
    /// Is recording on? The sampler thread reads this on every tick, so that
    /// "off" takes effect at once and not on the next start.
    activity: Arc<AtomicBool>,
    /// The same switch lives in the menu and in the tray. Both check marks
    /// have to follow when either one is clicked.
    activity_items: Mutex<Vec<CheckMenuItem<Wry>>>,
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

    let state = app.state::<Runtime>();

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
    let track = activity_item(app)?;
    let view_menu = SubmenuBuilder::new(app, "Ansicht")
        .item(&reload)
        .item(&home)
        .separator()
        .item(&ports)
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
    let track = activity_item(app)?;
    let stop = MenuItemBuilder::with_id("stack-stop", "Container stoppen").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "soloops beenden").build(app)?;

    let menu = MenuBuilder::new(app)
        .items(&[&show, &sync, &reload, &ports])
        .separator()
        .item(&track)
        .separator()
        .items(&[&stop, &quit])
        .build()?;

    let mut tray = TrayIconBuilder::with_id("main").menu(&menu);
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.on_menu_event(|app, event| {
        if event.id().as_ref() == "quit" {
            app.exit(0);
            return;
        }
        handle_menu(app, event.id().as_ref());
    })
    .build(app)?;
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
        .invoke_handler(tauri::generate_handler![list_ports, kill_port])
        .on_menu_event(|app, event| handle_menu(app, event.id().as_ref()))
        .on_window_event(|window, event| {
            // The red cross closes the window but does not end the
            // background — that keeps the tray reachable. Quit: Cmd+Q.
            if let WindowEvent::CloseRequested { api, .. } = event {
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

            app.manage(Runtime {
                dir: dir.clone(),
                web_port,
                loaded: loaded.clone(),
                activity: activity.clone(),
                activity_items: Mutex::new(Vec::new()),
            });

            build_menu(&handle)?;
            build_tray(&handle)?;

            start_sampler(&dir, api_port, activity);

            if let Some(window) = app.get_webview_window("main") {
                thread::spawn(move || boot(window, dir, web_port, api_port, loaded));
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("soloops konnte nicht starten");
}
