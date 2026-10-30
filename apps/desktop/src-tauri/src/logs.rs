//! Data folder and `logs/desktop.log`.
//!
//! The data folder is the same one the server uses (`defaultDataDir()` in
//! apps/server/src/core/paths.ts), so script mode and desktop mode share it. The shell only
//! writes `logs/desktop.log` (server output + its own lines), rotated by size.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// Rotate when desktop.log reaches this size; keep `KEEP` old files (desktop.log.1, .2).
const MAX_BYTES: u64 = 2 * 1024 * 1024;
const KEEP: usize = 2;

/// Per-user data folder. Never requires admin rights.
pub fn data_dir() -> PathBuf {
    data_dir_for(std::env::consts::OS, |k| std::env::var_os(k).map(PathBuf::from))
}

fn data_dir_for(os: &str, env: impl Fn(&str) -> Option<PathBuf>) -> PathBuf {
    if let Some(dir) = env("SWARMCAST_DATA_DIR").filter(|d| !d.as_os_str().is_empty()) {
        return std::path::absolute(&dir).unwrap_or(dir);
    }
    let home = env(if os == "windows" { "USERPROFILE" } else { "HOME" }).unwrap_or_else(|| PathBuf::from("."));
    match os {
        "windows" => env("LOCALAPPDATA").unwrap_or_else(|| home.join("AppData").join("Local")).join("SwarmCast"),
        "macos" => home.join("Library").join("Application Support").join("SwarmCast"),
        _ => env("XDG_DATA_HOME").unwrap_or_else(|| home.join(".local").join("share")).join("swarmcast"),
    }
}

pub fn logs_dir() -> PathBuf {
    data_dir().join("logs")
}

/// `2026-10-26T12:00:00.123Z` (UTC) without a date crate.
pub fn timestamp(t: SystemTime) -> String {
    let d = t.duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = d.as_secs() as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil-from-days (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z", rem / 3600, rem % 3600 / 60, rem % 60, d.subsec_millis())
}

struct Writer {
    path: PathBuf,
    file: Option<File>,
    size: u64,
}

impl Writer {
    fn open(&mut self) {
        if self.file.is_some() {
            return;
        }
        if let Some(dir) = self.path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        if let Ok(file) = OpenOptions::new().create(true).append(true).open(&self.path) {
            self.size = file.metadata().map(|m| m.len()).unwrap_or(0);
            self.file = Some(file);
        }
    }

    fn rotate(&mut self) {
        self.file = None;
        rotate_files(&self.path, KEEP);
        self.size = 0;
    }

    fn write_line(&mut self, line: &str) {
        self.open();
        if self.size >= MAX_BYTES {
            self.rotate();
            self.open();
        }
        if let Some(file) = self.file.as_mut() {
            let bytes = format!("{line}\n");
            if file.write_all(bytes.as_bytes()).is_ok() {
                self.size += bytes.len() as u64;
            }
        }
    }
}

/// desktop.log → desktop.log.1 → … → desktop.log.<keep> (the oldest is dropped).
fn rotate_files(path: &Path, keep: usize) {
    let numbered = |n: usize| PathBuf::from(format!("{}.{n}", path.display()));
    let _ = fs::remove_file(numbered(keep));
    for n in (1..keep).rev() {
        let _ = fs::rename(numbered(n), numbered(n + 1));
    }
    let _ = fs::rename(path, numbered(1));
}

fn writer() -> &'static Mutex<Writer> {
    static WRITER: OnceLock<Mutex<Writer>> = OnceLock::new();
    WRITER.get_or_init(|| Mutex::new(Writer { path: logs_dir().join("desktop.log"), file: None, size: 0 }))
}

/// A line printed by the server (copied as-is).
pub fn server_line(line: &str) {
    if let Ok(mut w) = writer().lock() {
        w.write_line(line.trim_end());
    }
}

/// A line from the shell itself.
pub fn shell(msg: impl AsRef<str>) {
    let line = format!("{} [desktop] {}", timestamp(SystemTime::now()), msg.as_ref());
    #[cfg(debug_assertions)]
    eprintln!("{line}");
    if let Ok(mut w) = writer().lock() {
        w.write_line(&line);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;
    use std::time::Duration;

    /// An environment that holds only `vars`.
    fn env_of(vars: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<PathBuf> {
        move |k: &str| vars.iter().find(|(n, _)| *n == k).map(|(_, v)| PathBuf::from(v))
    }

    #[test]
    fn the_windows_data_dir_is_in_localappdata() {
        // Arrange
        let env = env_of(&[("LOCALAPPDATA", "C:\\Users\\a\\AppData\\Local"), ("USERPROFILE", "C:\\Users\\a")]);

        // Act
        let dir = data_dir_for("windows", env);

        // Assert
        assert_eq!(dir, PathBuf::from("C:\\Users\\a\\AppData\\Local").join("SwarmCast"));
    }

    #[test]
    fn the_macos_data_dir_is_in_application_support() {
        // Act
        let dir = data_dir_for("macos", env_of(&[("HOME", "/Users/a")]));

        // Assert
        assert_eq!(dir, PathBuf::from("/Users/a/Library/Application Support/SwarmCast"));
    }

    #[test]
    fn the_linux_data_dir_follows_xdg_data_home() {
        // Act
        let default = data_dir_for("linux", env_of(&[("HOME", "/home/a")]));
        let xdg = data_dir_for("linux", env_of(&[("HOME", "/home/a"), ("XDG_DATA_HOME", "/x")]));

        // Assert
        assert_eq!(default, PathBuf::from("/home/a/.local/share/swarmcast"));
        assert_eq!(xdg, PathBuf::from("/x/swarmcast"));
    }

    /// Made absolute like the server's `path.resolve` (on Windows "/tmp/sc" gets the current drive).
    #[test]
    fn an_explicit_data_dir_is_made_absolute() {
        // Arrange
        let env = env_of(&[("HOME", "/Users/a"), ("SWARMCAST_DATA_DIR", "/tmp/sc")]);

        // Act
        let dir = data_dir_for("macos", env);

        // Assert
        assert_eq!(dir, std::path::absolute("/tmp/sc").unwrap());
    }

    /// Milliseconds are kept, and the calendar handles a leap day (no date crate).
    #[test]
    fn formats_utc_timestamps() {
        // Arrange
        let times = [UNIX_EPOCH, UNIX_EPOCH + Duration::from_millis(1_793_016_000_123), UNIX_EPOCH + Duration::from_secs(951_782_400)];

        // Act
        let formatted = times.map(timestamp);

        // Assert
        assert_eq!(formatted, ["1970-01-01T00:00:00.000Z", "2026-10-26T12:00:00.123Z", "2000-02-29T00:00:00.000Z"]);
    }

    /// Three times MAX_BYTES of lines: desktop.log stays under the limit, `KEEP` (2) old files
    /// are kept and the oldest is dropped.
    #[test]
    fn rotates_by_size() {
        // Arrange
        let dir = TempDir::new("log-rotation");
        let path = dir.path().join("desktop.log");
        let mut writer = Writer { path: path.clone(), file: None, size: 0 };
        let line = "x".repeat(1023);

        // Act
        for _ in 0..(MAX_BYTES / 1024) * 3 + 10 {
            writer.write_line(&line);
        }
        drop(writer);

        // Assert
        assert!(fs::metadata(&path).unwrap().len() <= MAX_BYTES);
        assert!(dir.path().join("desktop.log.1").exists());
        assert!(dir.path().join("desktop.log.2").exists());
        assert!(!dir.path().join("desktop.log.3").exists());
    }
}
