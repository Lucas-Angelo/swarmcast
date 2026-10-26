//! The server process (`swarmcast-server --desktop`).
//!
//! stdout carries `@@swarmcast` messages and log lines, stderr only logs; both go to
//! desktop.log. The process must never outlive the shell:
//! - Windows: it runs in a Job object with KILL_ON_JOB_CLOSE, so if the shell dies (even
//!   killed from the Task Manager) Windows kills the whole tree (server, reaper, MediaMTX,
//!   cloudflared, ffmpeg). It is started without a console window.
//! - macOS / Linux: the server watches its parent and its stdin (EOF = quit); its reaper
//!   cleans its children if it is killed.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::Duration;

use crate::logs;
use crate::protocol::{self, Line, ServerMessage, ShellMessage};

/// File name of the sidecar next to the shell executable (Tauri `externalBin`).
pub fn sidecar_file_name() -> &'static str {
    if cfg!(windows) {
        "swarmcast-server.exe"
    } else {
        "swarmcast-server"
    }
}

/// Where the shell finds the server and its resources.
#[derive(Clone, Debug)]
pub struct Layout {
    pub sidecar: PathBuf,
    pub bin_dir: PathBuf,
    pub web_dir: PathBuf,
}

impl Layout {
    /// `exe_dir`: folder of the shell executable (Contents/MacOS on macOS, /usr/bin for the
    /// .deb, usr/bin inside the AppImage, the install folder on Windows).
    /// `resource_dir`: Tauri's resource folder (Contents/Resources, /usr/lib/SwarmCast,
    /// the install folder on Windows).
    pub fn new(exe_dir: &Path, resource_dir: &Path) -> Self {
        let sidecar = exe_dir.join(sidecar_file_name());
        // Debug builds only: run another server (e.g. test/mock-server) without bundling it.
        #[cfg(debug_assertions)]
        let sidecar = std::env::var_os("SWARMCAST_SIDECAR").map(PathBuf::from).unwrap_or(sidecar);
        Layout { sidecar, bin_dir: resource_dir.join("bin"), web_dir: resource_dir.join("web") }
    }
}

/// Environment of the contract (docs/DESKTOP.md).
pub struct SpawnEnv {
    pub desktop_exe: PathBuf,
    pub version: String,
    pub locale: String,
    /// `--no-autostart`: started at login (`--background`), so the live (and its public
    /// tunnel) does not turn on by itself at every boot.
    pub no_autostart: bool,
}

pub struct Process {
    pub pid: u32,
    stdin: Mutex<Option<ChildStdin>>,
    exited: Arc<(Mutex<bool>, Condvar)>,
    #[cfg(windows)]
    job: Option<win::Job>,
}

impl Process {
    /// Starts the server. `on_message` runs on the reader thread for every protocol message;
    /// `on_exit` runs once, after the last stdout line was handled.
    pub fn spawn(
        layout: &Layout,
        env: &SpawnEnv,
        on_message: impl Fn(ServerMessage) + Send + 'static,
        on_exit: impl FnOnce(Option<i32>) + Send + 'static,
    ) -> std::io::Result<Arc<Process>> {
        let mut cmd = Command::new(&layout.sidecar);
        cmd.arg("--desktop");
        if env.no_autostart {
            cmd.arg("--no-autostart");
        }
        cmd.env("SWARMCAST_DESKTOP_EXE", &env.desktop_exe)
            .env("SWARMCAST_BIN_DIR", &layout.bin_dir)
            .env("SWARMCAST_WEB_DIR", &layout.web_dir)
            .env("SWARMCAST_DESKTOP_VERSION", &env.version)
            .env("SWARMCAST_LOCALE", &env.locale)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(dir) = layout.sidecar.parent() {
            cmd.current_dir(dir);
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            // Own process group: Ctrl+C in a terminal (dev runs) goes to the shell, which then
            // stops the server in order, instead of hitting both at once.
            cmd.process_group(0);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = cmd.spawn()?;
        let pid = child.id();
        #[cfg(windows)]
        let job = win::Job::for_child(&child);

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let process = Arc::new(Process {
            pid,
            stdin: Mutex::new(child.stdin.take()),
            exited: Arc::new((Mutex::new(false), Condvar::new())),
            #[cfg(windows)]
            job,
        });

        let (done_tx, done_rx) = mpsc::channel::<()>();
        if let Some(out) = stdout {
            thread::Builder::new().name("sidecar-stdout".into()).spawn(move || {
                for_each_line(out, |line| match protocol::parse_line(&line) {
                    Line::Log => logs::server_line(&line),
                    // Protocol lines are not logged: `ready` carries the per-run panel token.
                    Line::Message(msg) => on_message(msg),
                    Line::Invalid(err) => logs::shell(format!("ignoring an invalid server message ({err})")),
                });
                let _ = done_tx.send(());
            })?;
        }
        if let Some(err) = stderr {
            thread::Builder::new().name("sidecar-stderr".into()).spawn(move || for_each_line(err, |line| logs::server_line(&line)))?;
        }

        let exited = process.exited.clone();
        thread::Builder::new().name("sidecar-wait".into()).spawn(move || {
            let code = child.wait().ok().and_then(|s| s.code());
            // Handle the last messages (ready / fatal) before the exit. A grandchild that
            // kept the pipe open must not block us forever.
            let _ = done_rx.recv_timeout(Duration::from_secs(2));
            {
                let (lock, cvar) = &*exited;
                *lock.lock().unwrap() = true;
                cvar.notify_all();
            }
            on_exit(code);
        })?;

        Ok(process)
    }

    /// Writes one message to the server's stdin. False if the pipe is closed.
    pub fn send(&self, msg: &ShellMessage) -> bool {
        let mut guard = self.stdin.lock().unwrap();
        let Some(stdin) = guard.as_mut() else { return false };
        let ok = stdin.write_all(protocol::encode(msg).as_bytes()).and_then(|_| stdin.flush()).is_ok();
        if !ok {
            *guard = None;
        }
        ok
    }

    pub fn has_exited(&self) -> bool {
        *self.exited.0.lock().unwrap()
    }

    /// Waits for the process to exit; true if it did within `timeout`.
    pub fn wait_exit(&self, timeout: Duration) -> bool {
        let (lock, cvar) = &*self.exited;
        let guard = lock.lock().unwrap();
        let (guard, _) = cvar.wait_timeout_while(guard, timeout, |exited| !*exited).unwrap();
        *guard
    }

    /// Asks the server to stop everything and exit; kills it after `grace`.
    pub fn quit(&self, grace: Duration) {
        if self.has_exited() {
            return;
        }
        self.send(&ShellMessage::Quit);
        // Closing stdin is also a quit for the server, and unblocks a server that only
        // watches for EOF.
        *self.stdin.lock().unwrap() = None;
        if !self.wait_exit(grace) {
            logs::shell(format!("server (pid {}) did not exit within {}s, killing it", self.pid, grace.as_secs()));
            self.kill();
            self.wait_exit(Duration::from_secs(5));
        }
    }

    /// Kills the server. Windows: the whole Job (server and everything it started).
    /// POSIX: the server only; its reaper then kills the children it registered.
    pub fn kill(&self) {
        #[cfg(windows)]
        if let Some(job) = &self.job {
            job.terminate();
            return;
        }
        #[cfg(unix)]
        unsafe {
            libc::kill(self.pid as libc::pid_t, libc::SIGKILL);
        }
        #[cfg(windows)]
        {
            let _ = Command::new("taskkill")
                .args(["/F", "/T", "/PID", &self.pid.to_string()])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
    }
}

/// Reads `r` line by line (lossy UTF-8, CR stripped) until EOF.
fn for_each_line(r: impl Read, mut f: impl FnMut(String)) {
    let mut reader = BufReader::new(r);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                let line = String::from_utf8_lossy(&buf);
                f(line.trim_end_matches(['\n', '\r']).to_string());
            }
        }
    }
}

#[cfg(windows)]
mod win {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject, TerminateJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    /// A Job object that kills its processes when its last handle closes (when the shell exits
    /// or crashes).
    pub struct Job(HANDLE);

    // The handle is only used through thread-safe Win32 calls.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        pub fn for_child(child: &std::process::Child) -> Option<Job> {
            unsafe {
                let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if handle.is_null() {
                    crate::logs::shell("could not create a Job object for the server");
                    return None;
                }
                let job = Job(handle);
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(
                    job.0,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const core::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                ) != 0
                    && AssignProcessToJobObject(job.0, child.as_raw_handle() as HANDLE) != 0;
                if !ok {
                    crate::logs::shell("could not put the server in a Job object (the server's parent watch still applies)");
                    return None;
                }
                Some(job)
            }
        }

        pub fn terminate(&self) {
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}
