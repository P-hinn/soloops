//! Snapshots into a folder that copies itself to the other machines.
//!
//! The data lives in two places: a Postgres container and the `data/`
//! directory next to the compose file. Neither may be moved into iCloud
//! Drive. iCloud writes when it feels like it, evicts files it believes are
//! cold, and resolves a conflict by keeping both versions side by side —
//! three things a running database does not survive, and the failure arrives
//! weeks later as a cluster that will not start.
//!
//! So the data goes there as snapshots instead. One archive per run holding
//! a dump of the database and a copy of the file store, the oldest thrown
//! away, and a restore that puts both back on a machine that has nothing but
//! the repository. That is a backup and a way onto a new Mac at once, and
//! unlike a synced data directory it cannot corrupt what it is copying.
//!
//! The date arithmetic for the file names is at the top and takes nothing
//! from Tauri or the filesystem, so the part worth getting wrong can be
//! tested.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// Where the snapshots go unless another folder is named. `com~apple~CloudDocs`
/// is iCloud Drive itself — the one the Finder shows, so the archives can be
/// found without this app.
const SUGGESTED: &str = "Library/Mobile Documents/com~apple~CloudDocs/soloops-backup";

/// What a snapshot is called. The timestamp sorts as text, which is what
/// keeps rotation from having to parse anything.
const PREFIX: &str = "soloops-";
const SUFFIX: &str = ".tar.gz";

/// A dump that is smaller than this is not a dump — an empty database, a
/// container that was not running, `pg_dump` writing its error to stdout.
/// Rotating a good snapshot away for one of those is the one failure a
/// backup may not have.
const MIN_DUMP_BYTES: u64 = 1024;

// --- Naming the thing --------------------------------------------------------

/// Year, month, day, hour, minute from a Unix timestamp, in UTC.
///
/// UTC and not local time on purpose: the name only has to sort and to be
/// readable, and a snapshot that appears to go backwards on the last Sunday
/// in October would break rotation.
pub fn parts(secs: u64) -> (u64, u64, u64, u64, u64) {
    let days = secs / 86_400;
    let rest = secs % 86_400;

    // Howard Hinnant's civil_from_days, shifted to a March-based year so the
    // leap day lands at the end of it and the month lengths become a
    // formula instead of a table.
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u64;
    let month = (if mp < 10 { mp + 3 } else { mp - 9 }) as u64;
    let year = (yoe + era * 400 + i64::from(month <= 2)) as u64;

    (year, month, day, rest / 3600, (rest % 3600) / 60)
}

/// The file name for a snapshot taken at this moment.
pub fn name_for(secs: u64) -> String {
    let (y, m, d, h, min) = parts(secs);
    format!("{PREFIX}{y:04}-{m:02}-{d:02}-{h:02}{min:02}{SUFFIX}")
}

/// Is this one of ours? Rotation deletes files, so it may only ever look at
/// the archives this app wrote — never at whatever else is in the folder.
pub fn is_snapshot(name: &str) -> bool {
    name.starts_with(PREFIX) && name.ends_with(SUFFIX)
}

/// Which snapshots to delete, given every name in the folder.
///
/// Newest kept, oldest dropped, and `keep = 0` deletes nothing: a misread
/// setting must not be able to empty the backup folder.
pub fn rotate(mut names: Vec<String>, keep: usize) -> Vec<String> {
    if keep == 0 {
        return Vec::new();
    }
    names.retain(|name| is_snapshot(name));
    // The timestamp is fixed-width, so sorting as text sorts by date.
    names.sort();
    if names.len() <= keep {
        return Vec::new();
    }
    let drop = names.len() - keep;
    names.into_iter().take(drop).collect()
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// --- What is remembered ------------------------------------------------------

/// The settings, and what the last run did.
#[derive(Clone, Serialize, Deserialize)]
pub struct State {
    /// Off until a folder has been chosen.
    pub enabled: bool,
    /// Where the archives go. Empty means "use the suggested folder".
    pub folder: String,
    /// How often, in hours. 0 means only when asked by hand.
    pub every_hours: u64,
    /// How many archives to keep. Never 0 — see `rotate`.
    pub keep: usize,
    /// Unix seconds of the last successful run.
    pub last_run: u64,
    /// What went wrong last time, for the window to show.
    pub last_error: String,
    /// Size of the last archive.
    pub last_bytes: u64,
}

impl Default for State {
    fn default() -> Self {
        Self {
            enabled: false,
            folder: String::new(),
            // Once a day is what a day of lost work is worth here; the
            // archive is a few megabytes, so keeping two weeks of them is
            // cheaper than deciding which one to keep.
            every_hours: 24,
            keep: 14,
            last_run: 0,
            last_error: String::new(),
            last_bytes: 0,
        }
    }
}

fn state_path(dir: &Path) -> PathBuf {
    dir.join("data/backup.json")
}

pub fn load_state(dir: &Path) -> State {
    fs::read_to_string(state_path(dir))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub fn save_state(dir: &Path, state: &State) {
    let path = state_path(dir);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string_pretty(state) {
        let _ = fs::write(path, text);
    }
}

/// The folder in use: the one that was chosen, or the suggestion.
pub fn folder(state: &State, home: &Path) -> PathBuf {
    if state.folder.trim().is_empty() {
        home.join(SUGGESTED)
    } else {
        PathBuf::from(shellexpand(&state.folder, home))
    }
}

/// The suggested folder, for the window to show as a placeholder.
pub fn suggested(home: &Path) -> PathBuf {
    home.join(SUGGESTED)
}

/// `~/…` typed into the field is a path, not a directory called `~`.
fn shellexpand(path: &str, home: &Path) -> String {
    let path = path.trim();
    match path.strip_prefix("~/") {
        Some(rest) => home.join(rest).to_string_lossy().into_owned(),
        None => path.to_string(),
    }
}

// --- One snapshot ------------------------------------------------------------

/// What a run needs. Passed in rather than read here, so the scheduler and
/// the "back up now" button cannot disagree about where things are.
pub struct Plan {
    pub dir: PathBuf,
    pub home: PathBuf,
    pub docker: PathBuf,
}

/// One snapshot: dump the database, pack it with the file store, rotate.
///
/// Returns the archive's size. The archive is built under a temporary name
/// and moved into place at the end — iCloud starts uploading the moment a
/// file appears, and a half-written archive that gets uploaded is a backup
/// that looks like one and is not.
pub fn run(plan: &Plan, state: &State) -> Result<u64, String> {
    let target = folder(state, &plan.home);
    fs::create_dir_all(&target).map_err(|err| format!("Zielordner nicht nutzbar: {err}"))?;

    let user = env_value(&plan.dir, "POSTGRES_USER").ok_or("POSTGRES_USER fehlt in der .env")?;
    let db = env_value(&plan.dir, "POSTGRES_DB").ok_or("POSTGRES_DB fehlt in der .env")?;

    // Staging inside the project, not inside the target: a temporary file in
    // iCloud is a temporary file iCloud uploads.
    let stage = plan.dir.join("data/backup-stage");
    let _ = fs::remove_dir_all(&stage);
    fs::create_dir_all(&stage).map_err(|err| format!("Arbeitsordner nicht nutzbar: {err}"))?;

    let dump = stage.join("db.sql");
    dump_database(plan, &user, &db, &dump)?;

    let name = name_for(now_secs());
    let partial = target.join(format!(".{name}.part"));
    let _ = fs::remove_file(&partial);

    // Two sources in one archive: `db.sql` from the staging folder and
    // `data` from the project. The staging folder itself lives under `data`,
    // so it has to be excluded or the archive would pack the dump twice.
    let out = Command::new("tar")
        .arg("-czf")
        .arg(&partial)
        .arg("--exclude=backup-stage")
        .arg("--exclude=.DS_Store")
        .arg("-C")
        .arg(&stage)
        .arg("db.sql")
        .arg("-C")
        .arg(&plan.dir)
        .arg("data")
        .output()
        .map_err(|err| format!("tar nicht startbar: {err}"))?;
    if !out.status.success() {
        let _ = fs::remove_file(&partial);
        let _ = fs::remove_dir_all(&stage);
        return Err(format!("tar: {}", last_line(&out.stderr)));
    }

    let bytes = fs::metadata(&partial).map(|m| m.len()).unwrap_or(0);
    fs::rename(&partial, target.join(&name))
        .map_err(|err| format!("Archiv nicht ablegbar: {err}"))?;
    let _ = fs::remove_dir_all(&stage);

    for old in rotate(names_in(&target), state.keep) {
        let _ = fs::remove_file(target.join(old));
    }
    Ok(bytes)
}

/// `pg_dump` inside the container, straight into a file on the host.
///
/// Written here rather than piped through the shell: a password or a database
/// name with a space in it would otherwise end up as two arguments.
fn dump_database(plan: &Plan, user: &str, db: &str, to: &Path) -> Result<(), String> {
    let out = Command::new(&plan.docker)
        .arg("compose")
        .args([
            "exec",
            "-T",
            "postgres",
            "pg_dump",
            "--clean",
            "--if-exists",
        ])
        .args(["-U", user, db])
        .current_dir(&plan.dir)
        .output()
        .map_err(|err| format!("docker nicht startbar: {err}"))?;

    if !out.status.success() {
        return Err(format!(
            "pg_dump: {} — laeuft der Stack?",
            last_line(&out.stderr)
        ));
    }
    if (out.stdout.len() as u64) < MIN_DUMP_BYTES {
        return Err("pg_dump hat so gut wie nichts geliefert — Snapshot verworfen".to_string());
    }
    fs::write(to, &out.stdout).map_err(|err| format!("Dump nicht schreibbar: {err}"))
}

/// Put a snapshot back: the file store first, then the database.
///
/// This overwrites what is there — the window asks twice before it calls it.
/// The database goes last because it is the step that can fail on a stack
/// that is not running, and failing before the files have been touched is
/// easier to explain than failing after.
pub fn restore(plan: &Plan, archive: &Path, state: &State) -> Result<(), String> {
    let archive = if archive.is_absolute() {
        archive.to_path_buf()
    } else {
        folder(state, &plan.home).join(archive)
    };
    if !archive.is_file() {
        return Err("Archiv nicht gefunden".to_string());
    }

    let stage = plan.dir.join("data/backup-restore");
    let _ = fs::remove_dir_all(&stage);
    fs::create_dir_all(&stage).map_err(|err| format!("Arbeitsordner nicht nutzbar: {err}"))?;

    let out = Command::new("tar")
        .arg("-xzf")
        .arg(&archive)
        .arg("-C")
        .arg(&stage)
        .output()
        .map_err(|err| format!("tar nicht startbar: {err}"))?;
    if !out.status.success() {
        let _ = fs::remove_dir_all(&stage);
        return Err(format!("tar: {}", last_line(&out.stderr)));
    }

    let dump = stage.join("db.sql");
    if !dump.is_file() {
        let _ = fs::remove_dir_all(&stage);
        return Err("Im Archiv ist kein Datenbank-Dump".to_string());
    }

    // The file store, copied over the top. A copy and not a move of the
    // whole directory: `data/` holds this app's own state files, and taking
    // the directory away under a running app is how you lose them. `-f`
    // because a file a container wrote may be read-only to this user, and
    // one such file would otherwise abort the restore before the database.
    let files = stage.join("data");
    if files.is_dir() {
        let out = Command::new("cp")
            .arg("-Rf")
            .arg(format!("{}/.", files.to_string_lossy()))
            .arg(plan.dir.join("data"))
            .output()
            .map_err(|err| format!("cp nicht startbar: {err}"))?;
        if !out.status.success() {
            let _ = fs::remove_dir_all(&stage);
            return Err(format!("Dateien: {}", last_line(&out.stderr)));
        }
    }

    let user = env_value(&plan.dir, "POSTGRES_USER").ok_or("POSTGRES_USER fehlt in der .env")?;
    let db = env_value(&plan.dir, "POSTGRES_DB").ok_or("POSTGRES_DB fehlt in der .env")?;
    let sql = fs::read(&dump).map_err(|err| format!("Dump nicht lesbar: {err}"))?;

    let result = psql(plan, &user, &db, &sql);
    let _ = fs::remove_dir_all(&stage);
    result
}

/// Feed the dump to `psql` in the container through its stdin.
fn psql(plan: &Plan, user: &str, db: &str, sql: &[u8]) -> Result<(), String> {
    use std::io::Write;
    use std::process::Stdio;

    let mut child = Command::new(&plan.docker)
        .arg("compose")
        .args(["exec", "-T", "postgres", "psql", "-v", "ON_ERROR_STOP=1"])
        .args(["-U", user, "-d", db])
        .current_dir(&plan.dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("docker nicht startbar: {err}"))?;

    child
        .stdin
        .take()
        .ok_or("psql nimmt keine Eingabe")?
        .write_all(sql)
        .map_err(|err| format!("Dump nicht uebergebbar: {err}"))?;

    let out = child
        .wait_with_output()
        .map_err(|err| format!("psql nicht abwartbar: {err}"))?;
    if out.status.success() {
        return Ok(());
    }
    Err(format!("psql: {}", last_line(&out.stderr)))
}

// --- Looking at the folder ---------------------------------------------------

/// One archive in the backup folder, as the window lists it.
#[derive(Serialize)]
pub struct Snapshot {
    pub name: String,
    pub bytes: u64,
}

fn names_in(target: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(target) else {
        return Vec::new();
    };
    entries
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| is_snapshot(name))
        .collect()
}

/// The archives in the folder, newest first.
pub fn snapshots(state: &State, home: &Path) -> Vec<Snapshot> {
    let target = folder(state, home);
    let mut names = names_in(&target);
    names.sort();
    names.reverse();
    names
        .into_iter()
        .map(|name| {
            let bytes = fs::metadata(target.join(&name))
                .map(|m| m.len())
                .unwrap_or(0);
            Snapshot { name, bytes }
        })
        .collect()
}

/// Is a run due? Off, or no interval, means never.
pub fn due(state: &State, now: u64) -> bool {
    if !state.enabled || state.every_hours == 0 {
        return false;
    }
    now.saturating_sub(state.last_run) >= state.every_hours * 3600
}

/// The interval the scheduler sleeps for. Minutes, not hours: the thread has
/// to notice a folder being chosen without the app being restarted.
pub const TICK: Duration = Duration::from_secs(60);

// --- Shared odds and ends ----------------------------------------------------

/// The last line of a process's error output — the one that says what broke.
fn last_line(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes)
        .trim()
        .lines()
        .last()
        .unwrap_or("unbekannt")
        .to_string()
}

/// A value out of the project's `.env`. Its own copy rather than the one in
/// `lib.rs`: this module is about the two Postgres variables and nothing
/// else, and importing a private helper would make the two files depend on
/// each other for a loop over lines.
fn env_value(dir: &Path, key: &str) -> Option<String> {
    let text = fs::read_to_string(dir.join(".env")).ok()?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_epoch_is_the_first_of_january_1970() {
        assert_eq!(parts(0), (1970, 1, 1, 0, 0));
    }

    #[test]
    fn a_name_sorts_by_date_because_it_is_written_that_way() {
        // 2026-10-16 14:35 UTC
        let secs = 1_792_161_300;
        assert_eq!(parts(secs), (2026, 10, 16, 14, 35));
        assert_eq!(name_for(secs), "soloops-2026-10-16-1435.tar.gz");
        // An hour later sorts after it, as text.
        assert!(name_for(secs + 3600) > name_for(secs));
    }

    #[test]
    fn the_leap_day_is_a_day() {
        // 2024-02-29 00:00 UTC
        assert_eq!(parts(1_709_164_800), (2024, 2, 29, 0, 0));
        // 2024-03-01 00:00 UTC — the day after.
        assert_eq!(parts(1_709_251_200), (2024, 3, 1, 0, 0));
    }

    #[test]
    fn only_our_own_archives_are_archives() {
        assert!(is_snapshot("soloops-2026-10-16-1435.tar.gz"));
        assert!(!is_snapshot("Steuer 2025.tar.gz"));
        assert!(!is_snapshot("soloops-2026-10-16-1435.tar.gz.icloud"));
        assert!(!is_snapshot(".soloops-2026-10-16-1435.tar.gz.part"));
    }

    #[test]
    fn rotation_drops_the_oldest_and_nothing_else() {
        let names = vec![
            "soloops-2026-10-14-0300.tar.gz".to_string(),
            "soloops-2026-10-16-0300.tar.gz".to_string(),
            "Steuer 2025.tar.gz".to_string(),
            "soloops-2026-10-15-0300.tar.gz".to_string(),
        ];
        assert_eq!(
            rotate(names.clone(), 2),
            vec!["soloops-2026-10-14-0300.tar.gz".to_string()]
        );
        // Room to spare: nothing goes.
        assert!(rotate(names.clone(), 5).is_empty());
        // A zero would mean "delete everything" — it means "delete nothing".
        assert!(rotate(names, 0).is_empty());
    }

    #[test]
    fn a_snapshot_is_due_a_day_later_and_not_before() {
        let state = State {
            enabled: true,
            every_hours: 24,
            last_run: 1_000_000,
            ..Default::default()
        };
        assert!(!due(&state, 1_000_000 + 23 * 3600));
        assert!(due(&state, 1_000_000 + 24 * 3600));
        // Switched off is switched off, however long ago it last ran.
        assert!(!due(
            &State {
                enabled: false,
                ..state.clone()
            },
            2_000_000
        ));
        // No interval means by hand only.
        assert!(!due(
            &State {
                every_hours: 0,
                ..state.clone()
            },
            2_000_000
        ));
    }

    #[test]
    fn the_folder_falls_back_to_icloud_drive() {
        let home = Path::new("/Users/test");
        let state = State::default();
        assert_eq!(folder(&state, home), suggested(home));
        assert!(folder(&state, home).to_string_lossy().contains("CloudDocs"));

        let chosen = State {
            folder: "~/Backups/soloops".to_string(),
            ..State::default()
        };
        assert_eq!(
            folder(&chosen, home),
            PathBuf::from("/Users/test/Backups/soloops")
        );

        let absolute = State {
            folder: "/Volumes/Platte/soloops".to_string(),
            ..State::default()
        };
        assert_eq!(
            folder(&absolute, home),
            PathBuf::from("/Volumes/Platte/soloops")
        );
    }

    #[test]
    fn the_remembered_settings_survive_a_round_trip() {
        let state = State {
            enabled: true,
            folder: "~/iCloud/soloops".to_string(),
            every_hours: 6,
            keep: 30,
            last_run: 1_792_161_300,
            last_error: String::new(),
            last_bytes: 4_200_000,
        };
        let text = serde_json::to_string(&state).unwrap();
        let back: State = serde_json::from_str(&text).unwrap();
        assert!(back.enabled && back.every_hours == 6 && back.keep == 30);
        assert_eq!(back.last_bytes, 4_200_000);
    }

    #[test]
    fn an_unreadable_state_file_is_switched_off() {
        let state = State::default();
        assert!(!state.enabled);
        assert!(state.folder.is_empty());
        assert!(state.keep > 0, "sonst loescht die Rotation alles");
    }
}
