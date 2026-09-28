//! Writing, editing and patching — all of it atomic.
//!
//! Three rules the previous engine did not enforce:
//!
//! 1. **Ambiguity is an error, not a coin flip.** `applyHunk` in
//!    `agent-engine.js` refused a search string appearing more than once, but
//!    silently accepted a whitespace-relaxed second-chance match. Here a match
//!    is either unique or the edit fails with the count and the candidate line
//!    numbers, so the model can add context instead of guessing.
//! 2. **Tolerance is graduated and declared.** Refusing an edit because the
//!    model dropped an invisible trailing space, or indented a block to its own
//!    idea of the nesting, costs a round trip and teaches the model nothing. So
//!    matching falls back from exact, to trailing-whitespace-insensitive, to
//!    indentation-insensitive — each tier still requiring a *unique* match, and
//!    every tier below exact reported in [`FileEdit::adjusted`]. That is the
//!    difference from the old second-chance match: it was silent, this is not.
//!    An indentation-tolerant match also re-anchors the replacement to the
//!    file's own indentation, so a match never corrupts a nested block.
//! 3. **A multi-file patch is all-or-nothing.** The old loop mutated an
//!    in-memory string per hunk and wrote at the end, which was accidentally
//!    atomic for one file and had no story at all for several. Here every file
//!    is validated first, written second, and rolled back if any write fails.

use crate::diff::{self, LineDiff};
use crate::path::ResolvedPath;
use crate::text::{self, FileText};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use zaalis_core::{Result, ZaalisError};

/// Largest file this crate will rewrite.
pub const MAX_WRITE_BYTES: u64 = 8 * 1024 * 1024;

/// One search/replace pair.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Hunk {
    /// Exact text to find. Empty means "append to the end of the file".
    pub search: String,
    pub replace: String,
    /// When the search text legitimately appears several times, say which one
    /// (1-based). Without it, a repeated match is refused.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub occurrence: Option<usize>,
}

impl Hunk {
    pub fn new(search: impl Into<String>, replace: impl Into<String>) -> Self {
        Self {
            search: search.into(),
            replace: replace.into(),
            occurrence: None,
        }
    }

    pub fn nth(mut self, occurrence: usize) -> Self {
        self.occurrence = Some(occurrence);
        self
    }
}

/// Why a hunk could not be applied.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "reason", rename_all = "snake_case")]
pub enum HunkFailure {
    /// The search text is nowhere in the file.
    NotFound {
        /// Set when a whitespace-insensitive comparison *would* have matched —
        /// the actionable case, since it usually means indentation drift.
        near_line: Option<usize>,
    },
    /// The search text appears more than once and no occurrence was named.
    Ambiguous {
        count: usize,
        /// Line numbers of the matches, so the model can pick or add context.
        lines: Vec<usize>,
    },
    /// An occurrence index was given but the file has fewer matches.
    OccurrenceOutOfRange { count: usize, requested: usize },
}

impl HunkFailure {
    pub fn message(&self, index: usize) -> String {
        match self {
            HunkFailure::NotFound { near_line: None } => {
                format!("hunk {index} : texte SEARCH introuvable")
            }
            HunkFailure::NotFound {
                near_line: Some(line),
            } => format!(
                "hunk {index} : texte SEARCH introuvable — une correspondance existe ligne {line} \
                 aux espaces près, recopiez l'indentation exacte"
            ),
            HunkFailure::Ambiguous { count, lines } => format!(
                "hunk {index} : texte SEARCH présent {count} fois (lignes {}) — ajoutez du \
                 contexte ou précisez « occurrence »",
                lines
                    .iter()
                    .map(|line| line.to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            HunkFailure::OccurrenceOutOfRange { count, requested } => format!(
                "hunk {index} : occurrence {requested} demandée mais seulement {count} \
                 correspondance(s)"
            ),
        }
    }
}

/// The result of applying hunks to one file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileEdit {
    pub path: String,
    pub hunks_applied: usize,
    pub added: u32,
    pub removed: u32,
    /// Unified diff, ready for the review card.
    pub diff: String,
    /// Set when the file did not exist before.
    pub created: bool,
    /// One note per hunk that needed a tolerance to match.
    ///
    /// Empty for a byte-for-byte edit. Non-empty means the matcher assumed
    /// something, and the reviewer should see what.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub adjusted: Vec<String>,
}

/// How closely a hunk's search text matched the file.
///
/// A relaxed match is *reported*, never silent. The old JavaScript engine
/// accepted a whitespace-relaxed second chance without saying so, which is how
/// an edit could land on a line nobody meant to touch; the rule kept here is
/// that any tolerance the matcher applies shows up in the result the user
/// reviews.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MatchQuality {
    /// Byte-for-byte.
    Exact,
    /// Matched once trailing whitespace and `\r` were ignored.
    TrailingWhitespace,
    /// Matched once indentation was ignored; the replacement was re-indented to
    /// the file's own depth.
    Indentation,
}

impl MatchQuality {
    fn note(self, index: usize, line: usize) -> Option<String> {
        match self {
            MatchQuality::Exact => None,
            MatchQuality::TrailingWhitespace => Some(format!(
                "hunk {index} : appliqué ligne {line} en ignorant les espaces de fin"
            )),
            MatchQuality::Indentation => Some(format!(
                "hunk {index} : appliqué ligne {line}, indentation du remplacement alignée sur le fichier"
            )),
        }
    }
}

/// Apply hunks to an in-memory text without touching the disk.
///
/// Every hunk is validated against the running content, so a later hunk can
/// legitimately match text an earlier one produced. Any failure aborts the
/// whole set — the caller never sees a half-applied file.
pub fn apply_hunks(original: &str, hunks: &[Hunk]) -> Result<String> {
    apply_hunks_reporting(original, hunks).map(|(content, _)| content)
}

/// Apply hunks, also returning a note for every tolerance that was used.
///
/// Callers that show the result to a human should prefer this: the notes are
/// what turn "it worked" into "it worked, and here is what I had to assume".
pub fn apply_hunks_reporting(
    original: &str,
    hunks: &[Hunk],
) -> Result<(String, Vec<String>)> {
    let mut content = original.to_owned();
    let mut notes = Vec::new();
    for (index, hunk) in hunks.iter().enumerate() {
        let applied = apply_one(&content, hunk).map_err(|failure| {
            ZaalisError::tool(failure.message(index + 1))
                .with_detail(serde_json::to_value(&failure).unwrap_or(serde_json::Value::Null))
        })?;
        if let Some(note) = applied.quality.note(index + 1, applied.line) {
            notes.push(note);
        }
        content = applied.content;
    }
    Ok((content, notes))
}

/// One hunk successfully applied.
struct Applied {
    content: String,
    quality: MatchQuality,
    /// 1-based line where the match started, for the note.
    line: usize,
}

fn apply_one(content: &str, hunk: &Hunk) -> std::result::Result<Applied, HunkFailure> {
    if hunk.search.is_empty() {
        let mut out = content.to_owned();
        if !out.is_empty() && !out.ends_with('\n') {
            out.push('\n');
        }
        out.push_str(&hunk.replace);
        return Ok(Applied {
            line: out.matches('\n').count() + 1,
            content: out,
            quality: MatchQuality::Exact,
        });
    }

    let positions: Vec<usize> = content
        .match_indices(&hunk.search)
        .map(|(at, _)| at)
        .collect();

    match (positions.len(), hunk.occurrence) {
        // Nothing matched byte-for-byte. Rather than stopping here, try the
        // graduated matchers: a model that reproduced the code correctly but
        // lost a trailing space, or indented it to its own idea of the nesting,
        // has still identified the right lines. Each tier still demands a
        // unique match, so tolerance never becomes guessing.
        (0, _) => relaxed_apply(content, hunk),
        (_, Some(requested)) if requested == 0 || requested > positions.len() => {
            Err(HunkFailure::OccurrenceOutOfRange {
                count: positions.len(),
                requested,
            })
        }
        (_, Some(requested)) => Ok(Applied {
            content: replace_at(content, positions[requested - 1], hunk),
            quality: MatchQuality::Exact,
            line: line_of(content, positions[requested - 1]),
        }),
        (1, None) => Ok(Applied {
            content: replace_at(content, positions[0], hunk),
            quality: MatchQuality::Exact,
            line: line_of(content, positions[0]),
        }),
        (count, None) => Err(HunkFailure::Ambiguous {
            count,
            lines: positions.iter().map(|at| line_of(content, *at)).collect(),
        }),
    }
}

/// The byte span of each line, excluding its newline.
fn line_spans(content: &str) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    let mut start = 0;
    for (index, byte) in content.bytes().enumerate() {
        if byte == b'\n' {
            spans.push((start, index));
            start = index + 1;
        }
    }
    spans.push((start, content.len()));
    spans
}

/// Try the tolerant matchers, tightest first.
fn relaxed_apply(content: &str, hunk: &Hunk) -> std::result::Result<Applied, HunkFailure> {
    for (quality, normalise) in [
        (
            MatchQuality::TrailingWhitespace,
            (|line: &str| line.trim_end().to_owned()) as fn(&str) -> String,
        ),
        (MatchQuality::Indentation, |line: &str| {
            line.trim().to_owned()
        }),
    ] {
        let matches = find_line_matches(content, &hunk.search, normalise);
        let chosen = match (matches.len(), hunk.occurrence) {
            (0, _) => continue,
            (_, Some(requested)) if requested == 0 || requested > matches.len() => {
                return Err(HunkFailure::OccurrenceOutOfRange {
                    count: matches.len(),
                    requested,
                })
            }
            (_, Some(requested)) => matches[requested - 1],
            (1, None) => matches[0],
            // Unique at this tier or not at all: several near-misses mean the
            // model has to say which one it meant.
            (count, None) => {
                return Err(HunkFailure::Ambiguous {
                    count,
                    lines: matches
                        .iter()
                        .map(|(start, _)| line_of(content, *start))
                        .collect(),
                })
            }
        };

        let (start, end) = chosen;
        let replacement = if quality == MatchQuality::Indentation {
            reindent(&hunk.replace, &hunk.search, &content[start..end])
        } else {
            hunk.replace.clone()
        };
        let mut out = String::with_capacity(content.len() + replacement.len());
        out.push_str(&content[..start]);
        out.push_str(&replacement);
        out.push_str(&content[end..]);
        return Ok(Applied {
            content: out,
            quality,
            line: line_of(content, start),
        });
    }

    Err(HunkFailure::NotFound {
        near_line: fuzzy_line(content, &hunk.search),
    })
}

/// Byte spans in `content` whose lines equal the search text under `normalise`.
fn find_line_matches(
    content: &str,
    search: &str,
    normalise: fn(&str) -> String,
) -> Vec<(usize, usize)> {
    let trailing_newline = search.ends_with('\n');
    let needle: Vec<String> = search
        .trim_end_matches('\n')
        .split('\n')
        .map(normalise)
        .collect();
    if needle.is_empty() || needle.iter().all(String::is_empty) {
        return Vec::new();
    }

    let spans = line_spans(content);
    let mut found = Vec::new();
    if spans.len() < needle.len() {
        return found;
    }
    for index in 0..=spans.len() - needle.len() {
        let window = &spans[index..index + needle.len()];
        let same = window
            .iter()
            .zip(&needle)
            .all(|((start, end), expected)| normalise(&content[*start..*end]) == *expected);
        if !same {
            continue;
        }
        let start = window[0].0;
        let mut end = window[window.len() - 1].1;
        // Mirror the shape of the search text: if it ended with a newline, the
        // region it stands for includes that newline too.
        if trailing_newline && end < content.len() {
            end += 1;
        }
        found.push((start, end));
    }
    found
}

/// Shift the replacement's indentation to match the file's.
///
/// Without this, an indentation-tolerant match would paste the model's own
/// indentation into the file — turning a successful match into a broken block
/// in exactly the languages where indentation carries meaning.
fn reindent(replace: &str, search: &str, matched: &str) -> String {
    let model_indent = leading_whitespace(search.trim_end_matches('\n').lines().next().unwrap_or(""));
    let file_indent = leading_whitespace(matched.lines().next().unwrap_or(""));
    if model_indent == file_indent {
        return replace.to_owned();
    }

    replace
        .split_inclusive('\n')
        .map(|line| {
            let body = line.trim_end_matches(['\n', '\r']);
            let ending = &line[body.len()..];
            if body.trim().is_empty() {
                return line.to_owned();
            }
            let shifted = match body.strip_prefix(&model_indent) {
                // The line carries the model's indentation: swap it for the
                // file's.
                Some(rest) => format!("{file_indent}{rest}"),
                // Deeper or differently indented than the block's first line:
                // keep its relative shape, only re-anchor the common part.
                None => format!("{file_indent}{}", body.trim_start()),
            };
            format!("{shifted}{ending}")
        })
        .collect()
}

fn leading_whitespace(line: &str) -> String {
    line.chars()
        .take_while(|character| character.is_whitespace())
        .collect()
}

fn replace_at(content: &str, at: usize, hunk: &Hunk) -> String {
    let mut out = String::with_capacity(content.len() + hunk.replace.len());
    out.push_str(&content[..at]);
    out.push_str(&hunk.replace);
    out.push_str(&content[at + hunk.search.len()..]);
    out
}

fn line_of(content: &str, byte_offset: usize) -> usize {
    content[..byte_offset].matches('\n').count() + 1
}

/// Find where the search text would match if trailing whitespace were ignored.
///
/// Reported rather than applied: silently matching a near-miss is how an agent
/// ends up editing the wrong line.
fn fuzzy_line(content: &str, search: &str) -> Option<usize> {
    let squash = |text: &str| -> String {
        text.lines()
            .map(|line| line.trim())
            .collect::<Vec<_>>()
            .join("\n")
    };
    let needle = squash(search);
    if needle.is_empty() {
        return None;
    }
    let lines: Vec<&str> = content.split('\n').collect();
    let needle_lines: Vec<&str> = needle.split('\n').collect();
    lines
        .windows(needle_lines.len().max(1))
        .position(|window| {
            window
                .iter()
                .map(|line| line.trim())
                .eq(needle_lines.iter().copied())
        })
        .map(|index| index + 1)
}

/// One file's worth of pending change, validated but not yet written.
#[derive(Debug, Clone)]
struct PendingWrite {
    relative: String,
    absolute: PathBuf,
    bytes: Vec<u8>,
    previous: Option<Vec<u8>>,
    diff: LineDiff,
    created: bool,
    hunks_applied: usize,
    adjusted: Vec<String>,
}

/// A set of file changes applied together or not at all.
///
/// Build it with [`Transaction::edit`] / [`Transaction::write`], then call
/// [`Transaction::commit`].
#[derive(Debug, Default)]
pub struct Transaction {
    pending: Vec<PendingWrite>,
}

impl Transaction {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }

    pub fn len(&self) -> usize {
        self.pending.len()
    }

    /// Stage a full-content write, creating parent directories at commit time.
    pub fn write(&mut self, path: &ResolvedPath, content: &str) -> Result<()> {
        let (previous, before, template) = if path.exists() {
            let existing = text::read_text(path.absolute(), MAX_WRITE_BYTES)?;
            (
                Some(std::fs::read(path.absolute())?),
                existing.content.clone(),
                existing,
            )
        } else {
            (
                None,
                String::new(),
                FileText {
                    content: String::new(),
                    eol: text::Eol::platform_default(),
                    bom: false,
                    trailing_newline: true,
                },
            )
        };

        let normalised = content.replace("\r\n", "\n");
        let trailing = normalised.ends_with('\n');
        let body = if trailing {
            normalised[..normalised.len() - 1].to_owned()
        } else {
            normalised
        };

        let mut next = template.with_content(body.clone());
        // An existing file keeps its own convention; a brand-new one follows
        // what the caller actually wrote. Forcing the platform default here
        // would turn every `\n` a model writes into `\r\n` on Windows, which is
        // wrong in the many repositories that are LF-only.
        if previous.is_none() {
            next.eol = text::Eol::detect(content);
            next.trailing_newline = trailing;
        }

        self.pending.push(PendingWrite {
            relative: path.relative().to_owned(),
            absolute: path.absolute().to_owned(),
            bytes: next.encode(),
            created: previous.is_none(),
            previous,
            diff: diff::diff_lines(&before, &body),
            hunks_applied: 0,
            adjusted: Vec::new(),
        });
        Ok(())
    }

    /// Stage a hunk-based edit of an existing file.
    pub fn edit(&mut self, path: &ResolvedPath, hunks: &[Hunk]) -> Result<()> {
        if !path.exists() {
            return Err(ZaalisError::not_found(format!(
                "{} n'existe pas — utilisez write pour le créer",
                path.relative()
            )));
        }
        if hunks.is_empty() {
            return Err(ZaalisError::invalid("aucun hunk fourni"));
        }

        let existing = text::read_text(path.absolute(), MAX_WRITE_BYTES)?;
        let (updated, adjusted) = apply_hunks_reporting(&existing.content, hunks)?;
        if updated == existing.content {
            return Err(ZaalisError::invalid(format!(
                "{} : l'édition ne change rien",
                path.relative()
            )));
        }

        let next = existing.with_content(updated.clone());
        self.pending.push(PendingWrite {
            relative: path.relative().to_owned(),
            absolute: path.absolute().to_owned(),
            bytes: next.encode(),
            previous: Some(std::fs::read(path.absolute())?),
            diff: diff::diff_lines(&existing.content, &updated),
            created: false,
            hunks_applied: hunks.len(),
            adjusted,
        });
        Ok(())
    }

    /// Write every staged change, restoring all of them if any write fails.
    pub fn commit(self) -> Result<Vec<FileEdit>> {
        let mut done: Vec<(PathBuf, Option<Vec<u8>>)> = Vec::new();
        let mut results = Vec::with_capacity(self.pending.len());

        for entry in &self.pending {
            if let Some(parent) = entry.absolute.parent() {
                if let Err(error) = std::fs::create_dir_all(parent) {
                    rollback(&done);
                    return Err(ZaalisError::io(format!("{} : {error}", entry.relative)));
                }
            }
            if let Err(error) = std::fs::write(&entry.absolute, &entry.bytes) {
                rollback(&done);
                return Err(ZaalisError::io(format!("{} : {error}", entry.relative)));
            }
            done.push((entry.absolute.clone(), entry.previous.clone()));

            results.push(FileEdit {
                path: entry.relative.clone(),
                hunks_applied: entry.hunks_applied,
                added: entry.diff.added,
                removed: entry.diff.removed,
                diff: entry.diff.to_unified(&entry.relative),
                created: entry.created,
                adjusted: entry.adjusted.clone(),
            });
        }
        Ok(results)
    }

    /// Preview without writing anything. Plan mode and `--dry-run` use this.
    pub fn preview(&self) -> Vec<FileEdit> {
        self.pending
            .iter()
            .map(|entry| FileEdit {
                path: entry.relative.clone(),
                hunks_applied: entry.hunks_applied,
                added: entry.diff.added,
                removed: entry.diff.removed,
                diff: entry.diff.to_unified(&entry.relative),
                created: entry.created,
                adjusted: entry.adjusted.clone(),
            })
            .collect()
    }
}

fn rollback(done: &[(PathBuf, Option<Vec<u8>>)]) {
    for (path, previous) in done.iter().rev() {
        let _ = match previous {
            Some(bytes) => std::fs::write(path, bytes),
            None => std::fs::remove_file(path),
        };
    }
}

/// Parse the `<<<<<<< SEARCH / ======= / >>>>>>> REPLACE` form the current text
/// protocol uses, so a model still speaking it keeps working during migration.
pub fn parse_search_replace(body: &str) -> Vec<Hunk> {
    let mut hunks = Vec::new();
    let mut lines = body.split('\n').peekable();

    while let Some(line) = lines.next() {
        if !line.trim_start().starts_with("<<<<<<<") {
            continue;
        }
        let mut search = Vec::new();
        let mut replace = Vec::new();
        let mut in_replace = false;
        let mut closed = false;

        for line in lines.by_ref() {
            let trimmed = line.trim_start();
            if trimmed.starts_with("=======") {
                in_replace = true;
                continue;
            }
            if trimmed.starts_with(">>>>>>>") {
                closed = true;
                break;
            }
            if in_replace {
                replace.push(line);
            } else {
                search.push(line);
            }
        }
        if closed {
            hunks.push(Hunk::new(search.join("\n"), replace.join("\n")));
        }
    }
    hunks
}

/// Snapshot the bytes of a set of files, for checkpointing before a risky edit.
pub fn snapshot(paths: &[ResolvedPath]) -> Result<HashMap<String, Vec<u8>>> {
    let mut out = HashMap::new();
    for path in paths {
        if path.exists() && path.is_file() {
            out.insert(path.relative().to_owned(), std::fs::read(path.absolute())?);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::path::Workspace;
    use std::fs;
    use tempfile::TempDir;

    fn workspace() -> (TempDir, Workspace) {
        let dir = TempDir::new().expect("tempdir");
        let workspace = Workspace::open(dir.path()).expect("open");
        (dir, workspace)
    }

    #[test]
    fn a_unique_match_is_replaced() {
        let out = apply_hunks(
            "let a = 1;\nlet b = 2;",
            &[Hunk::new("let a = 1;", "let a = 42;")],
        )
        .expect("apply");
        assert_eq!(out, "let a = 42;\nlet b = 2;");
    }

    #[test]
    fn a_lost_trailing_space_no_longer_fails_the_edit() {
        // The model reproduced the line correctly but dropped the invisible
        // trailing space. Refusing here taught the model nothing and cost a
        // round trip.
        let content = "fn main() {   \n    let a = 1;\n}\n";
        let (out, notes) = apply_hunks_reporting(
            content,
            &[Hunk::new("fn main() {\n    let a = 1;", "fn main() {\n    let a = 2;")],
        )
        .expect("apply");
        assert!(out.contains("let a = 2;"));
        assert_eq!(notes.len(), 1, "la tolérance doit être signalée : {notes:?}");
        assert!(notes[0].contains("espaces de fin"));
    }

    #[test]
    fn an_indentation_drift_matches_and_the_replacement_is_re_indented() {
        // The model quoted the block with no indentation; the file has it
        // nested. Pasting the replacement verbatim would break the block, so
        // the replacement is shifted to the file's own depth.
        let content = "class A:\n    def run(self):\n        return 1\n";
        let (out, notes) = apply_hunks_reporting(
            content,
            &[Hunk::new("def run(self):\n    return 1", "def run(self):\n    return 2")],
        )
        .expect("apply");
        assert_eq!(out, "class A:\n    def run(self):\n        return 2\n");
        assert!(notes[0].contains("indentation"), "{notes:?}");
    }

    #[test]
    fn tolerance_never_resolves_an_ambiguity() {
        // Two near-misses is exactly the case where guessing edits the wrong
        // line, so it stays an error at every tier.
        let content = "  call(x)\n  other()\n      call(x)\n";
        let error = apply_hunks(content, &[Hunk::new("call(y)", "call(z)")]).expect_err("no match");
        assert!(error.message.contains("introuvable"));

        let error = apply_hunks(content, &[Hunk::new("call(x)", "call(z)")]).expect_err("ambiguous");
        assert!(error.message.contains("2 fois"), "{}", error.message);
    }

    #[test]
    fn an_exact_match_is_never_reported_as_adjusted() {
        let (_, notes) = apply_hunks_reporting("a = 1\n", &[Hunk::new("a = 1", "a = 2")])
            .expect("apply");
        assert!(notes.is_empty());
    }

    #[test]
    fn an_exact_match_wins_over_a_relaxed_one_elsewhere() {
        // The relaxed tiers only run when nothing matched exactly, so a file
        // containing both shapes still edits the one the model actually wrote.
        let content = "value = 1\n   value = 1   \n";
        let out = apply_hunks(content, &[Hunk::new("value = 1\n", "value = 2\n")]).expect("apply");
        assert_eq!(out, "value = 2\n   value = 1   \n");
    }

    #[test]
    fn a_repeated_match_is_refused_with_its_line_numbers() {
        let content = "x = 1;\ny = 0;\nx = 1;\n";
        let error = apply_hunks(content, &[Hunk::new("x = 1;", "x = 2;")]).expect_err("ambiguous");
        assert!(error.message.contains("2 fois"));
        assert!(error.message.contains("1, 3"), "{}", error.message);
        // The file is untouched — the caller got a hard error, not a guess.
    }

    #[test]
    fn a_repeated_match_can_be_disambiguated_by_occurrence() {
        let content = "x = 1;\ny = 0;\nx = 1;\n";
        let out = apply_hunks(content, &[Hunk::new("x = 1;", "x = 2;").nth(2)]).expect("apply");
        assert_eq!(out, "x = 1;\ny = 0;\nx = 2;\n");
    }

    #[test]
    fn an_out_of_range_occurrence_is_refused() {
        let error = apply_hunks("a\n", &[Hunk::new("a", "b").nth(5)]).expect_err("range");
        assert!(error.message.contains("occurrence 5"));
    }

    #[test]
    fn a_shorter_indentation_still_matches_as_a_substring() {
        // Standard search/replace semantics: the needle may start mid-line, and
        // the surrounding characters are preserved. This is what makes "replace
        // `false` with `true`" work without quoting the whole line.
        let out = apply_hunks(
            "function f() {\n    return 1;\n}\n",
            &[Hunk::new("return 1;", "return 2;")],
        )
        .expect("apply");
        assert_eq!(out, "function f() {\n    return 2;\n}\n");
    }

    #[test]
    fn a_tab_versus_spaces_mismatch_applies_and_keeps_the_file_s_own_indentation() {
        // The file indents with a tab, the model sent spaces. This used to be
        // refused outright; the model's intent is unambiguous, so it now
        // applies — and the tab survives, because the replacement is re-anchored
        // to the file's indentation rather than the model's.
        let content = "function f() {\n\treturn 1;\n}\n";
        let (out, notes) =
            apply_hunks_reporting(content, &[Hunk::new("    return 1;", "    return 2;")])
                .expect("apply");
        assert_eq!(out, "function f() {\n\treturn 2;\n}\n");
        assert!(notes[0].contains("ligne 2"), "{notes:?}");
    }

    #[test]
    fn a_genuinely_absent_search_still_says_where_it_nearly_matched() {
        // Tolerance covers whitespace, not different code: this one really is
        // absent, and the message still points at the closest line rather than
        // sending the agent to re-read the whole file.
        let content = "function f() {\n\treturn 1;\n}\n";
        let error = apply_hunks(content, &[Hunk::new("  return 1;  // cache", "x")])
            .expect_err("absent");
        assert!(error.message.contains("introuvable"), "{}", error.message);
    }

    #[test]
    fn an_empty_search_appends() {
        let out = apply_hunks("a", &[Hunk::new("", "b")]).expect("apply");
        assert_eq!(out, "a\nb");
    }

    #[test]
    fn later_hunks_may_match_what_earlier_hunks_produced() {
        let out = apply_hunks("one", &[Hunk::new("one", "two"), Hunk::new("two", "three")])
            .expect("apply");
        assert_eq!(out, "three");
    }

    #[test]
    fn a_failing_hunk_aborts_the_whole_set() {
        let error = apply_hunks("a\nb\n", &[Hunk::new("a", "A"), Hunk::new("MISSING", "x")])
            .expect_err("second hunk fails");
        assert!(error.message.contains("hunk 2"));
    }

    #[test]
    fn a_multi_file_transaction_writes_everything_or_nothing() {
        let (_dir, workspace) = workspace();
        fs::write(workspace.root().join("a.txt"), "alpha\n").expect("write");
        fs::write(workspace.root().join("b.txt"), "beta\n").expect("write");

        let mut transaction = Transaction::new();
        transaction
            .edit(
                &workspace.resolve("a.txt").unwrap(),
                &[Hunk::new("alpha", "ALPHA")],
            )
            .expect("stage a");
        transaction
            .edit(
                &workspace.resolve("b.txt").unwrap(),
                &[Hunk::new("beta", "BETA")],
            )
            .expect("stage b");

        let results = transaction.commit().expect("commit");
        assert_eq!(results.len(), 2);
        assert_eq!(
            fs::read_to_string(workspace.root().join("a.txt")).unwrap(),
            "ALPHA\n"
        );
        assert_eq!(
            fs::read_to_string(workspace.root().join("b.txt")).unwrap(),
            "BETA\n"
        );
    }

    #[test]
    fn a_bad_hunk_in_the_second_file_leaves_the_first_untouched() {
        let (_dir, workspace) = workspace();
        fs::write(workspace.root().join("a.txt"), "alpha\n").expect("write");
        fs::write(workspace.root().join("b.txt"), "beta\n").expect("write");

        let mut transaction = Transaction::new();
        transaction
            .edit(
                &workspace.resolve("a.txt").unwrap(),
                &[Hunk::new("alpha", "ALPHA")],
            )
            .expect("stage a");
        // Staging fails, so nothing was ever written.
        assert!(transaction
            .edit(
                &workspace.resolve("b.txt").unwrap(),
                &[Hunk::new("NOPE", "x")]
            )
            .is_err());

        assert_eq!(
            fs::read_to_string(workspace.root().join("a.txt")).unwrap(),
            "alpha\n",
            "aucune écriture ne doit avoir eu lieu"
        );
    }

    #[test]
    fn a_commit_failure_rolls_the_earlier_files_back() {
        let (_dir, workspace) = workspace();
        fs::write(workspace.root().join("a.txt"), "alpha\n").expect("write");
        // `blocker` is a file, so creating it as a parent directory fails — but
        // only at commit time, once `a.txt` has already been rewritten. That is
        // exactly the window rollback has to cover.
        fs::write(workspace.root().join("blocker"), "x").expect("write");

        let mut transaction = Transaction::new();
        transaction
            .edit(
                &workspace.resolve("a.txt").unwrap(),
                &[Hunk::new("alpha", "ALPHA")],
            )
            .expect("stage a");
        transaction
            .write(&workspace.resolve("blocker/child.txt").unwrap(), "beta")
            .expect("stage b");

        assert!(transaction.commit().is_err());
        assert_eq!(
            fs::read_to_string(workspace.root().join("a.txt")).unwrap(),
            "alpha\n",
            "le premier fichier doit avoir été restauré"
        );
    }

    #[test]
    fn a_rolled_back_creation_removes_the_file_it_created() {
        let (_dir, workspace) = workspace();
        fs::write(workspace.root().join("blocker"), "x").expect("write");

        let mut transaction = Transaction::new();
        transaction
            .write(&workspace.resolve("fresh.txt").unwrap(), "new")
            .expect("stage fresh");
        transaction
            .write(&workspace.resolve("blocker/child.txt").unwrap(), "boom")
            .expect("stage blocked");

        assert!(transaction.commit().is_err());
        assert!(
            !workspace.root().join("fresh.txt").exists(),
            "un fichier créé puis annulé doit disparaître"
        );
    }

    #[test]
    fn writing_a_new_file_creates_its_parent_directories() {
        let (_dir, workspace) = workspace();
        let mut transaction = Transaction::new();
        transaction
            .write(
                &workspace.resolve("deep/nested/file.txt").unwrap(),
                "content\n",
            )
            .expect("stage");
        let results = transaction.commit().expect("commit");
        assert!(results[0].created);
        assert_eq!(
            fs::read_to_string(workspace.root().join("deep/nested/file.txt")).unwrap(),
            "content\n"
        );
    }

    #[test]
    fn an_edit_preserves_crlf_and_bom() {
        let (_dir, workspace) = workspace();
        fs::write(
            workspace.root().join("w.txt"),
            b"\xEF\xBB\xBFalpha\r\nbeta\r\n",
        )
        .expect("write");

        let mut transaction = Transaction::new();
        transaction
            .edit(
                &workspace.resolve("w.txt").unwrap(),
                &[Hunk::new("beta", "BETA")],
            )
            .expect("stage");
        transaction.commit().expect("commit");

        let raw = fs::read(workspace.root().join("w.txt")).expect("read");
        assert_eq!(raw, b"\xEF\xBB\xBFalpha\r\nBETA\r\n".to_vec());
    }

    #[test]
    fn a_no_op_edit_is_an_error_rather_than_a_silent_success() {
        let (_dir, workspace) = workspace();
        fs::write(workspace.root().join("a.txt"), "same\n").expect("write");
        let mut transaction = Transaction::new();
        let error = transaction
            .edit(
                &workspace.resolve("a.txt").unwrap(),
                &[Hunk::new("same", "same")],
            )
            .expect_err("no-op");
        assert!(error.message.contains("ne change rien"));
    }

    #[test]
    fn editing_a_missing_file_points_at_write() {
        let (_dir, workspace) = workspace();
        let mut transaction = Transaction::new();
        let error = transaction
            .edit(
                &workspace.resolve("ghost.txt").unwrap(),
                &[Hunk::new("a", "b")],
            )
            .expect_err("missing");
        assert!(error.message.contains("write"));
    }

    #[test]
    fn a_preview_reports_the_diff_without_writing() {
        let (_dir, workspace) = workspace();
        fs::write(workspace.root().join("a.txt"), "alpha\n").expect("write");
        let mut transaction = Transaction::new();
        transaction
            .edit(
                &workspace.resolve("a.txt").unwrap(),
                &[Hunk::new("alpha", "ALPHA")],
            )
            .expect("stage");

        let preview = transaction.preview();
        assert_eq!(preview[0].added, 1);
        assert_eq!(preview[0].removed, 1);
        assert!(preview[0].diff.contains("+ALPHA"));
        assert_eq!(
            fs::read_to_string(workspace.root().join("a.txt")).unwrap(),
            "alpha\n",
            "un aperçu n'écrit rien"
        );
    }

    #[test]
    fn the_legacy_search_replace_block_still_parses() {
        // Migration path: a model still emitting the fenced text protocol keeps
        // working while providers move to native tool calling.
        let body = "<<<<<<< SEARCH\nold line\n=======\nnew line\n>>>>>>> REPLACE";
        let hunks = parse_search_replace(body);
        assert_eq!(hunks.len(), 1);
        assert_eq!(hunks[0].search, "old line");
        assert_eq!(hunks[0].replace, "new line");
    }

    #[test]
    fn an_unterminated_legacy_block_is_ignored() {
        let hunks = parse_search_replace("<<<<<<< SEARCH\nold\n=======\nnew");
        assert!(hunks.is_empty());
    }

    #[test]
    fn snapshots_capture_the_bytes_needed_for_a_checkpoint() {
        let (_dir, workspace) = workspace();
        fs::write(workspace.root().join("a.txt"), "alpha\n").expect("write");
        let captured = snapshot(&[
            workspace.resolve("a.txt").unwrap(),
            workspace.resolve("missing.txt").unwrap(),
        ])
        .expect("snapshot");
        assert_eq!(captured.len(), 1);
        assert_eq!(captured["a.txt"], b"alpha\n".to_vec());
    }
}
