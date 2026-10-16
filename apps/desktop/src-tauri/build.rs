/// The app declares its own commands in the ACL.
///
/// Needed because the interface runs under http://localhost and counts as a
/// remote origin as far as Tauri is concerned: there nothing is allowed that no
/// capability names. The permissions (`allow-<command>`) are generated from
/// this list; which window and which origin may use them is decided in
/// `capabilities/`.
fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "list_ports",
            "kill_port",
            "claude_status",
            "claude_connect",
            "claude_restart_desktop",
            "tracker_state",
            "tracker_place",
            "tracker_snap",
            "tracker_expand",
            "tracker_hide",
            "timer_status",
            "timer_projects",
            "timer_start",
            "timer_stop",
            "timer_commits",
            "backup_status",
            "backup_configure",
            "backup_now",
            "backup_restore",
            "backup_choose_folder",
            "backup_reveal",
        ]),
    ))
    .expect("tauri-build ist gescheitert");
}
