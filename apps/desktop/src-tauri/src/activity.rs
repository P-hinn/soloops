//! Samples of what is happening on the machine.
//!
//! Every few seconds it notes which app is in front, what its window is
//! called and how long nobody has typed. Nothing else — no keystrokes, no
//! screen contents.
//!
//! Two things are built this way on purpose:
//!
//! * **No third-party boxes.** The data goes to our own API on 127.0.0.1 and
//!   nowhere else. Mapping it to projects happens locally later on; none of
//!   it needs the network.
//! * **No new dependencies.** The foreground comes from `osascript`, the idle
//!   time from `ioreg`, the transfer from a raw HTTP request. Two process
//!   calls per tick are cheaper than three crates that drag in half of macOS.
//!
//! Buffering happens on disk, not in memory: if the containers are down or
//! the app is quit, the buffer is still there on the next start.

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Apps whose window titles are never stored, unless the .env says otherwise.
/// That they ran stays visible — what was in them does not.
const DEFAULT_BLOCKED: &str = "com.1password.,com.apple.keychainaccess,com.apple.Passwords,\
com.apple.MobileSMS,net.whatsapp.,org.whispersystems.signal,ch.threema.";

/// How often the buffer goes to the API. The sampling beat is finer — one
/// request a minute is plenty.
const FLUSH_EVERY: Duration = Duration::from_secs(60);

/// Ceiling per request. Fits the API's `.max(1000)` and keeps the body small.
const MAX_BATCH: usize = 500;

/// At a 20-second beat that is roughly four days of backlog. If the API stays
/// away for longer, the oldest entries fall off — week-old samples are no use
/// as a memory aid anyway.
const MAX_PENDING_LINES: usize = 20_000;

pub struct Config {
    pub api_port: u16,
    pub token: String,
    pub sample_seconds: u64,
    pub blocked: Vec<String>,
    /// Line-delimited JSON. What sits here is not in the database yet.
    pub pending: PathBuf,
}

impl Config {
    pub fn from_env(
        api_port: u16,
        token: String,
        sample_seconds: Option<u64>,
        blocked: Option<String>,
        pending: PathBuf,
    ) -> Self {
        let list = blocked.unwrap_or_else(|| DEFAULT_BLOCKED.to_string());
        Self {
            api_port,
            token,
            // Below five seconds sampling turns into surveillance; above two
            // minutes the switch between two tasks blurs.
            sample_seconds: sample_seconds.unwrap_or(20).clamp(5, 120),
            blocked: list
                .split(',')
                .map(|entry| entry.trim().to_lowercase())
                .filter(|entry| !entry.is_empty())
                .collect(),
            pending,
        }
    }

    fn is_blocked(&self, bundle_id: &str) -> bool {
        let id = bundle_id.to_lowercase();
        self.blocked.iter().any(|prefix| id.starts_with(prefix))
    }
}

// --- Measuring --------------------------------------------------------------

/// The frontmost app through System Events. Needs the permission under
/// System Settings > Privacy & Security > Accessibility once; without it the
/// call fails and simply nothing gets recorded.
const FRONTMOST: &str = r#"
tell application "System Events"
  set b to ""
  set n to ""
  set t to ""
  try
    set p to first application process whose frontmost is true
    try
      set b to bundle identifier of p as text
    end try
    try
      set n to name of p as text
    end try
    try
      set t to value of attribute "AXTitle" of window 1 of p as text
    end try
  end try
  return b & "\n" & n & "\n" & t
end tell
"#;

fn parse_frontmost(text: &str) -> Option<(String, String, String)> {
    let mut lines = text.split('\n');
    let bundle = lines.next()?.trim().to_string();
    let name = lines.next()?.trim().to_string();
    // The rest is the title. Some windows carry line breaks in their name —
    // those become spaces, so that one sample stays one line.
    let title = lines.collect::<Vec<_>>().join(" ").trim().to_string();
    if bundle.is_empty() && name.is_empty() {
        return None;
    }
    Some((bundle, name, title))
}

fn frontmost() -> Option<(String, String, String)> {
    let out = Command::new("/usr/bin/osascript")
        .args(["-e", FRONTMOST])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    parse_frontmost(&String::from_utf8_lossy(&out.stdout))
}

/// Seconds since the last input. `ioreg` reports nanoseconds.
fn idle_seconds() -> u64 {
    // `-r -d 1`: the IOHIDSystem node itself rather than half the tree —
    // 36 lines against 3000. Without `-r`, `-d 1` drops the properties, and
    // HIDIdleTime is precisely one of those.
    let Ok(out) = Command::new("/usr/sbin/ioreg")
        .args(["-r", "-c", "IOHIDSystem", "-d", "1"])
        .output()
    else {
        return 0;
    };
    parse_idle(&String::from_utf8_lossy(&out.stdout))
}

/// The line looks like this: `      "HIDIdleTime" = 26156096375`.
fn parse_idle(text: &str) -> u64 {
    for line in text.lines() {
        if !line.contains("HIDIdleTime") {
            continue;
        }
        let digits: String = line
            .rsplit('=')
            .next()
            .unwrap_or("")
            .chars()
            .filter(char::is_ascii_digit)
            .collect();
        if let Ok(nanos) = digits.parse::<u128>() {
            return (nanos / 1_000_000_000) as u64;
        }
    }
    0
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

// --- Buffer ------------------------------------------------------------------

/// A JSON string by hand. It is four fields — that does not warrant serde.
fn quote(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => out.push(' '),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn sample_json(cfg: &Config) -> Option<String> {
    let (bundle, name, title) = frontmost()?;
    let redacted = cfg.is_blocked(&bundle);
    Some(format!(
        r#"{{"atMs":{},"bundleId":{},"appName":{},"title":{},"redacted":{},"idleSec":{}}}"#,
        now_ms(),
        quote(&bundle),
        quote(&name),
        quote(if redacted { "" } else { title.as_str() }),
        redacted,
        idle_seconds(),
    ))
}

fn append(cfg: &Config, line: &str) {
    if let Some(parent) = cfg.pending.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let Ok(mut file) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&cfg.pending)
    else {
        return;
    };
    let _ = writeln!(file, "{line}");
}

fn read_pending(cfg: &Config) -> Vec<String> {
    let Ok(text) = fs::read_to_string(&cfg.pending) else {
        return Vec::new();
    };
    let mut lines: Vec<String> = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(str::to_string)
        .collect();
    if lines.len() > MAX_PENDING_LINES {
        lines.drain(..lines.len() - MAX_PENDING_LINES);
    }
    lines
}

fn write_pending(cfg: &Config, lines: &[String]) {
    if lines.is_empty() {
        let _ = fs::remove_file(&cfg.pending);
        return;
    }
    let _ = fs::write(&cfg.pending, format!("{}\n", lines.join("\n")));
}

// --- Sending ------------------------------------------------------------------

/// Drain the buffer as far as it goes. Whatever is left stays left — the
/// next round takes it along.
fn flush(cfg: &Config) {
    loop {
        let lines = read_pending(cfg);
        if lines.is_empty() {
            return;
        }
        let batch = lines.len().min(MAX_BATCH);
        let body = format!("{{\"samples\":[{}]}}", lines[..batch].join(","));

        match crate::http::post(
            cfg.api_port,
            &cfg.token,
            "desktop",
            "/api/activity/samples",
            &body,
        )
        .map(|(status, _)| status)
        {
            Ok(code) if (200..300).contains(&code) => {
                write_pending(cfg, &lines[batch..]);
                if lines.len() == batch {
                    return;
                }
            }
            // 4xx means: the API will never accept this. Keeping it would
            // clog the buffer, so out it goes.
            Ok(code) if (400..500).contains(&code) && code != 401 => {
                eprintln!("[activity] {batch} Stichproben verworfen, API antwortete {code}");
                write_pending(cfg, &lines[batch..]);
                return;
            }
            // Everything else (API down, 401, 5xx) is temporary.
            _ => return,
        }
    }
}

// --- The loop -------------------------------------------------------------------

/// Runs in a thread of its own until the app quits. `enabled` is the switch
/// from menu and tray: off means genuinely off, nothing is even measured.
pub fn spawn(cfg: Config, enabled: Arc<AtomicBool>) {
    thread::spawn(move || {
        let tick = Duration::from_secs(cfg.sample_seconds);
        let mut since_flush = Duration::ZERO;
        let mut warned = false;

        loop {
            thread::sleep(tick);
            since_flush += tick;

            if !enabled.load(Ordering::SeqCst) {
                continue;
            }

            match sample_json(&cfg) {
                Some(line) => {
                    warned = false;
                    append(&cfg, &line);
                }
                None if !warned => {
                    warned = true;
                    eprintln!(
                        "[activity] Vordergrund nicht lesbar — fehlt die Freigabe unter \
Systemeinstellungen > Datenschutz & Sicherheit > Bedienungshilfen?"
                    );
                }
                None => {}
            }

            if since_flush >= FLUSH_EVERY {
                since_flush = Duration::ZERO;
                flush(&cfg);
            }
        }
    });
}

// --- Tests ---------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_idle_time_from_the_ioreg_line() {
        let text =
            "    | | |   \"HIDEventCount\" = 12\n    | | |   \"HIDIdleTime\" = 26156096375\n";
        assert_eq!(parse_idle(text), 26);
    }

    #[test]
    fn without_the_line_zero_rather_than_a_guess() {
        assert_eq!(parse_idle("+-o Root  <class IORegistryEntry>"), 0);
    }

    #[test]
    fn splits_the_answer_from_system_events() {
        let got = parse_frontmost("com.microsoft.VSCode\nCode\nactivity.rs — soloops\n");
        assert_eq!(
            got,
            Some((
                "com.microsoft.VSCode".into(),
                "Code".into(),
                "activity.rs — soloops".into()
            ))
        );
    }

    #[test]
    fn a_title_with_a_line_break_stays_one_line() {
        let (_, _, title) = parse_frontmost("com.apple.Safari\nSafari\nzwei\nzeilen").unwrap();
        assert_eq!(title, "zwei zeilen");
    }

    #[test]
    fn no_foreground_no_record() {
        assert_eq!(parse_frontmost("\n\n"), None);
    }

    #[test]
    fn the_blocklist_matches_on_the_prefix() {
        let cfg = Config::from_env(3000, "t".into(), None, None, PathBuf::from("/tmp/x.jsonl"));
        assert!(cfg.is_blocked("com.1password.1password8"));
        assert!(!cfg.is_blocked("com.microsoft.VSCode"));
    }
}
