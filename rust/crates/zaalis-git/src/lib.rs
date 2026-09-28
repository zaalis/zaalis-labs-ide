//! Git operations used by the universal tool runtime.
//!
//! Commands are always passed as argument arrays, never through a shell. Git
//! is run with prompting disabled so a daemon cannot hang on credentials.

use serde::{Deserialize, Serialize};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use zaalis_core::{Result, ZaalisError};

const MAX_GIT_OUTPUT_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct GitRepository {
    root: PathBuf,
    managed_worktrees: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitStatus {
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub entries: Vec<StatusEntry>,
    pub clean: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatusEntry {
    pub index: char,
    pub worktree: char,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitDiff {
    pub text: String,
    pub truncated: bool,
    pub bytes: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BranchInfo {
    pub name: String,
    pub current: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorktreeInfo {
    pub path: String,
    pub head: String,
    pub branch: Option<String>,
    pub bare: bool,
    pub detached: bool,
}

impl GitRepository {
    pub fn open(root: impl AsRef<Path>) -> Result<Self> {
        let root = dunce_path(root.as_ref())?;
        let probe = run_git_at(&root, ["rev-parse", "--show-toplevel"])?;
        let git_root = dunce_path(Path::new(probe.trim()))?;
        if git_root != root {
            return Err(ZaalisError::invalid(format!(
                "le workspace doit être la racine Git : {}",
                git_root.display()
            )));
        }
        let repo_name = root
            .file_name()
            .and_then(OsStr::to_str)
            .unwrap_or("workspace");
        let managed_worktrees = root
            .parent()
            .unwrap_or(&root)
            .join(".zaalis-worktrees")
            .join(safe_component(repo_name)?);
        Ok(Self {
            root,
            managed_worktrees,
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn managed_worktrees(&self) -> &Path {
        &self.managed_worktrees
    }

    pub fn status(&self) -> Result<GitStatus> {
        let text = self.git([
            "status",
            "--porcelain=v1",
            "--branch",
            "--untracked-files=all",
        ])?;
        parse_status(&text)
    }

    pub fn diff(&self, staged: bool, path: Option<&str>) -> Result<GitDiff> {
        let mut args = vec!["diff"];
        if staged {
            args.push("--cached");
        }
        args.extend(["--no-ext-diff", "--no-color", "--"]);
        if let Some(path) = path.filter(|value| !value.is_empty()) {
            reject_pathspec(path)?;
            args.push(path);
        }
        let bytes = self.git_bytes(args)?;
        let full_len = bytes.len();
        let truncated = full_len > MAX_GIT_OUTPUT_BYTES;
        let visible = &bytes[..full_len.min(MAX_GIT_OUTPUT_BYTES)];
        Ok(GitDiff {
            text: String::from_utf8_lossy(visible).into_owned(),
            truncated,
            bytes: full_len,
        })
    }

    pub fn branches(&self) -> Result<Vec<BranchInfo>> {
        let text = self.git(["branch", "--format=%(HEAD)%00%(refname:short)"])?;
        let mut branches = Vec::new();
        for line in text.lines() {
            let Some((head, name)) = line.split_once('\0') else {
                continue;
            };
            branches.push(BranchInfo {
                name: name.to_owned(),
                current: head == "*",
            });
        }
        Ok(branches)
    }

    pub fn create_branch(&self, name: &str, start_point: Option<&str>) -> Result<()> {
        validate_ref(name)?;
        let mut args = vec!["branch", "--", name];
        if let Some(start) = start_point.filter(|value| !value.is_empty()) {
            validate_ref(start)?;
            args.push(start);
        }
        self.git(args).map(|_| ())
    }

    pub fn worktrees(&self) -> Result<Vec<WorktreeInfo>> {
        parse_worktrees(&self.git(["worktree", "list", "--porcelain"])?)
    }

    pub fn add_worktree(&self, name: &str, branch: &str, create_branch: bool) -> Result<PathBuf> {
        let component = safe_component(name)?;
        validate_ref(branch)?;
        let destination = self.managed_worktrees.join(component);
        if destination.exists() {
            return Err(ZaalisError::invalid(format!(
                "worktree déjà présent : {}",
                destination.display()
            )));
        }
        std::fs::create_dir_all(&self.managed_worktrees)?;
        let destination_text = destination.to_string_lossy().into_owned();
        let args = if create_branch {
            vec!["worktree", "add", "-b", branch, &destination_text]
        } else {
            vec!["worktree", "add", &destination_text, branch]
        };
        if let Err(error) = self.git(args) {
            if destination.is_dir() {
                let _ = std::fs::remove_dir(&destination);
            }
            return Err(error);
        }
        dunce_path(&destination)
    }

    pub fn remove_worktree(&self, name: &str) -> Result<()> {
        let destination = self.managed_worktrees.join(safe_component(name)?);
        let canonical_parent = dunce_path(&self.managed_worktrees)?;
        let canonical_target = dunce_path(&destination)?;
        if canonical_target.parent() != Some(canonical_parent.as_path()) {
            return Err(ZaalisError::outside_workspace("worktree non géré"));
        }
        let destination_text = canonical_target.to_string_lossy().into_owned();
        self.git(["worktree", "remove", "--", &destination_text])?;
        Ok(())
    }

    fn git<I, S>(&self, args: I) -> Result<String>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let bytes = self.git_bytes(args)?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }

    fn git_bytes<I, S>(&self, args: I) -> Result<Vec<u8>>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let output = git_command(&self.root, args).output()?;
        output_result(output)
    }
}

fn git_command<I, S>(root: &Path, args: I) -> Command
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut command = Command::new("git");
    command
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .args(args);
    command
}

fn run_git_at<I, S>(root: &Path, args: I) -> Result<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let output = git_command(root, args).output()?;
    Ok(String::from_utf8_lossy(&output_result(output)?).into_owned())
}

fn output_result(output: Output) -> Result<Vec<u8>> {
    if output.status.success() {
        return Ok(output.stdout);
    }
    let message = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    Err(ZaalisError::tool(if message.is_empty() {
        format!("git a quitté avec {}", output.status)
    } else {
        message
    }))
}

fn dunce_path(path: &Path) -> Result<PathBuf> {
    dunce::canonicalize(path).map_err(Into::into)
}

fn safe_component(value: &str) -> Result<&str> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed == "."
        || trimmed == ".."
        || trimmed.contains(['/', '\\', ':'])
        || trimmed.chars().any(char::is_control)
    {
        return Err(ZaalisError::invalid("nom de worktree invalide"));
    }
    Ok(trimmed)
}

fn validate_ref(value: &str) -> Result<()> {
    if value.trim().is_empty() || value.starts_with('-') || value.contains(['\0', '\n', '\r']) {
        return Err(ZaalisError::invalid("référence Git invalide"));
    }
    Ok(())
}

fn reject_pathspec(value: &str) -> Result<()> {
    if value.starts_with('-') || value.contains(['\0', '\n', '\r']) || value.contains("..") {
        return Err(ZaalisError::invalid("pathspec Git invalide"));
    }
    Ok(())
}

fn parse_status(text: &str) -> Result<GitStatus> {
    let mut branch = None;
    let mut upstream = None;
    let mut ahead = 0;
    let mut behind = 0;
    let mut entries = Vec::new();
    for line in text.lines() {
        if let Some(header) = line.strip_prefix("## ") {
            let (head, tracking) = header.split_once("...").unwrap_or((header, ""));
            branch = (head != "HEAD (no branch)").then(|| head.to_owned());
            if !tracking.is_empty() {
                let tracking = tracking.trim();
                let (name, counts) = tracking.split_once(" [").unwrap_or((tracking, ""));
                upstream = Some(name.to_owned());
                let counts = counts.trim_end_matches(']');
                for count in counts.split(", ") {
                    if let Some(value) = count.strip_prefix("ahead ") {
                        ahead = value.parse().unwrap_or(0);
                    }
                    if let Some(value) = count.strip_prefix("behind ") {
                        behind = value.parse().unwrap_or(0);
                    }
                }
            }
            continue;
        }
        let bytes = line.as_bytes();
        if bytes.len() < 3 {
            continue;
        }
        let body = &line[3..];
        let (path, original_path) = body
            .split_once(" -> ")
            .map_or((body.to_owned(), None), |(from, to)| {
                (to.to_owned(), Some(from.to_owned()))
            });
        entries.push(StatusEntry {
            index: bytes[0] as char,
            worktree: bytes[1] as char,
            path,
            original_path,
        });
    }
    Ok(GitStatus {
        branch,
        upstream,
        ahead,
        behind,
        clean: entries.is_empty(),
        entries,
    })
}

fn parse_worktrees(text: &str) -> Result<Vec<WorktreeInfo>> {
    let mut result = Vec::new();
    for block in text.split("\n\n").filter(|block| !block.trim().is_empty()) {
        let mut path = None;
        let mut head = None;
        let mut branch = None;
        let mut bare = false;
        let mut detached = false;
        for line in block.lines() {
            if let Some(value) = line.strip_prefix("worktree ") {
                path = Some(value.to_owned());
            } else if let Some(value) = line.strip_prefix("HEAD ") {
                head = Some(value.to_owned());
            } else if let Some(value) = line.strip_prefix("branch ") {
                branch = Some(value.trim_start_matches("refs/heads/").to_owned());
            } else if line == "bare" {
                bare = true;
            } else if line == "detached" {
                detached = true;
            }
        }
        result.push(WorktreeInfo {
            path: path.ok_or_else(|| ZaalisError::tool("sortie worktree sans chemin"))?,
            head: head.unwrap_or_default(),
            branch,
            bare,
            detached,
        });
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn repository() -> (TempDir, GitRepository) {
        let dir = TempDir::new().expect("tempdir");
        run_git_at(dir.path(), ["init", "-q"]).expect("init");
        run_git_at(dir.path(), ["config", "user.email", "test@zaalis.local"]).expect("email");
        run_git_at(dir.path(), ["config", "user.name", "Zaalis Test"]).expect("name");
        fs::write(dir.path().join("tracked.txt"), "one\n").expect("write");
        run_git_at(dir.path(), ["add", "tracked.txt"]).expect("add");
        run_git_at(dir.path(), ["commit", "-qm", "initial"]).expect("commit");
        let repo = GitRepository::open(dir.path()).expect("open");
        (dir, repo)
    }

    #[test]
    fn status_and_diff_are_structured() {
        let (dir, repo) = repository();
        fs::write(dir.path().join("tracked.txt"), "two\n").expect("edit");
        fs::write(dir.path().join("new.txt"), "new\n").expect("new");
        let status = repo.status().expect("status");
        assert!(!status.clean);
        assert!(status
            .entries
            .iter()
            .any(|entry| entry.path == "tracked.txt"));
        assert!(status.entries.iter().any(|entry| entry.path == "new.txt"));
        let diff = repo.diff(false, Some("tracked.txt")).expect("diff");
        assert!(diff.text.contains("-one"));
        assert!(diff.text.contains("+two"));
    }

    #[test]
    fn branches_and_worktrees_have_machine_readable_results() {
        let (_dir, repo) = repository();
        repo.create_branch("feature/test", None).expect("branch");
        assert!(repo
            .branches()
            .expect("branches")
            .iter()
            .any(|branch| branch.name == "feature/test"));
        let destination = repo
            .add_worktree("agent-1", "feature/test", false)
            .expect("worktree");
        assert!(destination.join("tracked.txt").exists());
        assert!(repo
            .worktrees()
            .expect("list")
            .iter()
            .any(|worktree| worktree.branch.as_deref() == Some("feature/test")));
        repo.remove_worktree("agent-1").expect("remove");
        assert!(!destination.exists());
    }

    #[test]
    fn unsafe_names_and_pathspecs_are_rejected_before_git() {
        let (_dir, repo) = repository();
        assert!(repo.add_worktree("../escape", "main", false).is_err());
        assert!(repo.diff(false, Some("../outside")).is_err());
        assert!(repo.create_branch("--help", None).is_err());
    }

    #[test]
    fn porcelain_parsers_cover_tracking_and_renames() {
        let parsed = parse_status(
            "## main...origin/main [ahead 2, behind 1]\nR  old.txt -> new.txt\n?? loose.txt\n",
        )
        .expect("parse");
        assert_eq!(parsed.branch.as_deref(), Some("main"));
        assert_eq!(parsed.upstream.as_deref(), Some("origin/main"));
        assert_eq!((parsed.ahead, parsed.behind), (2, 1));
        assert_eq!(parsed.entries[0].original_path.as_deref(), Some("old.txt"));
    }
}
