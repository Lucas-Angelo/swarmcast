//! Helpers shared by the shell's unit tests (compiled for `cargo test` only).
//!
//! Tests run in parallel threads of one process (Rust Book ch. 11): each one gets its own
//! folder, and nothing here touches the environment or the current directory.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// A new, empty folder of its own in the temp dir, deleted with its content when dropped (also
/// when an assertion fails: the panic unwinds through the drop). Drop the files opened in it
/// first (declare them after it): on Windows an open file can keep the folder from going.
pub struct TempDir(PathBuf);

impl TempDir {
    /// `swarmcast-<name>-<pid>-<nanoseconds>`: unique per test and per run, never reused, so a
    /// folder an aborted run left behind cannot leak into a new test.
    pub fn new(name: &str) -> TempDir {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
        let dir = std::env::temp_dir().join(format!("swarmcast-{name}-{}-{nanos}", std::process::id()));
        std::fs::create_dir(&dir).unwrap_or_else(|err| panic!("cannot create {}: {err}", dir.display()));
        TempDir(dir)
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        // Cleanup only: a folder that cannot be removed must not turn a passing test red.
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
