use crate::env::{Environment, TargetOs};
use std::path::PathBuf;
use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum PathError {
    #[error("Missing home directory")]
    MissingHome,
    #[error("Unresolved environment variable: {0}")]
    UnresolvedEnv(String),
}

/// Expands `~` and environment variables in a path pattern according to the target OS.
pub fn expand_path(
    pattern: &str,
    os: TargetOs,
    env: &dyn Environment,
) -> Result<PathBuf, PathError> {
    let mut expanded = pattern.to_string();

    // 1. Expand %VAR% for Windows-style variables
    let mut win_start = 0;
    while let Some(start) = expanded[win_start..].find('%') {
        let abs_start = win_start + start;
        if let Some(end) = expanded[abs_start + 1..].find('%') {
            let abs_end = abs_start + 1 + end;
            let var_name = &expanded[abs_start + 1..abs_end];
            if let Some(val) = env.var(var_name) {
                expanded.replace_range(abs_start..=abs_end, &val);
                win_start = abs_start + val.len();
            } else {
                return Err(PathError::UnresolvedEnv(var_name.to_string()));
            }
        } else {
            break;
        }
    }

    // 2. Expand ${VAR} Unix-style variables
    while let Some(start) = expanded.find("${") {
        if let Some(end) = expanded[start + 2..].find('}') {
            let abs_end = start + 2 + end;
            let var_name = &expanded[start + 2..abs_end];
            if let Some(val) = env.var(var_name) {
                expanded.replace_range(start..=abs_end, &val);
            } else {
                return Err(PathError::UnresolvedEnv(var_name.to_string()));
            }
        } else {
            break;
        }
    }

    // 3. Expand $VAR Unix-style variables
    let mut i = 0;
    while i < expanded.len() {
        if let Some(pos) = expanded[i..].find('$') {
            let abs_pos = i + pos;
            if abs_pos + 1 < expanded.len() && expanded.as_bytes()[abs_pos + 1] == b'{' {
                i = abs_pos + 2;
                continue;
            }
            // Find end of identifier: [A-Za-z0-9_]
            let mut end_pos = abs_pos + 1;
            while end_pos < expanded.len() {
                let b = expanded.as_bytes()[end_pos];
                if b.is_ascii_alphanumeric() || b == b'_' {
                    end_pos += 1;
                } else {
                    break;
                }
            }
            if end_pos > abs_pos + 1 {
                let var_name = &expanded[abs_pos + 1..end_pos];
                if let Some(val) = env.var(var_name) {
                    expanded.replace_range(abs_pos..end_pos, &val);
                    i = abs_pos + val.len();
                    continue;
                } else {
                    return Err(PathError::UnresolvedEnv(var_name.to_string()));
                }
            } else {
                i = abs_pos + 1;
            }
        } else {
            break;
        }
    }

    // 4. Expand ~
    if expanded.starts_with('~') {
        let home = env.home_dir().ok_or(PathError::MissingHome)?;
        let home_str = home.to_string_lossy().to_string();
        if expanded == "~" {
            expanded = home_str;
        } else if expanded.starts_with("~/") || expanded.starts_with("~\\") {
            let rest = &expanded[2..];
            let sep = if os == TargetOs::Windows { "\\" } else { "/" };
            expanded = format!("{}{}{}", home_str.trim_end_matches(['/', '\\']), sep, rest);
        }
    }

    // 5. Normalize separators according to OS
    if os == TargetOs::Windows {
        expanded = expanded.replace('/', "\\");
    }

    Ok(PathBuf::from(expanded))
}
