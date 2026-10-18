//! Explicit opt-in probes. Discovery never calls this API.
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};
#[derive(Debug, thiserror::Error)]
pub enum ProbeError {
    #[error("version probe path is not an explicitly trusted resolved executable")]
    Untrusted,
    #[error("version probe timed out")]
    Timeout,
    #[error("version probe output exceeded cap")]
    OutputLimit,
    #[error("version probe failed: {0}")]
    Io(#[from] std::io::Error),
}
/// The caller's allowlist contains exact canonical paths, never PATH directories.
pub fn probe_trusted_version(
    path: &Path,
    trusted: &[PathBuf],
    args: &[String],
    timeout: Duration,
    output_cap: usize,
) -> Result<Option<String>, ProbeError> {
    if timeout.is_zero()
        || timeout > Duration::from_secs(5)
        || output_cap == 0
        || output_cap > 64 * 1024
    {
        return Err(ProbeError::Untrusted);
    }
    let canonical = path.canonicalize()?;
    if !path.is_absolute()
        || canonical != path
        || !trusted.iter().any(|p| p == &canonical)
        || !fs::metadata(path)?.is_file()
    {
        return Err(ProbeError::Untrusted);
    }
    let mut command = Command::new(&canonical);
    command
        .args(args)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn()?;
    let mut stdout = child.stdout.take().unwrap();
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        // SAFETY: stdout owns a valid pipe descriptor throughout this scope.
        let fd = stdout.as_raw_fd();
        let current = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        if current < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, current | libc::O_NONBLOCK) } < 0
        {
            let _ = child.kill();
            let _ = child.wait();
            return Err(std::io::Error::last_os_error().into());
        }
    }
    #[cfg(not(unix))]
    {
        let _ = child.kill();
        let _ = child.wait();
        return Err(ProbeError::Untrusted);
    }
    let kill = |child: &mut std::process::Child| {
        #[cfg(unix)]
        unsafe {
            libc::kill(-(child.id() as i32), libc::SIGKILL);
        }
        let _ = child.kill();
        let _ = child.wait();
    };
    let started = Instant::now();
    let mut output = Vec::new();
    let mut buf = [0_u8; 4096];
    loop {
        // A continuous stream cannot evade the deadline.
        if started.elapsed() >= timeout {
            kill(&mut child);
            return Err(ProbeError::Timeout);
        }
        match stdout.read(&mut buf) {
            Ok(n) if n > 0 => {
                if output.len() + n > output_cap {
                    kill(&mut child);
                    return Err(ProbeError::OutputLimit);
                }
                output.extend_from_slice(&buf[..n]);
            }
            Ok(_) => {
                if let Some(status) = child.try_wait()? {
                    kill(&mut child);
                    if !status.success() {
                        return Ok(None);
                    }
                    break;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if child.try_wait()?.is_some() { /* drain until EOF */ }
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(e) => {
                kill(&mut child);
                return Err(e.into());
            }
        }
    }
    let text = String::from_utf8_lossy(&output);
    Ok(regex::Regex::new(r"\d+\.\d+\.\d+")
        .unwrap()
        .find(&text)
        .map(|m| m.as_str().into()))
}
