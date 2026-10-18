//! The sole product file-content read boundary. Root handles anchor no-follow opens.
use crate::{credentials::is_credential_file, readers::jsonl::ReaderError};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::Read,
    path::{Component, Path, PathBuf},
};

pub const MAX_SOURCE_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_SOURCE_RECORDS: usize = 250_000;
pub struct ReadBoundary {
    roots: Vec<(PathBuf, File)>,
    /// Files refused in the order they were asked for: over a size limit, unreadable (no
    /// permission, say), or a link out of the approved folders. Module adapters that skip a file
    /// they cannot read use this so the file is reported, never dropped silently
    /// (`modules::dispatch_module_batches`; RR1-3, r2 fix round 2, added the last two).
    refused: std::sync::Mutex<Vec<(PathBuf, Refused)>>,
    /// Set by `new_for_project_roots`: the roots as given (before canonicalization). The folders
    /// that make up a root are then checked against credential stores only (.ssh, .aws and
    /// similar); every name below the root is checked in full.
    given_roots: Option<Vec<PathBuf>>,
}
thread_local! {
    /// The stop check of the import running on this thread (R-1, r2 fix round 2). Set only by
    /// `with_read_stop`; other readers (the Switchboard scan) never see one.
    static READ_STOP: std::cell::RefCell<Option<std::rc::Rc<dyn Fn() -> bool>>> =
        const { std::cell::RefCell::new(None) };
}

/// Run `f` with `stop` as this thread's read stop: once `stop` returns true, every later
/// `ReadBoundary::read` on this thread is refused with "import cancelled" before it opens the
/// file, so a stopped import finishes at most the one file it is reading. The previous stop check
/// comes back when `f` returns or panics.
pub fn with_read_stop<R>(stop: std::rc::Rc<dyn Fn() -> bool>, f: impl FnOnce() -> R) -> R {
    struct Restore(Option<std::rc::Rc<dyn Fn() -> bool>>);
    impl Drop for Restore {
        fn drop(&mut self) {
            let previous = self.0.take();
            READ_STOP.with(|cell| *cell.borrow_mut() = previous);
        }
    }
    let previous = READ_STOP.with(|cell| cell.borrow_mut().replace(stop));
    let _restore = Restore(previous);
    f()
}

fn read_stopped() -> bool {
    let stop = READ_STOP.with(|cell| cell.borrow().clone());
    stop.is_some_and(|stop| stop())
}

/// Why a read was refused, kept so the refusal can be reported after the module skipped the file.
#[derive(Debug, Clone)]
enum Refused {
    Limit(String),
    Io(std::io::ErrorKind, String),
    Outside(String),
}

impl Refused {
    /// The refusals worth reporting: a missing file (an optional -wal, -shm or wire.jsonl) and a
    /// stopped import are not.
    fn of(error: &ReaderError) -> Option<Self> {
        match error {
            ReaderError::Limit(m) => Some(Self::Limit(m.clone())),
            ReaderError::Io(e)
                if !matches!(e.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::Interrupted) =>
            {
                Some(Self::Io(e.kind(), e.to_string()))
            }
            ReaderError::Boundary(m) if m.starts_with("path outside approved source roots") => {
                Some(Self::Outside(m.clone()))
            }
            _ => None,
        }
    }
    fn error(&self) -> ReaderError {
        match self {
            Self::Limit(m) => ReaderError::Limit(m.clone()),
            Self::Io(kind, m) => ReaderError::Io(std::io::Error::new(*kind, m.clone())),
            Self::Outside(m) => ReaderError::Boundary(m.clone()),
        }
    }
}

pub struct SourceBytes {
    pub bytes: Vec<u8>,
    pub file_identity: String,
}
impl ReadBoundary {
    pub fn new(approved_roots: &[PathBuf]) -> Result<Self, ReaderError> {
        if approved_roots.is_empty() {
            return Err(ReaderError::Boundary("no approved source roots".into()));
        }
        let mut roots = vec![];
        for root in approved_roots {
            refuse_credentials(root)?;
            let canonical = root.canonicalize()?;
            refuse_credentials(&canonical)?;
            let handle = open_absolute_directory(&canonical)?;
            roots.push((canonical, handle));
        }
        Ok(Self { roots, refused: std::sync::Mutex::new(Vec::new()), given_roots: None })
    }
    /// A boundary for project folders the user works in (the Switchboard's rules and config scan,
    /// P3-1). A project folder may have any name (keychain-app, notes.pem); it is refused only when
    /// it is or sits inside a credential store such as ~/.ssh. Names below the root get the full
    /// check, links are still never followed out of the root, and opens are still no-follow.
    pub fn new_for_project_roots(approved_roots: &[PathBuf]) -> Result<Self, ReaderError> {
        if approved_roots.is_empty() {
            return Err(ReaderError::Boundary("no approved source roots".into()));
        }
        let mut roots = vec![];
        for root in approved_roots {
            refuse_credential_places(root)?;
            let canonical = root.canonicalize()?;
            refuse_credential_places(&canonical)?;
            let handle = open_absolute_directory(&canonical)?;
            roots.push((canonical, handle));
        }
        Ok(Self {
            roots,
            refused: std::sync::Mutex::new(Vec::new()),
            given_roots: Some(approved_roots.to_vec()),
        })
    }
    /// The credential check for one path: in full, or for a project boundary, in full below the
    /// root it belongs to and against credential stores above it.
    fn refuse(&self, path: &Path) -> Result<(), ReaderError> {
        let Some(given) = &self.given_roots else {
            // An agent's history folder (R-5, r2 fix round 2): the folders below it often encode a
            // project path (Claude Code's projects/-Users-dev-code-keychain-app), so they are
            // checked against credential stores only; the file name gets the full check. The
            // root itself was checked in full when the boundary was made.
            for (root, _) in &self.roots {
                if path.starts_with(root) {
                    refuse_credential_places(path)?;
                    if crate::credentials::is_credential_file(path) {
                        return Err(ReaderError::CredentialBlocked(path.display().to_string()));
                    }
                    return Ok(());
                }
            }
            return refuse_credentials(path);
        };
        let prefixes = self.roots.iter().map(|(r, _)| r).chain(given.iter());
        for root in prefixes {
            if let Ok(below) = path.strip_prefix(root) {
                refuse_credential_places(root)?;
                if crate::credentials::is_credential_file(path) {
                    return Err(ReaderError::CredentialBlocked(path.display().to_string()));
                }
                return refuse_credentials(below).map_err(|_| ReaderError::CredentialBlocked(path.display().to_string()));
            }
        }
        refuse_credentials(path)
    }
    /// The files refused since the last call (over a size limit, unreadable, or a link out of the
    /// approved folders) with the error each got, and forget them.
    pub fn take_read_refusals(&self) -> Vec<(PathBuf, ReaderError)> {
        std::mem::take(&mut *self.refused.lock().unwrap_or_else(|e| e.into_inner()))
            .into_iter()
            .map(|(path, why)| (path, why.error()))
            .collect()
    }
    pub fn read(&self, path: &Path) -> Result<SourceBytes, ReaderError> {
        if read_stopped() {
            return Err(ReaderError::Io(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "import cancelled",
            )));
        }
        let result = self.read_checked(path);
        if let Some(why) = result.as_ref().err().and_then(Refused::of) {
            self.refused
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push((path.to_path_buf(), why));
        }
        result
    }
    fn read_checked(&self, path: &Path) -> Result<SourceBytes, ReaderError> {
        self.refuse(path)?;
        // Canonicalization never opens file contents. Both names are checked before opening.
        let canonical = path.canonicalize()?;
        self.refuse(&canonical)?;
        let (root, handle) = self
            .roots
            .iter()
            .find(|(r, _)| canonical.starts_with(r))
            .ok_or_else(|| {
                ReaderError::Boundary(format!(
                    "path outside approved source roots: {}",
                    path.display()
                ))
            })?;
        let relative = canonical
            .strip_prefix(root)
            .map_err(|e| ReaderError::Boundary(e.to_string()))?;
        let mut file = open_relative(handle, relative, false)?;
        let before = file.metadata()?;
        if !before.is_file() {
            return Err(ReaderError::Boundary("source is not a regular file".into()));
        }
        if before.len() > MAX_SOURCE_BYTES {
            return Err(ReaderError::Limit("source exceeds 64 MiB".into()));
        }
        let mut bytes = vec![];
        (&mut file)
            .take(MAX_SOURCE_BYTES + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX_SOURCE_BYTES {
            return Err(ReaderError::Limit("source exceeds 64 MiB".into()));
        }
        let after = file.metadata()?;
        if before.len() != after.len()
            || before.modified()? != after.modified()?
            || bytes.len() as u64 != after.len()
        {
            return Err(ReaderError::Changed("source changed during read".into()));
        }
        #[cfg(unix)]
        let identity = {
            use std::os::unix::fs::MetadataExt;
            format!("unix:{}:{}", before.dev(), before.ino())
        };
        #[cfg(not(unix))]
        let identity = canonical.to_string_lossy().into_owned();
        Ok(SourceBytes {
            bytes,
            file_identity: identity,
        })
    }
}
pub fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn refuse_credential_places(path: &Path) -> Result<(), ReaderError> {
    for component in path.components() {
        if crate::credentials::is_credential_place(&component.as_os_str().to_string_lossy()) {
            return Err(ReaderError::CredentialBlocked(path.display().to_string()));
        }
    }
    Ok(())
}
fn refuse_credentials(path: &Path) -> Result<(), ReaderError> {
    for component in path.components() {
        if is_credential_file(Path::new(component.as_os_str())) {
            return Err(ReaderError::CredentialBlocked(path.display().to_string()));
        }
    }
    if is_credential_file(path) {
        return Err(ReaderError::CredentialBlocked(path.display().to_string()));
    }
    Ok(())
}
#[cfg(unix)]
fn open_absolute_directory(path: &Path) -> Result<File, ReaderError> {
    use std::os::unix::fs::OpenOptionsExt;
    let root = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open("/")?;
    open_relative(
        &root,
        path.strip_prefix("/")
            .map_err(|e| ReaderError::Boundary(e.to_string()))?,
        true,
    )
}
#[cfg(unix)]
fn open_relative(root: &File, path: &Path, directory: bool) -> Result<File, ReaderError> {
    use std::os::{
        fd::{AsRawFd, FromRawFd},
        unix::ffi::OsStrExt,
    };
    let components: Vec<_> = path.components().collect();
    let mut current = root.try_clone()?;
    if components.is_empty() && !directory {
        return Err(ReaderError::Boundary("source names a directory".into()));
    }
    for (index, component) in components.iter().enumerate() {
        let Component::Normal(name) = component else {
            return Err(ReaderError::Boundary("non-normal path component".into()));
        };
        let name = std::ffi::CString::new(name.as_bytes())
            .map_err(|_| ReaderError::Boundary("NUL in path".into()))?;
        let is_directory = directory || index + 1 < components.len();
        let flags = libc::O_RDONLY
            | libc::O_CLOEXEC
            | libc::O_NOFOLLOW
            | libc::O_NONBLOCK
            | if is_directory { libc::O_DIRECTORY } else { 0 };
        // SAFETY: name is NUL-terminated, the directory descriptor remains owned,
        // and the returned descriptor is transferred to exactly one File.
        let fd = unsafe { libc::openat(current.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        current = unsafe { File::from_raw_fd(fd) };
    }
    Ok(current)
}
#[cfg(not(unix))]
fn open_absolute_directory(_: &Path) -> Result<File, ReaderError> {
    Err(ReaderError::Boundary(
        "secure source reads require a native no-follow boundary on this platform".into(),
    ))
}
#[cfg(not(unix))]
fn open_relative(_: &File, _: &Path, _: bool) -> Result<File, ReaderError> {
    Err(ReaderError::Boundary(
        "secure source reads unavailable on this platform".into(),
    ))
}
