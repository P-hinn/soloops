//! The iPhone's postbox, for when the Mac is not reachable.
//!
//! On the same Wi-Fi the phone talks to the API directly and this does
//! nothing. The rest of the time — Mac asleep, phone on mobile data — the two
//! still have to converge, and without a server there is exactly one channel
//! that both devices can reach on their own: a folder Apple synchronises.
//!
//! So the phone writes its ops as files into its iCloud container, and this
//! thread does the two things the phone cannot do from outside the house:
//! hand those files to the local API, and leave the answer behind for the
//! phone to pick up.
//!
//! Three properties make this safe to run unattended:
//!
//!  - **Delivery is at-least-once, never exactly-once.** A file is deleted
//!    only after the API has accepted it. A crash in between means the batch
//!    is handed in twice, which the op log absorbs: `(deviceId, seq)` is
//!    unique, so the second attempt is reported as `bereits verarbeitet`.
//!  - **The outbound file is overwritten, not appended.** Until the phone
//!    confirms its cursor, the same ops are still pending; one file per
//!    device that gets rewritten keeps that from growing without bound.
//!  - **Nothing here parses an op.** The files are moved between the folder
//!    and the API as opaque JSON. The merge rules live in the API, in one
//!    place, and this thread cannot disagree with them.

use std::fs;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// How often to look. iCloud itself takes seconds to tens of seconds to move
/// a file, so polling faster would only burn battery on both ends.
const EVERY: Duration = Duration::from_secs(30);

/// The container the iOS app writes into. The `~` form of the bundle id is
/// how iCloud Drive names containers on disk.
const CONTAINER: &str = "Library/Mobile Documents/iCloud~com~soloops~app/Documents/sync";

/// Phone to Mac. One file per batch, written by the app, deleted here.
const INBOX: &str = "to-mac";
/// Mac to phone. One file per device, rewritten here, deleted by the app.
const OUTBOX: &str = "to-phone";

/// A batch larger than this is not a weekend offline but a broken client.
const MAX_BYTES: u64 = 8 * 1024 * 1024;

pub struct Config {
    pub api_port: u16,
    pub token: String,
    pub home: PathBuf,
}

/// What the phone leaves in `to-mac`.
#[derive(Deserialize)]
struct Batch {
    #[serde(rename = "deviceId")]
    device_id: String,
    /// Opaque: handed to the API as it came in.
    ops: Vec<serde_json::Value>,
    /// How far the phone has consumed the outbox. Confirms the cursor.
    #[serde(default)]
    cursor: Option<String>,
}

/// What this thread leaves in `to-phone`.
#[derive(Serialize)]
struct Outbound<'a> {
    #[serde(rename = "forDevice")]
    for_device: &'a str,
    ops: &'a serde_json::Value,
    cursor: &'a str,
    more: bool,
}

#[derive(Deserialize)]
struct RelayDevice {
    id: String,
    cursor: String,
}

#[derive(Deserialize)]
struct RelayDevices {
    devices: Vec<RelayDevice>,
}

#[derive(Deserialize)]
struct PullAnswer {
    ops: serde_json::Value,
    cursor: String,
    more: bool,
}

pub fn spawn(cfg: Config) {
    thread::spawn(move || {
        let root = cfg.home.join(CONTAINER);
        loop {
            thread::sleep(EVERY);
            // No container means the iOS app has never run on this Apple ID.
            // That is the normal state before the phone is set up, so it is
            // not worth a line in the log every thirty seconds.
            if !root.is_dir() {
                continue;
            }
            if let Err(err) = once(&cfg, &root) {
                eprintln!("[sync] {err}");
            }
        }
    });
}

fn once(cfg: &Config, root: &Path) -> Result<(), String> {
    drain_inbox(cfg, root)?;
    fill_outbox(cfg, root)
}

/// Hand everything the phone left behind to the API.
fn drain_inbox(cfg: &Config, root: &Path) -> Result<(), String> {
    let inbox = root.join(INBOX);
    if !inbox.is_dir() {
        return Ok(());
    }

    let entries = fs::read_dir(&inbox).map_err(|err| format!("{INBOX} nicht lesbar: {err}"))?;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }

        // iCloud materialises a file only when it is read, and a download in
        // flight shows up as a zero-byte placeholder. Skipping those costs
        // one more cycle; parsing them would report a broken batch that is
        // merely not here yet.
        let Ok(meta) = entry.metadata() else { continue };
        if meta.len() == 0 {
            continue;
        }
        if meta.len() > MAX_BYTES {
            eprintln!(
                "[sync] {} ist {} Bytes gross und wird uebersprungen",
                path.display(),
                meta.len()
            );
            continue;
        }

        let raw = match fs::read_to_string(&path) {
            Ok(raw) => raw,
            // Still downloading, or being written right now. Next round.
            Err(_) => continue,
        };

        let batch: Batch = match serde_json::from_str(&raw) {
            Ok(batch) => batch,
            Err(err) => {
                // Unparseable will stay unparseable, so it is moved aside
                // rather than retried every thirty seconds forever.
                eprintln!("[sync] {} ist kein Op-Paket: {err}", path.display());
                quarantine(&path);
                continue;
            }
        };

        let body = serde_json::json!({
            "deviceId": batch.device_id,
            "ops": batch.ops,
            "cursor": batch.cursor,
        })
        .to_string();

        let (status, answer) = crate::http::post(
            cfg.api_port,
            &cfg.token,
            "desktop",
            "/api/sync/relay/push",
            &body,
        )?;

        match status {
            // Accepted. The op log now owns these, so the file goes.
            200 => {
                let _ = fs::remove_file(&path);
            }
            // The device was revoked, or the batch is malformed in a way the
            // API rejects. Retrying cannot help.
            404 | 403 | 422 => {
                eprintln!(
                    "[sync] API lehnt {} ab ({status}): {answer}",
                    path.display()
                );
                quarantine(&path);
            }
            // API down or starting up — the containers take a moment. Keep
            // the file and try again.
            _ => return Ok(()),
        }
    }

    Ok(())
}

/// Leave everything the phone has not seen yet where it can find it.
fn fill_outbox(cfg: &Config, root: &Path) -> Result<(), String> {
    let (status, body) = crate::http::post(
        cfg.api_port,
        &cfg.token,
        "desktop",
        "/api/sync/relay/devices",
        "{}",
    )?;
    if status != 200 {
        return Ok(());
    }

    let devices: RelayDevices =
        serde_json::from_str(&body).map_err(|err| format!("Geraeteliste nicht lesbar: {err}"))?;
    if devices.devices.is_empty() {
        return Ok(());
    }

    let outbox = root.join(OUTBOX);
    fs::create_dir_all(&outbox).map_err(|err| format!("{OUTBOX} nicht anlegbar: {err}"))?;

    for device in devices.devices {
        let pull =
            serde_json::json!({ "deviceId": device.id, "cursor": device.cursor }).to_string();
        let (status, body) = crate::http::post(
            cfg.api_port,
            &cfg.token,
            "desktop",
            "/api/sync/relay/pull",
            &pull,
        )?;
        if status != 200 {
            continue;
        }

        let answer: PullAnswer =
            serde_json::from_str(&body).map_err(|err| format!("Pull nicht lesbar: {err}"))?;

        // Nothing pending. Clear the file so the phone does not re-apply a
        // batch it has already confirmed.
        if answer.ops.as_array().is_some_and(|ops| ops.is_empty()) {
            let _ = fs::remove_file(outbox.join(outbox_name(&device.id)));
            continue;
        }

        let out = Outbound {
            for_device: &device.id,
            ops: &answer.ops,
            cursor: &answer.cursor,
            more: answer.more,
        };
        let text =
            serde_json::to_string(&out).map_err(|err| format!("Antwort nicht baubar: {err}"))?;

        write_atomically(&outbox.join(outbox_name(&device.id)), &text)?;
    }

    Ok(())
}

/// One file per device, so a pending batch is replaced and not stacked up.
fn outbox_name(device_id: &str) -> String {
    format!("{}.pending.json", sanitise(device_id))
}

/// A device id comes from the database, but it ends up in a path — so it is
/// reduced to characters that cannot climb out of the folder.
fn sanitise(id: &str) -> String {
    id.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// Write to a temporary name, then rename.
///
/// iCloud uploads whatever it finds, and a half-written file would be synced
/// to the phone as a truncated batch. A rename within the folder is atomic,
/// so the phone only ever sees the whole thing.
fn write_atomically(path: &Path, text: &str) -> Result<(), String> {
    let temp = path.with_extension("tmp");
    fs::write(&temp, text).map_err(|err| format!("{} nicht schreibbar: {err}", temp.display()))?;
    fs::rename(&temp, path).map_err(|err| format!("{} nicht ersetzbar: {err}", path.display()))
}

/// Move a file that will never be accepted out of the way.
///
/// Deleting would be tidier and would also destroy the only copy of changes
/// made on the phone. It keeps the extension off `.json` so the loop stops
/// picking it up.
fn quarantine(path: &Path) {
    let aside = path.with_extension("rejected");
    if fs::rename(path, &aside).is_err() {
        // Could not even move it — then at least stop retrying it.
        let _ = fs::remove_file(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_device_id_cannot_climb_out_of_the_folder() {
        assert_eq!(sanitise("../../etc/passwd"), "------etc-passwd");
        assert_eq!(
            sanitise("cmusfwj2f0000c9vda3784s9w"),
            "cmusfwj2f0000c9vda3784s9w"
        );
    }

    #[test]
    fn one_file_per_device() {
        assert_eq!(outbox_name("abc123"), "abc123.pending.json");
        // Two calls for the same device name the same file, which is what
        // keeps a pending batch from stacking up.
        assert_eq!(outbox_name("abc123"), outbox_name("abc123"));
    }

    #[test]
    fn the_temporary_file_is_not_picked_up_by_the_loop() {
        let path = Path::new("/tmp/soloops/abc.pending.json");
        let temp = path.with_extension("tmp");
        assert_eq!(temp.extension().and_then(|e| e.to_str()), Some("tmp"));
    }

    #[test]
    fn a_rejected_batch_stops_looking_like_a_batch() {
        let path = Path::new("/tmp/soloops/to-mac/batch-7.json");
        let aside = path.with_extension("rejected");
        assert_ne!(aside.extension().and_then(|e| e.to_str()), Some("json"));
    }
}
