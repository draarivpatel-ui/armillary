use std::path::Path;

/// Folders and files that hold keys or tokens for other tools. A path with any of these as a
/// component is never opened (the boundary checks every component of the resolved path).
const CREDENTIAL_PLACES: &[&str] = &[
    ".ssh",
    ".aws",
    ".gnupg",
    ".netrc",
    "_netrc",
    ".pgpass",
    ".git-credentials",
    ".npmrc",
    ".pypirc",
    "credentials",
    // The macOS keychain folder (~/Library/Keychains); its files are refused by name as well.
    "keychains",
];

/// True for a folder or file name that is itself a credential store (~/.ssh, ~/.aws, .netrc and
/// similar), as opposed to a name that only looks like a key file. Used for the folders above an
/// approved project root (P3-1): a project called keychain-app is fine, a project inside ~/.ssh is
/// not.
pub fn is_credential_place(name: &str) -> bool {
    CREDENTIAL_PLACES.contains(&name.to_ascii_lowercase().as_str())
}

/// Check if a file or path represents a credential or secret file that must never be opened.
pub fn is_credential_file(path: &Path) -> bool {
    let path_str = path.to_string_lossy().to_ascii_lowercase();
    let file_name = path_str.rsplit(['/', '\\']).next().unwrap_or(&path_str);

    if file_name == "auth.json"
        || file_name == ".credentials.json"
        || file_name == "credentials.json"
        || file_name == ".env"
        || file_name.starts_with(".env.")
        || file_name.ends_with(".key")
        || file_name.contains("keychain")
        || file_name.starts_with("id_rsa")
        || file_name.starts_with("id_ed25519")
        || file_name.starts_with("id_ecdsa")
        || file_name.starts_with("id_dsa")
        || CREDENTIAL_PLACES.contains(&file_name)
        || path_str.ends_with("/gh/hosts.yml")
    {
        return true;
    }

    false
}
