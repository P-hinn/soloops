//! Reminders for leads that are due.
//!
//! A follow-up has a date; when that date arrives the API hands the lead over
//! exactly once (`claim-notifications`) and the app turns it into a macOS
//! notification. Repeating would be nagging, which is why the marking happens
//! on the server and not here.

use std::process::Command;
use std::thread;
use std::time::Duration;

use serde::Deserialize;

/// How often to ask. A follow-up is a day, not a minute — five minutes is
/// plenty, and it costs one local request.
const EVERY: Duration = Duration::from_secs(300);
/// Nothing at night. A follow-up falls due at midnight; being told about it
/// then is no use to anyone.
const QUIET_BEFORE: u32 = 8;
const QUIET_AFTER: u32 = 22;
/// More than this in one go and the rest becomes a single line — a wall of
/// notifications is read by nobody.
const AT_MOST: usize = 4;

pub struct Config {
    pub api_port: u16,
    pub token: String,
}

#[derive(Deserialize)]
struct FollowUp {
    title: String,
    company: Option<String>,
    #[serde(rename = "followUpNote")]
    note: Option<String>,
    days: i64,
}

pub fn spawn(cfg: Config) {
    thread::spawn(move || loop {
        thread::sleep(EVERY);
        if quiet_hours() {
            continue;
        }
        match claim(&cfg) {
            Ok(due) => announce(&due),
            Err(err) => eprintln!("[wiedervorlage] {err}"),
        }
    });
}

/// The local hour, read from the system — the app has no clue about time
/// zones and does not need one.
fn quiet_hours() -> bool {
    let Ok(out) = Command::new("/bin/date").args(["+%H"]).output() else {
        return false;
    };
    let hour: u32 = String::from_utf8_lossy(&out.stdout)
        .trim()
        .parse()
        .unwrap_or(12);
    !(QUIET_BEFORE..QUIET_AFTER).contains(&hour)
}

fn claim(cfg: &Config) -> Result<Vec<FollowUp>, String> {
    let (status, body) = crate::http::post(
        cfg.api_port,
        &cfg.token,
        "desktop",
        "/api/leads/follow-ups/claim-notifications",
        "{}",
    )?;
    // The API being down is the normal case while the containers start — not
    // worth a line in the log every five minutes.
    if status == 0 || status >= 500 {
        return Ok(Vec::new());
    }
    if status != 200 {
        return Err(format!("API antwortet mit {status}"));
    }
    serde_json::from_str(&body).map_err(|err| format!("Antwort nicht lesbar: {err}"))
}

fn announce(due: &[FollowUp]) {
    for lead in due.iter().take(AT_MOST) {
        let subtitle = match &lead.company {
            Some(company) if !company.is_empty() => format!("{} · {}", lead.title, company),
            _ => lead.title.clone(),
        };
        let body = match &lead.note {
            Some(note) if !note.is_empty() => note.clone(),
            _ => "Wiedervorlage ohne Notiz".to_string(),
        };
        notify(&overdue_title(lead.days), &subtitle, &body);
    }
    if due.len() > AT_MOST {
        notify(
            "Wiedervorlage",
            &format!("{} weitere fällig", due.len() - AT_MOST),
            "In soloops unter Leads nachsehen.",
        );
    }
}

fn overdue_title(days: i64) -> String {
    match days {
        0 => "Wiedervorlage heute".to_string(),
        -1 => "Wiedervorlage seit gestern".to_string(),
        d if d < 0 => format!("Wiedervorlage {} Tage überfällig", -d),
        _ => "Wiedervorlage".to_string(),
    }
}

/// macOS shows notifications for whoever asks through AppleScript — no
/// framework, no dependency.
fn notify(title: &str, subtitle: &str, body: &str) {
    let script = format!(
        "display notification \"{}\" with title \"{}\" subtitle \"{}\"",
        escape(body),
        escape(title),
        escape(subtitle)
    );
    let _ = Command::new("/usr/bin/osascript")
        .args(["-e", &script])
        .status();
}

/// AppleScript strings know exactly two escapes, and a line break ends the
/// command — so it goes too.
fn escape(text: &str) -> String {
    text.replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace(['\n', '\r'], " ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_and_line_breaks_cannot_break_out_of_the_script() {
        assert_eq!(escape("sagt \"ja\"\nmorgen"), "sagt \\\"ja\\\" morgen");
        assert_eq!(escape("pfad\\weg"), "pfad\\\\weg");
    }

    #[test]
    fn the_title_says_how_late_it_is() {
        assert_eq!(overdue_title(0), "Wiedervorlage heute");
        assert_eq!(overdue_title(-1), "Wiedervorlage seit gestern");
        assert_eq!(overdue_title(-5), "Wiedervorlage 5 Tage überfällig");
    }
}
