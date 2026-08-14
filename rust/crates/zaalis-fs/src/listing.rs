//! Directory listing and tree rendering.
//!
//! Separate from glob because the questions are different: glob answers "where
//! are the files matching X", listing answers "what is in this directory" and
//! tree answers "what does this project look like". Folding all three into one
//! tool is what pushed the previous engine into injecting a frozen file listing
//! into every prompt.

use crate::path::{Workspace, ALWAYS_SKIPPED_DIRS};
use serde::{Deserialize, Serialize};
use zaalis_core::{Result, ZaalisError};

/// Entries returned by one `list` call.
pub const MAX_LIST_ENTRIES: usize = 500;
/// Entries rendered in one `tree`.
pub const MAX_TREE_ENTRIES: usize = 400;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DirEntryInfo {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    /// Set when the entry is a symbolic link or a junction. Surfaced rather
    /// than followed: the resolver refuses links leaving the workspace, and the
    /// model should know why an entry may be unreadable.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub is_link: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ListResult {
    pub path: String,
    pub entries: Vec<DirEntryInfo>,
    pub truncated: bool,
    pub total: usize,
}

impl ListResult {
    pub fn to_prompt_text(&self) -> String {
        if self.entries.is_empty() {
            return format!("{}/ (vide)", display_path(&self.path));
        }
        let mut out = format!("{}/\n", display_path(&self.path));
        for entry in &self.entries {
            out.push_str(&format!(
                "  {}{}{}\n",
                entry.name,
                if entry.is_dir { "/" } else { "" },
                if entry.is_link { " → lien" } else { "" }
            ));
        }
        if self.truncated {
            out.push_str(&format!(
                "  … ({} entrées au total, liste tronquée)\n",
                self.total
            ));
        }
        out
    }
}

/// List one directory, without recursing.
pub fn list(workspace: &Workspace, path: Option<&str>, max: Option<usize>) -> Result<ListResult> {
    let target = match path {
        Some(value) if !value.is_empty() && value != "." => workspace.resolve(value)?,
        _ => workspace.root_path(),
    };
    if !target.exists() {
        return Err(ZaalisError::not_found(format!(
            "{} n'existe pas",
            target.relative()
        )));
    }
    if !target.is_dir() {
        return Err(ZaalisError::invalid(format!(
            "{} n'est pas un dossier",
            target.relative()
        )));
    }

    let max = max.unwrap_or(MAX_LIST_ENTRIES).clamp(1, MAX_LIST_ENTRIES);
    let mut entries: Vec<DirEntryInfo> = Vec::new();
    let mut total = 0usize;

    for entry in std::fs::read_dir(target.absolute())? {
        let Ok(entry) = entry else { continue };
        let name = entry.file_name().to_string_lossy().into_owned();
        if ALWAYS_SKIPPED_DIRS.contains(&name.as_str()) {
            continue;
        }
        total += 1;
        if entries.len() >= max {
            continue;
        }

        let metadata = entry.metadata().ok();
        let is_link = entry
            .file_type()
            .map(|kind| kind.is_symlink())
            .unwrap_or(false);
        let is_dir = metadata.as_ref().map(|meta| meta.is_dir()).unwrap_or(false);
        let relative = if target.relative().is_empty() {
            name.clone()
        } else {
            format!("{}/{name}", target.relative())
        };

        entries.push(DirEntryInfo {
            name,
            path: relative,
            is_dir,
            size_bytes: metadata
                .filter(|meta| meta.is_file())
                .map(|meta| meta.len()),
            is_link,
        });
    }

    // Directories first, then alphabetical — the order the file tree in the
    // interface already uses.
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));

    Ok(ListResult {
        path: target.relative().to_owned(),
        truncated: total > entries.len(),
        total,
        entries,
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TreeResult {
    pub path: String,
    /// Pre-rendered indented tree. Cheaper for the model to read than a nested
    /// structure it would have to walk.
    pub rendered: String,
    pub entries: usize,
    pub truncated: bool,
}

/// Render a bounded tree, for orienting an agent in an unfamiliar project.
pub fn tree(
    workspace: &Workspace,
    path: Option<&str>,
    max_depth: usize,
    max_entries: Option<usize>,
) -> Result<TreeResult> {
    let root = match path {
        Some(value) if !value.is_empty() && value != "." => workspace.resolve(value)?,
        _ => workspace.root_path(),
    };
    if !root.is_dir() {
        return Err(ZaalisError::invalid(format!(
            "{} n'est pas un dossier",
            root.relative()
        )));
    }

    let budget = max_entries
        .unwrap_or(MAX_TREE_ENTRIES)
        .clamp(1, MAX_TREE_ENTRIES);
    let depth = max_depth.clamp(1, 12);
    let mut rendered = String::new();
    let mut count = 0usize;
    let mut truncated = false;

    rendered.push_str(&format!("{}/\n", display_path(root.relative())));
    walk(
        workspace,
        root.absolute(),
        "",
        depth,
        budget,
        &mut count,
        &mut truncated,
        &mut rendered,
    );

    if truncated {
        rendered.push_str("… (arborescence tronquée)\n");
    }

    Ok(TreeResult {
        path: root.relative().to_owned(),
        rendered,
        entries: count,
        truncated,
    })
}

#[allow(clippy::too_many_arguments)]
fn walk(
    workspace: &Workspace,
    dir: &std::path::Path,
    prefix: &str,
    depth_left: usize,
    budget: usize,
    count: &mut usize,
    truncated: &mut bool,
    out: &mut String,
) {
    if depth_left == 0 || *truncated {
        return;
    }
    let Ok(reader) = std::fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<_> = reader
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            !ALWAYS_SKIPPED_DIRS.contains(&entry.file_name().to_string_lossy().as_ref())
        })
        .collect();
    entries.sort_by_key(|entry| {
        let is_dir = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
        (!is_dir, entry.file_name())
    });

    let last_index = entries.len().saturating_sub(1);
    for (index, entry) in entries.iter().enumerate() {
        if *count >= budget {
            *truncated = true;
            return;
        }
        *count += 1;

        let is_last = index == last_index;
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_dir = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
        out.push_str(prefix);
        out.push_str(if is_last { "└── " } else { "├── " });
        out.push_str(&name);
        if is_dir {
            out.push('/');
        }
        out.push('\n');

        if is_dir {
            // Never follow a link out of the workspace while rendering a tree.
            if !workspace.contains(&entry.path()) {
                continue;
            }
            let child_prefix = format!("{prefix}{}", if is_last { "    " } else { "│   " });
            walk(
                workspace,
                &entry.path(),
                &child_prefix,
                depth_left - 1,
                budget,
                count,
                truncated,
                out,
            );
        }
    }
}

fn display_path(relative: &str) -> &str {
    if relative.is_empty() {
        "."
    } else {
        relative
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn sample() -> (TempDir, Workspace) {
        let dir = TempDir::new().expect("tempdir");
        fs::create_dir_all(dir.path().join("src/deep")).expect("mkdir");
        fs::create_dir_all(dir.path().join("node_modules")).expect("mkdir");
        fs::write(dir.path().join("src/app.js"), "x").expect("w");
        fs::write(dir.path().join("src/deep/inner.js"), "y").expect("w");
        fs::write(dir.path().join("README.md"), "z").expect("w");
        fs::write(dir.path().join("node_modules/junk.js"), "junk").expect("w");
        let workspace = Workspace::open(dir.path()).expect("open");
        (dir, workspace)
    }

    #[test]
    fn list_puts_directories_first() {
        let (_dir, workspace) = sample();
        let result = list(&workspace, None, None).expect("list");
        assert!(result.entries[0].is_dir);
        let names: Vec<_> = result.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["src", "README.md"]);
    }

    #[test]
    fn list_hides_the_always_skipped_directories() {
        let (_dir, workspace) = sample();
        let result = list(&workspace, None, None).expect("list");
        assert!(result.entries.iter().all(|e| e.name != "node_modules"));
    }

    #[test]
    fn list_reports_relative_paths_not_names_only() {
        let (_dir, workspace) = sample();
        let result = list(&workspace, Some("src"), None).expect("list");
        let paths: Vec<_> = result.entries.iter().map(|e| e.path.as_str()).collect();
        assert!(paths.contains(&"src/app.js"));
        assert!(paths.contains(&"src/deep"));
    }

    #[test]
    fn list_reports_truncation() {
        let (_dir, workspace) = sample();
        let result = list(&workspace, None, Some(1)).expect("list");
        assert_eq!(result.entries.len(), 1);
        assert!(result.truncated);
        assert!(result.to_prompt_text().contains("tronquée"));
    }

    #[test]
    fn listing_a_file_is_an_error_with_a_useful_message() {
        let (_dir, workspace) = sample();
        let error = list(&workspace, Some("README.md"), None).expect_err("not a dir");
        assert!(error.message.contains("pas un dossier"));
    }

    #[test]
    fn listing_outside_the_workspace_is_refused() {
        let (_dir, workspace) = sample();
        assert!(list(&workspace, Some("../"), None).is_err());
    }

    #[test]
    fn an_empty_directory_says_so() {
        let (_dir, workspace) = sample();
        fs::create_dir(workspace.root().join("empty")).expect("mkdir");
        let result = list(&workspace, Some("empty"), None).expect("list");
        assert!(result.entries.is_empty());
        assert!(result.to_prompt_text().contains("vide"));
    }

    #[test]
    fn tree_renders_indented_structure() {
        let (_dir, workspace) = sample();
        let result = tree(&workspace, None, 3, None).expect("tree");
        assert!(result.rendered.contains("├── ") || result.rendered.contains("└── "));
        assert!(result.rendered.contains("src/"));
        assert!(result.rendered.contains("inner.js"));
        assert!(!result.rendered.contains("node_modules"));
    }

    #[test]
    fn tree_respects_its_depth_limit() {
        let (_dir, workspace) = sample();
        let shallow = tree(&workspace, None, 1, None).expect("tree");
        assert!(shallow.rendered.contains("src/"));
        assert!(
            !shallow.rendered.contains("app.js"),
            "profondeur 1 ne doit pas descendre dans src"
        );
    }

    #[test]
    fn tree_reports_truncation_when_the_budget_runs_out() {
        let (_dir, workspace) = sample();
        let result = tree(&workspace, None, 5, Some(2)).expect("tree");
        assert!(result.truncated);
        assert!(result.rendered.contains("tronquée"));
    }

    #[test]
    fn tree_of_a_subdirectory_is_scoped() {
        let (_dir, workspace) = sample();
        let result = tree(&workspace, Some("src"), 3, None).expect("tree");
        assert!(result.rendered.starts_with("src/"));
        assert!(!result.rendered.contains("README.md"));
    }
}
