// Switchboard (SPEC 2.5, read-only v0.1).
//
// Reads each supported agent's MCP server config and rules files and returns them
// normalized. Read only: this module never opens a file for writing, never follows a
// path outside the scan roots, and never returns a secret value.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/// Config files above this size are reported instead of parsed.
const MAX_CONFIG_BYTES: u64 = 1024 * 1024;
/// A rules preview is a preview, not a copy of the file.
const PREVIEW_MAX_CHARS: usize = 480;
const PREVIEW_MAX_LINES: usize = 12;

const MASKED: &str = "[masked]";

// ---------------------------------------------------------------------------
// Public types (mirrored in app/src/views/Switchboard/types.ts)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Scope {
    Global,
    Project,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Transport {
    Stdio,
    Http,
    Sse,
    Unknown,
}

/// One MCP server as declared by one agent, in one scope.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    pub agent: String,
    pub name: String,
    pub scope: Scope,
    /// Project label for project scope entries; None for global scope.
    pub project: Option<String>,
    pub transport: Transport,
    pub command: Option<String>,
    /// Secret shaped values replaced by "[masked]".
    pub args: Vec<String>,
    /// Credential pairs and secret query parameters masked.
    pub url: Option<String>,
    /// Environment variable NAMES the server reads. Values are never collected.
    pub env_names: Vec<String>,
    /// HTTP header NAMES the server sends. Values are never collected.
    pub header_names: Vec<String>,
    /// Environment variable NAMES referenced by args or the url, e.g. `${TOKEN}`.
    pub referenced_env_names: Vec<String>,
    pub enabled: bool,
    pub masked_values: usize,
    /// Display path: `~/...` for global scope, `webapp/...` for project scope.
    pub source_path: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RulesFormat {
    Markdown,
    Mdc,
    Text,
}

/// A rules or instruction file an agent is expected to read, with a short masked preview.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RulesFile {
    pub agent: String,
    pub scope: Scope,
    pub project: Option<String>,
    pub path: String,
    pub format: RulesFormat,
    pub exists: bool,
    pub preview: Option<String>,
    pub truncated: bool,
    pub line_count: usize,
    pub masked_values: usize,
}

/// A file the scanner refused to open because it holds credentials.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedFile {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    pub agent: String,
    pub display_name: String,
    pub vendor: String,
    pub servers: Vec<McpServer>,
    pub rules: Vec<RulesFile>,
    pub skipped: Vec<SkippedFile>,
    /// Parse problems and other observations. A bad file never fails the whole scan.
    pub notes: Vec<String>,
}

/// Cross-agent presence of one server name: what the Switchboard highlights.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerPresence {
    pub name: String,
    pub present_in: Vec<String>,
    pub missing_from: Vec<String>,
    /// Distinct masked definitions behind the name, so "same name, different wiring" shows up.
    pub definitions: usize,
    /// Present in every scanned agent, so the view can mark it aligned.
    pub shared_by_all: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSnapshot {
    pub agents: Vec<AgentConfig>,
    pub server_matrix: Vec<ServerPresence>,
    pub projects: Vec<String>,
    pub server_count: usize,
    pub masked_value_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConfigScanErrorKind {
    NoHomeDirectory,
    UnknownAgent,
    InvalidPath,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigScanError {
    pub kind: ConfigScanErrorKind,
    pub message: String,
}

impl std::fmt::Display for ConfigScanError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for ConfigScanError {}

// ---------------------------------------------------------------------------
// Scan context
// ---------------------------------------------------------------------------

/// Where to look. Tests pass the fixture tree; the command passes the real home directory.
#[derive(Debug, Clone)]
pub struct ScanContext {
    home: PathBuf,
    project_roots: Vec<PathBuf>,
}

impl ScanContext {
    pub fn new(home: PathBuf, project_roots: Vec<PathBuf>) -> Self {
        Self {
            home,
            project_roots,
        }
    }

    /// The user's home directory, used only by the real Tauri command.
    pub fn from_environment() -> Result<Self, ConfigScanError> {
        let home = home_directory().ok_or_else(|| ConfigScanError {
            kind: ConfigScanErrorKind::NoHomeDirectory,
            message: "no home directory for this process".to_string(),
        })?;
        Ok(Self::new(home, Vec::new()))
    }

    pub fn with_project_roots(mut self, roots: Vec<PathBuf>) -> Self {
        self.project_roots = roots;
        self
    }

    pub fn home(&self) -> &Path {
        &self.home
    }

    pub fn project_roots(&self) -> &[PathBuf] {
        &self.project_roots
    }

    pub fn project_label(root: &Path) -> String {
        root.file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "project".to_string())
    }

    /// Join a declared relative path onto a root, refusing anything that escapes the root.
    pub fn checked_join(root: &Path, relative: &str) -> Result<PathBuf, ConfigScanError> {
        let mut path = root.to_path_buf();
        for segment in relative.split(['/', '\\']) {
            if segment == ".." {
                return Err(ConfigScanError {
                    kind: ConfigScanErrorKind::InvalidPath,
                    message: format!("path escapes the scan root: {relative}"),
                });
            }
            if !segment.is_empty() {
                path.push(segment);
            }
        }
        Ok(path)
    }
}

fn home_directory() -> Option<PathBuf> {
    #[cfg(windows)]
    let from_env = std::env::var_os("USERPROFILE");
    #[cfg(not(windows))]
    let from_env = std::env::var_os("HOME");
    from_env.map(PathBuf::from)
}

// ---------------------------------------------------------------------------
// Secret masking
// ---------------------------------------------------------------------------

/// File names that hold credentials. SPEC 5: an adapter must skip these by name.
const CREDENTIAL_NAMES: &[&str] = &[
    "auth.json",
    ".credentials.json",
    "credentials.json",
    "oauth_creds.json",
    "google_accounts.json",
    "mcp-oauth-tokens.json",
    "installation_id",
    "providers.json",
    "secrets.json",
    "secret.json",
    ".env",
    "id_rsa",
    "id_ed25519",
    "state.vscdb",
];

const CREDENTIAL_SUBSTRINGS: &[&str] = &["keychain", "keychains"];
const SECRET_KEY_WORDS: &[&str] = &[
    "api_key",
    "apikey",
    "api-key",
    "access_token",
    "access-token",
    "accesstoken",
    "personal_access_token",
    "token",
    "secret",
    "password",
    "passwd",
    "authorization",
    "bearer",
    "credential",
    "private_key",
    "client_secret",
    "signing_key",
    "passphrase",
];

/// Short words that name a secret only as a whole word of the name (split at `_` and `-`), so
/// `--pat` and `X-Custom-Auth` count but `--path` and `--monkey` do not (r2 fix round 2).
const SECRET_KEY_WHOLE_WORDS: &[&str] = &["auth", "pat", "pw", "pwd", "pass", "sas", "key", "cookie", "sig"];

/// Prefixes that identify a key or token by shape alone.
const SECRET_PREFIXES: &[&str] = &[
    "sk-", "sk_", "sk_live", "sk_test", "ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_",
    "xox", "ya29.", "AIza", "AKIA", "ASIA", "glpat-", "sbpat-", "dck_", "dck-", "pat_", "tok_",
    "key-", "hf_", "sgp_", "xai-", "aws_access", "figd_", "ntn_", "shpat_",
];

/// True for file names that hold credentials and must never be opened (SPEC 5).
pub fn is_credential_file_name(file_name: &str) -> bool {
    let lower = file_name.to_ascii_lowercase();
    if CREDENTIAL_NAMES.contains(&lower.as_str()) {
        return true;
    }
    if lower.ends_with(".key") || lower.ends_with(".p12") || lower.ends_with(".pem") {
        return true;
    }
    if lower.starts_with(".env.") {
        return true;
    }
    CREDENTIAL_SUBSTRINGS.iter().any(|needle| lower.contains(needle))
}

/// True when a key, flag or header name says the value that follows is a secret.
pub fn secret_key_name(name: &str) -> bool {
    let normalized = name
        .trim_start_matches('-')
        .to_ascii_lowercase()
        .replace('-', "_");
    SECRET_KEY_WORDS.iter().any(|word| normalized.contains(word))
        || normalized.split(['_', '.']).any(|part| SECRET_KEY_WHOLE_WORDS.contains(&part))
}

/// A value that is plainly not a secret even after a secret-sounding flag: a short number
/// (`--max-tokens 4096`, `-p 3000`) or a file path (`--key-file /path`).
fn ordinary_flag_value(value: &str) -> bool {
    (!value.is_empty() && value.len() <= 6 && value.bytes().all(|b| b.is_ascii_digit()))
        || value.starts_with('/')
        || value.starts_with("./")
        || value.starts_with("../")
        || value.starts_with("~/")
}

/// A value after `-p` that is not a password: `-p` is also npx's package flag
/// (`-p @scope/server`, `-p mcp-remote@latest`) and docker's port map (`-p 8080:80`).
fn ordinary_p_value(value: &str) -> bool {
    ordinary_flag_value(value)
        || value.starts_with('@')
        || value.contains('/')
        || value.contains('@')
        || digits_pair(value)
        || (value.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '.')
            && (value.contains('-') || value.contains('.')))
}

/// `8080:80`, `1000:1000`, `127.0.0.1:8080:80`, `53:53/udp`: numbers joined by colons.
fn digits_pair(value: &str) -> bool {
    let value = value.split('/').next().unwrap_or(value);
    value.contains(':')
        && value
            .split(':')
            .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit() || c == '.'))
}

/// True when a value is a reference to an environment variable rather than a secret itself.
pub fn is_env_reference(value: &str) -> bool {
    match extract_var_names(value) {
        Some(names) => render_reference_shape(value, names.as_slice()),
        None => false,
    }
}

fn render_reference_shape(value: &str, names: &[String]) -> bool {
    // `${A}`, `{env:A}`, `$A`, `%A%` and `${A:-}` are references; anything else that merely
    // contains a reference (a url with a query string, or `${A:-literal}` with a fallback that
    // can itself be a secret) is not a pure one.
    let single = names.len() == 1;
    if !single {
        return false;
    }
    let name = &names[0];
    let candidates = [
        format!("${{{name}}}"),
        format!("${{{name}:-}}"),
        format!("${name}"),
        format!("%{name}%"),
        format!("{{env:{name}}}"),
        format!("${{env:{name}}}"),
    ];
    candidates.iter().any(|shape| shape == value)
}

/// True when a bare string has the shape of a key or token.
pub fn looks_like_secret_value(value: &str) -> bool {
    if value.is_empty() {
        return false;
    }
    if SECRET_PREFIXES.iter().any(|prefix| value.starts_with(prefix)) {
        return true;
    }
    // All-capital tokens with digits, 16 characters or more (r2 fix round 2).
    if value.len() >= 16
        && value.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
        && value.chars().filter(|c| c.is_ascii_digit()).count() >= 2
        && value.chars().filter(|c| c.is_ascii_uppercase()).count() >= 4
    {
        return true;
    }
    if value.len() < 24 {
        return false;
    }
    let allowed = value.chars().all(|c| {
        c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | ':' | '.' | '=')
    });
    if !allowed {
        return false;
    }
    let has_digit = value.chars().any(|c| c.is_ascii_digit());
    let has_letter = value.chars().any(|c| c.is_ascii_alphabetic());
    // Hex tokens and UUIDs (r2 fix round 2): 32 or more hex digits, with or without dashes.
    let hex_digits = value.chars().filter(|c| c.is_ascii_hexdigit()).count();
    if has_digit
        && has_letter
        && hex_digits >= 32
        && value.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
    {
        return true;
    }
    let mixed_case = value.chars().any(|c| c.is_ascii_uppercase())
        && value.chars().any(|c| c.is_ascii_lowercase());
    has_digit && has_letter && mixed_case && shannon_entropy(value) >= 3.0
}

fn shannon_entropy(value: &str) -> f64 {
    let mut counts = std::collections::BTreeMap::new();
    for byte in value.as_bytes() {
        *counts.entry(*byte).or_insert(0usize) += 1;
    }
    let total = value.len() as f64;
    counts
        .values()
        .map(|count| {
            let p = *count as f64 / total;
            -p * p.log2()
        })
        .sum()
}

/// Environment variable NAMES referenced inside a string: `${NAME}`, `${env:NAME}`,
/// `{env:NAME}`, `$NAME`, `%NAME%`, `${NAME:-default}`. Only the names come back, so a
/// value that happens to contain a reference still never leaks.
fn extract_var_names(value: &str) -> Option<Vec<String>> {
    let bytes: Vec<char> = value.chars().collect();
    let mut names: Vec<String> = Vec::new();
    let mut i = 0usize;
    while i < bytes.len() {
        match bytes[i] {
            '$' => {
                if i + 1 < bytes.len() && bytes[i + 1] == '{' {
                    if let Some(end) = find_closing_brace(&bytes, i + 2) {
                        let inner: String = bytes[i + 2..end].iter().collect();
                        if let Some(name) = brace_name(&inner) {
                            push_unique(&mut names, name);
                        }
                        i = end + 1;
                        continue;
                    }
                } else {
                    let mut j = i + 1;
                    let name = read_bare_name(&bytes, &mut j);
                    if !name.is_empty() {
                        push_unique(&mut names, name);
                        i = j;
                        continue;
                    }
                }
                i += 1;
            }
            '%' if i + 1 < bytes.len() => {
                let mut j = i + 1;
                let name = read_bare_name(&bytes, &mut j);
                if !name.is_empty() && bytes.get(j) == Some(&'%') {
                    push_unique(&mut names, name);
                    i = j + 1;
                    continue;
                }
                i += 1;
            }
            '{' if i + 1 < bytes.len() => {
                if let Some(end) = find_closing_brace(&bytes, i + 1) {
                    let inner: String = bytes[i + 1..end].iter().collect();
                    if let Some(name) = brace_name(&inner) {
                        push_unique(&mut names, name);
                    }
                    i = end + 1;
                    continue;
                }
                i += 1;
            }
            _ => i += 1,
        }
    }
    if names.is_empty() {
        None
    } else {
        Some(names)
    }
}

fn find_closing_brace(chars: &[char], from: usize) -> Option<usize> {
    chars[from..].iter().position(|c| *c == '}').map(|p| p + from)
}

/// "MY_TOKEN", "env:MY_TOKEN" and "MY_TOKEN:-default" all name MY_TOKEN.
fn brace_name(inner: &str) -> Option<String> {
    let body = inner
        .strip_prefix("env:")
        .or_else(|| inner.strip_prefix("secrets:"))
        .unwrap_or(inner);
    if body.starts_with("file:") {
        return None;
    }
    let name = body.split(":-").next().unwrap_or(body);
    let name: String = name
        .trim()
        .chars()
        .take_while(|c| c.is_alphanumeric() || *c == '_')
        .collect();
    if name.is_empty() || name.chars().next().map_or(false, |c| c.is_ascii_digit()) {
        return None;
    }
    Some(name)
}

fn read_bare_name(chars: &[char], cursor: &mut usize) -> String {
    let mut name = String::new();
    let mut i = *cursor;
    while i < chars.len() {
        let c = chars[i];
        let acceptable =
            c == '_' || (c.is_alphanumeric() && !(name.is_empty() && c.is_ascii_digit()));
        if !acceptable {
            break;
        }
        name.push(c);
        i += 1;
    }
    *cursor = i;
    name
}

fn push_unique(list: &mut Vec<String>, value: String) {
    if !list.contains(&value) {
        list.push(value);
    }
}

/// Mask secret shaped arg values; flags and variable references stay visible.
/// Returns (masked args, referenced env names, masked value count).
///
/// PRIV-3: an argument can carry a secret inside it, not only as the whole value: a connection
/// URL with a password, an `Authorization: Bearer <token>` header, a `KEY=value` inside a shell
/// string. Each argument is masked word by word (`mask_arg_value`); a variable reference anywhere
/// in it is still listed by name and never masked.
pub fn mask_args(args: &[String]) -> (Vec<String>, Vec<String>, usize) {
    let mut out: Vec<String> = Vec::with_capacity(args.len());
    let mut names: Vec<String> = Vec::new();
    let mut masked = 0usize;
    let mut secret_flag_follows = false;
    // `-u user:password` (curl): the part after the colon is the secret.
    let mut user_flag_follows = false;
    // `-p password` (mysql, sshpass); see `ordinary_p_value` for what stays visible.
    let mut p_flag_follows = false;

    for arg in args {
        if std::mem::take(&mut p_flag_follows) && !arg.starts_with('-') {
            if !ordinary_p_value(arg) && !is_env_reference(arg) {
                masked += 1;
                out.push(MASKED.to_string());
            } else {
                out.push(arg.clone());
            }
            secret_flag_follows = false;
            continue;
        }
        if std::mem::take(&mut user_flag_follows) {
            if let Some((user, rest)) = arg.split_once(':') {
                if !rest.is_empty() && !is_env_reference(rest) && !digits_pair(arg) {
                    masked += 1;
                    out.push(format!("{user}:{MASKED}"));
                    secret_flag_follows = false;
                    continue;
                }
            }
        }
        if let Some(referenced) = extract_var_names(arg) {
            for name in referenced {
                push_unique(&mut names, name);
            }
        }
        if is_env_reference(arg) {
            out.push(arg.clone());
            secret_flag_follows = false;
            continue;
        }
        // `-p` takes a password in mysql and sshpass: `-p secret` and `-psecret`. Ports and
        // paths stay visible, and so do word flags such as `-port`.
        if arg == "-p" {
            p_flag_follows = true;
            secret_flag_follows = false;
            out.push(arg.clone());
            continue;
        }
        if let Some(attached) = arg.strip_prefix("-p").filter(|rest| !rest.is_empty() && !arg.starts_with("--")) {
            let word_flag = attached.chars().all(|c| c.is_ascii_lowercase() || c == '-');
            if !word_flag && !attached.contains('=') && !ordinary_p_value(attached) && !is_env_reference(attached) {
                masked += 1;
                out.push(format!("-p{MASKED}"));
                secret_flag_follows = false;
                continue;
            }
        }
        if arg == "-u" || arg == "--user" {
            user_flag_follows = true;
            secret_flag_follows = false;
            out.push(arg.clone());
            continue;
        }
        if let Some(stripped) = arg.strip_prefix('-') {
            if let Some((key, value)) = stripped.split_once('=') {
                let flag = format!("-{key}");
                if flag == "--user" {
                    if let Some((user, rest)) = value.split_once(':') {
                        if !rest.is_empty() && !is_env_reference(rest) && !digits_pair(value) {
                            masked += 1;
                            out.push(format!("{flag}={user}:{MASKED}"));
                            secret_flag_follows = false;
                            continue;
                        }
                    }
                }
                if secret_key_name(&flag) && !is_env_reference(value) && !ordinary_flag_value(value) {
                    masked += 1;
                    out.push(format!("{flag}={MASKED}"));
                } else {
                    let (value, count) = mask_arg_value(value);
                    masked += count;
                    out.push(format!("{flag}={value}"));
                }
                secret_flag_follows = false;
            } else if arg.contains(char::is_whitespace) {
                // "--token ${T:-x}" as one argument is a shell string, not a flag.
                let (value, count) = mask_arg_value(arg);
                masked += count;
                out.push(value);
                secret_flag_follows = false;
            } else {
                secret_flag_follows = secret_key_name(arg);
                out.push(arg.clone());
            }
            continue;
        }
        if secret_flag_follows && !ordinary_flag_value(arg) {
            masked += 1;
            out.push(MASKED.to_string());
        } else {
            let (value, count) = mask_arg_value(arg);
            masked += count;
            out.push(value);
        }
        secret_flag_follows = false;
    }

    (out, names, masked)
}

/// Words that introduce a credential in an Authorization header. Quotes around the word do
/// not hide it: `"Authorization": "Bearer x"` (sol-loop N9).
fn is_auth_scheme(word: &str) -> bool {
    matches!(word.trim_matches(['"', '\'', '`']).to_ascii_lowercase().as_str(), "bearer" | "basic" | "token")
}

/// A header whose value may start with one scheme word before the credential.
fn is_authorization_key(key: &str) -> bool {
    matches!(
        key.trim_matches(['"', '\'', '`', '*', '{', '[', '(', ',', '\\']).to_ascii_lowercase().as_str(),
        "authorization" | "proxy-authorization"
    )
}

/// A key as written, without the quotes, braces, brackets, commas, backslashes and markdown
/// around it: `{"key"`, `\"password\"`, `**Token**` and `${DB_PASSWORD` all read as the name.
fn bare_key(key: &str) -> &str {
    key.trim_matches(|c: char| !(c.is_alphanumeric() || matches!(c, '_' | '-' | '.')))
}

/// A word made only of a separator (`:`, `=`, `=>`, `:=`, `**:**`): the key before it names the
/// value after.
fn separator_only(word: &str) -> bool {
    let tail = word.trim_end_matches(['*', '`']);
    !tail.is_empty() && tail.trim_end_matches([':', '=', '>']).is_empty()
}

/// Characters that may come before a value's opening quote and keep it a quote: escapes
/// (`\"`), shell `$'..'`, and string prefixes (`r"..."`, `b'..'`, `@"..."`).
fn quote_prefix(c: char) -> bool {
    matches!(c, '\\' | '$' | '@' | 'r' | 'R' | 'b' | 'B' | 'f' | 'F' | 'u' | 'U')
}

/// True when a value word opens with a quote or a bracket (after a prefix such as `$` or `r`).
fn starts_quoted(word: &str) -> bool {
    word.trim_start_matches(quote_prefix).starts_with(['"', '\'', '`', '{', '['])
}

/// A word that is only a variable reference, possibly quoted or followed by a comma:
/// `${TOKEN}`, `"${TOKEN}",`.
fn reference_word(word: &str) -> bool {
    is_env_reference(word.trim_end_matches([',', ';']).trim_matches(['"', '\'', '`']))
}

/// A quote a secret value opened. `escapes` counts the backslashes right before the opening
/// quote: `"x"` opens at 0, `\"x\"` (JSON inside a shell string) at 1.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Quote {
    ch: char,
    escapes: usize,
}

impl Quote {
    /// True when `ch` with `escapes` backslashes right before it closes this quote. An escaped
    /// quote (`\"` inside `"..."`) does not close it (sol-loop N10).
    fn closed_by(self, ch: char, escapes: usize) -> bool {
        ch == self.ch && if self.escapes == 0 { escapes % 2 == 0 } else { escapes == self.escapes }
    }
}

/// What a secret value still has open at the end of a word: a quote, or brackets.
#[derive(Clone, Copy, Debug, Default)]
struct Open {
    quote: Option<Quote>,
    depth: usize,
}

impl Open {
    fn is_open(&self) -> bool {
        self.quote.is_some() || self.depth > 0
    }
}

/// Walk a secret value in `word` from byte `start`, already inside `open`. Returns the byte
/// where the value ends in this word and what is still open at the end of the word. A quote
/// opens the value only as its first character (after a `quote_prefix`); a doubled quote
/// (`'it''s'`, `"""`) stays inside it; inside brackets every quote and nested bracket is
/// followed. Outside both, the value ends at `,` `}` `]` when the word is `structured` (JSON,
/// an inline table) and otherwise runs to the end of the word.
fn walk_value(word: &str, start: usize, mut open: Open, structured: bool) -> (usize, Open) {
    let mut chars = word[start..].char_indices().map(|(offset, c)| (start + offset, c)).peekable();
    let mut escapes = 0usize;
    // Only prefix characters so far: a quote here still opens the value.
    let mut prefix_only = true;
    while let Some((at, c)) = chars.next() {
        if c == '\\' {
            escapes += 1;
            continue;
        }
        let before = std::mem::take(&mut escapes);
        if let Some(quote) = open.quote {
            prefix_only = false;
            if quote.closed_by(c, before) {
                if quote.escapes == 0 && chars.peek().is_some_and(|&(_, next)| next == c) {
                    chars.next();
                } else {
                    open.quote = None;
                }
            }
            continue;
        }
        let first = prefix_only;
        prefix_only = prefix_only && quote_prefix(c);
        match c {
            '"' | '\'' | '`' if first || open.depth > 0 => open.quote = Some(Quote { ch: c, escapes: before }),
            '{' | '[' if first || open.depth > 0 => open.depth += 1,
            '}' | ']' if open.depth > 0 => open.depth -= 1,
            ',' | '}' | ']' if structured && open.depth == 0 => return (at, open),
            _ => {}
        }
    }
    (word.len(), open)
}

/// Where an unquoted value after a spaced separator ends. YAML and INI values run to the end of
/// the line (`password: correct horse battery`), so every word is masked until then, or until
/// the word that closes the quote the key opened (`"X-Api-Key: a b" https://...`), or until a
/// word ending in `,` `}` `]` inside an inline table (`{token: a b, user: c}`).
#[derive(Clone, Copy, Debug, Default)]
struct Until {
    outer: Option<char>,
    flow: bool,
}

impl Until {
    /// The quote a key word opened and did not close before its separator (`"X-Api-Key:`).
    fn for_key(key_word: &str, flow: bool) -> Until {
        let outer = key_word
            .chars()
            .next()
            .filter(|q| matches!(q, '"' | '\'' | '`') && key_word.matches(*q).count() % 2 == 1);
        Until { outer, flow }
    }

    fn ends_at(self, word: &str) -> bool {
        let closing = word.trim_end_matches([',', ';', ')', '}', ']']);
        self.outer.is_some_and(|q| closing.ends_with(q)) || (self.flow && word.ends_with([',', '}', ']']))
    }
}

/// The secret value after a key, word by word (sol-loop N6/N9/N10). The value is the next
/// word, every word up to its closing quote or bracket when it opens one, and, after a spaced
/// separator, every word to the end of the value (`Until`). Only after `Authorization` or
/// `Proxy-Authorization` may its first word be one scheme (`Bearer`, `Basic`, `Token`) that
/// stays visible; the credential after it is masked whatever it is spelled like.
#[derive(Default)]
struct SecretValue {
    /// The next word starts the value (or is the credential after a kept scheme).
    pending: bool,
    /// The next word may be the one scheme word.
    scheme_allowed: bool,
    /// The value opened a quote or brackets: every word until they close is masked.
    open: Open,
    /// The value may run over several unquoted words; while not pending, it still does.
    until: Option<Until>,
}

impl SecretValue {
    /// A key that names a secret ends this word; the value starts at the next word. `until` is
    /// set after a separator (`password: a b`) and not after a flag (`--password a`).
    fn start(&mut self, authorization: bool, until: Option<Until>) {
        *self = SecretValue { pending: true, scheme_allowed: authorization, open: Open::default(), until };
    }

    /// The scheme word was kept (`Bearer`, `"Bearer`, `Authorization:Bearer`); the credential
    /// follows it, inside the quote the scheme opened when it opened one.
    fn after_scheme(&mut self, scheme: &str) {
        let (_, open) = walk_value(scheme, 0, Open::default(), false);
        *self = SecretValue { pending: !open.is_open(), scheme_allowed: false, open, until: None };
    }

    /// A value word was masked whole; what it leaves open, or what the text after its end
    /// starts (`"a",token:"b`), carries to the next word.
    fn after_value(&mut self, word: &str, open: Open, end: usize) {
        *self = SecretValue { pending: false, scheme_allowed: false, open, until: None };
        if !open.is_open() && end < word.len() {
            let _ = mask_compact(&word[end..], self, true);
        }
    }

    /// The word as shown when it belongs to the value, or None when the caller masks it as an
    /// ordinary word (it is not part of a value, or it is a variable reference).
    fn take(&mut self, word: &str, masked: &mut usize) -> Option<String> {
        if self.open.is_open() {
            let (end, open) = walk_value(word, 0, self.open, true);
            self.after_value(word, open, end);
            *masked += 1;
            return Some(MASKED.to_string());
        }
        if !self.pending {
            let until = self.until.take()?;
            if !until.ends_at(word) {
                self.until = Some(until);
            }
            *masked += 1;
            return Some(MASKED.to_string());
        }
        let scheme_allowed = std::mem::take(&mut self.scheme_allowed);
        self.pending = false;
        let until = self.until.take();
        let (end, open) = walk_value(word, 0, Open::default(), true);
        let quoted = starts_quoted(word);
        let continues = |secret: &mut SecretValue| {
            if let Some(until) = until.filter(|until| !quoted && !until.ends_at(word)) {
                if !secret.open.is_open() && !secret.pending {
                    secret.until = Some(until);
                }
            }
        };
        if !open.is_open() && reference_word(word) {
            continues(self);
            return None;
        }
        if scheme_allowed && is_auth_scheme(word) {
            self.after_scheme(word);
            return Some(word.to_string());
        }
        self.after_value(word, open, end);
        continues(self);
        *masked += 1;
        Some(MASKED.to_string())
    }
}

/// Mask the value after EVERY secret key in a word with no spaces, not only the first
/// (sol-loop S1/N6/N9): `{"headers":{"Authorization":"Bearer`, `{"key":"x"}`,
/// `[{"name":"a","token":"x"}]`, `PASSWORD="a`, `Server=db;Password=x`. Each `:` and `=` is a
/// separator; the key is the text back to the previous separator, brace, bracket, comma, `;`,
/// `&` or `?`, read without its quotes (`bare_key`). A `${NAME:-x}` reference is not a pair.
/// The value runs to its end (`walk_value`); what it leaves open carries to the next words
/// through `secret`. Text between values goes through `mask_word`. None when no secret key.
fn mask_compact(word: &str, secret: &mut SecretValue, flow: bool) -> Option<(String, usize)> {
    let bytes = word.as_bytes();
    let mut out = String::new();
    let mut masked = 0usize;
    let mut copied = 0usize;
    let mut key_start = 0usize;
    let mut found = false;
    // A brace or bracket came before: JSON or an inline table, where `,` `}` `]` end a value.
    let mut structured = false;
    let mut i = 0usize;
    while i < bytes.len() {
        match bytes[i] {
            b'$' if bytes.get(i + 1) == Some(&b'{') => {
                i = word[i..].find('}').map_or(bytes.len(), |end| i + end + 1);
                continue;
            }
            b'{' | b'[' => {
                structured = true;
                key_start = i + 1;
            }
            b'(' | b',' | b';' | b'&' | b'?' => key_start = i + 1,
            b':' | b'=' => {
                let key = bare_key(&word[key_start..i]);
                let mut value_start = i + 1;
                while matches!(bytes.get(value_start), Some(b'=' | b'>')) {
                    value_start += 1;
                }
                let is_secret = !key.is_empty() && secret_key_name(key);
                // A scheme that ends the word names the next word as the credential, whatever
                // the key: `"value":"Bearer` (a header list), `Authorization:Bearer`.
                let scheme_last = bytes.len() - value_start <= 8 && is_auth_scheme(&word[value_start..]);
                if !is_secret && !scheme_last {
                    key_start = i + 1;
                    i += 1;
                    continue;
                }
                let (end, open) = walk_value(word, value_start, Open::default(), structured);
                let value = &word[value_start..end];
                found = true;
                let (before, count) = mask_word(&word[copied..key_start]);
                out.push_str(&before);
                masked += count;
                out.push_str(&word[key_start..value_start]);
                if value_start == bytes.len() || value.trim_matches(['*', '`']).is_empty() {
                    // `password:` or `**Token:**`: the value is the next word.
                    out.push_str(value);
                    let until = Until::for_key(&word[key_start..i], flow || structured);
                    secret.start(is_authorization_key(key), Some(until));
                } else if scheme_last && (is_authorization_key(key) || !is_secret) {
                    out.push_str(value);
                    secret.after_scheme(value);
                } else if value.starts_with(MASKED) || (!open.is_open() && reference_word(value)) {
                    out.push_str(value);
                } else {
                    out.push_str(MASKED);
                    masked += 1;
                    *secret = SecretValue { pending: false, scheme_allowed: false, open, until: None };
                }
                copied = end;
                key_start = end;
                i = end;
            }
            _ => {}
        }
        i += 1;
    }
    if !found {
        return None;
    }
    let (rest, count) = mask_word(&word[copied.min(bytes.len())..]);
    out.push_str(&rest);
    Some((out, masked + count))
}

/// One word with nothing around it: a URL goes to the URL masker, any other word has its secret
/// keys found first (`mask_compact`) and is then masked as a word.
fn mask_token(word: &str, secret: &mut SecretValue, flow: bool) -> (String, usize) {
    let url = word.find("://").is_some_and(|end| {
        end > 0 && word[..end].chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
    });
    if url {
        return mask_word(word);
    }
    mask_compact(word, secret, flow).unwrap_or_else(|| mask_word(word))
}

/// How a run of words is read: a rules preview (prose and config text) or a server argument
/// (a shell string or a header), where `Basic` and `Token` on their own also start a
/// credential.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Words {
    Preview,
    Argument,
}

/// Mask a line of words with one shared rule set (sol-loop S1): the value after a secret key
/// written `key: x`, `key = x`, `key=x`, `"key": "x"`, `{"key":"x"}`, `--key x`, the credential
/// after a scheme, `-u user:password`, every value after `Cookie:`, and every word the word
/// masker finds (URLs, `user:password@host`, token shaped words).
fn mask_words(text: &str, kind: Words) -> (String, usize) {
    let mut masked = 0usize;
    let mut secret = SecretValue::default();
    let mut mask_rest = false;
    let mut user_follows = false;
    // A secret key word with no separator (`password`, `"Authorization"`): when the next word is
    // only `:` or `=`, the value starts after it. Holds whether it is an Authorization key and
    // where its value ends.
    let mut key_before: Option<(bool, Until)> = None;
    // The word before ends an inline table's opening (`{`, `[`) or a pair (`,`).
    let mut flow = false;
    let mut words: Vec<String> = Vec::new();
    for word in text.split_whitespace() {
        let after_flow = std::mem::replace(&mut flow, word.ends_with(['{', '[', ',']));
        // "Cookie: a=1; b=2": every word after the header name is the secret.
        if mask_rest {
            masked += 1;
            words.push(MASKED.to_string());
            continue;
        }
        if let Some((authorization, until)) = key_before.take() {
            if separator_only(word) {
                secret.start(authorization, Some(until));
                words.push(word.to_string());
                continue;
            }
        }
        if let Some(shown) = secret.take(word, &mut masked) {
            words.push(shown);
            continue;
        }
        let key = bare_key(word);
        if !word.trim_start_matches(':').contains([':', '=']) && !key.is_empty() && secret_key_name(key) {
            let until = Until::for_key(word, after_flow || word.starts_with(['{', '[']));
            key_before = Some((is_authorization_key(key), until));
        }
        if std::mem::take(&mut user_follows) {
            if let Some((user, rest)) = word.split_once(':') {
                if !rest.is_empty() && !is_env_reference(rest) && !digits_pair(word) {
                    masked += 1;
                    words.push(format!("{user}:{MASKED}"));
                    continue;
                }
            }
        }
        if let Some(name) = word.strip_suffix(':') {
            if matches!(bare_key(name).to_ascii_lowercase().as_str(), "cookie" | "set-cookie") {
                words.push(word.to_string());
                mask_rest = true;
                continue;
            }
        }
        // A scheme on its own ("Bearer x", `proxy_set_header Authorization "Bearer x"`) names
        // the next word as the credential. In prose only `Bearer` does.
        let scheme = match kind {
            Words::Argument => is_auth_scheme(word),
            Words::Preview => word.trim_matches(['"', '\'', '`']).eq_ignore_ascii_case("bearer"),
        };
        if scheme {
            words.push(word.to_string());
            secret.after_scheme(word);
            continue;
        }
        // curl's `-u user:password` and `--user=user:password`.
        if word == "-u" || word == "--user" {
            user_follows = true;
            words.push(word.to_string());
            continue;
        }
        if let Some((user, rest)) = word.strip_prefix("--user=").and_then(|value| value.split_once(':')) {
            if !rest.is_empty() && !is_env_reference(rest) && !digits_pair(&word[7..]) {
                masked += 1;
                words.push(format!("--user={user}:{MASKED}"));
                continue;
            }
        }
        // "--api-key sk-..." in a shell string, `"--api-key",` in an args list.
        if key.starts_with('-') && !word.contains('=') && secret_key_name(key) {
            words.push(word.to_string());
            secret.start(false, None);
            continue;
        }
        let (shown, count) = mask_token(word, &mut secret, after_flow);
        masked += count;
        words.push(shown);
    }
    (words.join(" "), masked)
}

/// Mask one argument value: word by word when it holds spaces (a shell string or a header),
/// otherwise as a single word, with the same rules (`mask_words`).
fn mask_arg_value(value: &str) -> (String, usize) {
    if is_env_reference(value) {
        return (value.to_string(), 0);
    }
    mask_words(value, Words::Argument)
}

/// Mask one word: a URL keeps its scheme, host and plain path; `KEY=value` and `Key:value` keep
/// the key when it or the value looks secret; a bare token shaped word is replaced.
fn mask_word(word: &str) -> (String, usize) {
    struct Depth;
    impl Drop for Depth {
        fn drop(&mut self) {
            WORD_DEPTH.with(|depth| depth.set(depth.get() - 1));
        }
    }
    let depth = WORD_DEPTH.with(|depth| {
        depth.set(depth.get() + 1);
        depth.get()
    });
    let _depth = Depth;
    if depth > MAX_WORD_DEPTH {
        return (MASKED.to_string(), 1);
    }
    mask_word_once(word)
}

thread_local! {
    static WORD_DEPTH: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// Nested masking (an assignment's value, a `${A:-...}` fallback, a URL inside a query value)
/// is bounded: past this depth the rest of the word is masked whole, so one long line such as
/// `k=v&k=v&...` cannot exhaust the stack (sol-loop S1, found by the round 5 bound test).
const MAX_WORD_DEPTH: usize = 32;

fn mask_word_once(word: &str) -> (String, usize) {
    if is_env_reference(word) {
        return (word.to_string(), 0);
    }
    // `${NAME:-fallback}`: the name stays; the fallback is a literal and is masked like one.
    if let Some((name, fallback)) = word
        .strip_prefix("${")
        .and_then(|rest| rest.strip_suffix('}'))
        .and_then(|inner| inner.split_once(":-"))
    {
        if secret_key_name(name) {
            return (format!("${{{name}:-{MASKED}}}"), 1);
        }
        let (fallback, count) = mask_word(fallback);
        return (format!("${{{name}:-{fallback}}}"), count);
    }
    // A URL starts with its scheme; "KEY=postgres://..." is an assignment holding one.
    if let Some(scheme_end) = word.find("://") {
        if !word[..scheme_end].contains('=') {
            let (url, _, count) = mask_url(word);
            return (url, count);
        }
    }
    // "Server=db;Database=x;Password=..." (a connection string): each pair on its own.
    if word.contains(';') && word.contains('=') {
        let mut count = 0usize;
        let parts: Vec<String> = word
            .split(';')
            .map(|part| match part.split_once('=') {
                Some((key, value))
                    if !value.is_empty()
                        && !is_env_reference(value)
                        && (secret_key_name(key.trim()) || looks_like_secret_value(value)) =>
                {
                    count += 1;
                    format!("{key}={MASKED}")
                }
                _ => part.to_string(),
            })
            .collect();
        if count > 0 {
            return (parts.join(";"), count);
        }
    }
    // "user:password@db.example.com" without a scheme.
    if let Some((userinfo, host)) = word.rsplit_once('@') {
        let host_name = host.split([':', '/']).next().unwrap_or("");
        let host_like = host_name.contains('.')
            && host_name.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-');
        if host_like && !userinfo.contains('/') && !userinfo.contains('=') {
            if let Some((user, password)) = userinfo.split_once(':') {
                if !user.is_empty() && !password.is_empty() && !is_env_reference(password) {
                    return (format!("{user}:{MASKED}@{host}"), 1);
                }
            }
        }
    }
    if let Some((key, value)) = word.split_once('=') {
        if !key.is_empty() && !is_env_reference(value) {
            if secret_key_name(key) || looks_like_secret_value(value) {
                return (format!("{key}={MASKED}"), 1);
            }
            // The value is masked like a word of its own: a URL, `user:password@host` or a
            // `${NAME:-literal}` fallback inside an assignment.
            let (value, count) = mask_word(value);
            if count > 0 {
                return (format!("{key}={value}"), count);
            }
        }
        return (word.to_string(), 0);
    }
    if let Some((key, value)) = word.split_once(':') {
        if !value.is_empty() && secret_key_name(key) && !is_env_reference(value) {
            return (format!("{key}:{MASKED}"), 1);
        }
    }
    if looks_like_secret_value(word) {
        return (MASKED.to_string(), 1);
    }
    (word.to_string(), 0)
}

/// Keep scheme, host and path so the server is recognizable; drop credentials from the
/// userinfo, from token shaped path segments (PRIV-3) and from secret query parameters.
pub fn mask_url(url: &str) -> (String, Vec<String>, usize) {
    let mut names: Vec<String> = Vec::new();
    let mut masked = 0usize;

    let (before_fragment, fragment) = match url.split_once('#') {
        Some((head, tail)) => (head, Some(tail.to_string())),
        None => (url, None),
    };
    let (head, query) = match before_fragment.split_once('?') {
        Some((head, tail)) => (head, Some(tail.to_string())),
        None => (before_fragment, None),
    };

    // user:pass@host -> user:[masked]@host; a token used as the user name is masked too.
    let mut rebuilt = head.to_string();
    if let Some(scheme_end) = head.find("://") {
        let rest = &head[scheme_end + 3..];
        let authority_end = rest
            .find(['/', '?', '#'])
            .unwrap_or(rest.len());
        let mut authority = rest[..authority_end].to_string();
        if let Some(at) = authority.rfind('@') {
            let user = authority[..at].split(':').next().unwrap_or("").to_string();
            let user = if looks_like_secret_value(&user) { MASKED.to_string() } else { user };
            masked += 1;
            authority = format!("{user}:{MASKED}@{}", &authority[at + 1..]);
        }
        let path: Vec<String> = rest[authority_end..]
            .split('/')
            .map(|segment| {
                if looks_like_secret_value(segment) && !is_env_reference(segment) {
                    masked += 1;
                    MASKED.to_string()
                } else {
                    segment.to_string()
                }
            })
            .collect();
        rebuilt = format!("{}://{}{}", &head[..scheme_end], authority, path.join("/"));
    }

    if let Some(query) = query {
        let pairs = mask_pairs(&query, &mut names, &mut masked);
        if !pairs.is_empty() {
            rebuilt = format!("{rebuilt}?{pairs}");
        }
    }
    if let Some(fragment) = fragment {
        // "#access_token=..." (an OAuth implicit grant) is masked like a query string.
        let fragment = if fragment.contains('=') { mask_pairs(&fragment, &mut names, &mut masked) } else { fragment };
        rebuilt = format!("{rebuilt}#{fragment}");
    }

    (rebuilt, names, masked)
}

/// Mask the `key=value` pairs of a query string or fragment; referenced variables are listed.
fn mask_pairs(query: &str, names: &mut Vec<String>, masked: &mut usize) -> String {
    {
        let pairs: Vec<String> = query
            .split('&')
            .filter(|pair| !pair.is_empty())
            .map(|pair| {
                let (key, value) = match pair.split_once('=') {
                    Some((k, v)) => (k.to_string(), Some(v.to_string())),
                    None => (pair.to_string(), None),
                };
                if let Some(referenced) = value.as_deref().and_then(extract_var_names) {
                    for name in referenced {
                        push_unique(names, name);
                    }
                    if value.as_deref().is_some_and(is_env_reference) {
                        return format!("{key}={}", value.unwrap_or_default());
                    }
                }
                let is_secret = secret_key_name(&key)
                    || value.as_deref().map(|v| looks_like_secret_value(v)).unwrap_or(false);
                if is_secret {
                    *masked += 1;
                    match value {
                        Some(_) => format!("{key}={MASKED}"),
                        None => format!("{key}"),
                    }
                } else {
                    match value {
                        // `?value=${TOKEN:-literal}`: the fallback is masked like any word.
                        Some(v) => {
                            let (v, count) = mask_token(&v, &mut SecretValue::default(), false);
                            *masked += count;
                            format!("{key}={v}")
                        }
                        None => key,
                    }
                }
            })
            .collect();
        pairs.join("&")
    }
}

/// Mask a rules preview line by line with the rules used for server arguments (`mask_words`):
/// assignments, URLs and `user:password@host` credentials, bare token shaped words, and the
/// value after every secret key however it is written: `password: x`, `password = x`,
/// `"token": "x"`, `**Password:** x`, `{"headers":{"Authorization":"Bearer x"}}`.
pub fn mask_preview(text: &str) -> (String, usize) {
    let mut masked = 0usize;
    let lines: Vec<String> = text
        .lines()
        .map(|line| {
            let (shown, count) = mask_words(line, Words::Preview);
            masked += count;
            shown
        })
        .collect();
    (lines.join("\n"), masked)
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

/// How one config file stores its MCP server list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Dialect {
    /// `{"mcpServers": {"name": {"command": "npx", "args": [...], "env": {...}}}}`
    JsonServers,
    /// OpenCode: `{"mcp": {"name": {"type": "local", "command": ["npx", ...]}}}`
    OpenCode,
    /// Codex: TOML `[mcp_servers.name]`
    CodexToml,
    /// `{"projects": {"/path/to/repo": {"mcpServers": {...}}}}` inside ~/.claude.json
    ClaudeProjectsMap,
}

#[derive(Debug, Clone, Copy)]
struct ConfigSource {
    scope: Scope,
    /// Relative to the home directory (Global) or to a project root (Project).
    path: &'static str,
    dialect: Dialect,
}

#[derive(Debug, Clone, Copy)]
enum RulesKind {
    /// A single file, reported with `exists` either way when `report_if_missing` is set.
    File,
    /// A directory: every file whose name ends with this suffix is a rules file.
    Dir(&'static str),
}

#[derive(Debug, Clone, Copy)]
struct RulesSource {
    scope: Scope,
    path: &'static str,
    kind: RulesKind,
    report_if_missing: bool,
}

struct AgentSpec {
    id: &'static str,
    display_name: &'static str,
    vendor: &'static str,
    sources: &'static [ConfigSource],
    rules: &'static [RulesSource],
    /// Credential files known to sit next to the config. Refused before any open.
    refused: &'static [&'static str],
}

/// File names verified from each project's own docs. Where a path
/// is best effort (not documented), the comment says so.
const AGENTS: &[AgentSpec] = &[
    AgentSpec {
        id: "claude-code",
        display_name: "Claude Code",
        vendor: "Anthropic",
        sources: &[
            ConfigSource {
                scope: Scope::Global,
                path: ".claude.json",
                dialect: Dialect::JsonServers,
            },
            ConfigSource {
                scope: Scope::Global,
                path: ".claude.json",
                dialect: Dialect::ClaudeProjectsMap,
            },
            ConfigSource {
                scope: Scope::Project,
                path: ".mcp.json",
                dialect: Dialect::JsonServers,
            },
        ],
        rules: &[
            RulesSource {
                scope: Scope::Global,
                path: ".claude/CLAUDE.md",
                kind: RulesKind::File,
                report_if_missing: true,
            },
            RulesSource {
                scope: Scope::Project,
                path: "CLAUDE.md",
                kind: RulesKind::File,
                report_if_missing: true,
            },
            RulesSource {
                scope: Scope::Project,
                path: ".claude/CLAUDE.md",
                kind: RulesKind::File,
                report_if_missing: false,
            },
            RulesSource {
                scope: Scope::Project,
                path: ".claude/rules",
                kind: RulesKind::Dir(".md"),
                report_if_missing: false,
            },
        ],
        refused: &[".claude/.credentials.json"],
    },
    AgentSpec {
        id: "codex-cli",
        display_name: "Codex CLI",
        vendor: "OpenAI",
        sources: &[
            ConfigSource {
                scope: Scope::Global,
                path: ".codex/config.toml",
                dialect: Dialect::CodexToml,
            },
            ConfigSource {
                scope: Scope::Project,
                path: ".codex/config.toml",
                dialect: Dialect::CodexToml,
            },
        ],
        rules: &[
            RulesSource {
                scope: Scope::Global,
                path: ".codex/AGENTS.md",
                kind: RulesKind::File,
                report_if_missing: true,
            },
            RulesSource {
                scope: Scope::Global,
                path: ".codex/AGENTS.override.md",
                kind: RulesKind::File,
                report_if_missing: false,
            },
            RulesSource {
                scope: Scope::Project,
                path: "AGENTS.md",
                kind: RulesKind::File,
                report_if_missing: true,
            },
        ],
        refused: &[".codex/auth.json"],
    },
    AgentSpec {
        id: "gemini-cli",
        display_name: "Gemini CLI",
        vendor: "Google",
        sources: &[
            ConfigSource {
                scope: Scope::Global,
                path: ".gemini/settings.json",
                dialect: Dialect::JsonServers,
            },
            ConfigSource {
                scope: Scope::Project,
                path: ".gemini/settings.json",
                dialect: Dialect::JsonServers,
            },
        ],
        rules: &[
            RulesSource {
                scope: Scope::Global,
                path: ".gemini/GEMINI.md",
                kind: RulesKind::File,
                report_if_missing: true,
            },
            RulesSource {
                scope: Scope::Project,
                path: "GEMINI.md",
                kind: RulesKind::File,
                report_if_missing: true,
            },
        ],
        refused: &[
            ".gemini/oauth_creds.json",
            ".gemini/google_accounts.json",
            ".gemini/mcp-oauth-tokens.json",
            ".gemini/installation_id",
        ],
    },
    AgentSpec {
        id: "cursor",
        display_name: "Cursor",
        vendor: "Cursor",
        sources: &[
            ConfigSource {
                scope: Scope::Global,
                path: ".cursor/mcp.json",
                dialect: Dialect::JsonServers,
            },
            ConfigSource {
                scope: Scope::Project,
                path: ".cursor/mcp.json",
                dialect: Dialect::JsonServers,
            },
        ],
        rules: &[
            RulesSource {
                scope: Scope::Global,
                path: ".cursor/rules",
                kind: RulesKind::Dir(".mdc"),
                // Cursor User Rules are set in the settings UI; this folder is what the
                // Cursor CLI reads. Best effort.
                report_if_missing: false,
            },
            RulesSource {
                scope: Scope::Project,
                path: ".cursor/rules",
                kind: RulesKind::Dir(".mdc"),
                report_if_missing: false,
            },
            RulesSource {
                scope: Scope::Project,
                path: "AGENTS.md",
                kind: RulesKind::File,
                report_if_missing: true,
            },
            RulesSource {
                scope: Scope::Project,
                path: ".cursorrules",
                kind: RulesKind::File,
                report_if_missing: false,
            },
        ],
        refused: &[".cursor/state.vscdb"],
    },
    AgentSpec {
        id: "opencode",
        display_name: "OpenCode",
        vendor: "OpenCode",
        sources: &[
            ConfigSource {
                scope: Scope::Global,
                path: ".config/opencode/opencode.json",
                dialect: Dialect::OpenCode,
            },
            ConfigSource {
                scope: Scope::Project,
                path: "opencode.json",
                dialect: Dialect::OpenCode,
            },
            ConfigSource {
                scope: Scope::Project,
                path: "opencode.jsonc",
                dialect: Dialect::OpenCode,
            },
        ],
        rules: &[
            RulesSource {
                scope: Scope::Global,
                path: ".config/opencode/AGENTS.md",
                kind: RulesKind::File,
                report_if_missing: true,
            },
            RulesSource {
                scope: Scope::Project,
                path: "AGENTS.md",
                kind: RulesKind::File,
                report_if_missing: true,
            },
            // OpenCode falls back to CLAUDE.md when AGENTS.md is absent.
            RulesSource {
                scope: Scope::Project,
                path: "CLAUDE.md",
                kind: RulesKind::File,
                report_if_missing: false,
            },
        ],
        refused: &[".local/share/opencode/auth.json"],
    },
    AgentSpec {
        id: "copilot-cli",
        display_name: "GitHub Copilot CLI",
        vendor: "GitHub",
        sources: &[
            ConfigSource {
                scope: Scope::Global,
                path: ".copilot/mcp-config.json",
                dialect: Dialect::JsonServers,
            },
            ConfigSource {
                scope: Scope::Project,
                path: ".mcp.json",
                dialect: Dialect::JsonServers,
            },
            ConfigSource {
                scope: Scope::Project,
                path: ".github/mcp.json",
                dialect: Dialect::JsonServers,
            },
        ],
        rules: &[
            RulesSource {
                scope: Scope::Global,
                path: ".copilot/copilot-instructions.md",
                kind: RulesKind::File,
                report_if_missing: true,
            },
            RulesSource {
                scope: Scope::Project,
                path: ".github/copilot-instructions.md",
                kind: RulesKind::File,
                report_if_missing: true,
            },
            RulesSource {
                scope: Scope::Project,
                path: ".github/instructions",
                kind: RulesKind::Dir(".instructions.md"),
                report_if_missing: false,
            },
            RulesSource {
                scope: Scope::Project,
                path: "AGENTS.md",
                kind: RulesKind::File,
                report_if_missing: false,
            },
        ],
        refused: &[".copilot/config.json"],
    },
    AgentSpec {
        id: "windsurf",
        display_name: "Windsurf",
        vendor: "Codeium",
        sources: &[
            ConfigSource {
                scope: Scope::Global,
                path: ".codeium/windsurf/mcp_config.json",
                dialect: Dialect::JsonServers,
            },
            // No project scoped MCP file is documented for Windsurf. Best effort.
            ConfigSource {
                scope: Scope::Project,
                path: ".windsurf/mcp.json",
                dialect: Dialect::JsonServers,
            },
        ],
        rules: &[
            RulesSource {
                scope: Scope::Global,
                path: ".codeium/windsurf/global_rules.md",
                kind: RulesKind::File,
                report_if_missing: true,
            },
            RulesSource {
                scope: Scope::Project,
                path: ".windsurf/rules",
                kind: RulesKind::Dir(".md"),
                report_if_missing: false,
            },
            RulesSource {
                scope: Scope::Project,
                path: ".windsurfrules",
                kind: RulesKind::File,
                report_if_missing: true,
            },
            RulesSource {
                scope: Scope::Project,
                path: "AGENTS.md",
                kind: RulesKind::File,
                report_if_missing: false,
            },
        ],
        refused: &[".codeium/windsurf/state.vscdb", ".codeium/windsurf/db.vscdb"],
    },
    AgentSpec {
        id: "cline",
        display_name: "Cline",
        vendor: "Cline Bot",
        sources: &[
            // VS Code extension storage. The path is what the app writes on disk; it is not
            // in the current docs, so treat it as best effort.
            ConfigSource {
                scope: Scope::Global,
                path: "Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json",
                dialect: Dialect::JsonServers,
            },
            ConfigSource {
                scope: Scope::Global,
                path: ".cline/data/settings/cline_mcp_settings.json",
                dialect: Dialect::JsonServers,
            },
            ConfigSource {
                scope: Scope::Project,
                path: ".cline/mcp.json",
                dialect: Dialect::JsonServers,
            },
        ],
        rules: &[
            RulesSource {
                scope: Scope::Global,
                path: ".cline/data/settings/rules",
                kind: RulesKind::Dir(".md"),
                report_if_missing: false,
            },
            RulesSource {
                scope: Scope::Global,
                path: "Documents/Cline/Rules",
                kind: RulesKind::Dir(".md"),
                report_if_missing: false,
            },
            RulesSource {
                scope: Scope::Project,
                path: ".clinerules",
                kind: RulesKind::Dir(".md"),
                report_if_missing: false,
            },
            RulesSource {
                scope: Scope::Project,
                path: ".cline/rules",
                kind: RulesKind::Dir(".md"),
                report_if_missing: false,
            },
            RulesSource {
                scope: Scope::Project,
                path: "AGENTS.md",
                kind: RulesKind::File,
                report_if_missing: false,
            },
        ],
        refused: &[".cline/data/settings/providers.json", ".cline/data/secrets.json"],
    },
];

/// The largest number of rules files read from one directory.
const MAX_RULES_PER_DIR: usize = 12;

struct Reader {
    home: PathBuf,
    notes: Vec<String>,
    skipped: Vec<SkippedFile>,
}

/// Why a declared file was not read. Each becomes a short reason; never any file content.
#[derive(Debug)]
enum Refusal {
    Absent,
    Credential,
    OutsideFolder,
    TooLarge(u64),
    Unreadable,
}

/// True when any component of `path` names a credential file or folder (SPEC 5), using both the
/// Switchboard's list and the adapters' list (which also covers .ssh, .aws, .netrc and similar).
fn credential_path(path: &Path) -> bool {
    orrery_adapters::credentials::is_credential_file(path)
        || path.components().any(|c| {
            let name = c.as_os_str().to_string_lossy();
            is_credential_file_name(&name)
                || orrery_adapters::credentials::is_credential_file(Path::new(c.as_os_str()))
        })
}

/// `credential_path` for a file inside `root` (P3-1). The folders that make up the root are
/// checked against credential stores only (.ssh, .aws and similar), so a project called
/// keychain-app or notes.pem is read; every name below the root gets the full check.
fn credential_path_below(path: &Path, root: &Path) -> bool {
    let above_is_store = root
        .components()
        .any(|c| orrery_adapters::credentials::is_credential_place(&c.as_os_str().to_string_lossy()));
    match path.strip_prefix(root) {
        Ok(below) => above_is_store || credential_path(below) || orrery_adapters::credentials::is_credential_file(path),
        Err(_) => credential_path(path),
    }
}

/// Read one declared file through the product read boundary (R2-RC-1, LA-1). `root` is the folder
/// the file belongs to: the agent's own config folder for a global file, the project root for a
/// project file. The file's real location must sit inside that root (a link may point elsewhere
/// inside it, never out of it); no part of the resolved path may name a credential file or
/// folder; the open itself is no-follow (ReadBoundary). A file that sits directly in the home
/// folder has no smaller folder to stay in, so a link there is never followed at all.
fn guarded_read(path: &Path, root: &Path, home: &Path) -> Result<String, Refusal> {
    use orrery_adapters::readers::jsonl::ReaderError;
    let link_meta = std::fs::symlink_metadata(path).map_err(|_| Refusal::Absent)?;
    let canonical_root = root.canonicalize().map_err(|_| Refusal::Absent)?;
    if link_meta.file_type().is_symlink() {
        let canonical_home = home.canonicalize().ok();
        if canonical_home.as_deref() == Some(canonical_root.as_path()) {
            return Err(Refusal::OutsideFolder);
        }
    }
    // A dangling link is simply absent. Canonicalizing never opens file contents.
    let canonical = path.canonicalize().map_err(|_| Refusal::Absent)?;
    if !canonical.starts_with(&canonical_root) {
        return Err(Refusal::OutsideFolder);
    }
    if credential_path_below(&canonical, &canonical_root) {
        return Err(Refusal::Credential);
    }
    let meta = std::fs::metadata(&canonical).map_err(|_| Refusal::Absent)?;
    if !meta.is_file() {
        return Err(Refusal::Absent);
    }
    if meta.len() > MAX_CONFIG_BYTES {
        return Err(Refusal::TooLarge(meta.len()));
    }
    let boundary = orrery_adapters::boundary::ReadBoundary::new_for_project_roots(&[canonical_root])
        .map_err(|e| match e {
            ReaderError::CredentialBlocked(_) => Refusal::Credential,
            _ => Refusal::Unreadable,
        })?;
    match boundary.read(&canonical) {
        Ok(source) => {
            if source.bytes.len() as u64 > MAX_CONFIG_BYTES {
                return Err(Refusal::TooLarge(source.bytes.len() as u64));
            }
            String::from_utf8(source.bytes).map_err(|_| Refusal::Unreadable)
        }
        Err(ReaderError::CredentialBlocked(_)) => Err(Refusal::Credential),
        Err(ReaderError::Boundary(_)) => Err(Refusal::OutsideFolder),
        Err(ReaderError::Limit(_)) => Err(Refusal::TooLarge(meta.len())),
        Err(ReaderError::Io(e)) if e.kind() == std::io::ErrorKind::NotFound => Err(Refusal::Absent),
        Err(_) => Err(Refusal::Unreadable),
    }
}

impl Reader {
    fn new(home: &Path) -> Self {
        Self {
            home: home.to_path_buf(),
            notes: Vec::new(),
            skipped: Vec::new(),
        }
    }

    /// Read a declared file as text (see `guarded_read`). Credential names are refused before
    /// the open, absent files are silent, refusals and oversized files become short notes.
    fn read_text(&mut self, path: &Path, root: &Path, display: &str) -> Option<String> {
        let file_name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        if is_credential_file_name(&file_name) {
            if std::fs::symlink_metadata(path).is_ok() {
                self.skipped.push(SkippedFile {
                    path: display.to_string(),
                    reason: "credentialFile".to_string(),
                });
            }
            return None;
        }
        match guarded_read(path, root, &self.home) {
            Ok(text) => Some(text),
            Err(Refusal::Absent) => None,
            Err(Refusal::Credential) => {
                self.skipped.push(SkippedFile {
                    path: display.to_string(),
                    reason: "credentialFile".to_string(),
                });
                None
            }
            Err(Refusal::OutsideFolder) => {
                self.skipped.push(SkippedFile {
                    path: display.to_string(),
                    reason: "linkOutsideFolder".to_string(),
                });
                None
            }
            Err(Refusal::TooLarge(len)) => {
                self.notes
                    .push(format!("{display} is too large to read ({len} bytes)"));
                None
            }
            Err(Refusal::Unreadable) => {
                self.notes.push(format!("could not read {display}"));
                None
            }
        }
    }
}

/// The folder a global file belongs to: its own parent folder (for example `~/.claude` for
/// `~/.claude/CLAUDE.md`). For a file directly in the home folder that is the home folder, where
/// links are never followed.
fn global_root(path: &Path, home: &Path) -> PathBuf {
    path.parent().map(Path::to_path_buf).unwrap_or_else(|| home.to_path_buf())
}

fn global_display(relative: &str) -> String {
    format!("~/{relative}")
}

fn project_display(label: &str, relative: &str) -> String {
    if relative.is_empty() {
        label.to_string()
    } else {
        format!("{label}/{relative}")
    }
}

fn value_to_string(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

pub fn scan(context: &ScanContext, agent_id: Option<&str>) -> Result<ConfigSnapshot, ConfigScanError> {
    if let Some(id) = agent_id {
        if !AGENTS.iter().any(|spec| spec.id == id) {
            return Err(ConfigScanError {
                kind: ConfigScanErrorKind::UnknownAgent,
                message: format!("no config reader for agent '{id}'"),
            });
        }
    }

    let mut agents: Vec<AgentConfig> = Vec::new();
    for spec in AGENTS {
        if agent_id.map(|id| id != spec.id).unwrap_or(false) {
            continue;
        }
        agents.push(scan_agent(spec, context));
    }

    let server_matrix = build_matrix(&agents);
    let server_count = agents.iter().map(|a| a.servers.len()).sum();
    let masked_value_count: usize = agents
        .iter()
        .map(|a| {
            a.servers
                .iter()
                .map(|s| s.masked_values)
                .sum::<usize>()
                + a.rules.iter().map(|r| r.masked_values).sum::<usize>()
        })
        .sum();
    let mut projects: Vec<String> = Vec::new();
    for root in context.project_roots() {
        let label = ScanContext::project_label(root);
        if !projects.contains(&label) {
            projects.push(label);
        }
    }

    Ok(ConfigSnapshot {
        agents,
        server_matrix,
        projects,
        server_count,
        masked_value_count,
    })
}

fn scan_agent(spec: &'static AgentSpec, context: &ScanContext) -> AgentConfig {
    let mut reader = Reader::new(context.home());

    // Known credential neighbours: record the refusal, never the contents.
    for relative in spec.refused {
        let path = ScanContext::checked_join(context.home(), relative);
        let display = global_display(relative);
        match path {
            Ok(path) if path.is_file() => reader.skipped.push(SkippedFile {
                path: display,
                reason: "credentialFile".to_string(),
            }),
            _ => {}
        }
    }

    let mut servers = Vec::new();
    for source in spec.sources {
        collect_servers(spec, source, context, &mut reader, &mut servers);
    }

    let rules = collect_rules(spec, context, &mut reader);

    // Deterministic order: global scope first, then name, then the file it came from.
    servers.sort_by_key(|server| {
        (
            server.scope != Scope::Global,
            server.name.clone(),
            server.source_path.clone(),
        )
    });

    AgentConfig {
        agent: spec.id.to_string(),
        display_name: spec.display_name.to_string(),
        vendor: spec.vendor.to_string(),
        servers,
        rules,
        skipped: reader.skipped,
        notes: reader.notes,
    }
}

fn collect_servers(
    spec: &'static AgentSpec,
    source: &ConfigSource,
    context: &ScanContext,
    reader: &mut Reader,
    out: &mut Vec<McpServer>,
) {
    match source.scope {
        Scope::Global => {
            let path = match ScanContext::checked_join(context.home(), source.path) {
                Ok(path) => path,
                Err(err) => {
                    reader.notes.push(err.message);
                    return;
                }
            };
            let display = global_display(source.path);
            let root = global_root(&path, context.home());
            read_servers_from(spec, source, &path, &root, &display, None, reader, out);
        }
        Scope::Project => {
            for root in context.project_roots() {
                let label = ScanContext::project_label(root);
                let path = match ScanContext::checked_join(root, source.path) {
                    Ok(path) => path,
                    Err(err) => {
                        reader.notes.push(err.message);
                        continue;
                    }
                };
                let display = project_display(&label, source.path);
                read_servers_from(spec, source, &path, root, &display, Some(label), reader, out);
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn read_servers_from(
    spec: &AgentSpec,
    source: &ConfigSource,
    path: &Path,
    root: &Path,
    display: &str,
    project: Option<String>,
    reader: &mut Reader,
    out: &mut Vec<McpServer>,
) {
    let Some(text) = reader.read_text(path, root, display) else {
        return;
    };
    let root: serde_json::Value = match source.dialect {
        Dialect::CodexToml => match toml::from_str::<toml::Value>(&text) {
            Ok(value) => match serde_json::to_value(value) {
                Ok(json) => json,
                Err(_) => {
                    // Never the converter's message: it can quote the file.
                    reader.notes.push(format!("could not parse {display}"));
                    return;
                }
            },
            Err(_) => {
                // A short reason only: the TOML error quotes the offending line of the file.
                reader.notes.push(format!("could not parse {display}"));
                return;
            }
        },
        _ => match serde_json::from_str(&text) {
            Ok(value) => value,
            Err(_) => {
                reader.notes.push(format!("could not parse {display}"));
                return;
            }
        },
    };

    if source.dialect == Dialect::ClaudeProjectsMap {
        // Each entry is one project's own server list, keyed by its absolute path. The key
        // is read as a label only, never opened, so any project on the machine is shown.
        let Some(projects) = root.get("projects").and_then(|v| v.as_object()) else {
            return;
        };
        for (key, entry) in projects {
            let label = key
                .rsplit(['/', '\\'])
                .find(|part| !part.is_empty())
                .unwrap_or("project")
                .to_string();
            let Some(map) = entry.get("mcpServers").and_then(|v| v.as_object()) else {
                continue;
            };
            let scoped_display = format!("{display}#projects/{label}");
            append_servers(
                spec,
                source.dialect,
                map.iter(),
                Scope::Project,
                Some(label),
                &scoped_display,
                reader,
                out,
            );
        }
        return;
    }

    let container = match source.dialect {
        Dialect::OpenCode => "mcp",
        Dialect::CodexToml => "mcp_servers",
        _ => "mcpServers",
    };
    match root.get(container).and_then(|v| v.as_object()) {
        Some(map) => append_servers(
            spec,
            source.dialect,
            map.iter(),
            source.scope,
            project,
            display,
            reader,
            out,
        ),
        // Copilot accepts a bare top level map instead of the mcpServers wrapper.
        None if spec.id == "copilot-cli" => {
            let Some(object) = root.as_object() else { return };
            append_servers(
                spec,
                source.dialect,
                object
                    .iter()
                    .filter(|(key, _)| !COPILOT_TOP_LEVEL_KEYS.contains(&key.as_str())),
                source.scope,
                project,
                display,
                reader,
                out,
            );
        }
        None => {}
    }
}

/// Keys in a Copilot config that are not server definitions.
const COPILOT_TOP_LEVEL_KEYS: &[&str] = &["mcpServers", "user", "projects", "$schema"];

fn append_servers<'a>(
    spec: &AgentSpec,
    dialect: Dialect,
    entries: impl Iterator<Item = (&'a String, &'a serde_json::Value)>,
    scope: Scope,
    project: Option<String>,
    display: &str,
    reader: &mut Reader,
    out: &mut Vec<McpServer>,
) {
    for (name, entry) in entries {
        let Some(entry) = entry.as_object() else {
            reader
                .notes
                .push(format!("{display}: server '{name}' is not an object, skipped"));
            continue;
        };
        out.push(build_server(
            spec.id,
            name,
            entry,
            dialect,
            scope,
            project.clone(),
            display,
        ));
    }
}

fn build_server(
    agent: &str,
    name: &str,
    entry: &serde_json::Map<String, serde_json::Value>,
    dialect: Dialect,
    scope: Scope,
    project: Option<String>,
    display: &str,
) -> McpServer {
    // OpenCode puts the whole command line in one array: command plus args.
    let (command, raw_args): (Option<String>, Vec<String>) = match entry.get("command") {
        Some(serde_json::Value::Array(parts)) if dialect == Dialect::OpenCode => {
            let mut parts = parts.iter().map(value_to_string);
            let command = parts.next();
            (command, parts.collect())
        }
        Some(value) => (
            Some(value_to_string(value)),
            entry
                .get("args")
                .and_then(|v| v.as_array())
                .map(|args| args.iter().map(value_to_string).collect())
                .unwrap_or_default(),
        ),
        None => (None, Vec::new()),
    };

    let (args, mut referenced, mut masked) = mask_args(&raw_args);
    // Some configs put a whole command line in "command" (PRIV-3): mask it like an argument.
    let command = command.map(|c| {
        if let Some(names) = extract_var_names(&c) {
            for name in names {
                push_unique(&mut referenced, name);
            }
        }
        let (shown, count) = mask_arg_value(&c);
        masked += count;
        shown
    });

    // Agents spell "remote server" differently: url, httpUrl (Gemini streamable) or
    // serverUrl (Windsurf).
    let url_keys: &[&str] = match dialect {
        Dialect::CodexToml | Dialect::OpenCode => &["url"],
        _ => &["url", "httpUrl", "serverUrl"],
    };
    let mut url: Option<String> = None;
    let mut url_key: Option<&str> = None;
    for key in url_keys {
        if let Some(value) = entry.get(*key).and_then(|v| v.as_str()) {
            let (masked_url, names, count) = mask_url(value);
            url = Some(masked_url);
            url_key = Some(key);
            masked += count;
            for name in names {
                push_unique(&mut referenced, name);
            }
            break;
        }
    }

    let transport = transport_of(entry, command.as_deref(), url_key, agent);

    let mut env_names: Vec<String> = Vec::new();
    let mut header_names: Vec<String> = Vec::new();
    // Only the variable NAMES inside an env or header value are ever taken; the value
    // itself is dropped without being stored.
    for (key, is_header) in [
        ("env", false),
        ("environment", false),
        ("headers", true),
        ("http_headers", true),
    ] {
        if let Some(map) = entry.get(key).and_then(|v| v.as_object()) {
            for (name, value) in map {
                let target = if is_header { &mut header_names } else { &mut env_names };
                push_unique(target, name.clone());
                if let Some(names) = value.as_str().and_then(extract_var_names) {
                    for var_name in names {
                        push_unique(&mut referenced, var_name);
                    }
                }
            }
        }
    }
    if let Some(serde_json::Value::Array(list)) = entry.get("env_vars") {
        for item in list {
            let name = match item {
                serde_json::Value::String(name) => Some(name.clone()),
                serde_json::Value::Object(object) => object.get("name").map(value_to_string),
                _ => None,
            };
            if let Some(name) = name {
                push_unique(&mut env_names, name);
            }
        }
    }
    // Codex names the variable that holds a bearer token instead of carrying the token.
    if let Some(name) = entry.get("bearer_token_env_var").and_then(|v| v.as_str()) {
        push_unique(&mut env_names, name.to_string());
    }
    if let Some(map) = entry.get("env_http_headers").and_then(|v| v.as_object()) {
        for name in map.values() {
            if let Some(name) = name.as_str() {
                push_unique(&mut env_names, name.to_string());
            }
        }
    }

    let enabled = match (
        entry.get("disabled").and_then(|v| v.as_bool()),
        entry.get("enabled").and_then(|v| v.as_bool()),
    ) {
        (Some(true), _) => false,
        (_, Some(false)) => false,
        _ => true,
    };

    McpServer {
        agent: agent.to_string(),
        name: name.to_string(),
        scope,
        project,
        transport,
        command,
        args,
        url,
        env_names: sorted_unique(env_names),
        header_names: sorted_unique(header_names),
        referenced_env_names: sorted_unique(referenced),
        enabled,
        masked_values: masked,
        source_path: display.to_string(),
    }
}

fn transport_of(
    entry: &serde_json::Map<String, serde_json::Value>,
    command: Option<&str>,
    url_key: Option<&str>,
    agent: &str,
) -> Transport {
    if let Some(kind) = entry.get("type").and_then(|v| v.as_str()) {
        return match kind.to_ascii_lowercase().replace('-', "").as_str() {
            "stdio" | "local" => Transport::Stdio,
            "http" | "streamablehttp" | "streamable" | "remote" => Transport::Http,
            "sse" => Transport::Sse,
            _ => Transport::Unknown,
        };
    }
    if command.is_some() {
        return Transport::Stdio;
    }
    match url_key {
        // Gemini: `url` is the SSE transport and `httpUrl` is streamable HTTP.
        Some("url") if agent == "gemini-cli" => Transport::Sse,
        Some(_) => Transport::Http,
        None => Transport::Unknown,
    }
}

fn sorted_unique(mut list: Vec<String>) -> Vec<String> {
    list.sort();
    list.dedup();
    list
}

fn collect_rules(spec: &AgentSpec, context: &ScanContext, reader: &mut Reader) -> Vec<RulesFile> {
    let mut out = Vec::new();
    for source in spec.rules {
        // (declared path, the folder it must stay in, display path)
        let roots: Vec<(PathBuf, PathBuf, String)> = match source.scope {
            Scope::Global => {
                let joined = ScanContext::checked_join(context.home(), source.path)
                    .unwrap_or_else(|_| context.home().to_path_buf());
                let root = global_root(&joined, context.home());
                vec![(joined, root, global_display(source.path))]
            }
            Scope::Project => context
                .project_roots()
                .iter()
                .map(|root| {
                    let label = ScanContext::project_label(root);
                    let joined = ScanContext::checked_join(root, source.path)
                        .unwrap_or_else(|_| root.clone());
                    (joined, root.clone(), project_display(&label, source.path))
                })
                .collect(),
        };

        for (path, root, display) in roots {
            match source.kind {
                RulesKind::File => {
                    let text = reader.read_text(&path, &root, &display);
                    match text {
                        Some(text) => {
                            out.push(rules_entry(spec.id, source.scope, &display, &text))
                        }
                        None if source.report_if_missing => {
                            out.push(absent_rules(spec.id, source.scope, &display))
                        }
                        None => {}
                    }
                }
                RulesKind::Dir(suffix) => {
                    // The folder itself must be a real folder inside its root: a linked rules
                    // folder that leads elsewhere (such as ~/.ssh) is never listed.
                    let Ok(dir_meta) = std::fs::symlink_metadata(&path) else {
                        continue;
                    };
                    let contained = match (path.canonicalize(), root.canonicalize()) {
                        (Ok(real), Ok(real_root)) => real.starts_with(&real_root) && !credential_path_below(&real, &real_root),
                        _ => false,
                    };
                    if !contained || !(dir_meta.is_dir() || dir_meta.file_type().is_symlink()) {
                        if dir_meta.file_type().is_symlink() {
                            reader.skipped.push(SkippedFile {
                                path: display.clone(),
                                reason: "linkOutsideFolder".to_string(),
                            });
                        }
                        continue;
                    }
                    let Ok(entries) = std::fs::read_dir(&path) else {
                        continue;
                    };
                    let mut names: Vec<String> = entries
                        .flatten()
                        .filter_map(|entry| {
                            let name = entry.file_name().to_string_lossy().to_string();
                            // file_type does not follow links; a linked entry is checked by the
                            // guarded read below like any other file.
                            let kind = entry.file_type().ok()?;
                            (kind.is_file() || kind.is_symlink())
                                .then(|| name.ends_with(suffix).then_some(name))
                                .flatten()
                        })
                        .filter(|name| !is_credential_file_name(name))
                        .collect();
                    names.sort();
                    if names.len() > MAX_RULES_PER_DIR {
                        reader.notes.push(format!(
                            "{display}: more than {MAX_RULES_PER_DIR} rules files, showing the first {MAX_RULES_PER_DIR}"
                        ));
                        names.truncate(MAX_RULES_PER_DIR);
                    }
                    // A global rules folder is its own root; a project one stays in the project.
                    let child_root = match source.scope {
                        Scope::Global => path.clone(),
                        Scope::Project => root.clone(),
                    };
                    for name in names {
                        let child_display = format!("{display}/{name}");
                        let child = path.join(&name);
                        if let Some(text) = reader.read_text(&child, &child_root, &child_display) {
                            out.push(rules_entry(
                                spec.id,
                                source.scope,
                                &child_display,
                                &text,
                            ));
                        }
                    }
                }
            }
        }
    }
    out
}

fn absent_rules(agent: &str, scope: Scope, display: &str) -> RulesFile {
    RulesFile {
        agent: agent.to_string(),
        scope,
        project: project_label_of(scope, display),
        path: display.to_string(),
        format: format_of(display),
        exists: false,
        preview: None,
        truncated: false,
        line_count: 0,
        masked_values: 0,
    }
}

/// Project display paths start with the project label: `webapp/CLAUDE.md`.
fn project_label_of(scope: Scope, display: &str) -> Option<String> {
    match scope {
        Scope::Global => None,
        Scope::Project => display.split('/').next().map(str::to_string),
    }
}

fn rules_entry(agent: &str, scope: Scope, display: &str, text: &str) -> RulesFile {
    let (masked_text, masked_values) = mask_preview(text);
    let line_count = text.lines().count();
    let mut taken: Vec<&str> = Vec::new();
    let mut length = 0usize;
    let mut truncated = line_count > PREVIEW_MAX_LINES;
    for line in masked_text.lines().take(PREVIEW_MAX_LINES) {
        if length + line.len() + 1 > PREVIEW_MAX_CHARS {
            truncated = true;
            break;
        }
        length += line.len() + 1;
        taken.push(line);
    }
    let preview = taken.join("\n");

    RulesFile {
        agent: agent.to_string(),
        scope,
        project: project_label_of(scope, display),
        path: display.to_string(),
        format: format_of(display),
        exists: true,
        preview: Some(preview),
        truncated,
        line_count,
        masked_values,
    }
}

fn format_of(display: &str) -> RulesFormat {
    if display.ends_with(".mdc") {
        RulesFormat::Mdc
    } else if display.ends_with(".md") {
        RulesFormat::Markdown
    } else {
        RulesFormat::Text
    }
}

fn build_matrix(agents: &[AgentConfig]) -> Vec<ServerPresence> {
    let mut names: Vec<String> = agents
        .iter()
        .flat_map(|a| a.servers.iter().map(|s| s.name.clone()))
        .collect();
    names.sort();
    names.dedup();

    names
        .into_iter()
        .map(|name| {
            let mut present_in: Vec<String> = Vec::new();
            let mut missing_from: Vec<String> = Vec::new();
            let mut signatures: Vec<String> = Vec::new();
            for agent in agents {
                let entries: Vec<&McpServer> = agent
                    .servers
                    .iter()
                    .filter(|server| server.name == name)
                    .collect();
                if entries.is_empty() {
                    missing_from.push(agent.agent.clone());
                    continue;
                }
                present_in.push(agent.agent.clone());
                for server in entries {
                    let signature = format!(
                        "{:?}|{}|{}|{}",
                        server.transport,
                        server.command.clone().unwrap_or_default(),
                        server.args.join(" "),
                        server.url.clone().unwrap_or_default()
                    );
                    push_unique(&mut signatures, signature);
                }
            }
            let shared_by_all = missing_from.is_empty();
            ServerPresence {
                name,
                present_in,
                missing_from,
                definitions: signatures.len(),
                shared_by_all,
            }
        })
        .collect()
}

/// Which of the requested project folders the scan may read. A folder is kept only when it is an absolute
/// path to an existing directory whose real (symlink-resolved) location is under the real home folder or is
/// the real location of a project root the archive recorded. The result holds those real locations, so the
/// scan reads exactly what was checked (a symlink cannot be swapped in between). Duplicates collapse, the
/// first occurrence keeps its place, and everything else is dropped silently: an archived project may have
/// been deleted.
pub fn accepted_project_roots(
    requested: &[String],
    home: &Path,
    archive_roots: &[String],
) -> Vec<PathBuf> {
    let real_home = home.canonicalize().ok();
    let known: std::collections::HashSet<PathBuf> = archive_roots
        .iter()
        .filter_map(|root| {
            let path = Path::new(root);
            if path.is_absolute() {
                path.canonicalize().ok()
            } else {
                None
            }
        })
        .collect();
    let mut seen: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
    let mut accepted = Vec::new();
    for root in requested {
        let path = Path::new(root);
        if !path.is_absolute() {
            continue;
        }
        let real = match path.canonicalize() {
            // the filesystem root is never a project, even when an archive row names it
            Ok(real) if real.is_dir() && real.parent().is_some() => real,
            _ => continue,
        };
        let under_home = real_home.as_ref().is_some_and(|h| real.starts_with(h));
        if !(under_home || known.contains(&real)) {
            continue;
        }
        if seen.insert(real.clone()) {
            accepted.push(real);
        }
    }
    accepted
}

/// Every distinct project root recorded in the archive, in the order first seen.
pub fn archive_project_roots(
    archive: &orrery_archive::Archive,
) -> Result<Vec<String>, crate::archive_api::ApiError> {
    use crate::archive_api::{sessions_query_core, SessionQuery};
    const PAGE: u32 = 200;
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut roots = Vec::new();
    let mut offset: u32 = 0;
    loop {
        let page = sessions_query_core(
            archive,
            &SessionQuery { limit: Some(PAGE), offset: Some(offset), ..SessionQuery::default() },
        )?;
        if page.items.is_empty() {
            break;
        }
        for session in &page.items {
            if let Some(root) = session.project_root.as_deref() {
                if !root.is_empty() && seen.insert(root.to_string()) {
                    roots.push(root.to_string());
                }
            }
        }
        offset = offset.saturating_add(page.items.len() as u32);
        if u64::from(offset) >= page.total {
            break;
        }
    }
    Ok(roots)
}

fn scan_error(err: ConfigScanError) -> crate::archive_api::ApiError {
    let code = match err.kind {
        ConfigScanErrorKind::UnknownAgent => "invalid_input",
        _ => "config_failed",
    };
    crate::archive_api::ApiError { code: code.into(), message: err.message }
}

/// Consent-gated form of the command: without recorded consent no scan context is built and no
/// config, rules or MCP file is read.
pub fn config_list_in(
    data_dir: &Path,
    archive: &orrery_archive::Archive,
    make_context: impl FnOnce() -> Result<ScanContext, ConfigScanError>,
    agent_id: Option<&str>,
    project_roots: Option<Vec<String>>,
) -> Result<ConfigSnapshot, crate::archive_api::ApiError> {
    crate::archive_api::consent::require(data_dir)?;
    let context = make_context().map_err(scan_error)?;
    let requested = project_roots.unwrap_or_default();
    // If the archive cannot list its projects, only folders under the home folder are trusted.
    let archive_roots = archive_project_roots(archive).unwrap_or_default();
    let roots = accepted_project_roots(&requested, context.home(), &archive_roots);
    scan(&context.with_project_roots(roots), agent_id).map_err(scan_error)
}

#[tauri::command]
pub fn config_list(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::archive_api::CoreState>,
    agent_id: Option<String>,
    project_roots: Option<Vec<String>>,
) -> Result<ConfigSnapshot, crate::archive_api::ApiError> {
    let data_dir = crate::archive_api::app_data_dir_of(&app)?;
    config_list_in(&data_dir, &state.archive, ScanContext::from_environment, agent_id.as_deref(), project_roots)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures/switchboard")
            .canonicalize()
            .expect("fixture folder exists")
    }

    fn fixture_context() -> ScanContext {
        let root = fixture_root();
        ScanContext::new(root.join("home"), vec![root.join("project/webapp")])
    }

    /// R2-REV-1 / LA-2: the Switchboard's scan refuses after "Not now" before building any context.
    #[test]
    fn config_list_refuses_after_decline_and_reads_nothing() {
        use crate::archive_api::testkit::{tmp, write_consented, write_declined};
        let data = tmp();
        let home = tmp();
        std::fs::create_dir_all(home.path().join(".claude")).unwrap();
        std::fs::write(home.path().join(".claude/CLAUDE.md"), "FAKE-RULES-LINE\n").unwrap();
        let archive = orrery_archive::Archive::in_memory().unwrap();
        for declined in [false, true] {
            if declined {
                write_declined(data.path());
            }
            let mut built = false;
            let err = config_list_in(data.path(), &archive, || {
                built = true;
                Ok(ScanContext::new(home.path().to_path_buf(), Vec::new()))
            }, None, None)
            .unwrap_err();
            assert_eq!(err.code, "consent_required");
            assert!(!built, "no scan context (and so no read) without consent");
        }
        write_consented(data.path());
        let snap = config_list_in(data.path(), &archive, || Ok(ScanContext::new(home.path().to_path_buf(), Vec::new())), None, None).unwrap();
        assert!(serde_json::to_string(&snap).unwrap().contains("FAKE-RULES-LINE"), "control: consent reads the fake HOME");
    }

    fn link(target: &str, at: &Path) {
        std::fs::create_dir_all(at.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(target, at).unwrap();
    }

    /// A fake HOME under /tmp with fake credential files holding canary text.
    fn canary_home() -> (tempfile::TempDir, PathBuf) {
        let tmp = crate::archive_api::testkit::tmp();
        let home = tmp.path().canonicalize().unwrap();
        for (rel, body) in [
            (".aws/credentials", "[default]\naws_access_key_id = AKIAFAKEFAKEFAKE1234\naws_secret_access_key = CANARYSECRETVALUE\n"),
            (".ssh/id_rsa", "-----BEGIN OPENSSH PRIVATE KEY-----\nCANARYKEYBODY\n-----END OPENSSH PRIVATE KEY-----\n"),
            (".netrc", "machine api.example.com login fakeuser password CANARYNETRC\n"),
            (".config/gh/hosts.yml", "github.com:\n  oauth_token: CANARYGHTOKEN\n  user: fakeuser\n"),
        ] {
            let p = home.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, body).unwrap();
        }
        (tmp, home)
    }

    fn assert_no_canary(snapshot: &ConfigSnapshot) {
        let json = serde_json::to_string(snapshot).unwrap();
        for canary in ["CANARY", "AKIAFAKE", "BEGIN OPENSSH", "aws_secret_access_key", "parse error", "line 2"] {
            assert!(!json.contains(canary), "{canary:?} leaked into the snapshot: {json}");
        }
    }

    /// R2-RC-1 / LA-1: links named like config or rules files that point at credential files (or
    /// anywhere outside their folder) are never opened, for every agent and dialect.
    #[test]
    fn symlinked_configs_and_rules_pointing_at_credentials_are_refused() {
        let (_tmp, home) = canary_home();
        let project = home.join("code/evilrepo");
        std::fs::create_dir_all(&project).unwrap();
        for (target, at) in [
            ("../../../.aws/credentials", ".codex/config.toml"),
            ("../../.aws/credentials", ".mcp.json"),
            ("../../.ssh/id_rsa", "CLAUDE.md"),
            ("../../.netrc", "AGENTS.md"),
            ("../../.aws/credentials", ".cursorrules"),
            ("../../../../.config/gh/hosts.yml", ".cursor/rules/a.mdc"),
            ("../../../../.ssh/id_rsa", ".claude/rules/r.md"),
            ("../../.netrc", "GEMINI.md"),
            ("../../../.aws/credentials", ".gemini/settings.json"),
            ("../../../.aws/credentials", ".cursor/mcp.json"),
            ("../../.aws/credentials", "opencode.json"),
            ("../../.netrc", ".windsurfrules"),
            ("../../.netrc", ".clinerules"),
            ("../../../.netrc", ".github/copilot-instructions.md"),
        ] {
            link(target, &project.join(at));
        }
        // Global files linked out of their agent folder.
        link("../.ssh/id_rsa", &home.join(".claude/CLAUDE.md"));
        link("../.aws/credentials", &home.join(".codex/config.toml"));
        link(".aws/credentials", &home.join(".claude.json"));
        link("../../.netrc", &home.join(".config/opencode/AGENTS.md"));
        // A link that stays inside its project is fine and still read.
        std::fs::create_dir_all(project.join("docs")).unwrap();
        std::fs::write(project.join("docs/rules.md"), "LEGIT_RULES_TEXT\n").unwrap();
        link("../../docs/rules.md", &project.join(".github/instructions/x.instructions.md"));

        let snapshot = scan(&ScanContext::new(home.clone(), vec![project.clone()]), None).unwrap();
        assert_no_canary(&snapshot);
        let json = serde_json::to_string(&snapshot).unwrap();
        assert!(json.contains("LEGIT_RULES_TEXT"), "a link inside the project is still read");
        let skipped: Vec<&SkippedFile> = snapshot.agents.iter().flat_map(|a| a.skipped.iter()).collect();
        assert!(skipped.iter().any(|s| s.reason == "linkOutsideFolder"), "refusals are reported: {skipped:?}");
    }

    /// The worst case: the user's home folder itself is a known project root, so containment alone
    /// cannot help. Credential folders and names on the resolved path are refused.
    #[test]
    fn home_as_project_root_never_follows_links_to_credentials() {
        let (_tmp, home) = canary_home();
        link(".ssh/id_rsa", &home.join("CLAUDE.md"));
        link(".netrc", &home.join("AGENTS.md"));
        link(".aws/credentials", &home.join(".mcp.json"));
        link(".config/gh/hosts.yml", &home.join(".cursorrules"));
        let snapshot = scan(&ScanContext::new(home.clone(), vec![home.clone()]), None).unwrap();
        assert_no_canary(&snapshot);
    }

    /// Parse failures show a short reason only, never the parser's quote of the file.
    #[test]
    fn parse_errors_never_quote_file_contents() {
        let tmp = crate::archive_api::testkit::tmp();
        let home = tmp.path().canonicalize().unwrap();
        std::fs::create_dir_all(home.join(".codex")).unwrap();
        std::fs::write(home.join(".codex/config.toml"), "[mcp_servers.x]\ntoken = CANARYPARSE oops\n").unwrap();
        std::fs::create_dir_all(home.join(".cursor")).unwrap();
        std::fs::write(home.join(".cursor/mcp.json"), "{\"mcpServers\": CANARYJSON }").unwrap();
        let snapshot = scan(&ScanContext::new(home.clone(), Vec::new()), None).unwrap();
        let json = serde_json::to_string(&snapshot).unwrap();
        assert!(!json.contains("CANARY"), "{json}");
        let notes: Vec<&String> = snapshot.agents.iter().flat_map(|a| a.notes.iter()).collect();
        assert!(notes.iter().any(|n| n.as_str() == "could not parse ~/.codex/config.toml"), "{notes:?}");
        assert!(notes.iter().any(|n| n.as_str() == "could not parse ~/.cursor/mcp.json"), "{notes:?}");
    }

    fn scan_all() -> ConfigSnapshot {
        scan(&fixture_context(), None).expect("fixture scan succeeds")
    }

    fn agent(snapshot: &ConfigSnapshot, id: &str) -> AgentConfig {
        snapshot
            .agents
            .iter()
            .find(|a| a.agent == id)
            .unwrap_or_else(|| panic!("agent {id} missing from snapshot"))
            .clone()
    }

    fn server(entry: &AgentConfig, name: &str, scope: Scope) -> McpServer {
        entry
            .servers
            .iter()
            .find(|s| s.name == name && s.scope == scope)
            .unwrap_or_else(|| panic!("server {name} in {scope:?} scope missing for {}", entry.agent))
            .clone()
    }

    fn presence(snapshot: &ConfigSnapshot, name: &str) -> ServerPresence {
        snapshot
            .server_matrix
            .iter()
            .find(|p| p.name == name)
            .unwrap_or_else(|| panic!("no matrix row for {name}"))
            .clone()
    }

    // -- coverage -----------------------------------------------------------

    #[test]
    fn scans_every_supported_agent() {
        let snapshot = scan_all();
        let ids: Vec<&str> = snapshot.agents.iter().map(|a| a.agent.as_str()).collect();
        for expected in [
            "claude-code",
            "codex-cli",
            "gemini-cli",
            "cursor",
            "opencode",
            "copilot-cli",
            "windsurf",
            "cline",
        ] {
            assert!(ids.contains(&expected), "{expected} not scanned: {ids:?}");
        }
        assert_eq!(ids.len(), 8, "exactly the eight supported agents");
    }

    #[test]
    fn agent_id_filter_returns_one_agent_and_rejects_unknown() {
        let only = scan(&fixture_context(), Some("claude-code")).unwrap();
        assert_eq!(only.agents.len(), 1);
        assert_eq!(only.agents[0].agent, "claude-code");

        let err = scan(&fixture_context(), Some("not-an-agent")).unwrap_err();
        assert_eq!(err.kind, ConfigScanErrorKind::UnknownAgent);
    }

    // -- normalization ------------------------------------------------------

    #[test]
    fn claude_code_global_servers_normalize_stdio_and_http() {
        let claude = agent(&scan_all(), "claude-code");

        let playwright = server(&claude, "playwright", Scope::Global);
        assert_eq!(playwright.transport, Transport::Stdio);
        assert_eq!(playwright.command.as_deref(), Some("npx"));
        assert_eq!(
            playwright.args,
            vec!["-y".to_string(), "@playwright/mcp@0.0.35".to_string()]
        );
        assert_eq!(playwright.source_path, "~/.claude.json");
        assert_eq!(playwright.scope, Scope::Global);
        assert!(playwright.project.is_none());

        let linear = server(&claude, "linear", Scope::Global);
        assert_eq!(linear.transport, Transport::Http);
        assert!(linear.command.is_none());

        let sentry = server(&claude, "sentry", Scope::Global);
        assert_eq!(sentry.transport, Transport::Sse);

        let legacy = server(&claude, "disabled-legacy", Scope::Global);
        assert!(!legacy.enabled, "disabled flag is carried through");

        assert_eq!(claude.servers.iter().filter(|s| s.scope == Scope::Global).count(), 5);
    }

    #[test]
    fn project_scope_comes_from_project_files_and_global_project_maps() {
        let snapshot = scan_all();
        let claude = agent(&snapshot, "claude-code");

        // From webapp/.mcp.json
        let stripe = server(&claude, "stripe", Scope::Project);
        assert_eq!(stripe.project.as_deref(), Some("webapp"));
        assert_eq!(stripe.command.as_deref(), Some("npx"));

        // From the projects map inside ~/.claude.json. Both sources are kept: the
        // Switchboard shows where each definition lives rather than picking one.
        let from_global_map = claude
            .servers
            .iter()
            .find(|s| {
                s.name == "sqlite"
                    && s.scope == Scope::Project
                    && s.source_path == "~/.claude.json#projects/webapp"
            })
            .cloned()
            .expect("sqlite from the ~/.claude.json projects map");
        assert_eq!(from_global_map.project.as_deref(), Some("webapp"));
        assert!(claude
            .servers
            .iter()
            .any(|s| s.name == "sqlite" && s.source_path == "webapp/.mcp.json"));

        // Other agents reach the same project root through their own files.
        let codex = agent(&snapshot, "codex-cli");
        assert_eq!(server(&codex, "sqlite", Scope::Project).source_path, "webapp/.codex/config.toml");
        let cursor = agent(&snapshot, "cursor");
        assert_eq!(server(&cursor, "sqlite", Scope::Project).command.as_deref(), Some("uvx"));
        let opencode = agent(&snapshot, "opencode");
        assert_eq!(server(&opencode, "sqlite", Scope::Project).transport, Transport::Stdio);
        let gemini = agent(&snapshot, "gemini-cli");
        assert!(gemini
            .servers
            .iter()
            .any(|s| s.scope == Scope::Project && s.name == "puppeteer"));

        // Copilot CLI also reads the project `.mcp.json`, so one file feeds two agents.
        let copilot = agent(&snapshot, "copilot-cli");
        assert_eq!(server(&copilot, "stripe", Scope::Project).transport, Transport::Stdio);

        assert_eq!(snapshot.projects, vec!["webapp".to_string()]);
    }

    #[test]
    fn each_agent_dialect_is_understood() {
        let snapshot = scan_all();

        // Codex TOML: [mcp_servers.<name>] with env inline tables and a bearer var.
        let codex = agent(&snapshot, "codex-cli");
        let codex_docs = server(&codex, "remote-docs", Scope::Global);
        assert_eq!(codex_docs.transport, Transport::Http);
        assert!(codex_docs
            .env_names
            .contains(&"DOCS_MCP_TOKEN".to_string()),
        "bearer_token_env_var is an env name: {codex_docs:?}");
        assert_eq!(codex_docs.header_names, vec!["X-API-KEY".to_string()]);

        // Gemini: mcpServers inside settings.json, plus $VAR header references.
        // In Gemini, `url` is the SSE transport and `httpUrl` is streamable HTTP.
        let gemini = agent(&snapshot, "gemini-cli");
        let jira = server(&gemini, "jira", Scope::Global);
        assert_eq!(jira.transport, Transport::Sse);
        assert_eq!(jira.header_names, vec!["Authorization".to_string()]);

        // OpenCode: `mcp` container, local command arrays, `environment` map.
        let opencode = agent(&snapshot, "opencode");
        let greptile = server(&opencode, "greptile", Scope::Global);
        assert_eq!(greptile.transport, Transport::Http);
        let context7 = server(&opencode, "context7", Scope::Global);
        assert_eq!(context7.command.as_deref(), Some("npx"));
        assert_eq!(context7.env_names, vec!["CONTEXT7_API_KEY".to_string()]);
        // OpenCode reads secrets through its own reference syntax, documented at
        // https://opencode.ai/docs/mcp-servers/
        assert!(context7
            .referenced_env_names
            .contains(&"CONTEXT7_API_KEY".to_string()));

        // Windsurf remote servers use serverUrl, not url.
        let windsurf = agent(&snapshot, "windsurf");
        let db = server(&windsurf, "db-inspector", Scope::Global);
        assert_eq!(db.transport, Transport::Http);

        // Cline carries the two homes (VS Code extension globalStorage and the CLI folder).
        let cline = agent(&snapshot, "cline");
        assert!(cline
            .servers
            .iter()
            .any(|s| s.source_path.contains("globalStorage")));
        assert!(cline
            .servers
            .iter()
            .any(|s| s.source_path.starts_with("~/.cline")));
        assert!(server(&cline, "linear", Scope::Global)
            .args
            .is_empty());

        // Copilot CLI reads ~/.copilot/mcp-config.json.
        let copilot = agent(&snapshot, "copilot-cli");
        assert_eq!(server(&copilot, "github", Scope::Global).command.as_deref(), Some("docker"));
    }

    // -- secrets ------------------------------------------------------------

    #[test]
    fn secret_looking_arg_values_are_masked() {
        let snapshot = scan_all();
        let windsurf = agent(&snapshot, "windsurf");
        let exa = server(&windsurf, "exa", Scope::Global);
        let joined = exa.args.join(" ");
        assert!(joined.contains(MASKED), "expected a masked token, got: {joined}");
        assert!(!joined.contains("exaFAKE0123456789exaFAKE0123456789ab"));
        assert!(exa.masked_values >= 1);
        assert!(exa
            .args
            .contains(&"--api-key".to_string()), "the flag itself stays visible");

        let gemini = agent(&snapshot, "gemini-cli");
        let monitoring = server(&gemini, "monitoring", Scope::Global);
        assert!(!monitoring.args.join(" ").contains("ya29.FAKEGEMINIBEARER"));

        let claude = agent(&snapshot, "claude-code");
        let legacy = server(&claude, "disabled-legacy", Scope::Global);
        assert!(!legacy.args.join(" ").contains("sk-FAKEOPENAIKEY"));
    }

    #[test]
    fn env_and_header_values_are_never_collected() {
        let snapshot = scan_all();
        let json = serde_json::to_string(&snapshot).unwrap();

        // Values, including a harmless one, never appear.
        for value in [
            "ghp_FAKEGITHUBTOKENAAAAAAAAAAAAAAAAA",
            "ghp_FAKECODEXTOKENBBBBBBBBBBBBBBBBBBBB",
            "ghp_FAKECOPILOTTOKENCCCCCCCCCCCCCCCCCC",
            "AIzaFAKEGEMINIKEY0123456789ABCDEFGHIJK",
            "sbpat_FAKEPAT0123456789abcdefghijklmnop",
            "sk_live_FAKESTRIPEKEY0123456789abcdef",
            "upstash_FAKEKEY0123456789upstash_FAKEKEY01",
            "production",
        ] {
            assert!(!json.contains(value), "secret value leaked: {value}");
        }

        let codex = agent(&snapshot, "codex-cli");
        let github = server(&codex, "github", Scope::Global);
        assert!(github.env_names.contains(&"GITHUB_TOKEN".to_string()));
        assert!(github.env_names.contains(&"NODE_ENV".to_string()));
        assert_eq!(github.env_names.len(), 2, "names only, values dropped");

        let claude = agent(&snapshot, "claude-code");
        let linear = server(&claude, "linear", Scope::Global);
        assert_eq!(linear.header_names, vec!["Authorization".to_string()]);
        assert!(
            !linear.env_names.iter().any(|name| name == "Authorization"),
            "header names stay out of envNames: {:?}",
            linear.env_names
        );
        assert!(!linear
            .header_names
            .iter()
            .any(|h| h.contains("ya29")));
    }

    #[test]
    fn urls_keep_host_and_path_but_lose_credentials() {
        let snapshot = scan_all();
        let claude = agent(&snapshot, "claude-code");
        let linear = server(&claude, "linear", Scope::Global);
        let url = linear.url.clone().unwrap();
        assert!(url.starts_with("https://mcp.linear.app/mcp"), "{url}");
        assert!(url.contains("access_token=") && url.contains(MASKED), "{url}");
        assert!(!url.contains("linFAKE0123456789"));

        let windsurf = agent(&snapshot, "windsurf");
        let db = server(&windsurf, "db-inspector", Scope::Global);
        assert!(!db.url.clone().unwrap().contains("dbFAKE0123456789"));

        // A url with nothing secret is untouched.
        let sentry = server(&claude, "sentry", Scope::Global);
        assert_eq!(sentry.url.as_deref(), Some("https://mcp.sentry.dev/sse"));
        assert_eq!(sentry.masked_values, 0);
    }

    #[test]
    fn variable_references_are_names_not_secrets() {
        let snapshot = scan_all();
        let opencode = agent(&snapshot, "opencode");
        let context7 = server(&opencode, "context7", Scope::Global);
        assert!(context7
            .args
            .contains(&"{env:CONTEXT7_API_KEY}".to_string()), "{:?}", context7.args);
        assert_eq!(context7.masked_values, 0, "a reference is not a secret value");
        assert!(context7
            .referenced_env_names
            .contains(&"CONTEXT7_API_KEY".to_string()));

        let cursor = agent(&snapshot, "cursor");
        let context7 = server(&cursor, "context7", Scope::Global);
        assert_eq!(context7.env_names, vec!["UPSTASH_API_KEY".to_string()]);
        assert!(context7
            .referenced_env_names
            .contains(&"UPSTASH_API_KEY".to_string()));

        let gemini = agent(&snapshot, "gemini-cli");
        let jira = server(&gemini, "jira", Scope::Global);
        assert!(jira
            .referenced_env_names
            .contains(&"MY_JIRA_TOKEN".to_string()));
    }

    #[test]
    fn credential_files_are_refused_and_never_read() {
        let snapshot = scan_all();
        let json = serde_json::to_string(&snapshot).unwrap();
        assert!(!json.contains("SENTINEL"), "a credential file leaked: {json}");

        let mut refused: Vec<String> = snapshot
            .agents
            .iter()
            .flat_map(|a| a.skipped.iter().map(|s| s.path.clone()))
            .collect();
        refused.sort();
        for expected in [
            "~/.claude/.credentials.json",
            "~/.codex/auth.json",
            "~/.gemini/oauth_creds.json",
            "~/.copilot/config.json",
            "~/.cline/data/settings/providers.json",
            "~/.cursor/state.vscdb",
        ] {
            assert!(refused.iter().any(|p| p == expected), "{expected} not refused: {refused:?}");
        }

        // The refusal carries a reason, so the Field Guide can explain it.
        let claude = agent(&snapshot, "claude-code");
        assert_eq!(claude.skipped[0].reason, "credentialFile");

        // A project .env or key file is never opened either.
        assert!(!json.contains("deploy.key"));
        assert!(!json.contains("webapp/.env"));
    }

    #[test]
    fn masking_helpers_work_on_bare_strings() {
        assert!(looks_like_secret_value("ghp_FAKEGITHUBTOKENAAAAAAAAAAAAAAAAA"));
        assert!(looks_like_secret_value("sk-FAKEOPENAIKEY0123456789abcdefghij"));
        assert!(looks_like_secret_value("ya29.FAKEGEMINIBEARER0123456789abcdefg"));
        assert!(!looks_like_secret_value("./archive.db"));
        assert!(!looks_like_secret_value("@playwright/mcp@0.0.35"));
        assert!(!looks_like_secret_value("run"));

        assert!(secret_key_name("--access-token"));
        assert!(secret_key_name("GITHUB_PERSONAL_ACCESS_TOKEN"));
        assert!(!secret_key_name("--db-path"));
        assert!(!secret_key_name("NODE_ENV"));

        assert!(is_env_reference("${CONTEXT7_API_KEY}"));
        assert!(is_env_reference("${env:UPSTASH_API_KEY}"));
        assert!(is_env_reference("$MY_JIRA_TOKEN"));
        assert!(!is_env_reference("sk_live_FAKESTRIPEKEY"));

        let (masked, _, count) = mask_args(&[
            "--api-key".to_string(),
            "exaFAKE0123456789exaFAKE0123456789ab".to_string(),
        ]);
        assert_eq!(masked, vec!["--api-key".to_string(), MASKED.to_string()]);
        assert_eq!(count, 1);

        let (kept, refs, count) = mask_args(&[
            "--api-key".to_string(),
            "${CONTEXT7_API_KEY}".to_string(),
        ]);
        assert_eq!(kept, vec!["--api-key".to_string(), "${CONTEXT7_API_KEY}".to_string()]);
        assert_eq!(refs, vec!["CONTEXT7_API_KEY".to_string()]);
        assert_eq!(count, 0);

        let (url, _, count) = mask_url("https://db.example.com/mcp?apiKey=dbFAKE0123456789");
        assert_eq!(url, "https://db.example.com/mcp?apiKey=[masked]");
        assert_eq!(count, 1);

        assert!(is_credential_file_name("auth.json"));
        assert!(is_credential_file_name(".credentials.json"));
        assert!(is_credential_file_name(".env"));
        assert!(is_credential_file_name("deploy.key"));
        assert!(is_credential_file_name("state.vscdb"));
        assert!(is_credential_file_name("providers.json"));
        assert!(!is_credential_file_name("mcp-config.json"));
        assert!(!is_credential_file_name("config.toml"));
    }

    // -- rules files --------------------------------------------------------

    #[test]
    fn rules_files_are_listed_per_agent_with_scope() {
        let snapshot = scan_all();

        let rules = |id: &str| -> Vec<RulesFile> { agent(&snapshot, id).rules };

        let claude = rules("claude-code");
        assert!(claude
            .iter()
            .any(|r| r.path == "~/.claude/CLAUDE.md" && r.scope == Scope::Global && r.exists));
        assert!(claude
            .iter()
            .any(|r| r.path == "webapp/CLAUDE.md" && r.scope == Scope::Project && r.exists));

        let codex = rules("codex-cli");
        assert!(codex.iter().any(|r| r.path == "~/.codex/AGENTS.md" && r.exists));
        assert!(codex
            .iter()
            .any(|r| r.path == "webapp/AGENTS.md" && r.scope == Scope::Project));

        let gemini = rules("gemini-cli");
        assert!(gemini.iter().any(|r| r.path == "~/.gemini/GEMINI.md" && r.exists));
        assert!(gemini.iter().any(|r| r.path == "webapp/GEMINI.md" && r.exists));

        // Cursor rules are a directory of .mdc files.
        let cursor = rules("cursor");
        assert!(cursor
            .iter()
            .any(|r| r.path == "~/.cursor/rules/010-global-standards.mdc" && r.format == RulesFormat::Mdc));
        assert!(cursor
            .iter()
            .any(|r| r.path == "webapp/.cursor/rules/branch-naming.mdc" && r.exists));

        let opencode = rules("opencode");
        assert!(opencode
            .iter()
            .any(|r| r.path == "~/.config/opencode/AGENTS.md" && r.scope == Scope::Global));
        assert!(opencode.iter().any(|r| r.path == "webapp/AGENTS.md" && r.exists));
        assert!(opencode
            .iter()
            .any(|r| r.path == "webapp/CLAUDE.md" && r.exists), "OpenCode falls back to CLAUDE.md");

        let copilot = rules("copilot-cli");
        assert!(copilot
            .iter()
            .any(|r| r.path == "~/.copilot/copilot-instructions.md" && r.exists));
        assert!(copilot
            .iter()
            .any(|r| r.path == "webapp/.github/copilot-instructions.md" && r.exists));

        let windsurf = rules("windsurf");
        assert!(windsurf
            .iter()
            .any(|r| r.path == "webapp/.windsurf/rules/review-style.md" && r.exists));

        let cline = rules("cline");
        assert!(cline
            .iter()
            .any(|r| r.path == "~/.cline/data/settings/rules/global-style.md" && r.exists));
        assert!(cline
            .iter()
            .any(|r| r.path == "webapp/.clinerules/project-rules.md" && r.exists));
    }

    #[test]
    fn a_missing_expected_rules_file_is_reported_not_crashed() {
        let snapshot = scan_all();
        let windsurf = agent(&snapshot, "windsurf");
        let missing = windsurf
            .rules
            .iter()
            .find(|r| !r.exists)
            .expect("at least one absent Windsurf rules candidate");
        assert!(missing.preview.is_none());
        assert_eq!(missing.line_count, 0);
    }

    #[test]
    fn rules_previews_are_short_and_masked() {
        let snapshot = scan_all();
        let json = serde_json::to_string(&snapshot).unwrap();
        assert!(!json.contains("ghp_FAKEGLOBALRULEAAAAAAAAAAAAAAAA"));
        assert!(!json.contains("AIzaFAKEGLOBALGEMINIKEY0123456789AB"));

        let claude = agent(&snapshot, "claude-code");
        let global = claude
            .rules
            .iter()
            .find(|r| r.path == "~/.claude/CLAUDE.md")
            .unwrap();
        let preview = global.preview.clone().unwrap();
        assert!(preview.contains("Synthetic global rules"), "{preview}");
        assert!(preview.contains(&format!("API_TOKEN={MASKED}")), "{preview}");
        assert!(preview.len() < 600, "preview capped: {} chars", preview.len());

        // The deliberately long fixture rules file shows truncation.
        let cursor = agent(&snapshot, "cursor");
        let long = cursor
            .rules
            .iter()
            .find(|r| r.path == "webapp/.cursor/rules/branch-naming.mdc")
            .unwrap();
        assert!(long.truncated, "long file must be marked truncated");
        assert!(long.preview.clone().unwrap().len() < 600);
        assert!(long.line_count > PREVIEW_MAX_LINES);
    }

    // -- difference highlighting -------------------------------------------

    #[test]
    fn server_matrix_marks_what_differs_between_agents() {
        let snapshot = scan_all();

        let context7 = presence(&snapshot, "context7");
        assert!(context7.present_in.contains(&"codex-cli".to_string()));
        assert!(context7.present_in.contains(&"gemini-cli".to_string()));
        assert!(context7.present_in.contains(&"cursor".to_string()));
        assert!(context7.present_in.contains(&"windsurf".to_string()));
        assert!(context7.missing_from.contains(&"claude-code".to_string()));
        assert!(context7.missing_from.contains(&"cline".to_string()));
        assert!(!context7.shared_by_all);
        assert_eq!(context7.definitions, 2, "OpenCode wires an extra api-key argument");

        // Same name, same wiring everywhere it appears: this is what the view marks aligned.
        let playwright = presence(&snapshot, "playwright");
        assert_eq!(playwright.definitions, 1);
        assert_eq!(
            playwright.missing_from,
            vec!["gemini-cli".to_string(), "windsurf".to_string()],
            "missing_from follows the canonical agent order"
        );
        assert!(!playwright.shared_by_all);

        let sqlite = presence(&snapshot, "sqlite");
        assert!(sqlite.definitions == 1 && sqlite.present_in.len() >= 4, "{sqlite:?}");

        // One name, several wirings: linear is http with a token in Claude,
        // bearer var in Codex and disabled in Cline.
        let linear = presence(&snapshot, "linear");
        assert!(linear.definitions > 1, "linear wiring differs between agents");

        // Every matrix row covers all eight agents exactly once.
        for row in &snapshot.server_matrix {
            assert_eq!(
                row.present_in.len() + row.missing_from.len(),
                snapshot.agents.len(),
                "{}",
                row.name
            );
        }
        assert!(!snapshot.server_matrix.is_empty());
        assert!(snapshot.server_count > 0);
    }

    // -- accepted project roots ----------------------------------------------

    fn strings(paths: &[&Path]) -> Vec<String> {
        paths.iter().map(|p| p.to_string_lossy().to_string()).collect()
    }

    fn real(path: &Path) -> PathBuf {
        path.canonicalize().unwrap()
    }

    #[test]
    fn accepted_roots_keep_a_folder_under_home() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let project = home.join("code/app");
        std::fs::create_dir_all(&project).unwrap();
        let kept = accepted_project_roots(&strings(&[&project]), &home, &[]);
        assert_eq!(kept, vec![real(&project)]);
    }

    #[test]
    fn accepted_roots_keep_a_folder_outside_home_only_when_the_archive_knows_it() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let outside = tmp.path().join("work/api");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let requested = strings(&[&outside]);
        let known = accepted_project_roots(&requested, &home, &requested);
        assert_eq!(known, vec![real(&outside)]);
        let unknown = accepted_project_roots(&requested, &home, &[]);
        assert!(unknown.is_empty());
        let other = accepted_project_roots(&requested, &home, &["/somewhere/else".to_string()]);
        assert!(other.is_empty());
    }

    #[test]
    fn accepted_roots_drop_relative_missing_file_and_filesystem_root() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        std::fs::create_dir_all(home.join("real")).unwrap();
        std::fs::write(home.join("notes.txt"), "x").unwrap();
        let requested = vec![
            "real".to_string(),
            "./real".to_string(),
            home.join("missing").to_string_lossy().to_string(),
            home.join("notes.txt").to_string_lossy().to_string(),
            "/".to_string(),
            String::new(),
        ];
        let kept = accepted_project_roots(&requested, &home, &[]);
        assert!(kept.is_empty(), "{kept:?}");
        // even when the archive lists the same strings
        let kept = accepted_project_roots(&requested, &home, &requested);
        assert!(kept.is_empty(), "{kept:?}");
    }

    #[cfg(unix)]
    #[test]
    fn accepted_roots_follow_a_symlink_out_of_home_only_for_an_archived_target() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let target = tmp.path().join("elsewhere/secret-project");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&target).unwrap();
        let link = home.join("shortcut");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let requested = strings(&[&link]);
        assert!(accepted_project_roots(&requested, &home, &[]).is_empty());
        assert!(accepted_project_roots(&requested, &home, &["/not/it".to_string()]).is_empty());
        let archived = strings(&[&target]);
        // the result is the resolved target, not the symlink, so the scan reads what was checked
        assert_eq!(accepted_project_roots(&requested, &home, &archived), vec![real(&target)]);
    }

    #[test]
    fn accepted_roots_collapse_duplicates_and_keep_request_order() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let b = home.join("b");
        let a = home.join("a");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        let dotted = home.join("b/../b");
        let requested = strings(&[&b, &a, &b, &dotted]);
        let kept = accepted_project_roots(&requested, &home, &[]);
        assert_eq!(kept, vec![real(&b), real(&a)]);
    }

    #[test]
    fn archive_project_roots_lists_each_recorded_root_once() {
        use crate::importer::testutil::staged_targets;
        let tmp = tempfile::tempdir().unwrap();
        let archive = std::sync::Arc::new(orrery_archive::Archive::in_memory().unwrap());
        let state = crate::archive_api::CoreState::new(archive, staged_targets(tmp.path()));
        crate::archive_api::import_now_core(&state, None, &|_| {}).unwrap();
        let mut roots = archive_project_roots(&state.archive).unwrap();
        roots.sort();
        assert_eq!(
            roots,
            vec![
                "/Users/developer/code/my-web-app".to_string(),
                "/home/developer/projects/core-api".to_string(),
            ]
        );
    }

    // -- robustness and safety ---------------------------------------------

    #[test]
    fn broken_config_files_become_notes_not_failures() {
        let root = fixture_root();
        let context = ScanContext::new(
            root.join("home"),
            vec![root.join("project/webapp"), root.join("project/broken")],
        );
        let snapshot = scan(&context, None).expect("scan survives a broken config");

        let claude = agent(&snapshot, "claude-code");
        assert!(
            claude.notes.iter().any(|n| n.contains("broken")),
            "expected a note about the broken project file: {:?}",
            claude.notes
        );
        // Good servers from the healthy project are still there.
        assert!(claude.servers.iter().any(|s| s.name == "stripe"));
        assert!(snapshot
            .projects
            .contains(&"webapp".to_string())
            && snapshot.projects.contains(&"broken".to_string()));
    }

    #[test]
    fn oversized_files_are_reported_instead_of_parsed() {
        // A scratch tree, not a fixture: a 1 MiB file has no business living in git.
        let root = std::env::temp_dir().join(format!("armillary-f6-oversized-{}", std::process::id()));
        let project = root.join("project/big");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(
            project.join(".mcp.json"),
            oversized_mcp_json(MAX_CONFIG_BYTES as usize + 1),
        )
        .unwrap();

        let context = ScanContext::new(root.join("home"), vec![project]);
        let snapshot = scan(&context, Some("claude-code")).unwrap();
        let claude = &snapshot.agents[0];
        assert!(
            claude
                .notes
                .iter()
                .any(|n| n.contains("too large") && n.contains("big")),
            "{:?}",
            claude.notes
        );

        std::fs::remove_dir_all(&root).ok();
    }

    fn oversized_mcp_json(bytes: usize) -> String {
        let mut filler = String::with_capacity(bytes);
        while filler.len() < bytes {
            filler.push_str("{\"pad\":\"padding padding padding padding padding padding\"},");
        }
        format!("{{\"mcpServers\":{{\"huge\":{{\"command\":\"npx\",\"args\":[{filler}]}}}}}}")
    }

    #[test]
    fn checked_join_refuses_paths_that_escape_the_root() {
        let root = fixture_root().join("project/webapp");
        let err = ScanContext::checked_join(&root, "../../etc/passwd").unwrap_err();
        assert_eq!(err.kind, ConfigScanErrorKind::InvalidPath);
        let ok = ScanContext::checked_join(&root, ".cursor/rules/branch-naming.mdc").unwrap();
        assert!(ok.starts_with(&root));
    }

    #[test]
    fn scanning_writes_nothing_to_the_fixture_tree() {
        // The golden rebase path writes expected/snapshot.json on purpose; skip there.
        if std::env::var("ARMILLARY_WRITE_SNAPSHOTS").is_ok() {
            return;
        }
        let before = tree_state(&fixture_root());
        let _snapshot = scan_all();
        let after = tree_state(&fixture_root());
        assert_eq!(before, after, "the Switchboard is read-only");
    }

    #[test]
    fn golden_snapshot_matches_the_expected_file() {
        let snapshot = scan_all();
        let expected_path = fixture_root().join("expected/snapshot.json");
        if std::env::var("ARMILLARY_WRITE_SNAPSHOTS").is_ok() {
            std::fs::write(
                &expected_path,
                format!("{}\n", serde_json::to_string_pretty(&snapshot).unwrap()),
            )
            .unwrap();
        }
        let expected: ConfigSnapshot =
            serde_json::from_str(&std::fs::read_to_string(&expected_path).unwrap())
                .expect("expected/snapshot.json parses back into the same shape");
        assert_eq!(expected, snapshot, "run with ARMILLARY_WRITE_SNAPSHOTS=1 to rebase");
    }

    fn tree_state(root: &Path) -> Vec<(String, u64, std::time::SystemTime)> {
        let mut out = Vec::new();
        collect_state(root, &mut out);
        out.sort();
        out
    }

    fn collect_state(dir: &Path, out: &mut Vec<(String, u64, std::time::SystemTime)>) {
        let entries = match std::fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(_) => return,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let meta = match std::fs::metadata(&path) {
                Ok(meta) => meta,
                Err(_) => continue,
            };
            if meta.is_dir() {
                collect_state(&path, out);
            } else {
                out.push((
                    path.to_string_lossy().to_string(),
                    meta.len(),
                    meta.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH),
                ));
            }
        }
    }
}

/// PRIV-3 (r2 fix round 1): secrets that sit inside server arguments or URL paths are masked
/// before the Switchboard paints the command line.
#[cfg(test)]
mod mask_shapes {
    use super::*;

    #[test]
    fn a_database_password_in_a_server_argument_is_masked() {
        for arg in [
            "postgres://app:CANARYDBPASS@db.internal:5432/prod",
            "mongodb+srv://app:CANARYDBPASS@cluster0.example.net/db",
        ] {
            let (out, _, n) = mask_args(&["--dsn".to_string(), arg.to_string()]);
            assert!(!out.join(" ").contains("CANARYDBPASS"), "{out:?}");
            assert!(out.join(" ").contains("db"), "the host stays readable: {out:?}");
            assert!(n >= 1);
        }
        for args in [
            vec!["--dsn=postgres://app:CANARYDBPASS@db.internal/prod?sslmode=require".to_string()],
            vec!["postgres://app:CANARYDBPASS@db.internal/prod?sslmode=require".to_string()],
            vec!["-c".to_string(), "psql postgres://app:CANARYDBPASS@db.internal/prod?sslmode=require".to_string()],
            vec!["DATABASE_URL=postgres://app:CANARYDBPASS@db.internal/prod?sslmode=require".to_string()],
        ] {
            let (out, _, _) = mask_args(&args);
            assert!(!out.join(" ").contains("CANARYDBPASS"), "{out:?}");
            assert!(out.join(" ").contains("sslmode=require"), "{out:?}");
        }
    }

    #[test]
    fn an_authorization_header_argument_is_masked() {
        for args in [
            vec!["--header".to_string(), "Authorization: Bearer CANARYBEARER0123456789".to_string()],
            vec!["-H".to_string(), "Authorization: Bearer CANARYBEARER0123456789".to_string()],
            vec!["--header=Authorization: Bearer CANARYBEARER0123456789".to_string()],
            vec!["--header".to_string(), "Authorization:Bearer CANARYBEARER0123456789".to_string()],
            vec!["--header".to_string(), "X-Api-Key: CANARYBEARER0123456789".to_string()],
            vec!["--header".to_string(), "X-Api-Key:CANARYBEARER0123456789".to_string()],
        ] {
            let (out, _, n) = mask_args(&args);
            assert!(!out.join(" ").contains("CANARYBEARER"), "{out:?}");
            assert!(n >= 1, "{out:?}");
        }
    }

    #[test]
    fn a_token_in_the_url_path_is_masked() {
        let (out, _, n) = mask_url("https://mcp.zapier.example/api/mcp/s/CANARYPATHTOKENZk3jQ9vLw8TnXp2RaB7cYd5E/sse");
        assert!(!out.contains("CANARYPATHTOKEN"), "{out}");
        assert!(out.starts_with("https://mcp.zapier.example/api/mcp/s/") && out.ends_with("/sse"), "{out}");
        assert_eq!(n, 1);
        // An ordinary path stays as it is.
        let (plain, _, n) = mask_url("https://mcp.example.com/v1/servers/github/sse");
        assert_eq!(plain, "https://mcp.example.com/v1/servers/github/sse");
        assert_eq!(n, 0);
    }

    #[test]
    fn a_token_used_as_the_url_user_name_is_masked() {
        let (out, _, _) = mask_url("https://ghp_CANARYUSERTOKEN0123456789abcdef@github.example/repo");
        assert!(!out.contains("CANARYUSERTOKEN"), "{out}");
        // A plain user name with a password keeps the name.
        let (kept, _, _) = mask_url("https://deploy:CANARYPW@host.example/x");
        assert!(kept.contains("deploy") && !kept.contains("CANARYPW"), "{kept}");
    }

    #[test]
    fn rules_previews_mask_spaced_assignments_and_connection_credentials() {
        let text = "password: canarypw1\n\
                    db_password = canarypw2\n\
                    \"api_key\": \"canarypw3\"\n\
                    **Token:** canarypw4\n\
                    DATABASE_URL=postgres://app:canarypw5@db.example/x\n\
                    connect to app:canarypw6@db.example.com\n\
                    TOKEN=${T:-canarypw7}";
        let (out, n) = mask_preview(text);
        assert!(!out.contains("canarypw"), "{out}");
        assert_eq!(n, 7, "{out}");
        assert!(out.contains("db.example") && out.contains("DATABASE_URL"), "{out}");
        // Ordinary prose and pure references are left as they are.
        let prose = "Run the tests before you push. Use ${GITHUB_TOKEN} from the env.";
        assert_eq!(mask_preview(prose), (prose.to_string(), 0));
    }

    #[test]
    fn rules_previews_mask_header_credentials_and_padded_values() {
        let (out, n) = mask_preview("Authorization: Bearer canarypw1");
        assert_eq!(out, format!("Authorization: Bearer {MASKED}"));
        assert_eq!(n, 1);
        let (out, n) = mask_preview("TOKEN=dGVzdA==");
        assert_eq!(out, format!("TOKEN={MASKED}"));
        assert_eq!(n, 1);
        let (out, n) = mask_preview("set API_KEY=Y2FuYXJ5cHc= first");
        assert_eq!(out, format!("set API_KEY={MASKED} first"));
        assert_eq!(n, 1);
        let (out, _) = mask_preview("see https://app:canarypw2@db.example/token: for it");
        assert!(!out.contains("canarypw2") && out.contains("for it"), "{out}");
        // References and ordinary values stay as written.
        for kept in ["Authorization: Bearer ${TOKEN}", "DATA=dGVzdA=="] {
            assert_eq!(mask_preview(kept), (kept.to_string(), 0));
        }
        // sol-loop N6: one scheme word, only in an Authorization header; the credential after
        // it, or after any other secret key, is masked however it is spelled.
        for (text, kept) in [
            ("Authorization: Bearer token", "Authorization: Bearer"),
            ("Authorization: Basic basic", "Authorization: Basic"),
            ("**Authorization:** Token Bearer", "**Authorization:** Token"),
            ("Authorization : bearer token", "Authorization : bearer"),
            ("password: basic", "password:"),
            ("api_key = Bearer", "api_key ="),
        ] {
            assert_eq!(mask_preview(text), (format!("{kept} {MASKED}"), 1), "{text}");
        }
        // The same rule for a header or shell string inside a server argument.
        for (arg, kept) in [
            ("Authorization: Bearer token", "Authorization: Bearer"),
            ("--password basic", "--password"),
            ("X-Api-Key: token", "X-Api-Key:"),
        ] {
            assert_eq!(mask_arg_value(arg), (format!("{kept} {MASKED}"), 1), "{arg}");
        }
    }

    #[test]
    fn quoted_and_compact_authorization_values_mask_the_credential() {
        // sol-loop N9: an opening quote does not hide the scheme, and the credential after it is
        // masked whatever it is spelled like. sol-loop N6: only Authorization and
        // Proxy-Authorization keep a scheme word.
        let cases = [
            ("\"Authorization\": \"Bearer canarypw\"", "\"Authorization\": \"Bearer", 1),
            ("'Authorization': 'Basic Y2FuYXJ5cHc='", "'Authorization': 'Basic", 1),
            ("{\"Authorization\":\"Bearer canarypw\"}", "{\"Authorization\":\"Bearer", 1),
            ("\"Authorization\": \"Bearer basic\",", "\"Authorization\": \"Bearer", 1),
            ("\"Authorization\" : \"Token canarypw\"", "\"Authorization\" : \"Token", 1),
            ("Authorization: Basic dXNlcjpjYW5hcnlwdw==", "Authorization: Basic", 1),
            ("Authorization: Bearer canarypw", "Authorization: Bearer", 1),
            ("Proxy-Authorization: Basic canarypw", "Proxy-Authorization: Basic", 1),
            ("\"Proxy-Authorization\": \"Bearer canarypw\"", "\"Proxy-Authorization\": \"Bearer", 1),
            ("\"Authorization\": \"Bearer canary pw\"", "\"Authorization\": \"Bearer", 2),
            ("\"X-Api-Key\": \"Bearer canarypw\"", "\"X-Api-Key\":", 2),
            ("X-Api-Key: basic", "X-Api-Key:", 1),
            ("password: basic", "password:", 1),
            ("\"password\": \"basic\"", "\"password\":", 1),
        ];
        for (text, kept, n) in cases {
            let expected = format!("{kept} {}", vec![MASKED; n].join(" "));
            assert_eq!(mask_preview(text), (expected.clone(), n), "preview {text}");
            assert_eq!(mask_arg_value(text), (expected, n), "arg {text}");
        }
        // Inside a shell string; the word after the quoted value is not part of it.
        for (arg, shown, n) in [
            ("curl -H X-Api-Key:basic https://h.example/v1", format!("curl -H X-Api-Key:{MASKED} https://h.example/v1"), 1),
            ("curl -H Authorization:Bearer canarypw https://h.example", format!("curl -H Authorization:Bearer {MASKED} https://h.example"), 1),
            ("curl -H \"Authorization: Bearer canarypw\" https://h.example", format!("curl -H \"Authorization: Bearer {MASKED} https://h.example"), 1),
            ("curl -H 'Proxy-Authorization: Basic canarypw' -v", format!("curl -H 'Proxy-Authorization: Basic {MASKED} -v"), 1),
            ("run --password basic --verbose", format!("run --password {MASKED} --verbose"), 1),
            ("run --password \"two words\" --verbose", format!("run --password {MASKED} {MASKED} --verbose"), 2),
            ("env PASSWORD=\"canary pw\" run", format!("env PASSWORD={MASKED} {MASKED} run"), 2),
            ("run --token=dGVzdA== now", format!("run --token={MASKED} now"), 1),
        ] {
            assert_eq!(mask_arg_value(arg), (shown, n), "{arg}");
        }
        let (out, n) = mask_preview("{\"headers\": {\"Authorization\": \"Bearer canarypw\"}, \"url\": \"https://h.example\"}");
        assert!(!out.contains("canarypw") && out.contains("\"Bearer") && out.contains("h.example"), "{out}");
        assert_eq!(n, 1);
        // A variable reference stays as written.
        let kept = "Authorization: Bearer ${TOKEN}";
        assert_eq!(mask_arg_value(kept), (kept.to_string(), 0));
    }

    #[test]
    fn a_literal_fallback_in_a_variable_reference_is_masked() {
        let (out, refs, n) = mask_args(&["--password".to_string(), "${DB_PW:-canarypw}".to_string()]);
        assert!(!out.join(" ").contains("canarypw"), "{out:?}");
        assert_eq!(refs, vec!["DB_PW".to_string()]);
        assert_eq!(n, 1);
        let (out, refs, _) = mask_args(&["${API_KEY:-CANARYFALLBACK0123}".to_string()]);
        assert_eq!(out, vec![format!("${{API_KEY:-{MASKED}}}")]);
        assert_eq!(refs, vec!["API_KEY".to_string()]);
        let (out, _, _) = mask_args(&["${DB_URL:-postgres://app:canarypw@db.example/x}".to_string()]);
        assert!(!out[0].contains("canarypw") && out[0].contains("db.example"), "{out:?}");
        let (out, refs, _) = mask_url("https://h.example/sse?token=${T:-canarytok}");
        assert!(!out.contains("canarytok"), "{out}");
        assert_eq!(refs, vec!["T".to_string()]);
        // Inside an assignment or an ordinary query value, the fallback is still masked.
        let (out, _, n) = mask_args(&["X=${TOKEN:-canaryfb1}".to_string()]);
        assert_eq!(out, vec![format!("X=${{TOKEN:-{MASKED}}}")]);
        assert_eq!(n, 1);
        let (out, refs, n) = mask_url("https://h.example/sse?value=${TOKEN:-canaryfb2}");
        assert_eq!(out, format!("https://h.example/sse?value=${{TOKEN:-{MASKED}}}"));
        assert_eq!((refs, n), (vec!["TOKEN".to_string()], 1));
        let (out, n) = mask_preview("export X=${TOKEN:-canaryfb3}");
        assert!(!out.contains("canaryfb3") && n == 1, "{out}");
        // Pure references and harmless fallbacks stay as written.
        let (out, _, n) = mask_args(&["X=${PORT:-3000}".to_string(), "https://h.example/?page=${P:-2}".to_string()]);
        assert_eq!(out, vec!["X=${PORT:-3000}".to_string(), "https://h.example/?page=${P:-2}".to_string()]);
        assert_eq!(n, 0);
        let (out, _, n) = mask_args(&["${PORT:-3000}".to_string(), "${TOKEN:-}".to_string()]);
        assert_eq!(out, vec!["${PORT:-3000}".to_string(), "${TOKEN:-}".to_string()]);
        assert_eq!(n, 0);
    }

    #[test]
    fn an_inline_assignment_inside_a_shell_argument_is_masked() {
        let (out, _, n) = mask_args(&["-c".to_string(), "API_KEY=CANARYSHELL0012abcdef npx foo".to_string()]);
        assert!(!out.join(" ").contains("CANARYSHELL"), "{out:?}");
        assert!(out.join(" ").contains("npx foo"), "{out:?}");
        assert!(n >= 1);
        // A variable reference elsewhere in the same argument does not stop the masking.
        let (out, refs, _) = mask_args(&["-c".to_string(), "API_KEY=CANARYSHELL0012abcdef node $HOME/server.js".to_string()]);
        assert!(!out.join(" ").contains("CANARYSHELL"), "{out:?}");
        assert!(out.join(" ").contains("$HOME/server.js"), "{out:?}");
        assert_eq!(refs, vec!["HOME".to_string()]);
    }

    #[test]
    fn a_whole_command_line_in_the_command_field_is_masked() {
        let entry: serde_json::Map<String, serde_json::Value> = serde_json::from_str(
            r#"{"command": "API_KEY=CANARYCMD0123456789abcdef node server.js", "args": ["--url", "https://x.example/s/CANARYPATHZk3jQ9vLw8TnXp2RaB7cYd5E/sse"]}"#,
        )
        .unwrap();
        let server = build_server("claude-code", "s", &entry, Dialect::JsonServers, Scope::Global, None, "~/.claude.json");
        let shown = format!("{} {}", server.command.clone().unwrap_or_default(), server.args.join(" "));
        assert!(!shown.contains("CANARYCMD") && !shown.contains("CANARYPATH"), "{shown}");
        assert!(shown.contains("node server.js"), "{shown}");
        assert_eq!(server.masked_values, 2, "{shown}");
        // A plain command is left alone.
        let plain: serde_json::Map<String, serde_json::Value> = serde_json::from_str(r#"{"command": "/usr/local/bin/npx", "args": ["-y", "pkg"]}"#).unwrap();
        let server = build_server("claude-code", "p", &plain, Dialect::JsonServers, Scope::Global, None, "~/.claude.json");
        assert_eq!(server.command.as_deref(), Some("/usr/local/bin/npx"));
        assert_eq!(server.masked_values, 0);
    }

    #[test]
    fn ordinary_arguments_stay_readable() {
        let args: Vec<String> = ["-y", "@modelcontextprotocol/server-filesystem", "/Users/dev/code", "--port", "8080", "${API_KEY}"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let (out, refs, n) = mask_args(&args);
        assert_eq!(out, args);
        assert_eq!(refs, vec!["API_KEY".to_string()]);
        assert_eq!(n, 0);
    }
}

/// P3-1 (r2 fix round 1): a project folder whose own name looks like a credential file name
/// (keychain-app, my.key, notes.pem) is an ordinary project: its rules file is read. A project
/// that sits inside a credential folder (~/.ssh, ~/.aws) is still refused, and so is a credential
/// file inside an ordinary project.
#[cfg(test)]
mod project_names {
    use super::*;

    fn home() -> tempfile::TempDir {
        tempfile::Builder::new().prefix("armillary-r2fix-").tempdir_in("/tmp").unwrap()
    }

    #[test]
    fn a_project_named_like_a_credential_file_is_read() {
        let home = home();
        for name in ["keychain-app", "my.key", "secrets.json", "notes.pem", "auth.json", ".env.d", "id_rsa-docs"] {
            let project = home.path().join("code").join(name);
            std::fs::create_dir_all(&project).unwrap();
            std::fs::write(project.join("CLAUDE.md"), "# rules").unwrap();
            let read = guarded_read(&project.join("CLAUDE.md"), &project, home.path());
            assert!(matches!(read.as_deref(), Ok("# rules")), "{name}: {:?}", read.err().map(|e| format!("{e:?}")));
        }
    }

    #[test]
    fn a_project_inside_a_credential_folder_and_a_credential_file_in_a_project_stay_refused() {
        let home = home();
        for folder in [".ssh", ".aws", ".gnupg"] {
            let project = home.path().join(folder).join("proj");
            std::fs::create_dir_all(&project).unwrap();
            std::fs::write(project.join("CLAUDE.md"), "# rules").unwrap();
            let read = guarded_read(&project.join("CLAUDE.md"), &project, home.path());
            assert!(matches!(read, Err(Refusal::Credential)), "{folder}: {:?}", read.map_err(|e| format!("{e:?}")));
        }
        let project = home.path().join("code/app");
        std::fs::create_dir_all(project.join(".aws")).unwrap();
        for file in ["auth.json", "deploy.key", ".env.local", ".aws/config"] {
            std::fs::write(project.join(file), "secret").unwrap();
            let read = guarded_read(&project.join(file), &project, home.path());
            assert!(matches!(read, Err(Refusal::Credential)), "{file}: {:?}", read.map_err(|e| format!("{e:?}")));
        }
    }
}

/// r2 fix round 2 (R2P-1, R-4, RR1-2): more secret shapes in MCP server arguments and URLs are
/// masked, and ordinary values next to secret-sounding flags (--max-tokens 4096) are not.
#[cfg(test)]
mod masking_round_2 {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        mask_args(&list.iter().map(|s| s.to_string()).collect::<Vec<_>>()).0
    }

    fn shown(list: &[&str]) -> String {
        args(list).join(" ")
    }

    #[test]
    fn secret_shapes_are_masked() {
        let cases: &[(&[&str], &str)] = &[
            (&["-u", "admin:CANARYCURLPW1"], "CANARYCURLPW1"),
            (&["--user", "admin:CANARYCURLPW2"], "CANARYCURLPW2"),
            (&["-pCANARYMYSQLPW0021"], "CANARYMYSQLPW0021"),
            (&["sshpass", "-p", "CANARYSSHPASS9", "ssh", "host"], "CANARYSSHPASS9"),
            (&["mysql", "-p", "hunter2"], "hunter2"),
            (&["--header", "Cookie: session=CANARYCOOKIE7; other=CANARYCOOKIE8"], "CANARYCOOKIE"),
            (&["-H", "Set-Cookie: sid=CANARYCOOKIE9"], "CANARYCOOKIE9"),
            (&["https://mcp.example/x#access_token=CANARYFRAG1&state=1"], "CANARYFRAG1"),
            (&["https://mcp.example/s/c4a9b7e1d2f34a58b6c0e9d7a1f2b3c4/sse"], "c4a9b7e1d2f34a58b6c0e9d7a1f2b3c4"),
            (&["https://mcp.example/u/3f2a9c1e-7b64-4d1a-9e0f-5a8c2b1d4e6f/sse"], "3f2a9c1e-7b64-4d1a-9e0f-5a8c2b1d4e6f"),
            (&["https://mcp.example/t/CANARYPATHUPPER0038/sse"], "CANARYPATHUPPER0038"),
            (&["https://mcp.example/sse?s=0f3a9b1c7d2e4a5b8c6d9e0f1a2b3c4d"], "0f3a9b1c7d2e4a5b8c6d9e0f1a2b3c4d"),
            (&["https://CANARYTOKENUSER123@mcp.example.com/sse"], "CANARYTOKENUSER123"),
            (&["--auth", "CANARYAUTH1"], "CANARYAUTH1"),
            (&["--pat", "CANARYPAT1"], "CANARYPAT1"),
            (&["--pw", "CANARYPW1"], "CANARYPW1"),
            (&["--sas", "CANARYSAS1"], "CANARYSAS1"),
            (&["--key=CANARYKEY1"], "CANARYKEY1"),
            (&["--passphrase", "CANARYPHRASE1"], "CANARYPHRASE1"),
            (&["--connection-string", "Server=db;Database=x;Password=hunter2secret;"], "hunter2secret"),
            (&["Server=db;Database=x;Pwd=CANARYPWD1;"], "CANARYPWD1"),
            (&["user:hunter2pw@db.example.com"], "hunter2pw"),
            (&["-H", "X-Custom-Auth: abcd1234efgh"], "abcd1234efgh"),
            (&["0f3a9b1c7d2e4a5b8c6d9e0f1a2b3c4d"], "0f3a9b1c7d2e4a5b8c6d9e0f1a2b3c4d"),
        ];
        for (input, canary) in cases {
            let out = shown(input);
            assert!(!out.contains(canary), "{input:?} -> {out}");
        }
    }

    #[test]
    fn ordinary_values_stay_visible() {
        let cases: &[&[&str]] = &[
            &["--max-tokens", "4096"],
            &["--max-tokens=4096"],
            &["-p", "3000"],
            &["-p8080"],
            &["-p", "./project"],
            &["--path", "/Users/dev/code/app"],
            &["--monkey", "banana"],
            &["-k", "https://example.com/api"],
            &["-y", "@modelcontextprotocol/server-filesystem", "/Users/dev/code"],
            &["--port", "8080"],
            &["image:tag@sha256"],
            &["https://mcp.example.com/v1/sse"],
            &["--key-file", "/Users/dev/.config/app/settings.toml"],
            &["npx", "-y", "-p", "@modelcontextprotocol/server-github", "mcp-server-github"],
            &["npx", "-p", "mcp-remote@latest", "mcp-remote"],
            &["docker", "run", "-p", "8080:80", "-u", "1000:1000", "image"],
            &["docker", "run", "-p3306:3306", "image"],
            &["--user", "1000:1000"],
        ];
        for input in cases {
            assert_eq!(args(input), input.iter().map(|s| s.to_string()).collect::<Vec<_>>(), "{input:?}");
        }
        assert_eq!(shown(&["ssh://git@github.com/org/repo.git"]), "ssh://git:[masked]@github.com/org/repo.git");
    }
}

/// sol-loop round 5 (S1/N6/N9/N10): masking fails closed. Every `key:value` and `key=value`
/// separator in a compact word is checked (not only the first), keys are read without their
/// quotes, braces and brackets, and an escaped quote does not close a quoted value.
#[cfg(test)]
mod masking_round_5 {
    use super::*;

    /// One line per config syntax, each carrying a canary. Both maskers run on every line, and
    /// `mask_args` with the line as one argument; no output may show any part of a canary.
    const CANARY_LINES: &[&str] = &[
        // JSON, pretty and minified, nested objects and arrays.
        r#"{"password": "canarypw-1"}"#,
        r#"{"password":"canarypw-2"}"#,
        r#"{"key":"canarypw-3"}"#,
        r#"{"headers":{"Authorization":"Bearer canarypw-4"}}"#,
        r#"{"mcpServers":{"x":{"env":{"API_KEY":"canarypw-5"}}}}"#,
        r#"{"servers":[{"name":"a","token":"canarypw-6"}]}"#,
        r#"  "apiKey": "canarypw-7","#,
        r#"{"secret":["canarypw-8a","canarypw-8b"]}"#,
        r#"{"password":"head\" canarypw-9"}"#,
        r#"{"env":{"PASSWORD":"canarypw-10"},"command":"npx"}"#,
        r#"  "Authorization": "Bearer canarypw-11","#,
        r#"[{"key":"Authorization","value":"Bearer canarypw-12"}]"#,
        r#""args": ["--api-key", "canarypw-13"]"#,
        r#"{"note": "a b","password":"canarypw-14"}"#,
        // YAML.
        r#"api_key: canarypw-15"#,
        r#"  Authorization: "Bearer canarypw-16""#,
        r#"env: {GITHUB_TOKEN: canarypw-17, NODE_ENV: production}"#,
        r#"password: "head\" canarypw-18""#,
        r#"password: 'canary pw canarypw-19'"#,
        r#"client_secret: "canarypw-20""#,
        r#"api-key: canarypw-21"#,
        // TOML.
        r#"api_key = "canarypw-22""#,
        r#"env = { API_KEY = "canarypw-23", DEBUG = "1" }"#,
        r#"headers = {Authorization="Bearer canarypw-24"}"#,
        // .env and INI.
        r#"DATABASE_PASSWORD=canarypw-25"#,
        r#"export OPENAI_API_KEY='canarypw-26'"#,
        r#"SECRET="canary pw canarypw-27""#,
        r#"password = canarypw-28"#,
        r#"token=canarypw-29"#,
        r#"aws_secret_access_key = canarypw-30"#,
        // Shell, single and double quotes, escaped quotes.
        r#"run --password "head\" canarypw-31""#,
        r#"run --password=canarypw-32 --verbose"#,
        r#"run --password canarypw-33"#,
        r#"PGPASSWORD=canarypw-34 psql -h db.example"#,
        r#"docker run -e API_KEY=canarypw-35 image"#,
        r#"curl -d '{"username":"bob","password":"canarypw-36"}' https://api.example"#,
        r#"echo "{\"password\":\"canarypw-37\"}""#,
        r#"const token = "canarypw-38";"#,
        r#"ENV OPENAI_API_KEY=canarypw-39"#,
        // curl -H headers and Authorization schemes.
        r#"curl -H "Authorization: Bearer canarypw-40" https://api.example/v1"#,
        r#"curl -H 'Authorization: Basic canarypw-41' https://api.example"#,
        r#"curl -H "Authorization: Token canarypw-42""#,
        r#"curl -H "X-Api-Key: canarypw-43" https://api.example"#,
        r#"curl -H X-Api-Key:canarypw-44 https://api.example"#,
        r#"curl -u admin:canarypw-45 https://api.example"#,
        r#"--header=Authorization: Bearer canarypw-46"#,
        r#"Authorization: Bearer canarypw-47"#,
        r#"Proxy-Authorization: Basic canarypw-48"#,
        r#""Authorization": "Token canarypw-49""#,
        r#"proxy_set_header Authorization "Bearer canarypw-50";"#,
        r#"Cookie: theme=dark; sid=canarypw-51"#,
        // Connection strings and query strings.
        r#"postgres://app:canarypw-52@db.example.com:5432/prod"#,
        r#"DATABASE_URL=mysql://root:canarypw-53@localhost/db"#,
        r#"Server=db.example;Database=app;User Id=sa;Password=canarypw-54;"#,
        r#"https://api.example/v1?api_key=canarypw-55&format=json"#,
        r#"https://h.example/sse?token=canarypw-56"#,
        r#"?Authorization=Bearer%20canarypw-57"#,
        // References with a literal fallback.
        r#"PASSWORD=${DB_PASSWORD:-canarypw-58}"#,
        r#"--token ${API_TOKEN:-canarypw-59}"#,
        r#"url: ${SERVICE_URL:-https://user:canarypw-60@h.example}"#,
        // Unquoted values that run to the end of the line, and more quoting styles.
        r#"password: correct horse canarypw-61"#,
        r#"password = my pass canarypw-62"#,
        r#"password: 'it''s canarypw-63'"#,
        r#"'password' => 'canarypw-64',"#,
        r#":password => "canary canarypw-65""#,
        r#"run --password $'head\' canarypw-66'"#,
        r#"PASSWORD = r"canary canarypw-67""#,
        r#"password = """canary canarypw-68""""#,
        r#"curl -H "X-Api-Key: canary canarypw-69" https://api.example"#,
        r#"env: {API_KEY: canary canarypw-70, DEBUG: 1}"#,
        r#"token := "canarypw-71""#,
        r#"password: !!str canarypw-72"#,
        r#"Authorization: Digest username="u", response="canarypw-73""#,
    ];

    #[test]
    fn the_round_5_findings_are_masked_in_both_maskers() {
        let cases = [
            // N6: a key read without its quotes and braces.
            (r#"{"key":"basic"}"#, format!(r#"{{"key":{MASKED}}}"#), 1),
            // N9: every separator is checked, not only the first (`headers`).
            (r#"{"headers":{"Authorization":"Bearer canarypw"}}"#, format!(r#"{{"headers":{{"Authorization":"Bearer {MASKED}"#), 1),
            // N10: an escaped quote does not close the value.
            (r#"password: "head\" canarypw""#, format!("password: {MASKED} {MASKED}"), 2),
            (r#"run --password "head\" canarypw""#, format!("run --password {MASKED} {MASKED}"), 2),
            (r#"{"password":"head\" canarypw"}"#, format!(r#"{{"password":{MASKED} {MASKED}"#), 2),
            // S1: a later secret key in the same compact word, and a value over several words.
            (r#"{"servers":[{"name":"a","token":"canarypw"}]}"#, format!(r#"{{"servers":[{{"name":"a","token":{MASKED}}}]}}"#), 1),
            (r#"{"note": "a b","password":"canarypw"}"#, format!(r#"{{"note": "a b","password":{MASKED}"#), 1),
            ("password: correct horse canarypw", format!("password: {MASKED} {MASKED} {MASKED}"), 3),
        ];
        for (text, expected, n) in cases {
            assert_eq!(mask_preview(text), (expected.clone(), n), "preview {text}");
            assert_eq!(mask_arg_value(text), (expected, n), "arg {text}");
        }
        // Over-masking stops where the value ends: after an inline table pair, after the quote the
        // header opened, and after a complete quoted value.
        assert_eq!(mask_preview("env: {API_KEY: a b, DEBUG: 1}").0, format!("env: {{API_KEY: {MASKED} {MASKED} DEBUG: 1}}"));
        assert_eq!(
            mask_arg_value(r#"curl -H "X-Api-Key: a b" https://api.example"#).0,
            format!(r#"curl -H "X-Api-Key: {MASKED} {MASKED} https://api.example"#)
        );
        assert_eq!(mask_preview(r#"password: "a b" # set by ops"#).0, format!("password: {MASKED} {MASKED} # set by ops"));
        // A pure reference stays visible; ordinary JSON stays as written.
        for kept in [r#"{"env":{"API_KEY":"${API_KEY}"}}"#, r#"{"command":"npx","args":["-y","pkg"]}"#, "password: ${DB_PASSWORD}"] {
            assert_eq!(mask_preview(kept), (kept.to_string(), 0), "{kept}");
            assert_eq!(mask_arg_value(kept), (kept.to_string(), 0), "{kept}");
        }
    }

    #[test]
    fn long_lines_are_masked_in_linear_time() {
        // A rules file is masked whole before its preview is cut, so one long line must not hang.
        let pairs = "k=v&".repeat(50_000);
        let json = format!("{{{}\"token\":\"canarypw\"}}", r#""name":"a","#.repeat(20_000));
        let words = "password: a ".repeat(20_000);
        let urls = format!("{}canarypw", "https://h.example/x?u=".repeat(10_000));
        for text in [pairs.as_str(), json.as_str(), words.as_str(), urls.as_str()] {
            let started = std::time::Instant::now();
            assert!(!mask_preview(text).0.contains("canarypw"));
            assert!(!mask_arg_value(text).0.contains("canarypw"));
            let elapsed = started.elapsed();
            assert!(elapsed < std::time::Duration::from_secs(2), "{elapsed:?} for {}", &text[..40]);
        }
        let (out, n) = mask_arg_value("curl --user=admin:canarypw https://api.example");
        assert_eq!((out, n), (format!("curl --user=admin:{MASKED} https://api.example"), 1));
    }

    #[test]
    fn canary_sweep_shows_no_secret_in_any_syntax() {
        let mut leaks: Vec<String> = Vec::new();
        for line in CANARY_LINES {
            assert!(line.contains("canarypw-"), "{line}");
            let outputs = [
                ("mask_preview", mask_preview(line).0),
                ("mask_arg_value", mask_arg_value(line).0),
                ("mask_args", mask_args(&[line.to_string()]).0.join(" ")),
            ];
            for (masker, out) in outputs {
                if out.contains("canarypw") {
                    leaks.push(format!("{masker}: {line}  ->  {out}"));
                }
            }
        }
        let leaked_lines = CANARY_LINES
            .iter()
            .filter(|line| leaks.iter().any(|leak| leak.contains(&format!(": {line}  ->"))))
            .count();
        println!("canary sweep: {} lines, {leaked_lines} lines leaked, {} leaking outputs", CANARY_LINES.len(), leaks.len());
        for leak in &leaks {
            println!("LEAK {leak}");
        }
        assert!(leaks.is_empty(), "{} leaking outputs on {leaked_lines} lines", leaks.len());
    }
}
