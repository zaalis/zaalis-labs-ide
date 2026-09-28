//! Glob and grep over the workspace.
//!
//! The previous engine walked at most 2 500 files at depth 12, read each one
//! fully into memory, and had no time limit — and when `rg` was missing it fell
//! back to a line-by-line JavaScript scan. Here the walk is `ignore` (the engine
//! behind ripgrep), so `.gitignore` is honoured and the speed does not depend on
//! a binary happening to be installed. Every limit is explicit and every
//! truncation is reported, because a silently short result set is worse than a
//! slow one: the model concludes the code is not there.

use crate::path::{Workspace, ALWAYS_SKIPPED_DIRS};
use globset::{Glob, GlobMatcher};
use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};
use zaalis_core::{Result, ZaalisError};

/// Files a single search may open.
pub const MAX_FILES_SCANNED: usize = 50_000;
/// Wall-clock ceiling for one search.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(15);
/// Largest file grep will open.
pub const MAX_GREP_FILE_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EntryKind {
    File,
    Dir,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GlobOptions {
    /// Glob applied to the workspace-relative path.
    pub pattern: String,
    /// Subdirectory to search from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<EntryKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<usize>,
    /// Include files `.gitignore` would hide.
    #[serde(default)]
    pub include_ignored: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GlobEntry {
    pub path: String,
    pub kind: EntryKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GlobResult {
    pub entries: Vec<GlobEntry>,
    /// Set when the limit or the timeout cut the walk short. The model is told
    /// so it does not treat a partial list as exhaustive.
    pub truncated: bool,
    pub scanned: usize,
    pub elapsed_ms: u64,
}

/// Match files by glob.
pub fn glob(workspace: &Workspace, options: &GlobOptions) -> Result<GlobResult> {
    let matcher = compile_glob(&options.pattern)?;
    let base = match options.path.as_deref() {
        Some(path) if !path.is_empty() && path != "." => workspace.resolve(path)?,
        _ => workspace.root_path(),
    };
    if !base.is_dir() {
        return Err(ZaalisError::invalid(format!(
            "{} n'est pas un dossier",
            base.relative()
        )));
    }

    let max = options.max.unwrap_or(1_000).clamp(1, 20_000);
    let started = Instant::now();
    let mut entries = Vec::new();
    let mut scanned = 0usize;
    let mut truncated = false;

    for entry in walker(base.absolute(), options.include_ignored).build() {
        if started.elapsed() > DEFAULT_TIMEOUT || scanned >= MAX_FILES_SCANNED {
            truncated = true;
            break;
        }
        let Ok(entry) = entry else { continue };
        let Some(relative) = relative_of(workspace, entry.path()) else {
            continue;
        };
        if relative.is_empty() {
            continue;
        }
        scanned += 1;

        let is_dir = entry.file_type().is_some_and(|kind| kind.is_dir());
        let kind = if is_dir {
            EntryKind::Dir
        } else {
            EntryKind::File
        };
        if let Some(wanted) = &options.kind {
            if wanted != &kind {
                continue;
            }
        }
        // A directory glob is written with or without the trailing slash
        // depending on habit; accept both rather than making the model guess.
        let candidate = if is_dir {
            format!("{relative}/")
        } else {
            relative.clone()
        };
        if !(matcher.is_match(&relative) || (is_dir && matcher.is_match(&candidate))) {
            continue;
        }

        entries.push(GlobEntry {
            path: relative,
            kind,
            size_bytes: entry.metadata().ok().map(|meta| meta.len()),
        });

        if entries.len() >= max {
            truncated = true;
            break;
        }
    }

    entries.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(GlobResult {
        entries,
        truncated,
        scanned,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GrepOptions {
    /// Regular expression. Falls back to a literal search when it does not
    /// compile, which is what a model usually meant anyway.
    pub pattern: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Restrict to files matching this glob.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include: Option<String>,
    #[serde(default)]
    pub case_sensitive: bool,
    /// Lines of context on each side of a match.
    #[serde(default)]
    pub context: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_matches: Option<usize>,
    #[serde(default)]
    pub include_ignored: bool,
    /// Sensitive files are excluded unless the caller explicitly requests
    /// them. The tool runtime then marks the access as sensitive so the guard
    /// requires a user decision even in permissive modes.
    #[serde(default)]
    pub include_sensitive: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GrepMatch {
    pub line: usize,
    pub text: String,
    /// Byte range of the match within `text`.
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GrepContextLine {
    pub line: usize,
    pub text: String,
}

/// Matches grouped by file, so the model sees structure instead of a flat list
/// of `path:line: text` strings it has to re-parse.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GrepFile {
    pub path: String,
    pub matches: Vec<GrepMatch>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub context: Vec<GrepContextLine>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GrepResult {
    pub files: Vec<GrepFile>,
    pub total_matches: usize,
    pub files_with_matches: usize,
    pub truncated: bool,
    /// Set when the pattern was not a valid regex and was searched literally.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub literal_fallback: bool,
    pub scanned: usize,
    pub elapsed_ms: u64,
}

impl GrepResult {
    /// Compact rendering for a model prompt.
    pub fn to_prompt_text(&self) -> String {
        if self.files.is_empty() {
            return "(aucun résultat)".to_owned();
        }
        let mut out = String::new();
        for file in &self.files {
            out.push_str(&format!("{}\n", file.path));
            let mut context: Vec<&GrepContextLine> = file.context.iter().collect();
            context.sort_by_key(|line| line.line);
            let mut rendered: Vec<(usize, char, &str)> = file
                .matches
                .iter()
                .map(|hit| (hit.line, '>', hit.text.as_str()))
                .chain(
                    context
                        .iter()
                        .map(|line| (line.line, ' ', line.text.as_str())),
                )
                .collect();
            rendered.sort_by_key(|(line, _, _)| *line);
            rendered.dedup_by_key(|(line, _, _)| *line);
            for (line, marker, text) in rendered {
                out.push_str(&format!("{marker}{line:>6} | {}\n", text.trim_end()));
            }
            out.push('\n');
        }
        if self.truncated {
            out.push_str(&format!(
                "[résultats tronqués — {} correspondance(s) affichée(s) ; affinez le motif ou le chemin]\n",
                self.total_matches
            ));
        }
        out
    }
}

/// Search file contents.
pub fn grep(workspace: &Workspace, options: &GrepOptions) -> Result<GrepResult> {
    if options.pattern.trim().is_empty() {
        return Err(ZaalisError::invalid("motif de recherche vide"));
    }

    let (regex, literal_fallback) = compile_pattern(&options.pattern, options.case_sensitive)?;
    let include = options
        .include
        .as_deref()
        .filter(|value| !value.is_empty())
        .map(compile_glob)
        .transpose()?;

    let base = match options.path.as_deref() {
        Some(path) if !path.is_empty() && path != "." => workspace.resolve(path)?,
        _ => workspace.root_path(),
    };

    let max_matches = options.max_matches.unwrap_or(200).clamp(1, 5_000);
    let context = options.context.min(10);
    let started = Instant::now();

    let mut files: Vec<GrepFile> = Vec::new();
    let mut total_matches = 0usize;
    let mut scanned = 0usize;
    let mut truncated = false;

    'walk: for entry in walker(base.absolute(), options.include_ignored).build() {
        if started.elapsed() > DEFAULT_TIMEOUT || scanned >= MAX_FILES_SCANNED {
            truncated = true;
            break;
        }
        let Ok(entry) = entry else { continue };
        if !entry.file_type().is_some_and(|kind| kind.is_file()) {
            continue;
        }
        let Some(relative) = relative_of(workspace, entry.path()) else {
            continue;
        };
        if !options.include_sensitive && workspace.is_sensitive_relative(&relative) {
            continue;
        }
        if let Some(matcher) = &include {
            if !matcher.is_match(&relative) {
                continue;
            }
        }
        if entry
            .metadata()
            .map(|meta| meta.len() > MAX_GREP_FILE_BYTES)
            .unwrap_or(true)
        {
            continue;
        }

        let Ok(bytes) = std::fs::read(entry.path()) else {
            continue;
        };
        if crate::text::sniff_binary(&bytes).is_some() {
            continue;
        }
        scanned += 1;

        let content = String::from_utf8_lossy(&bytes);
        let lines: Vec<&str> = content.split('\n').collect();
        let mut matches = Vec::new();
        let mut context_lines = Vec::new();

        for (index, line) in lines.iter().enumerate() {
            let Some(found) = regex.find(line) else {
                continue;
            };
            let number = index + 1;
            matches.push(GrepMatch {
                line: number,
                text: clip(line),
                start: found.start(),
                end: found.end(),
            });
            if context > 0 {
                let from = number.saturating_sub(context).max(1);
                let to = (number + context).min(lines.len());
                for around in from..=to {
                    if around != number {
                        context_lines.push(GrepContextLine {
                            line: around,
                            text: clip(lines[around - 1]),
                        });
                    }
                }
            }
            total_matches += 1;
            if total_matches >= max_matches {
                truncated = true;
                files.push(GrepFile {
                    path: relative,
                    matches,
                    context: context_lines,
                });
                break 'walk;
            }
        }

        if !matches.is_empty() {
            files.push(GrepFile {
                path: relative,
                matches,
                context: context_lines,
            });
        }
    }

    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(GrepResult {
        files_with_matches: files.len(),
        files,
        total_matches,
        truncated,
        literal_fallback,
        scanned,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

fn clip(line: &str) -> String {
    const MAX: usize = 400;
    if line.chars().count() > MAX {
        line.chars().take(MAX).collect::<String>() + "…"
    } else {
        line.to_owned()
    }
}

fn compile_glob(pattern: &str) -> Result<GlobMatcher> {
    // A bare `*.rs` should match at any depth, which is what a model means when
    // it writes it; `**/` prefixes are left alone.
    let normalised = if !pattern.contains('/') && pattern.contains('*') {
        format!("**/{pattern}")
    } else {
        pattern.to_owned()
    };
    Glob::new(&normalised)
        .map(|glob| glob.compile_matcher())
        .map_err(|error| {
            ZaalisError::invalid(format!("motif glob invalide « {pattern} » : {error}"))
        })
}

fn compile_pattern(pattern: &str, case_sensitive: bool) -> Result<(regex::Regex, bool)> {
    let build = |source: &str| {
        regex::RegexBuilder::new(source)
            .case_insensitive(!case_sensitive)
            .size_limit(10 * 1024 * 1024)
            .build()
    };
    match build(pattern) {
        Ok(regex) => Ok((regex, false)),
        Err(_) => build(&regex::escape(pattern))
            .map(|regex| (regex, true))
            .map_err(|error| ZaalisError::invalid(format!("motif invalide : {error}"))),
    }
}

fn walker(root: &std::path::Path, include_ignored: bool) -> WalkBuilder {
    let mut builder = WalkBuilder::new(root);
    builder
        .hidden(false)
        .git_ignore(!include_ignored)
        .git_global(!include_ignored)
        .git_exclude(!include_ignored)
        // Without this, `.gitignore` is only honoured inside an actual git
        // repository. zaalis opens whatever folder the user picks, and plenty of
        // them carry a `.gitignore` without a `.git` — ignoring it there would
        // flood every search with build output.
        .require_git(false)
        .follow_links(false)
        .max_depth(Some(24));
    builder.filter_entry(|entry| {
        entry
            .file_name()
            .to_str()
            .map(|name| !ALWAYS_SKIPPED_DIRS.contains(&name))
            .unwrap_or(true)
    });
    builder
}

fn relative_of(workspace: &Workspace, path: &std::path::Path) -> Option<String> {
    path.strip_prefix(workspace.root())
        .ok()
        .map(|rest| rest.to_string_lossy().replace('\\', "/"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn sample() -> (TempDir, Workspace) {
        let dir = TempDir::new().expect("tempdir");
        fs::create_dir_all(dir.path().join("src/nested")).expect("mkdir");
        fs::create_dir_all(dir.path().join("node_modules/pkg")).expect("mkdir");
        fs::write(
            dir.path().join("src/app.js"),
            "const answer = 42;\nexport {};\n",
        )
        .expect("w");
        fs::write(dir.path().join("src/nested/deep.js"), "const answer = 7;\n").expect("w");
        fs::write(dir.path().join("src/style.css"), ".answer { color: red }\n").expect("w");
        fs::write(dir.path().join("README.md"), "# answer\n").expect("w");
        fs::write(dir.path().join("node_modules/pkg/index.js"), "answer\n").expect("w");
        fs::write(dir.path().join("blob.bin"), [0u8, 1, 2, 0, 3]).expect("w");
        let workspace = Workspace::open(dir.path()).expect("open");
        (dir, workspace)
    }

    fn glob_options(pattern: &str) -> GlobOptions {
        GlobOptions {
            pattern: pattern.to_owned(),
            path: None,
            kind: None,
            max: None,
            include_ignored: false,
        }
    }

    fn grep_options(pattern: &str) -> GrepOptions {
        GrepOptions {
            pattern: pattern.to_owned(),
            path: None,
            include: None,
            case_sensitive: false,
            context: 0,
            max_matches: None,
            include_ignored: false,
            include_sensitive: false,
        }
    }

    #[test]
    fn glob_finds_files_at_any_depth_with_a_bare_pattern() {
        let (_dir, workspace) = sample();
        let result = glob(&workspace, &glob_options("*.js")).expect("glob");
        let paths: Vec<_> = result.entries.iter().map(|e| e.path.as_str()).collect();
        assert!(paths.contains(&"src/app.js"));
        assert!(paths.contains(&"src/nested/deep.js"));
    }

    #[test]
    fn glob_never_descends_into_node_modules() {
        let (_dir, workspace) = sample();
        let result = glob(&workspace, &glob_options("**/*.js")).expect("glob");
        assert!(
            result
                .entries
                .iter()
                .all(|entry| !entry.path.contains("node_modules")),
            "node_modules doit rester invisible"
        );
    }

    #[test]
    fn glob_can_return_directories_only() {
        let (_dir, workspace) = sample();
        let mut options = glob_options("src/**");
        options.kind = Some(EntryKind::Dir);
        let result = glob(&workspace, &options).expect("glob");
        assert!(result.entries.iter().all(|e| e.kind == EntryKind::Dir));
        assert!(result.entries.iter().any(|e| e.path == "src/nested"));
    }

    #[test]
    fn glob_reports_truncation_instead_of_hiding_it() {
        let (_dir, workspace) = sample();
        let mut options = glob_options("**/*");
        options.max = Some(2);
        let result = glob(&workspace, &options).expect("glob");
        assert_eq!(result.entries.len(), 2);
        assert!(result.truncated, "une liste coupée doit le dire");
    }

    #[test]
    fn an_invalid_glob_is_a_clear_error() {
        let (_dir, workspace) = sample();
        let error = glob(&workspace, &glob_options("src/[")).expect_err("invalid");
        assert!(error.message.contains("glob invalide"));
    }

    #[test]
    fn grep_groups_matches_by_file() {
        let (_dir, workspace) = sample();
        let result = grep(&workspace, &grep_options("answer")).expect("grep");
        assert!(result.files_with_matches >= 3);
        assert!(result.files.iter().all(|file| !file.matches.is_empty()));
        assert!(result
            .files
            .iter()
            .all(|file| !file.path.contains("node_modules")));
    }

    #[test]
    fn grep_can_restrict_to_a_glob() {
        let (_dir, workspace) = sample();
        let mut options = grep_options("answer");
        options.include = Some("*.css".into());
        let result = grep(&workspace, &options).expect("grep");
        assert_eq!(result.files_with_matches, 1);
        assert_eq!(result.files[0].path, "src/style.css");
    }

    #[test]
    fn grep_returns_context_lines_when_asked() {
        let (_dir, workspace) = sample();
        let mut options = grep_options("export");
        options.context = 1;
        let result = grep(&workspace, &options).expect("grep");
        let file = &result.files[0];
        assert!(!file.context.is_empty());
        assert!(file.context.iter().any(|line| line.line == 1));
    }

    #[test]
    fn grep_falls_back_to_a_literal_search_on_a_bad_regex() {
        let (_dir, workspace) = sample();
        fs::write(workspace.root().join("weird.txt"), "a[b unbalanced\n").expect("w");
        let result = grep(&workspace, &grep_options("a[b")).expect("grep");
        assert!(
            result.literal_fallback,
            "le motif invalide doit être littéral"
        );
        assert_eq!(result.total_matches, 1);
    }

    #[test]
    fn grep_stops_at_the_match_limit_and_says_so() {
        let (_dir, workspace) = sample();
        let body: String = (0..500).map(|n| format!("answer {n}\n")).collect();
        fs::write(workspace.root().join("many.txt"), body).expect("w");

        let mut options = grep_options("answer");
        options.max_matches = Some(5);
        let result = grep(&workspace, &options).expect("grep");
        assert_eq!(result.total_matches, 5);
        assert!(result.truncated);
        assert!(result.to_prompt_text().contains("tronqués"));
    }

    #[test]
    fn grep_skips_binary_files() {
        let (_dir, workspace) = sample();
        let result = grep(&workspace, &grep_options("\\x01")).expect("grep");
        assert!(result.files.iter().all(|file| file.path != "blob.bin"));
    }

    #[test]
    fn grep_honours_gitignore_by_default() {
        let (_dir, workspace) = sample();
        fs::write(workspace.root().join(".gitignore"), "ignored/\n").expect("w");
        fs::create_dir_all(workspace.root().join("ignored")).expect("mkdir");
        fs::write(workspace.root().join("ignored/secret.js"), "answer\n").expect("w");

        let hidden = grep(&workspace, &grep_options("answer")).expect("grep");
        assert!(hidden
            .files
            .iter()
            .all(|file| !file.path.starts_with("ignored/")));

        let mut options = grep_options("answer");
        options.include_ignored = true;
        let shown = grep(&workspace, &options).expect("grep");
        assert!(shown
            .files
            .iter()
            .any(|file| file.path.starts_with("ignored/")));
    }

    #[test]
    fn grep_excludes_sensitive_files_unless_explicitly_requested() {
        let (_dir, workspace) = sample();
        std::fs::write(workspace.root().join(".env"), "SECRET_TOKEN=needle\n")
            .expect("write secret");

        let hidden = grep(&workspace, &grep_options("needle")).expect("grep");
        assert!(hidden.files.is_empty());

        let mut explicit = grep_options("needle");
        explicit.include_sensitive = true;
        let visible = grep(&workspace, &explicit).expect("grep sensitive");
        assert_eq!(visible.files.len(), 1);
        assert_eq!(visible.files[0].path, ".env");
    }

    #[test]
    fn grep_is_case_insensitive_unless_asked_otherwise() {
        let (_dir, workspace) = sample();
        assert!(
            grep(&workspace, &grep_options("ANSWER"))
                .expect("grep")
                .total_matches
                > 0
        );

        let mut options = grep_options("ANSWER");
        options.case_sensitive = true;
        assert_eq!(grep(&workspace, &options).expect("grep").total_matches, 0);
    }

    #[test]
    fn an_empty_pattern_is_refused() {
        let (_dir, workspace) = sample();
        assert!(grep(&workspace, &grep_options("   ")).is_err());
    }

    #[test]
    fn searching_a_subdirectory_scopes_the_walk() {
        let (_dir, workspace) = sample();
        let mut options = grep_options("answer");
        options.path = Some("src/nested".into());
        let result = grep(&workspace, &options).expect("grep");
        assert_eq!(result.files_with_matches, 1);
        assert_eq!(result.files[0].path, "src/nested/deep.js");
    }

    #[test]
    fn searching_outside_the_workspace_is_refused() {
        let (_dir, workspace) = sample();
        let mut options = grep_options("answer");
        options.path = Some("../".into());
        assert!(grep(&workspace, &options).is_err());
    }

    #[test]
    fn empty_results_render_explicitly() {
        let (_dir, workspace) = sample();
        let result = grep(&workspace, &grep_options("zzz-not-present")).expect("grep");
        assert_eq!(result.total_matches, 0);
        assert_eq!(result.to_prompt_text(), "(aucun résultat)");
    }
}
