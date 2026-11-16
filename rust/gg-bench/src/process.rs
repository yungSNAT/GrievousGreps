//! Child processes for the run: below normal priority, an empty standard input and a time limit.

use std::ffi::OsStr;
use std::io::{self, Read};
use std::process::{Child, Command, ExitStatus, Stdio};
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

/// Reads a child's stream to its end on its own thread, so neither pipe fills and blocks the child.
fn drain(stream: Option<impl Read + Send + 'static>) -> thread::JoinHandle<io::Result<Vec<u8>>> {
    thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(mut stream) = stream {
            stream.read_to_end(&mut bytes)?;
        }
        Ok(bytes)
    })
}

/// The exit status, or none when the time ran out and the child was stopped.
fn wait(child: &mut Child, timeout: Duration) -> io::Result<Option<ExitStatus>> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(Some(status));
        }
        if Instant::now() >= deadline {
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

/// Runs the command to its end with an empty standard input, and stops it once `timeout` passes.
pub fn output(command: &mut Command, timeout: Duration) -> Result<Output, String> {
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    drop(child.stdin.take());
    let (stdout, stderr) = (drain(child.stdout.take()), drain(child.stderr.take()));
    let Some(status) = wait(&mut child, timeout).map_err(|e| e.to_string())? else {
        return Err(format!(
            "no answer within {} minutes",
            timeout.as_secs() / 60
        ));
    };
    let (stdout, stderr) = (
        joined(stdout).map_err(|e| e.to_string())?,
        joined(stderr).map_err(|e| e.to_string())?,
    );
    if stdout.len() > MAX_OUTPUT || stderr.len() > MAX_OUTPUT {
        return Err("printed over 512 MiB".to_owned());
    }
    Ok(Output {
        status,
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
    })
}
