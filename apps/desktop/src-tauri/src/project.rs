//! Finding the repository.
//!
//! The app is a frame around a stack that lives in a directory: the compose
//! file, the `.env`, `data/`. A `.app` has no working directory, so that path
//! has to come from somewhere.
//!
//! It used to be baked in at build time — `CARGO_MANIFEST_DIR` — which works
//! perfectly for the one machine that compiled it and for nobody else. An app
//! built on a CI runner carries `/Users/runner/work/soloops/soloops`, and on
//! the Mac that downloads it that path does not exist: no `.env`, no `data/`,
//! no stack. The installer would have been an app that cannot do anything.
//!
//! So it is a chain of places to look, most specific first, and the last link
//! is asking. What was asked is remembered, so it is asked once.
//!
//! The deciding part — "is this a soloops repository" — takes no Tauri types
//! and is tested.

use std::fs;
use std::path::{Path, PathBuf};

/// Where the chosen path is remembered. Next to the app's other state, not in
/// the repository: the whole point is to find a repository that may be
/// anywhere, so this cannot live inside one.
const REMEMBERED: &str = "Library/Application Support/com.philippniestroj.soloops/dir";

/// The usual places, relative to the home directory. Tried in this order
/// after the remembered path and before anybody is asked.
const USUAL: [&str; 4] = [
    "Desktop/PNSE/soloops",
    "soloops",
    "Developer/soloops",
    "Projects/soloops",
];

/// Does this directory hold the soloops stack?
///
/// Two marks, not one. A `docker-compose.yml` alone is any project with
/// containers, and a `package.json` alone is any npm project — a directory
/// that has both *and* the right package name is this one. The name is read
/// out of the file rather than trusted from the folder, because a copy called
/// `soloops-alt` is still the repository and a folder called `soloops` that
/// holds something else is not.
pub fn is_project(dir: &Path) -> bool {
    if !dir.join("docker-compose.yml").is_file() {
        return false;
    }
    let Ok(manifest) = fs::read_to_string(dir.join("package.json")) else {
        return false;
    };
    // Deliberately not a JSON parse: this runs before anything else and the
    // only question is whether one line is in there.
    manifest.contains("\"name\": \"soloops\"") || manifest.contains("\"name\":\"soloops\"")
}

/// The first of these that is a soloops repository.
///
/// Pure, so the order can be tested without a filesystem full of decoys:
/// `exists` says which of the candidates are real.
pub fn first_project<F>(candidates: &[PathBuf], exists: F) -> Option<PathBuf>
where
    F: Fn(&Path) -> bool,
{
    candidates.iter().find(|path| exists(path)).cloned()
}

/// Every place to look, in order.
///
/// 1. `SOLOOPS_DIR` — someone said so, and that beats everything.
/// 2. The path remembered from a previous answer.
/// 3. The path baked in at build time, **but only if it exists**: that keeps
///    the development build as convenient as it was, without letting a CI
///    runner's path leak onto somebody's Mac.
/// 4. The usual places under the home directory.
pub fn candidates(home: &Path, baked: Option<&str>, env_dir: Option<&str>) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(dir) = env_dir {
        out.push(PathBuf::from(dir));
    }
    if let Some(remembered) = read_remembered(home) {
        out.push(remembered);
    }
    if let Some(dir) = baked {
        out.push(PathBuf::from(dir));
    }
    for relative in USUAL {
        out.push(home.join(relative));
    }
    out
}

fn remembered_path(home: &Path) -> PathBuf {
    home.join(REMEMBERED)
}

pub fn read_remembered(home: &Path) -> Option<PathBuf> {
    let text = fs::read_to_string(remembered_path(home)).ok()?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(PathBuf::from(trimmed))
}

pub fn remember(home: &Path, dir: &Path) {
    let path = remembered_path(home);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(path, dir.to_string_lossy().as_bytes());
}

/// Ask, with the same Finder dialog the backup folder uses.
///
/// Returns `None` when the dialog was cancelled, which is not a failure — it
/// is somebody deciding to sort it out later.
pub fn ask() -> Option<PathBuf> {
    let out = std::process::Command::new("/usr/bin/osascript")
        .args([
            "-e",
            "POSIX path of (choose folder with prompt \
             \"Wo liegt das soloops-Repository? (Ordner mit docker-compose.yml)\")",
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let chosen = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if chosen.is_empty() {
        return None;
    }
    Some(PathBuf::from(chosen))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home() -> PathBuf {
        PathBuf::from("/Users/test")
    }

    #[test]
    fn the_environment_wins_over_everything() {
        let list = candidates(&home(), Some("/baked/path"), Some("/said/so"));
        assert_eq!(list.first(), Some(&PathBuf::from("/said/so")));
    }

    #[test]
    fn the_baked_path_comes_after_the_remembered_one() {
        // No remembered file in the test home, so baked is second.
        let list = candidates(&home(), Some("/baked/path"), None);
        assert_eq!(list.first(), Some(&PathBuf::from("/baked/path")));
    }

    #[test]
    fn without_a_baked_path_the_usual_places_remain() {
        let list = candidates(&home(), None, None);
        assert_eq!(
            list.first(),
            Some(&PathBuf::from("/Users/test/Desktop/PNSE/soloops"))
        );
        assert_eq!(list.len(), USUAL.len());
    }

    #[test]
    fn the_first_one_that_exists_wins() {
        let list = vec![
            PathBuf::from("/nope"),
            PathBuf::from("/yes"),
            PathBuf::from("/also-yes"),
        ];
        let found = first_project(&list, |path| path.to_string_lossy().contains("yes"));
        assert_eq!(found, Some(PathBuf::from("/yes")));
    }

    #[test]
    fn nothing_found_is_nothing_found() {
        let list = vec![PathBuf::from("/nope")];
        assert_eq!(first_project(&list, |_| false), None);
    }

    /// A CI-built app carries a path from the runner. It has to be skipped,
    /// not used — that is the whole reason this module exists.
    #[test]
    fn a_baked_path_that_does_not_exist_is_passed_over() {
        let list = candidates(&home(), Some("/Users/runner/work/soloops/soloops"), None);
        let found = first_project(&list, |path| path.starts_with("/Users/test"));
        assert_eq!(
            found,
            Some(PathBuf::from("/Users/test/Desktop/PNSE/soloops"))
        );
    }

    #[test]
    fn a_directory_is_only_the_project_with_both_marks() {
        let dir = std::env::temp_dir().join("soloops-project-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        // Nothing in it.
        assert!(!is_project(&dir));

        // A compose file alone is any project with containers.
        fs::write(dir.join("docker-compose.yml"), "services: {}\n").unwrap();
        assert!(!is_project(&dir));

        // A package.json for something else is still not this one.
        fs::write(
            dir.join("package.json"),
            "{\n  \"name\": \"something\"\n}\n",
        )
        .unwrap();
        assert!(!is_project(&dir));

        // Both marks, and the right name.
        fs::write(dir.join("package.json"), "{\n  \"name\": \"soloops\"\n}\n").unwrap();
        assert!(is_project(&dir));

        // Written without the space, as a formatter might.
        fs::write(dir.join("package.json"), "{\"name\":\"soloops\"}").unwrap();
        assert!(is_project(&dir));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn what_was_answered_is_remembered() {
        let home = std::env::temp_dir().join("soloops-remember-test");
        let _ = fs::remove_dir_all(&home);
        assert_eq!(read_remembered(&home), None);

        remember(&home, Path::new("/Volumes/Platte/soloops"));
        assert_eq!(
            read_remembered(&home),
            Some(PathBuf::from("/Volumes/Platte/soloops"))
        );

        // And it is the first place looked at afterwards, before the baked path.
        let list = candidates(&home, Some("/baked"), None);
        assert_eq!(
            list.first(),
            Some(&PathBuf::from("/Volumes/Platte/soloops"))
        );

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn an_empty_note_is_no_answer() {
        let home = std::env::temp_dir().join("soloops-remember-empty");
        let _ = fs::remove_dir_all(&home);
        let path = home.join(REMEMBERED);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "   \n").unwrap();
        assert_eq!(read_remembered(&home), None);
        let _ = fs::remove_dir_all(&home);
    }
}
