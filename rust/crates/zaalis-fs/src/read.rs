//! Reading files, with the details an agent actually needs.
//!
//! The previous engine truncated at 16 000 characters and said `... (tronque)`,
//! which left the model no way to ask for the rest — so it either guessed or
//! re-read the same head. Here a truncated read reports exactly where it
//! stopped and what to pass next, and the result is structured rather than a
//! pre-formatted blob.

use crate::path::ResolvedPath;
use crate::text::{self, FileText};
use serde::{Deserialize, Serialize};
use zaalis_core::{Result, ZaalisError};

/// Hard ceiling on a single read, whatever the caller asks for.
pub const MAX_READ_BYTES: u64 = 4 * 1024 * 1024;
/// Default number of lines returned when the caller does not say.
pub const DEFAULT_LINE_LIMIT: usize = 2_000;
/// Longest single line returned intact; beyond this the line is cut and marked.
pub const MAX_LINE_CHARS: usize = 2_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReadOptions {
    /// First line to return, 1-based. `0` and `1` both mean the beginning.
    #[serde(default)]
    pub offset: usize,
    /// How many lines to return.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
}

impl Default for ReadOptions {
    fn default() -> Self {
        Self {
            offset: 1,
            limit: None,
        }
    }
}

impl ReadOptions {
    pub fn from_line(offset: usize) -> Self {
        Self {
            offset,
            limit: None,
        }
    }

    fn start_index(&self) -> usize {
        self.offset.saturating_sub(1)
    }

    fn effective_limit(&self) -> usize {
        self.limit.unwrap_or(DEFAULT_LINE_LIMIT).clamp(1, 50_000)
    }
}

/// One returned line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NumberedLine {
    /// 1-based line number in the file, not in the returned window.
    pub number: usize,
    pub text: String,
    /// Set when the line itself was too long and got cut.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub clipped: bool,
}

/// The structured result of a read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileRead {
    pub path: String,
    pub lines: Vec<NumberedLine>,
    pub total_lines: usize,
    pub size_bytes: u64,
    pub eol: text::Eol,
    /// Set when more lines exist past the window.
    pub truncated: bool,
    /// The `offset` to pass to continue. `None` when the file is exhausted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_offset: Option<usize>,
    /// Set when the requested offset was past the end of the file, so the model
    /// gets a real explanation instead of a silently empty result.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub offset_past_end: bool,
}

impl FileRead {
    /// Render for a model prompt: `   12 | const a = 1;`.
    ///
    /// Line numbers matter because they are how the model refers back to a spot
    /// in later reasoning and how a reviewer finds it.
    pub fn to_prompt_text(&self) -> String {
        if self.offset_past_end {
            return format!(
                "{} : l'offset demandé dépasse la fin du fichier ({} lignes).",
                self.path, self.total_lines
            );
        }
        if self.lines.is_empty() {
            return format!("{} : fichier vide.", self.path);
        }
        let width = self
            .lines
            .last()
            .map(|line| line.number.to_string().len())
            .unwrap_or(1);
        let mut out = String::with_capacity(self.lines.len() * 48);
        for line in &self.lines {
            out.push_str(&format!(
                "{:>width$} | {}{}\n",
                line.number,
                line.text,
                if line.clipped {
                    " …(ligne tronquée)"
                } else {
                    ""
                },
                width = width
            ));
        }
        if let Some(next) = self.next_offset {
            out.push_str(&format!(
                "\n[{} lignes au total ; suite à partir de la ligne {next} avec offset={next}]",
                self.total_lines
            ));
        }
        out
    }
}

/// Read a resolved path.
pub fn read_file(path: &ResolvedPath, options: &ReadOptions) -> Result<FileRead> {
    if !path.exists() {
        return Err(ZaalisError::not_found(format!(
            "{} n'existe pas",
            path.relative()
        )));
    }
    if path.is_dir() {
        return Err(ZaalisError::invalid(format!(
            "{} est un dossier — utilisez list ou tree",
            path.relative()
        )));
    }

    let size_bytes = std::fs::metadata(path.absolute())?.len();
    let file = text::read_text(path.absolute(), MAX_READ_BYTES)?;
    Ok(window(path.relative(), &file, size_bytes, options))
}

/// Slice an already-loaded file. Split out so the edit path can reuse it
/// without a second disk read.
pub fn window(relative: &str, file: &FileText, size_bytes: u64, options: &ReadOptions) -> FileRead {
    let all: Vec<&str> = if file.content.is_empty() {
        Vec::new()
    } else {
        file.content.split('\n').collect()
    };
    let total_lines = all.len();
    let start = options.start_index();
    let limit = options.effective_limit();

    if start >= total_lines && total_lines > 0 {
        return FileRead {
            path: relative.to_owned(),
            lines: Vec::new(),
            total_lines,
            size_bytes,
            eol: file.eol,
            truncated: false,
            next_offset: None,
            offset_past_end: true,
        };
    }

    let end = (start + limit).min(total_lines);
    let lines = all[start..end]
        .iter()
        .enumerate()
        .map(|(index, raw)| {
            let clipped = raw.chars().count() > MAX_LINE_CHARS;
            let text = if clipped {
                raw.chars().take(MAX_LINE_CHARS).collect()
            } else {
                (*raw).to_owned()
            };
            NumberedLine {
                number: start + index + 1,
                text,
                clipped,
            }
        })
        .collect();

    let truncated = end < total_lines;
    FileRead {
        path: relative.to_owned(),
        lines,
        total_lines,
        size_bytes,
        eol: file.eol,
        truncated,
        next_offset: truncated.then_some(end + 1),
        offset_past_end: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::path::Workspace;
    use std::fs;
    use tempfile::TempDir;

    fn workspace_with(name: &str, content: &str) -> (TempDir, Workspace, ResolvedPath) {
        let dir = TempDir::new().expect("tempdir");
        fs::write(dir.path().join(name), content).expect("write");
        let workspace = Workspace::open(dir.path()).expect("open");
        let path = workspace.resolve(name).expect("resolve");
        (dir, workspace, path)
    }

    #[test]
    fn reads_a_whole_small_file_with_line_numbers() {
        let (_dir, _ws, path) = workspace_with("a.txt", "one\ntwo\nthree\n");
        let result = read_file(&path, &ReadOptions::default()).expect("read");
        assert_eq!(result.total_lines, 3);
        assert!(!result.truncated);
        assert_eq!(result.next_offset, None);
        assert_eq!(result.lines[0].number, 1);
        assert_eq!(result.lines[2].text, "three");
    }

    #[test]
    fn a_truncated_read_says_exactly_where_to_continue() {
        let body: String = (1..=100).map(|n| format!("line {n}\n")).collect();
        let (_dir, _ws, path) = workspace_with("big.txt", &body);

        let first = read_file(
            &path,
            &ReadOptions {
                offset: 1,
                limit: Some(10),
            },
        )
        .expect("read");
        assert!(first.truncated);
        assert_eq!(first.next_offset, Some(11));
        assert_eq!(first.lines.len(), 10);

        // Continuing from the reported offset lands exactly on line 11 — the
        // thing the old `... (tronque)` message made impossible.
        let second = read_file(
            &path,
            &ReadOptions {
                offset: first.next_offset.unwrap(),
                limit: Some(10),
            },
        )
        .expect("read");
        assert_eq!(second.lines[0].number, 11);
        assert_eq!(second.lines[0].text, "line 11");
    }

    #[test]
    fn an_offset_past_the_end_is_reported_rather_than_returning_nothing() {
        let (_dir, _ws, path) = workspace_with("a.txt", "one\ntwo\n");
        let result = read_file(&path, &ReadOptions::from_line(50)).expect("read");
        assert!(result.offset_past_end);
        assert!(result.lines.is_empty());
        assert!(result.to_prompt_text().contains("dépasse la fin"));
    }

    #[test]
    fn a_very_long_line_is_clipped_and_marked() {
        let long = "x".repeat(MAX_LINE_CHARS + 500);
        let (_dir, _ws, path) = workspace_with("long.txt", &long);
        let result = read_file(&path, &ReadOptions::default()).expect("read");
        assert!(result.lines[0].clipped);
        assert_eq!(result.lines[0].text.chars().count(), MAX_LINE_CHARS);
        assert!(result.to_prompt_text().contains("ligne tronquée"));
    }

    #[test]
    fn an_empty_file_is_not_an_error() {
        let (_dir, _ws, path) = workspace_with("empty.txt", "");
        let result = read_file(&path, &ReadOptions::default()).expect("read");
        assert_eq!(result.total_lines, 0);
        assert!(result.lines.is_empty());
        assert!(result.to_prompt_text().contains("vide"));
    }

    #[test]
    fn reading_a_directory_points_at_the_right_tool() {
        let dir = TempDir::new().expect("tempdir");
        fs::create_dir(dir.path().join("src")).expect("mkdir");
        let workspace = Workspace::open(dir.path()).expect("open");
        let path = workspace.resolve("src").expect("resolve");
        let error = read_file(&path, &ReadOptions::default()).expect_err("dir");
        assert!(error.message.contains("list"));
    }

    #[test]
    fn reading_a_missing_file_fails_with_not_found() {
        let dir = TempDir::new().expect("tempdir");
        let workspace = Workspace::open(dir.path()).expect("open");
        let path = workspace.resolve("ghost.txt").expect("resolve");
        let error = read_file(&path, &ReadOptions::default()).expect_err("missing");
        assert_eq!(error.code, zaalis_core::ErrorCode::NotFound);
    }

    #[test]
    fn a_binary_file_is_refused_rather_than_mangled() {
        let dir = TempDir::new().expect("tempdir");
        fs::write(
            dir.path().join("image.png"),
            [0x89, b'P', b'N', b'G', 0x00, 0x1A],
        )
        .expect("write");
        let workspace = Workspace::open(dir.path()).expect("open");
        let path = workspace.resolve("image.png").expect("resolve");
        let error = read_file(&path, &ReadOptions::default()).expect_err("binary");
        assert!(error.message.contains("binaire"));
    }

    #[test]
    fn the_prompt_rendering_aligns_line_numbers() {
        let body: String = (1..=12).map(|n| format!("l{n}\n")).collect();
        let (_dir, _ws, path) = workspace_with("a.txt", &body);
        let rendered = read_file(&path, &ReadOptions::default())
            .expect("read")
            .to_prompt_text();
        assert!(rendered.contains(" 1 | l1"));
        assert!(rendered.contains("12 | l12"));
    }

    #[test]
    fn crlf_files_report_their_style() {
        let (_dir, _ws, path) = workspace_with("crlf.txt", "a\r\nb\r\n");
        let result = read_file(&path, &ReadOptions::default()).expect("read");
        assert_eq!(result.eol, text::Eol::Crlf);
        assert_eq!(result.total_lines, 2);
        assert_eq!(result.lines[0].text, "a");
    }

    #[test]
    fn limits_are_clamped_to_something_sane() {
        let (_dir, _ws, path) = workspace_with("a.txt", "one\n");
        let result = read_file(
            &path,
            &ReadOptions {
                offset: 0,
                limit: Some(usize::MAX),
            },
        )
        .expect("read");
        assert_eq!(result.lines.len(), 1);
    }
}
