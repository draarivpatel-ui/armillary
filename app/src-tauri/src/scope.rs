//! Home-scoped detection: `ARMILLARY_DETECT_SCOPE=home` confines agent detection and
//! discovery to the HOME folder, so a run with a temporary HOME holding synthetic data never
//! sees this machine's real installed apps (PATH entries, /Applications, CODEX_HOME and so on).
//!
//! Callers that detect or discover agents take their `Environment` and `FileSystem` from
//! [`detection_env`] instead of building `SystemEnvironment` / `SystemFileSystem` directly:
//! `agents_list`, `launch.rs` discovery, `import_now`'s lazy discovery, and (outside this
//! crate stream) the first-run flow in firstrun.rs, the presentation exporter and the SNAP
//! capture runner.
//!
//! This file is compiled into the app and, through `archive_api.rs`, into the integration
//! tests that include that file with `#[path]`, so it depends only on the adapters crate.

use orrery_adapters::env::{Environment, FileSystem, SystemEnvironment, SystemFileSystem, TargetOs};
use std::io;
use std::path::{Path, PathBuf};

/// Name of the switch. Only the value `home` (any ASCII case, surrounding whitespace ignored)
/// turns the scope on; anything else, including an unset variable, leaves detection unscoped.
pub const SCOPE_VAR: &str = "ARMILLARY_DETECT_SCOPE";

pub fn home_scope_from(value: Option<&str>) -> bool {
    value.map(|v| v.trim().eq_ignore_ascii_case("home")).unwrap_or(false)
}

/// Resolve `.` and `..` without touching the disk. Only absolute paths qualify: a relative
/// path has no place under the home folder, so it yields `None`. A `..` at the root stays at
/// the root, as the operating system does.
fn normalize(path: &Path) -> Option<PathBuf> {
    use std::path::Component;
    if !path.is_absolute() {
        return None;
    }
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(_) | Component::RootDir => out.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                if matches!(out.components().next_back(), Some(Component::Normal(_))) {
                    out.pop();
                }
            }
            Component::Normal(name) => out.push(name),
        }
    }
    Some(out)
}

/// True when `path` is absolute and, once `.` and `..` are resolved, lies at or under `home`.
/// Comparison is component-wise, so a trailing separator or a sibling such as `home2` cannot
/// confuse it.
fn lexically_under(path: &Path, home: &Path) -> bool {
    match (normalize(path), normalize(home)) {
        (Some(p), Some(h)) => p.starts_with(h),
        _ => false,
    }
}

/// An `Environment` that only reveals the HOME folder, PATH entries under it, and variables
/// whose value is an absolute path under it.
pub struct HomeScopedEnvironment<E> {
    home: PathBuf,
    inner: E,
}

impl<E: Environment> HomeScopedEnvironment<E> {
    pub fn new(home: PathBuf, inner: E) -> Self {
        Self { home, inner }
    }

    /// The PATH entries (in order) that lie under the home folder.
    pub fn scoped_path_entries(&self) -> Vec<PathBuf> {
        let Some(raw) = self.inner.var("PATH") else {
            return Vec::new();
        };
        std::env::split_paths(&raw)
            .filter(|entry| lexically_under(entry, &self.home))
            .collect()
    }
}

impl<E: Environment> Environment for HomeScopedEnvironment<E> {
    fn os(&self) -> TargetOs {
        self.inner.os()
    }

    fn var(&self, key: &str) -> Option<String> {
        match key {
            "HOME" | "USERPROFILE" => Some(self.home.to_string_lossy().to_string()),
            "PATH" => {
                let entries = self.scoped_path_entries();
                if entries.is_empty() {
                    return None;
                }
                std::env::join_paths(entries)
                    .ok()
                    .map(|joined| joined.to_string_lossy().to_string())
            }
            other => self
                .inner
                .var(other)
                .filter(|value| lexically_under(Path::new(value), &self.home)),
        }
    }

    fn home_dir(&self) -> Option<PathBuf> {
        Some(self.home.clone())
    }
}

/// A `FileSystem` that answers only for paths under the home folder.
pub struct HomeScopedFileSystem<F> {
    home: PathBuf,
    path_dirs: Vec<PathBuf>,
    inner: F,
}

impl<F: FileSystem> HomeScopedFileSystem<F> {
    pub fn new(home: PathBuf, path_dirs: Vec<PathBuf>, inner: F) -> Self {
        Self { home, path_dirs, inner }
    }

    /// A path is inside when it is lexically under the home (against the home as given or as
    /// canonicalized) AND its canonical form, which follows symlinks, is under the canonical
    /// home. A path that cannot be canonicalized does not exist, so it is not answered.
    fn inside(&self, path: &Path) -> bool {
        let Some(norm_home) = normalize(&self.home) else {
            return false;
        };
        let canon_home = self.home.canonicalize().unwrap_or_else(|_| norm_home.clone());
        let Some(norm_path) = normalize(path) else {
            return false;
        };
        if !(norm_path.starts_with(&norm_home) || norm_path.starts_with(&canon_home)) {
            return false;
        }
        match path.canonicalize() {
            Ok(canonical) => canonical.starts_with(&canon_home),
            Err(_) => false,
        }
    }
}

impl<F: FileSystem> FileSystem for HomeScopedFileSystem<F> {
    fn exists(&self, path: &Path) -> bool {
        self.inside(path) && self.inner.exists(path)
    }

    fn is_file(&self, path: &Path) -> bool {
        self.inside(path) && self.inner.is_file(path)
    }

    fn is_dir(&self, path: &Path) -> bool {
        self.inside(path) && self.inner.is_dir(path)
    }

    fn read_dir(&self, path: &Path) -> Result<Vec<PathBuf>, io::Error> {
        if self.inside(path) {
            self.inner.read_dir(path)
        } else {
            Err(io::Error::new(
                io::ErrorKind::NotFound,
                "path is outside the home scope",
            ))
        }
    }

    fn which(&self, binary: &str) -> Option<PathBuf> {
        // A binary name is one plain path segment; anything else could leave the search folders.
        let mut parts = Path::new(binary).components();
        match (parts.next(), parts.next()) {
            (Some(std::path::Component::Normal(_)), None) => {}
            _ => return None,
        }
        for dir in &self.path_dirs {
            let candidate = dir.join(binary);
            if self.is_file(&candidate) {
                return Some(candidate);
            }
            #[cfg(windows)]
            {
                let candidate_exe = dir.join(format!("{}.exe", binary));
                if self.is_file(&candidate_exe) {
                    return Some(candidate_exe);
                }
            }
        }
        None
    }

    fn version_of(&self, _binary_path: &Path, _args: &[String]) -> Option<String> {
        // Detection is passive: nothing is ever run to ask for a version.
        None
    }
}

/// Pure core of [`detection_env`]: the scoped pair when `scope_value` asks for it and the
/// environment knows a home folder, otherwise the given pair unchanged.
pub fn detection_pair<E, F>(
    scope_value: Option<&str>,
    env: E,
    fs: F,
) -> (Box<dyn Environment>, Box<dyn FileSystem>)
where
    E: Environment + 'static,
    F: FileSystem + 'static,
{
    if home_scope_from(scope_value) {
        if let Some(home) = env.home_dir() {
            // A HOME reached through a symlink (macOS /tmp) is scoped by its canonical form, so
            // the paths expanded from it agree with the canonical paths discovery and import see.
            let home = home.canonicalize().unwrap_or(home);
            let scoped_env = HomeScopedEnvironment::new(home.clone(), env);
            let path_dirs = scoped_env.scoped_path_entries();
            let scoped_fs = HomeScopedFileSystem::new(home, path_dirs, fs);
            return (Box::new(scoped_env), Box::new(scoped_fs));
        }
    }
    (Box::new(env), Box::new(fs))
}

/// The environment and file system every detection or discovery call should use.
pub fn detection_env() -> (Box<dyn Environment>, Box<dyn FileSystem>) {
    detection_pair(
        std::env::var(SCOPE_VAR).ok().as_deref(),
        SystemEnvironment,
        SystemFileSystem,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use orrery_adapters::env::{MockEnvironment, MockFileSystem};
    use std::fs;
    use tempfile::{tempdir, TempDir};

    fn path_list(entries: &[&Path]) -> String {
        std::env::join_paths(entries.iter().map(|p| p.as_os_str()))
            .unwrap()
            .to_string_lossy()
            .to_string()
    }

    /// A temporary HOME plus a second, unrelated folder that stands for "elsewhere on this Mac".
    fn home_and_outside() -> (TempDir, TempDir) {
        (tempdir().unwrap(), tempdir().unwrap())
    }

    fn scoped_env(home: &Path, path_var: &str) -> HomeScopedEnvironment<MockEnvironment> {
        // The inner environment deliberately has a different HOME than the scoped one.
        let inner = MockEnvironment::new(TargetOs::current(), "/Users/someone-else")
            .with_var("PATH", path_var);
        HomeScopedEnvironment::new(home.to_path_buf(), inner)
    }

    fn scoped_fs(home: &Path, env: &HomeScopedEnvironment<MockEnvironment>) -> HomeScopedFileSystem<orrery_adapters::env::SystemFileSystem> {
        HomeScopedFileSystem::new(
            home.to_path_buf(),
            env.scoped_path_entries(),
            orrery_adapters::env::SystemFileSystem,
        )
    }

    #[test]
    fn scope_value_parsing_accepts_only_home() {
        assert!(home_scope_from(Some("home")));
        assert!(home_scope_from(Some("HOME")));
        assert!(home_scope_from(Some("  Home \n")));
        assert!(!home_scope_from(None));
        assert!(!home_scope_from(Some("")));
        assert!(!home_scope_from(Some("all")));
        assert!(!home_scope_from(Some("homes")));
        assert!(!home_scope_from(Some("off")));
        assert!(!home_scope_from(Some("1")));
    }

    #[test]
    fn home_variables_and_home_dir_are_the_scoped_home() {
        let (home, _outside) = home_and_outside();
        let env = scoped_env(home.path(), "");
        assert_eq!(env.home_dir(), Some(home.path().to_path_buf()));
        let want = home.path().to_string_lossy().to_string();
        assert_eq!(env.var("HOME"), Some(want.clone()));
        assert_eq!(env.var("USERPROFILE"), Some(want));
        assert_eq!(env.os(), TargetOs::current());
    }

    #[test]
    fn path_keeps_entries_under_home_and_drops_the_rest() {
        let (home, outside) = home_and_outside();
        let local_bin = home.path().join(".local/bin");
        let bin_slash = PathBuf::from(format!("{}/bin/", home.path().display()));
        let sibling = PathBuf::from(format!("{}2/bin", home.path().display()));
        let escaping = home.path().join("../elsewhere/bin");
        let outside_bin = outside.path().join("bin");
        let usr_bin = PathBuf::from("/usr/bin");
        let relative = PathBuf::from("relative/bin");
        let raw = path_list(&[
            &usr_bin,
            &local_bin,
            &outside_bin,
            &bin_slash,
            &sibling,
            &escaping,
            &relative,
        ]);
        let env = scoped_env(home.path(), &raw);
        let kept = env.scoped_path_entries();
        assert_eq!(kept, vec![local_bin.clone(), bin_slash.clone()]);
        let joined = env.var("PATH").expect("two entries remain");
        let split: Vec<PathBuf> = std::env::split_paths(&joined).collect();
        assert_eq!(split, kept);
    }

    #[test]
    fn path_is_none_when_nothing_lies_under_home() {
        let (home, _outside) = home_and_outside();
        let env = scoped_env(home.path(), &path_list(&[Path::new("/usr/bin"), Path::new("/bin")]));
        assert_eq!(env.var("PATH"), None);
        assert!(env.scoped_path_entries().is_empty());
        // No PATH at all behaves the same.
        let bare = HomeScopedEnvironment::new(
            home.path().to_path_buf(),
            MockEnvironment::new(TargetOs::current(), "/Users/someone-else"),
        );
        assert_eq!(bare.var("PATH"), None);
    }

    #[test]
    fn other_variables_survive_only_as_absolute_paths_under_home() {
        let (home, outside) = home_and_outside();
        let inside_codex = home.path().join(".codex");
        let inner = MockEnvironment::new(TargetOs::current(), "/Users/someone-else")
            .with_var("CODEX_HOME", &outside.path().to_string_lossy())
            .with_var("GOOSE_PATH_ROOT", &inside_codex.to_string_lossy())
            .with_var("APPDATA", "/Users/someone-else/AppData/Roaming")
            .with_var("RELATIVE_THING", "some/relative/dir")
            .with_var("PLAIN_TEXT", "hello")
            .with_var("ESCAPE", &format!("{}/../elsewhere", home.path().display()));
        let env = HomeScopedEnvironment::new(home.path().to_path_buf(), inner);
        assert_eq!(env.var("CODEX_HOME"), None);
        assert_eq!(
            env.var("GOOSE_PATH_ROOT"),
            Some(inside_codex.to_string_lossy().to_string())
        );
        assert_eq!(env.var("APPDATA"), None);
        assert_eq!(env.var("RELATIVE_THING"), None);
        assert_eq!(env.var("PLAIN_TEXT"), None);
        assert_eq!(env.var("ESCAPE"), None);
        assert_eq!(env.var("NOT_SET_ANYWHERE"), None);
    }

    #[test]
    fn exists_is_false_outside_home_even_when_the_path_is_real() {
        let (home, outside) = home_and_outside();
        let env = scoped_env(home.path(), "");
        let fs = scoped_fs(home.path(), &env);
        let real_elsewhere = outside.path().join("agent.txt");
        fs::write(&real_elsewhere, b"x").unwrap();
        // Precondition: the plain file system does see it.
        assert!(real_elsewhere.exists());
        assert!(!fs.exists(&real_elsewhere));
        assert!(!fs.is_file(&real_elsewhere));
        assert!(!fs.is_dir(outside.path()));
        #[cfg(target_os = "macos")]
        {
            assert!(Path::new("/Applications").exists(), "precondition on macOS");
            assert!(!fs.exists(Path::new("/Applications")));
            assert!(!fs.is_dir(Path::new("/Applications")));
        }
        // Inside the home everything is answered normally.
        let inside = home.path().join("notes.txt");
        fs::write(&inside, b"x").unwrap();
        fs::create_dir(home.path().join("dir")).unwrap();
        assert!(fs.exists(&inside));
        assert!(fs.is_file(&inside));
        assert!(!fs.is_dir(&inside));
        assert!(fs.is_dir(&home.path().join("dir")));
        assert!(fs.exists(home.path()));
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_inside_home_that_points_outside_is_outside() {
        let (home, outside) = home_and_outside();
        let target_dir = outside.path().join("real-data");
        fs::create_dir(&target_dir).unwrap();
        fs::write(target_dir.join("session.json"), b"{}").unwrap();
        let link = home.path().join("linked");
        std::os::unix::fs::symlink(&target_dir, &link).unwrap();
        let file_link = home.path().join("linked-file");
        std::os::unix::fs::symlink(target_dir.join("session.json"), &file_link).unwrap();
        // Precondition: the plain file system follows both links.
        assert!(link.is_dir());
        assert!(file_link.is_file());

        let env = scoped_env(home.path(), "");
        let fs_ = scoped_fs(home.path(), &env);
        assert!(!fs_.exists(&link));
        assert!(!fs_.is_dir(&link));
        assert!(!fs_.exists(&link.join("session.json")));
        assert!(!fs_.exists(&file_link));
        assert!(!fs_.is_file(&file_link));
        assert!(fs_.read_dir(&link).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_inside_home_that_stays_inside_is_inside() {
        let (home, _outside) = home_and_outside();
        let real = home.path().join("real");
        fs::create_dir(&real).unwrap();
        fs::write(real.join("a.txt"), b"x").unwrap();
        std::os::unix::fs::symlink(&real, home.path().join("alias")).unwrap();
        let env = scoped_env(home.path(), "");
        let fs_ = scoped_fs(home.path(), &env);
        assert!(fs_.is_dir(&home.path().join("alias")));
        assert!(fs_.is_file(&home.path().join("alias/a.txt")));
    }

    #[test]
    fn dot_dot_that_climbs_out_of_home_is_refused() {
        let (home, outside) = home_and_outside();
        let env = scoped_env(home.path(), "");
        let fs_ = scoped_fs(home.path(), &env);
        let outside_file = outside.path().join("secret.txt");
        fs::write(&outside_file, b"x").unwrap();
        let outside_name = outside.path().file_name().unwrap().to_string_lossy().to_string();

        // Enough ".." to reach the filesystem root (extra ones at the root stay at the root),
        // then down to the real outside file.
        let mut climbing = home.path().to_path_buf();
        for _ in 0..40 {
            climbing.push("..");
        }
        let climbing = climbing.join(outside_file.strip_prefix("/").unwrap());
        assert!(climbing.exists(), "precondition: the climbing path reaches a real file");
        assert!(!fs_.exists(&climbing));
        assert!(!fs_.is_file(&climbing));

        let sibling_route = home
            .path()
            .parent()
            .unwrap()
            .join(&outside_name)
            .join("secret.txt");
        // A plain "up one, then in" path, only meaningful when the folders share a parent.
        if sibling_route.exists() {
            let via_dots = home.path().join("..").join(&outside_name).join("secret.txt");
            assert!(via_dots.exists());
            assert!(!fs_.exists(&via_dots));
        }

        // ".." that stays inside is fine.
        fs::create_dir_all(home.path().join("a/b")).unwrap();
        fs::write(home.path().join("a/file.txt"), b"x").unwrap();
        assert!(fs_.is_file(&home.path().join("a/b/../file.txt")));
        assert!(fs_.is_file(&home.path().join("./a/./file.txt")));
        // A relative path can never be inside the home.
        assert!(!fs_.exists(Path::new("a/file.txt")));
    }

    #[test]
    fn read_dir_works_inside_home_and_errors_outside() {
        let (home, outside) = home_and_outside();
        fs::write(home.path().join("one.txt"), b"x").unwrap();
        fs::write(outside.path().join("two.txt"), b"x").unwrap();
        let env = scoped_env(home.path(), "");
        let fs_ = scoped_fs(home.path(), &env);
        let listed = fs_.read_dir(home.path()).expect("home is readable");
        assert_eq!(listed, vec![home.path().join("one.txt")]);
        let err = fs_.read_dir(outside.path()).expect_err("outside must fail");
        assert_eq!(err.kind(), io::ErrorKind::NotFound);
        let err = fs_.read_dir(Path::new("/")).expect_err("root must fail");
        assert_eq!(err.kind(), io::ErrorKind::NotFound);
    }

    #[test]
    fn which_searches_only_the_scoped_path_directories() {
        let (home, outside) = home_and_outside();
        let home_bin = home.path().join("bin");
        let outside_bin = outside.path().join("bin");
        fs::create_dir(&home_bin).unwrap();
        fs::create_dir(&outside_bin).unwrap();
        fs::write(home_bin.join("inhome-tool"), b"x").unwrap();
        fs::write(outside_bin.join("outside-tool"), b"x").unwrap();
        fs::write(outside_bin.join("inhome-tool"), b"x").unwrap();

        // Both folders are on the "real" PATH-like list; only the home one survives.
        let raw = path_list(&[&outside_bin, &home_bin]);
        let env = scoped_env(home.path(), &raw);
        let fs_ = scoped_fs(home.path(), &env);
        assert_eq!(fs_.which("inhome-tool"), Some(home_bin.join("inhome-tool")));
        assert_eq!(fs_.which("outside-tool"), None);
        assert_eq!(fs_.which("definitely-not-installed-anywhere"), None);
        // Names that try to leave the search folders are refused.
        assert_eq!(fs_.which("../outside-tool"), None);
        assert_eq!(fs_.which(""), None);
        // A directory with the binary's name is not a binary.
        fs::create_dir(home_bin.join("a-directory")).unwrap();
        assert_eq!(fs_.which("a-directory"), None);
    }

    #[test]
    fn which_refuses_a_path_dir_outside_home_even_if_handed_one() {
        let (home, outside) = home_and_outside();
        let outside_bin = outside.path().join("bin");
        fs::create_dir(&outside_bin).unwrap();
        fs::write(outside_bin.join("tool"), b"x").unwrap();
        let fs_ = HomeScopedFileSystem::new(
            home.path().to_path_buf(),
            vec![outside_bin.clone()],
            orrery_adapters::env::SystemFileSystem,
        );
        assert_eq!(fs_.which("tool"), None);
    }

    #[test]
    fn version_of_is_always_none() {
        let (home, _outside) = home_and_outside();
        let bin = home.path().join("tool");
        fs::write(&bin, b"x").unwrap();
        let env = scoped_env(home.path(), "");
        let fs_ = scoped_fs(home.path(), &env);
        assert_eq!(fs_.version_of(&bin, &["--version".to_string()]), None);
    }

    #[test]
    fn detect_agent_sees_a_synthetic_install_under_home_only() {
        use orrery_adapters::{builtin_adapters, detect_agent};

        let adapter = builtin_adapters()
            .into_iter()
            .find(|a| !a.detection.binaries.is_empty())
            .expect("a builtin adapter with a detection binary");
        let binary = adapter.detection.binaries[0].clone();

        // 1. Binary staged under HOME/.local/bin, PATH names that folder.
        let (home, outside) = home_and_outside();
        let local_bin = home.path().join(".local/bin");
        fs::create_dir_all(&local_bin).unwrap();
        fs::write(local_bin.join(&binary), b"#!/bin/sh\n").unwrap();
        let outside_bin = outside.path().join("bin");
        fs::create_dir(&outside_bin).unwrap();
        let raw = path_list(&[&outside_bin, &local_bin, Path::new("/usr/bin")]);
        let env = scoped_env(home.path(), &raw);
        let fs_ = scoped_fs(home.path(), &env);
        let found = detect_agent(&adapter, &env, &fs_);
        assert!(found.installed, "a binary under HOME/.local/bin must be detected");

        // 2. Same binary staged only outside HOME, with the outside folder on the PATH list.
        let (home2, outside2) = home_and_outside();
        let outside_bin2 = outside2.path().join("bin");
        fs::create_dir(&outside_bin2).unwrap();
        fs::write(outside_bin2.join(&binary), b"#!/bin/sh\n").unwrap();
        assert!(outside_bin2.join(&binary).is_file(), "precondition");
        let raw2 = path_list(&[&outside_bin2, Path::new("/usr/bin")]);
        let env2 = scoped_env(home2.path(), &raw2);
        let fs2 = scoped_fs(home2.path(), &env2);
        let absent = detect_agent(&adapter, &env2, &fs2);
        assert!(!absent.installed, "a binary outside HOME must not be detected");
        assert!(absent.data_paths.is_empty());
    }

    #[test]
    fn detection_pair_scopes_only_when_asked_and_a_home_is_known() {
        let mut mock_fs = MockFileSystem::new();
        mock_fs.add_binary("claude", PathBuf::from("/usr/local/bin/claude"));
        let make_env = || MockEnvironment::new(TargetOs::current(), "/Users/synthetic");

        // Unscoped: the pair is passed through untouched.
        for value in [None, Some(""), Some("all")] {
            let (env, fs_) = detection_pair(value, make_env(), mock_fs.clone());
            assert_eq!(fs_.which("claude"), Some(PathBuf::from("/usr/local/bin/claude")));
            assert_eq!(env.home_dir(), Some(PathBuf::from("/Users/synthetic")));
        }

        // Scoped: the mock binary outside the home is invisible.
        let (env, fs_) = detection_pair(Some("home"), make_env(), mock_fs.clone());
        assert_eq!(fs_.which("claude"), None);
        assert!(!fs_.exists(Path::new("/usr/local/bin/claude")));
        assert_eq!(env.home_dir(), Some(PathBuf::from("/Users/synthetic")));
        assert_eq!(env.var("HOME"), Some("/Users/synthetic".to_string()));

        // Scope asked for but no home is known: fall back to the plain pair rather than an
        // empty one (documented: nothing to confine to).
        let mut homeless = make_env();
        homeless.home = None;
        let (_env, fs_) = detection_pair(Some("home"), homeless, mock_fs);
        assert_eq!(fs_.which("claude"), Some(PathBuf::from("/usr/local/bin/claude")));
    }
}
