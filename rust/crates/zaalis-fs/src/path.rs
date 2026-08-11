//! Workspace confinement.
//!
//! This is the security boundary for every file a model can reach. The rule is
//! simple and absolute: a resolved path is usable only if its canonical form
//! lies inside the canonical workspace root.
//!
//! The JavaScript engine checked containment *lexically*, with
//! `normalizeProjectPath` and `isInside` in `agent-engine.js`. A symbolic link
//! or an NTFS junction sitting inside the project and pointing outside it
//! therefore passed the check and was then read or written. Canonicalising
//! first closes that hole, and it is why this module resolves the deepest
//! existing ancestor rather than trusting the string it was handed.

use std::path::{Component, Path, PathBuf};
use zaalis_core::{Result, ZaalisError};

/// Names Windows treats as devices no matter which directory they sit in.
/// Opening one does not touch the filesystem at all, so they must never reach
/// an `fs` call.
const WINDOWS_DEVICE_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Directory names never walked, listed or searched.
///
/// Same set the existing engine filters (`FILTERED_NAMES`), plus the zaalis
/// runtime directory.
pub const ALWAYS_SKIPPED_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    ".zaalis",
    "server-data",
    "target",
    ".DS_Store",
];

/// File patterns denied by default even when the mode would allow the access.
///
/// A model that can read `.env` can exfiltrate every key the user owns through
/// its own answer, so this list is enforced under the permission engine rather
/// than left to policy.
pub const SENSITIVE_PATTERNS: &[&str] = &[
    ".env",
    ".env.*",
    "*.pem",
    "*.key",
    "*.pfx",
    "id_rsa",
    "id_rsa.*",
    "id_ed25519",
    "id_ed25519.*",
    ".npmrc",
    ".pypirc",
    ".netrc",
    "credentials",
    "*.p12",
];

/// A path proven to live inside the workspace.
///
/// The only way to obtain one is [`Workspace::resolve`], so a function taking a
/// `ResolvedPath` cannot be handed an unvalidated string by mistake.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedPath {
    absolute: PathBuf,
    relative: String,
    exists: bool,
}

impl ResolvedPath {
    /// Absolute path, safe to hand to `std::fs`.
    pub fn absolute(&self) -> &Path {
        &self.absolute
    }

    /// Forward-slash path relative to the workspace root. This is what the model
    /// and the interface both see; absolute paths never leave the core.
    pub fn relative(&self) -> &str {
        &self.relative
    }

    pub fn exists(&self) -> bool {
        self.exists
    }

    pub fn is_dir(&self) -> bool {
        self.absolute.is_dir()
    }

    pub fn is_file(&self) -> bool {
        self.absolute.is_file()
    }

    /// Whether this path matches the built-in sensitive list.
    pub fn is_sensitive(&self) -> bool {
        let name = self
            .absolute
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        SENSITIVE_PATTERNS.iter().any(|pattern| {
            match_simple_glob(pattern, name) || match_simple_glob(pattern, &self.relative)
        })
    }
}

/// Match a `*`-only glob. Enough for the built-in sensitive list; real rule
/// matching goes through `globset` in the guard.
fn match_simple_glob(pattern: &str, value: &str) -> bool {
    let value = value.to_ascii_lowercase();
    let pattern = pattern.to_ascii_lowercase();
    let mut parts = pattern.split('*');
    let Some(first) = parts.next() else {
        return false;
    };
    if !value.starts_with(first) {
        return false;
    }
    let mut cursor = first.len();
    let mut last = "";
    for part in parts {
        last = part;
        if part.is_empty() {
            continue;
        }
        match value[cursor..].find(part) {
            Some(offset) => cursor += offset + part.len(),
            None => return false,
        }
    }
    if !pattern.contains('*') {
        return value == pattern;
    }
    value[cursor..].is_empty() || value.ends_with(last)
}

/// The project directory an agent tree is confined to.
#[derive(Debug, Clone)]
pub struct Workspace {
    root: PathBuf,
}

impl Workspace {
    /// Open a workspace, canonicalising the root once so every later comparison
    /// is between canonical forms.
    pub fn open(root: impl AsRef<Path>) -> Result<Self> {
        let root = root.as_ref();
        if !root.exists() {
            return Err(ZaalisError::not_found(format!(
                "dossier de projet introuvable : {}",
                root.display()
            )));
        }
        if !root.is_dir() {
            return Err(ZaalisError::invalid(format!(
                "la racine du projet n'est pas un dossier : {}",
                root.display()
            )));
        }
        let canonical = dunce::canonicalize(root).map_err(|error| {
            ZaalisError::io(format!(
                "impossible de résoudre {} : {error}",
                root.display()
            ))
        })?;
        Ok(Self { root: canonical })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The workspace root as a [`ResolvedPath`], for tools that operate on `.`.
    pub fn root_path(&self) -> ResolvedPath {
        ResolvedPath {
            absolute: self.root.clone(),
            relative: String::new(),
            exists: true,
        }
    }

    /// Resolve a model- or user-supplied path.
    ///
    /// Rejects, in order: empty input, UNC and verbatim prefixes, absolute paths
    /// outside the root, `..` traversal, alternate data streams, Windows device
    /// names, components with trailing dots or spaces, control characters, and
    /// finally anything whose canonical form escapes the root — which is what
    /// catches symlinks and junctions.
    pub fn resolve(&self, input: &str) -> Result<ResolvedPath> {
        let relative = self.to_relative(input)?;
        let candidate = if relative.is_empty() {
            self.root.clone()
        } else {
            self.root
                .join(relative.replace('/', std::path::MAIN_SEPARATOR_STR))
        };

        let exists = candidate.exists();
        let canonical = canonicalize_deepest(&candidate)?;
        if !canonical.starts_with(&self.root) {
            return Err(ZaalisError::outside_workspace(format!(
                "« {input} » sort du dossier de projet (lien ou jonction ?)"
            )));
        }

        // Recompute the relative form from the canonical path: a symlink that
        // stays inside the workspace is legitimate, but the model should see
        // where it actually landed.
        let relative = canonical
            .strip_prefix(&self.root)
            .map(|rest| rest.to_string_lossy().replace('\\', "/"))
            .unwrap_or(relative);

        Ok(ResolvedPath {
            absolute: canonical,
            relative,
            exists,
        })
    }

    /// Normalise an input path to a forward-slash path relative to the root,
    /// applying every syntactic rule. No filesystem access happens here.
    fn to_relative(&self, input: &str) -> Result<String> {
        let trimmed = input
            .trim()
            .trim_matches(|c| c == '"' || c == '\'' || c == '`');
        if trimmed.is_empty() {
            return Err(ZaalisError::invalid("chemin vide"));
        }

        let unified = trimmed.replace('\\', "/");

        if unified.starts_with("//") {
            return Err(ZaalisError::outside_workspace(
                "les chemins réseau (UNC) sont refusés",
            ));
        }
        if trimmed.starts_with("\\\\?\\") || trimmed.starts_with("\\\\.\\") {
            return Err(ZaalisError::outside_workspace(
                "les chemins « verbatim » Windows sont refusés",
            ));
        }

        // An absolute path is accepted only if it already points inside the
        // workspace; it is then reduced to a relative one.
        let is_absolute = unified.starts_with('/')
            || (unified.len() >= 3
                && unified.as_bytes()[1] == b':'
                && unified.as_bytes()[0].is_ascii_alphabetic());

        let body = if is_absolute {
            let root_text = self.root.to_string_lossy().replace('\\', "/");
            let candidate = unified.trim_end_matches('/');
            let root_text = root_text.trim_end_matches('/');
            if candidate.eq_ignore_ascii_case(root_text) {
                String::new()
            } else {
                let prefix = format!("{root_text}/");
                let matches_prefix = candidate.len() > prefix.len()
                    && candidate[..prefix.len()].eq_ignore_ascii_case(&prefix);
                if !matches_prefix {
                    return Err(ZaalisError::outside_workspace(format!(
                        "« {input} » est hors du dossier de projet"
                    )));
                }
                candidate[prefix.len()..].to_owned()
            }
        } else {
            unified.trim_start_matches("./").to_owned()
        };

        let mut parts: Vec<&str> = Vec::new();
        for component in body.split('/') {
            match component {
                "" | "." => continue,
                ".." => {
                    return Err(ZaalisError::outside_workspace(format!(
                        "« {input} » remonte hors du dossier de projet"
                    )))
                }
                other => {
                    validate_component(other, input)?;
                    parts.push(other);
                }
            }
        }

        Ok(parts.join("/"))
    }

    /// Whether an absolute path is inside this workspace. Used by tools that
    /// receive a path from somewhere other than a model.
    pub fn contains(&self, path: &Path) -> bool {
        canonicalize_deepest(path)
            .map(|canonical| canonical.starts_with(&self.root))
            .unwrap_or(false)
    }

    /// Whether a workspace-relative path matches the built-in sensitive list.
    ///
    /// Callers must still resolve the path before accessing it. This helper is
    /// intended for directory walkers, which already obtained a confined path
    /// and need to decide whether its contents may be inspected.
    pub fn is_sensitive_relative(&self, relative: &str) -> bool {
        let name = Path::new(relative)
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        SENSITIVE_PATTERNS
            .iter()
            .any(|pattern| match_simple_glob(pattern, name) || match_simple_glob(pattern, relative))
    }
}

/// Reject a single path component that the OS would reinterpret.
fn validate_component(component: &str, original: &str) -> Result<()> {
    if component.contains(':') {
        // On Windows `file.txt:hidden` opens an alternate data stream, which is
        // an invisible sidecar the containment check would never see.
        return Err(ZaalisError::outside_workspace(format!(
            "« {original} » contient « : » (flux de données alterné refusé)"
        )));
    }
    if component.chars().any(|c| c.is_control()) {
        return Err(ZaalisError::invalid(format!(
            "« {original} » contient un caractère de contrôle"
        )));
    }
    if component.ends_with('.') || component.ends_with(' ') {
        // Windows silently strips these, so `secret.txt.` and `secret.txt` are
        // the same file while comparing as different strings.
        return Err(ZaalisError::invalid(format!(
            "« {original} » contient un composant terminé par un point ou une espace"
        )));
    }
    let stem = component.split('.').next().unwrap_or(component);
    if WINDOWS_DEVICE_NAMES
        .iter()
        .any(|device| stem.eq_ignore_ascii_case(device))
    {
        return Err(ZaalisError::invalid(format!(
            "« {original} » désigne un périphérique Windows réservé"
        )));
    }
    Ok(())
}

/// Canonicalise as much of `path` as exists, then re-append the rest.
///
/// A write targets a file that does not exist yet, so plain `canonicalize`
/// fails. Resolving the deepest existing ancestor still catches a symlinked
/// parent directory, which is the case that actually matters.
fn canonicalize_deepest(path: &Path) -> Result<PathBuf> {
    let mut existing = path;
    let mut tail: Vec<Component<'_>> = Vec::new();

    loop {
        if existing.exists() {
            break;
        }
        match (existing.parent(), existing.components().next_back()) {
            (Some(parent), Some(last)) => {
                tail.push(last);
                existing = parent;
            }
            _ => {
                return Err(ZaalisError::not_found(format!(
                    "chemin introuvable : {}",
                    path.display()
                )))
            }
        }
    }

    let mut canonical = dunce::canonicalize(existing).map_err(|error| {
        ZaalisError::io(format!(
            "impossible de résoudre {} : {error}",
            existing.display()
        ))
    })?;
    for component in tail.into_iter().rev() {
        canonical.push(component.as_os_str());
    }
    Ok(canonical)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn workspace() -> (TempDir, Workspace) {
        let dir = TempDir::new().expect("tempdir");
        fs::create_dir_all(dir.path().join("src")).expect("mkdir");
        fs::write(dir.path().join("src/app.js"), "const a = 1;\n").expect("write");
        fs::write(dir.path().join(".env"), "SECRET=1\n").expect("write");
        let workspace = Workspace::open(dir.path()).expect("open");
        (dir, workspace)
    }

    #[test]
    fn resolves_a_plain_relative_path() {
        let (_dir, workspace) = workspace();
        let resolved = workspace.resolve("src/app.js").expect("resolve");
        assert_eq!(resolved.relative(), "src/app.js");
        assert!(resolved.exists());
        assert!(resolved.is_file());
    }

    #[test]
    fn accepts_backslashes_and_quotes_like_the_previous_engine() {
        let (_dir, workspace) = workspace();
        for input in [
            "src\\app.js",
            "\"src/app.js\"",
            "'src/app.js'",
            "./src/app.js",
        ] {
            let resolved = workspace
                .resolve(input)
                .unwrap_or_else(|error| panic!("« {input} » devrait être accepté : {error}"));
            assert_eq!(resolved.relative(), "src/app.js");
        }
    }

    #[test]
    fn resolves_a_path_that_does_not_exist_yet() {
        let (_dir, workspace) = workspace();
        let resolved = workspace.resolve("src/new/deep.rs").expect("resolve");
        assert!(!resolved.exists());
        assert_eq!(resolved.relative(), "src/new/deep.rs");
        assert!(resolved.absolute().starts_with(workspace.root()));
    }

    #[test]
    fn rejects_parent_traversal() {
        let (_dir, workspace) = workspace();
        for input in ["../secret", "src/../../secret", "..", "src/../.."] {
            let error = workspace
                .resolve(input)
                .expect_err("la traversée doit être refusée");
            assert_eq!(error.code, zaalis_core::ErrorCode::OutsideWorkspace);
        }
    }

    #[test]
    fn rejects_absolute_paths_outside_the_root() {
        let (_dir, workspace) = workspace();
        for input in ["C:/Windows/System32/drivers/etc/hosts", "/etc/passwd"] {
            assert!(
                workspace.resolve(input).is_err(),
                "« {input} » devrait être refusé"
            );
        }
    }

    #[test]
    fn accepts_an_absolute_path_that_is_already_inside() {
        let (_dir, workspace) = workspace();
        let absolute = workspace.root().join("src/app.js");
        let resolved = workspace
            .resolve(&absolute.to_string_lossy())
            .expect("resolve");
        assert_eq!(resolved.relative(), "src/app.js");
    }

    #[test]
    fn rejects_unc_and_verbatim_paths() {
        let (_dir, workspace) = workspace();
        for input in [
            "//server/share/file",
            "\\\\server\\share\\file",
            "\\\\?\\C:\\x",
        ] {
            assert!(
                workspace.resolve(input).is_err(),
                "« {input} » devrait être refusé"
            );
        }
    }

    #[test]
    fn rejects_alternate_data_streams() {
        let (_dir, workspace) = workspace();
        let error = workspace
            .resolve("src/app.js:hidden")
            .expect_err("ADS refusé");
        assert_eq!(error.code, zaalis_core::ErrorCode::OutsideWorkspace);
    }

    #[test]
    fn rejects_windows_device_names() {
        let (_dir, workspace) = workspace();
        for input in ["CON", "nul", "src/COM1.txt", "aux.log", "LPT9"] {
            assert!(
                workspace.resolve(input).is_err(),
                "« {input} » devrait être refusé"
            );
        }
        // A name that merely starts with a device name is fine.
        assert!(workspace.resolve("console.js").is_ok());
        assert!(workspace.resolve("src/nullable.rs").is_ok());
    }

    #[test]
    fn rejects_trailing_dots_and_spaces_inside_the_path() {
        let (_dir, workspace) = workspace();
        for input in ["secret.txt.", "dir./file", "dir /file", "secret.txt. "] {
            assert!(
                workspace.resolve(input).is_err(),
                "« {input} » devrait être refusé"
            );
        }
    }

    #[test]
    fn whitespace_around_the_whole_input_is_trimmed_not_rejected() {
        // A model routinely pads a path with a stray space. Trimming the outer
        // whitespace normalises it onto the canonical name, which is also what
        // the deny rules will be matched against — so this is the safe
        // direction. Only whitespace *inside* the path stays an error.
        let (_dir, workspace) = workspace();
        for input in ["  src/app.js", "src/app.js  ", "\tsrc/app.js\n"] {
            let resolved = workspace
                .resolve(input)
                .unwrap_or_else(|error| panic!("« {input} » : {error}"));
            assert_eq!(resolved.relative(), "src/app.js");
        }
    }

    #[test]
    fn rejects_control_characters() {
        let (_dir, workspace) = workspace();
        assert!(workspace.resolve("src/app\u{0}.js").is_err());
        assert!(workspace.resolve("src/app\n.js").is_err());
    }

    #[test]
    fn rejects_empty_input() {
        let (_dir, workspace) = workspace();
        assert!(workspace.resolve("").is_err());
        assert!(workspace.resolve("   ").is_err());
    }

    #[test]
    fn the_root_itself_resolves_to_an_empty_relative_path() {
        let (_dir, workspace) = workspace();
        for input in [".", "./"] {
            let resolved = workspace.resolve(input).expect("resolve");
            assert_eq!(resolved.relative(), "");
            assert!(resolved.is_dir());
        }
        assert_eq!(workspace.root_path().relative(), "");
    }

    #[test]
    fn sensitive_files_are_recognised() {
        let (_dir, workspace) = workspace();
        assert!(workspace.resolve(".env").expect("resolve").is_sensitive());
        assert!(!workspace
            .resolve("src/app.js")
            .expect("resolve")
            .is_sensitive());
    }

    #[test]
    fn simple_glob_matches_the_sensitive_patterns() {
        assert!(match_simple_glob(".env", ".env"));
        assert!(match_simple_glob(".env.*", ".env.local"));
        assert!(match_simple_glob("*.pem", "server.pem"));
        assert!(match_simple_glob("id_rsa", "id_rsa"));
        assert!(!match_simple_glob("*.pem", "server.pemx"));
        assert!(!match_simple_glob(".env", ".environment"));
    }

    // A symlink pointing out of the workspace is the exact hole the previous
    // lexical check left open. Creating one needs privileges on Windows, so the
    // test asks for it and skips cleanly when the OS refuses rather than
    // reporting a false pass.
    #[test]
    fn a_symlink_escaping_the_workspace_is_refused() {
        let dir = TempDir::new().expect("tempdir");
        let outside = TempDir::new().expect("tempdir");
        fs::write(outside.path().join("secret.txt"), "classified").expect("write");

        let link = dir.path().join("escape");
        #[cfg(windows)]
        let created = std::os::windows::fs::symlink_dir(outside.path(), &link).is_ok();
        #[cfg(unix)]
        let created = std::os::unix::fs::symlink(outside.path(), &link).is_ok();

        if !created {
            eprintln!("symlink non créé (privilèges insuffisants) — test ignoré");
            return;
        }

        let workspace = Workspace::open(dir.path()).expect("open");
        let error = workspace
            .resolve("escape/secret.txt")
            .expect_err("le lien sortant doit être refusé");
        assert_eq!(
            error.code,
            zaalis_core::ErrorCode::OutsideWorkspace,
            "un lien vers l'extérieur doit être refusé, pas suivi"
        );
    }

    #[test]
    fn a_symlink_staying_inside_the_workspace_is_allowed() {
        let dir = TempDir::new().expect("tempdir");
        fs::create_dir_all(dir.path().join("real")).expect("mkdir");
        fs::write(dir.path().join("real/file.txt"), "ok").expect("write");

        let link = dir.path().join("alias");
        #[cfg(windows)]
        let created = std::os::windows::fs::symlink_dir(dir.path().join("real"), &link).is_ok();
        #[cfg(unix)]
        let created = std::os::unix::fs::symlink(dir.path().join("real"), &link).is_ok();

        if !created {
            eprintln!("symlink non créé (privilèges insuffisants) — test ignoré");
            return;
        }

        let workspace = Workspace::open(dir.path()).expect("open");
        let resolved = workspace
            .resolve("alias/file.txt")
            .expect("un lien interne reste autorisé");
        // The model is told where it actually landed.
        assert_eq!(resolved.relative(), "real/file.txt");
    }

    #[test]
    fn opening_a_missing_root_fails_clearly() {
        let error = Workspace::open("C:/definitely/not/here/zaalis").expect_err("missing");
        assert_eq!(error.code, zaalis_core::ErrorCode::NotFound);
    }

    #[test]
    fn contains_reports_membership_for_absolute_paths() {
        let (_dir, workspace) = workspace();
        assert!(workspace.contains(&workspace.root().join("src/app.js")));
        assert!(!workspace.contains(Path::new("C:/Windows")));
    }
}
