use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TargetOs {
    Macos,
    Linux,
    Windows,
}

impl TargetOs {
    pub fn current() -> Self {
        #[cfg(target_os = "macos")]
        return TargetOs::Macos;
        #[cfg(target_os = "windows")]
        return TargetOs::Windows;
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        return TargetOs::Linux;
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            TargetOs::Macos => "macos",
            TargetOs::Linux => "linux",
            TargetOs::Windows => "windows",
        }
    }
}

pub trait Environment: Send + Sync {
    fn os(&self) -> TargetOs;
    fn var(&self, key: &str) -> Option<String>;
    fn home_dir(&self) -> Option<PathBuf>;
}

pub trait FileSystem: Send + Sync {
    fn exists(&self, path: &Path) -> bool;
    fn is_file(&self, path: &Path) -> bool;
    fn is_dir(&self, path: &Path) -> bool;
    fn read_dir(&self, path: &Path) -> Result<Vec<PathBuf>, std::io::Error>;
    fn which(&self, binary: &str) -> Option<PathBuf>;
    fn version_of(&self, binary_path: &Path, args: &[String]) -> Option<String>;
}

pub struct SystemEnvironment;

impl Environment for SystemEnvironment {
    fn os(&self) -> TargetOs {
        TargetOs::current()
    }

    fn var(&self, key: &str) -> Option<String> {
        std::env::var(key).ok()
    }

    fn home_dir(&self) -> Option<PathBuf> {
        std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .ok()
            .map(PathBuf::from)
    }
}

pub struct SystemFileSystem;

impl FileSystem for SystemFileSystem {
    fn exists(&self, path: &Path) -> bool {
        path.exists()
    }

    fn is_file(&self, path: &Path) -> bool {
        path.is_file()
    }

    fn is_dir(&self, path: &Path) -> bool {
        path.is_dir()
    }

    fn read_dir(&self, path: &Path) -> Result<Vec<PathBuf>, std::io::Error> {
        let mut entries = Vec::new();
        for entry in std::fs::read_dir(path)? {
            let entry = entry?;
            entries.push(entry.path());
        }
        Ok(entries)
    }

    fn which(&self, binary: &str) -> Option<PathBuf> {
        if let Ok(path_var) = std::env::var("PATH") {
            let sep = if cfg!(windows) { ';' } else { ':' };
            for dir in path_var.split(sep) {
                let candidate = Path::new(dir).join(binary);
                if candidate.is_file() {
                    return Some(candidate);
                }
                #[cfg(windows)]
                {
                    let candidate_exe = Path::new(dir).join(format!("{}.exe", binary));
                    if candidate_exe.is_file() {
                        return Some(candidate_exe);
                    }
                }
            }
        }
        None
    }

    fn version_of(&self, _binary_path: &Path, _args: &[String]) -> Option<String> {
        // Compatibility method is passive. Use probe_trusted_version explicitly.
        None
    }
}

#[derive(Debug, Clone)]
pub struct MockEnvironment {
    pub os: TargetOs,
    pub env_vars: HashMap<String, String>,
    pub home: Option<PathBuf>,
}

impl MockEnvironment {
    pub fn new(os: TargetOs, home: &str) -> Self {
        let mut env_vars = HashMap::new();
        match os {
            TargetOs::Windows => {
                env_vars.insert("USERPROFILE".to_string(), home.to_string());
                env_vars.insert("APPDATA".to_string(), format!("{}\\AppData\\Roaming", home));
                env_vars.insert(
                    "LOCALAPPDATA".to_string(),
                    format!("{}\\AppData\\Local", home),
                );
            }
            TargetOs::Macos | TargetOs::Linux => {
                env_vars.insert("HOME".to_string(), home.to_string());
            }
        }
        Self {
            os,
            env_vars,
            home: Some(PathBuf::from(home)),
        }
    }

    pub fn with_var(mut self, key: &str, value: &str) -> Self {
        self.env_vars.insert(key.to_string(), value.to_string());
        self
    }
}

impl Environment for MockEnvironment {
    fn os(&self) -> TargetOs {
        self.os
    }

    fn var(&self, key: &str) -> Option<String> {
        self.env_vars.get(key).cloned()
    }

    fn home_dir(&self) -> Option<PathBuf> {
        self.home.clone()
    }
}

#[derive(Debug, Clone, Default)]
pub struct MockFileSystem {
    pub files: HashMap<PathBuf, Vec<u8>>,
    pub dirs: Vec<PathBuf>,
    pub binaries_on_path: HashMap<String, PathBuf>,
}

impl MockFileSystem {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn add_dir<P: AsRef<Path>>(&mut self, path: P) {
        let p = path.as_ref().to_path_buf();
        if !self.dirs.contains(&p) {
            self.dirs.push(p);
        }
    }

    pub fn add_file<P: AsRef<Path>>(&mut self, path: P, content: &[u8]) {
        let p = path.as_ref().to_path_buf();
        if let Some(parent) = p.parent() {
            self.add_dir(parent);
        }
        self.files.insert(p, content.to_vec());
    }

    pub fn add_binary(&mut self, binary: &str, path: PathBuf) {
        self.binaries_on_path
            .insert(binary.to_string(), path.clone());
        self.add_file(&path, b"");
    }
}

impl FileSystem for MockFileSystem {
    fn exists(&self, path: &Path) -> bool {
        self.files.contains_key(path) || self.dirs.iter().any(|d| d == path)
    }

    fn is_file(&self, path: &Path) -> bool {
        self.files.contains_key(path)
    }

    fn is_dir(&self, path: &Path) -> bool {
        self.dirs.iter().any(|d| d == path)
    }

    fn read_dir(&self, path: &Path) -> Result<Vec<PathBuf>, std::io::Error> {
        let mut results = Vec::new();
        for dir in &self.dirs {
            if dir.parent() == Some(path) && dir != path {
                results.push(dir.clone());
            }
        }
        for file in self.files.keys() {
            if file.parent() == Some(path) {
                results.push(file.clone());
            }
        }
        Ok(results)
    }

    fn which(&self, binary: &str) -> Option<PathBuf> {
        self.binaries_on_path.get(binary).cloned()
    }

    fn version_of(&self, binary_path: &Path, _args: &[String]) -> Option<String> {
        let companion = PathBuf::from(format!("{}.version", binary_path.display()));
        if let Some(bytes) = self.files.get(&companion) {
            let s = String::from_utf8_lossy(bytes).trim().to_string();
            if !s.is_empty() {
                return Some(s);
            }
        }
        None
    }
}
