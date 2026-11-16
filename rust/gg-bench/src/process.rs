//! Child processes for the run: below normal priority, an empty standard input and a time limit.

use std::ffi::OsStr;
use std::io::{self, Read};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

/// What a tool may print before the run calls it broken, as the JavaScript runner allowed.
const MAX_OUTPUT: usize = 512 * 1024 * 1024;

/// A command below normal priority. On Unix the whole run lowered its own priority at the start,
/// which its children inherit; Windows sets it on each child, and their children inherit it.
pub fn command(program: impl AsRef<OsStr>) -> Command {
    let mut command = Command::new(program);
    below_normal(&mut command);
    command
}

#[cfg(windows)]
fn below_normal(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x0000_4000;
    command.creation_flags(BELOW_NORMAL_PRIORITY_CLASS);
}

#[cfg(not(windows))]
fn below_normal(_: &mut Command) {}

/// Modest by design: one repository at a time, below normal priority. Priority is a courtesy, so
/// a platform that refuses it changes nothing.
#[cfg(unix)]
pub fn lower_priority() {
    // SAFETY: setpriority reads only its integer arguments, and who = 0 names this process.
    // nosemgrep: rust.lang.security.unsafe-usage.unsafe-usage -- one FFI call on integers, above
    unsafe {
        libc::setpriority(libc::PRIO_PROCESS, 0, 10);
    }
}

#[cfg(not(unix))]
pub fn lower_priority() {}

pub struct Output {
    pub status: ExitStatus,
    pub stdout: String,
    pub stderr: String,
}

/// Reads a child's stream on its own thread, so neither pipe fills and blocks the child, and stops
/// past `cap` bytes, setting `over`, as Node's `maxBuffer` does.
fn drain(
    stream: Option<impl Read + Send + 'static>,
    cap: usize,
    over: Arc<AtomicBool>,
) -> thread::JoinHandle<io::Result<Vec<u8>>> {
    thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(stream) = stream {
            stream.take(cap as u64 + 1).read_to_end(&mut bytes)?;
            if bytes.len() > cap {
                over.store(true, Ordering::Relaxed);
            }
        }
        Ok(bytes)
    })
}

/// The exit status, or none when the time ran out or a stream passed its cap and the child was
/// stopped.
fn wait(child: &mut Child, timeout: Duration, over: &AtomicBool) -> io::Result<Option<ExitStatus>> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(Some(status));
        }
        if over.load(Ordering::Relaxed) || Instant::now() >= deadline {
            // A child that exits just before this is still stopped without an error: std's
            // kill returns Ok for a process that has terminated, and on Unix it is not yet reaped.
            child.kill()?;
            child.wait()?;
            return Ok(None);
        }
        thread::sleep(Duration::from_millis(20));
    }
}

fn joined(handle: thread::JoinHandle<io::Result<Vec<u8>>>) -> io::Result<Vec<u8>> {
    handle
        .join()
        .unwrap_or_else(|_| Err(io::Error::other("the reader thread panicked")))
}

/// Runs the command to its end with an empty standard input, and stops it once `timeout` passes
/// or it prints over 512 MiB on either stream. Those 2 errors read as Node's `spawnSync` put them.
pub fn output(command: &mut Command, timeout: Duration) -> Result<Output, String> {
    capped_output(command, timeout, MAX_OUTPUT)
}

fn capped_output(command: &mut Command, timeout: Duration, cap: usize) -> Result<Output, String> {
    let program = command.get_program().to_string_lossy().into_owned();
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    drop(child.stdin.take());
    let over = Arc::new(AtomicBool::new(false));
    let (stdout, stderr) = (
        drain(child.stdout.take(), cap, Arc::clone(&over)),
        drain(child.stderr.take(), cap, Arc::clone(&over)),
    );
    let status = wait(&mut child, timeout, &over).map_err(|e| e.to_string())?;
    if over.load(Ordering::Relaxed) {
        return Err(format!("spawnSync {program} ENOBUFS"));
    }
    let Some(status) = status else {
        return Err(format!("spawnSync {program} ETIMEDOUT"));
    };
    let (stdout, stderr) = (
        joined(stdout).map_err(|e| e.to_string())?,
        joined(stderr).map_err(|e| e.to_string())?,
    );
    if over.load(Ordering::Relaxed) {
        return Err(format!("spawnSync {program} ENOBUFS"));
    }
    Ok(Output {
        status,
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_child_printing_past_the_cap_on_stderr_is_stopped_at_once() {
        let started = Instant::now();
        let err = capped_output(
            Command::new("node").args([
                "-e",
                "process.stderr.write('x'.repeat(65536)); setTimeout(() => {}, 60000)",
            ]),
            Duration::from_secs(60),
            1024,
        )
        .err()
        .unwrap();
        assert_eq!(err, "spawnSync node ENOBUFS");
        assert!(
            started.elapsed() < Duration::from_secs(30),
            "{:?}",
            started.elapsed()
        );
    }

    #[test]
    fn a_child_printing_past_the_cap_is_stopped_at_once() {
        // Prints 64 KiB, then would run for a minute: the cap, not the time limit, must end it.
        let mut node = Command::new("node");
        node.args([
            "-e",
            "process.stdout.write('x'.repeat(65536)); setTimeout(() => {}, 60000)",
        ]);
        let started = Instant::now();
        let err = capped_output(&mut node, Duration::from_secs(60), 1024)
            .err()
            .unwrap();
        assert_eq!(err, "spawnSync node ENOBUFS");
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "{:?}",
            started.elapsed()
        );
    }

    #[test]
    fn a_child_past_its_time_reads_as_node_put_it() {
        let mut node = Command::new("node");
        node.args(["-e", "setTimeout(() => {}, 60000)"]);
        let err = capped_output(&mut node, Duration::from_millis(300), MAX_OUTPUT)
            .err()
            .unwrap();
        assert_eq!(err, "spawnSync node ETIMEDOUT");
    }

    #[test]
    fn output_at_the_cap_is_kept() {
        let mut node = Command::new("node");
        node.args(["-e", "process.stdout.write('x'.repeat(1024))"]);
        let out = capped_output(&mut node, Duration::from_secs(60), 1024).unwrap();
        assert_eq!(out.stdout.len(), 1024);
    }
}
