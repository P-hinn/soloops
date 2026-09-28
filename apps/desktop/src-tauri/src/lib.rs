//! soloops als Fenster statt als Browsertab.
//!
//! Die App rendert nichts Eigenes: sie zeigt dieselbe Oberflaeche, die auch
//! unter http://localhost laeuft. Was sie hinzufuegt, ist der Rahmen —
//! Menueleiste, Tastenkuerzel, Tray — und der Start der Container, damit man
//! nicht erst ein Terminal aufmachen muss.
//!
//! Die geladene Seite bekommt bewusst keinen Zugriff auf Tauri-APIs. Alles,
//! was die App kann, laeuft hier in Rust; zur Oberflaeche geht nur JavaScript,
//! das genauso in der Konsole stehen koennte.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use tauri::menu::{AboutMetadata, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

/// Die Module in der Reihenfolge der Seitenleiste — Cmd+1 bis Cmd+9.
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

/// Was die Menuebefehle wissen muessen.
struct Runtime {
    dir: PathBuf,
    web_port: u16,
    /// Vor dem ersten erfolgreichen Laden zeigt das Fenster den Startbildschirm.
    /// Navigation und Abruf waeren dort wirkungslos und werden uebersprungen.
    loaded: Arc<AtomicBool>,
}

// --- Projekt und Ports ------------------------------------------------------

/// Wo das Repository liegt. Die .app hat kein Arbeitsverzeichnis, deshalb wird
/// der Pfad beim Bauen festgehalten; SOLOOPS_DIR sticht ihn, falls das
/// Verzeichnis spaeter umzieht.
fn project_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("SOLOOPS_DIR") {
        return PathBuf::from(dir);
    }
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../.."))
}

fn port_from_env(dir: &Path, key: &str, fallback: u16) -> u16 {
    let Ok(text) = std::fs::read_to_string(dir.join(".env")) else {
        return fallback;
    };
    for line in text.lines() {
        let Some(rest) = line.trim().strip_prefix(key) else {
            continue;
        };
        if let Some(value) = rest.strip_prefix('=') {
            if let Ok(port) = value.trim().parse() {
                return port;
            }
        }
    }
    fallback
}

fn port_open(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(400)).is_ok()
}

/// Ein offener Port heisst noch nicht, dass die API Anfragen beantwortet —
/// Fastify bindet frueher, als Prisma verbunden ist.
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

/// In einer .app ist PATH auf /usr/bin:/bin zusammengeschrumpft — Docker liegt
/// da nie. Also an den bekannten Stellen nachsehen.
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
    Err(stderr.trim().lines().last().unwrap_or("unbekannt").to_string())
}

// --- Ports ------------------------------------------------------------------

/// Die Portliste kommt aus `scripts/ports.sh`. Docker-Zuordnung, Filter und
/// das Beenden stehen damit an genau einer Stelle — im Terminal und hier gilt
/// dasselbe.
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
        // Eine .app startet mit fast leerem PATH. Ohne diese Zeile faende das
        // Skript weder docker noch lsof — und wuerde Container fuer gewoehnliche
        // Prozesse halten.
        .env(
            "PATH",
            format!("/usr/local/bin:/opt/homebrew/bin:{home}/.docker/bin:/usr/bin:/bin:/usr/sbin:/sbin"),
        )
        .output()
        .map_err(|err| err.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(stderr.trim().lines().last().unwrap_or("unbekannt").to_string());
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

/// Zweites Fenster, bewusst klein. Es zeigt nur, was `npm run ports` auch zeigt.
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

// --- Oberflaeche ansprechen -------------------------------------------------

/// JavaScript-String ohne serde. Es geht nur um Text fuer den Startbildschirm.
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

// --- Start -------------------------------------------------------------------

/// Laeuft in einem eigenen Thread: Container hochfahren, warten, dann die
/// Oberflaeche laden. Der Startbildschirm berichtet unterwegs, was passiert.
fn boot(window: WebviewWindow, dir: PathBuf, web_port: u16, api_port: u16, loaded: Arc<AtomicBool>) {
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
            let _ = Command::new("/usr/bin/open").args(["-ga", "Docker"]).status();
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
            status(&window, &format!("docker compose ist gescheitert:\n{err}"), true);
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

// --- Menuebefehle -------------------------------------------------------------

fn handle_menu(app: &AppHandle, id: &str) {
    if id == "ports" {
        open_ports_window(app);
        return;
    }

    let state = app.state::<Runtime>();
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
            // Die Anmeldung steckt im localStorage der Oberflaeche — der Abruf
            // laeuft deshalb dort und nicht hier.
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
            // pushState statt location.assign: der Vue-Router hoert auf
            // popstate, so bleibt der Wechsel ein Sprung ohne Neuladen.
            let _ = window.eval(&format!(
                "history.pushState({{}}, '', {}); dispatchEvent(new PopStateEvent('popstate'))",
                js_string(path)
            ));
        }
    }
}

// --- Aufbau -------------------------------------------------------------------

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

    // Ohne diese Eintraege funktionieren Cmd+C und Cmd+V in der WebView nicht:
    // macOS leitet die Kuerzel ueber das Menue.
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
    let view_menu = SubmenuBuilder::new(app, "Ansicht")
        .item(&reload)
        .item(&home)
        .separator()
        .item(&ports)
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
    let stop = MenuItemBuilder::with_id("stack-stop", "Container stoppen").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "soloops beenden").build(app)?;

    let menu = MenuBuilder::new(app)
        .items(&[&show, &sync, &reload, &ports])
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

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![list_ports, kill_port])
        .on_menu_event(|app, event| handle_menu(app, event.id().as_ref()))
        .on_window_event(|window, event| {
            // Das rote Kreuz schliesst das Fenster, beendet aber nicht den
            // Hintergrund — so bleibt der Tray erreichbar. Beenden: Cmd+Q.
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Nur das Hauptfenster bleibt im Hintergrund bestehen; das
                // Ports-Fenster darf sich schliessen wie jedes andere auch.
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

            app.manage(Runtime {
                dir: dir.clone(),
                web_port,
                loaded: loaded.clone(),
            });

            build_menu(&handle)?;
            build_tray(&handle)?;

            if let Some(window) = app.get_webview_window("main") {
                thread::spawn(move || boot(window, dir, web_port, api_port, loaded));
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("soloops konnte nicht starten");
}
