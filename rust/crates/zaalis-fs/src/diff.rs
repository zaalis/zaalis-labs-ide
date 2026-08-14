//! Line diffs for review surfaces.
//!
//! Used to show what an agent changed — in the IDE's diff card, in the CLI, and
//! in the report a subagent hands back. Not a general-purpose diff library: it
//! trims the common prefix and suffix, then runs an LCS over what is left, and
//! degrades to a single replace block when the middle is too large to be worth
//! the quadratic work.

use serde::{Deserialize, Serialize};

/// Above this many differing lines, fall back to a whole-block replacement
/// rather than spending O(n·m) on a prettier diff nobody will read line by line.
const MAX_LCS_LINES: usize = 2_000;
/// Unchanged lines kept around each change.
const CONTEXT_LINES: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeKind {
    Keep,
    Add,
    Remove,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiffLine {
    pub kind: ChangeKind,
    pub text: String,
}

/// A computed diff plus the counts every caller needs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LineDiff {
    pub added: u32,
    pub removed: u32,
    pub lines: Vec<DiffLine>,
}

impl LineDiff {
    pub fn is_empty(&self) -> bool {
        self.added == 0 && self.removed == 0
    }

    /// Unified diff text, with a `@@` header per hunk.
    pub fn to_unified(&self, path: &str) -> String {
        if self.is_empty() {
            return String::new();
        }
        let mut out = format!("--- a/{path}\n+++ b/{path}\n");
        let mut old_line = 1usize;
        let mut new_line = 1usize;
        let mut index = 0usize;

        while index < self.lines.len() {
            // Skip runs of unchanged lines, keeping the trailing context.
            let run_start = index;
            while index < self.lines.len() && self.lines[index].kind == ChangeKind::Keep {
                index += 1;
            }
            if index >= self.lines.len() {
                break;
            }
            let skipped = index - run_start;
            let context_before = skipped.min(CONTEXT_LINES);
            old_line += skipped - context_before;
            new_line += skipped - context_before;

            let hunk_start = index - context_before;
            let hunk_old_start = old_line;
            let hunk_new_start = new_line;

            // Consume changes plus any short gaps of unchanged lines.
            let mut hunk_end = index;
            let mut trailing_keep = 0usize;
            while hunk_end < self.lines.len() {
                match self.lines[hunk_end].kind {
                    ChangeKind::Keep => {
                        trailing_keep += 1;
                        if trailing_keep > CONTEXT_LINES * 2 {
                            break;
                        }
                    }
                    _ => trailing_keep = 0,
                }
                hunk_end += 1;
            }
            let hunk_end = hunk_end - trailing_keep.saturating_sub(CONTEXT_LINES);

            let slice = &self.lines[hunk_start..hunk_end];
            let old_count = slice
                .iter()
                .filter(|line| line.kind != ChangeKind::Add)
                .count();
            let new_count = slice
                .iter()
                .filter(|line| line.kind != ChangeKind::Remove)
                .count();

            out.push_str(&format!(
                "@@ -{hunk_old_start},{old_count} +{hunk_new_start},{new_count} @@\n"
            ));
            for line in slice {
                let marker = match line.kind {
                    ChangeKind::Keep => ' ',
                    ChangeKind::Add => '+',
                    ChangeKind::Remove => '-',
                };
                out.push(marker);
                out.push_str(&line.text);
                out.push('\n');
            }

            old_line += old_count;
            new_line += new_count;
            index = hunk_end;
        }
        out
    }
}

/// Diff two normalised (`\n`-only) texts by line.
pub fn diff_lines(before: &str, after: &str) -> LineDiff {
    let old: Vec<&str> = split(before);
    let new: Vec<&str> = split(after);

    let mut prefix = 0;
    while prefix < old.len() && prefix < new.len() && old[prefix] == new[prefix] {
        prefix += 1;
    }
    let mut suffix = 0;
    while suffix < old.len() - prefix
        && suffix < new.len() - prefix
        && old[old.len() - 1 - suffix] == new[new.len() - 1 - suffix]
    {
        suffix += 1;
    }

    let old_middle = &old[prefix..old.len() - suffix];
    let new_middle = &new[prefix..new.len() - suffix];

    let mut lines: Vec<DiffLine> = Vec::new();
    for text in &old[..prefix] {
        lines.push(DiffLine {
            kind: ChangeKind::Keep,
            text: (*text).to_owned(),
        });
    }

    if old_middle.len().max(new_middle.len()) > MAX_LCS_LINES {
        for text in old_middle {
            lines.push(DiffLine {
                kind: ChangeKind::Remove,
                text: (*text).to_owned(),
            });
        }
        for text in new_middle {
            lines.push(DiffLine {
                kind: ChangeKind::Add,
                text: (*text).to_owned(),
            });
        }
    } else {
        lines.extend(lcs_diff(old_middle, new_middle));
    }

    for text in &old[old.len() - suffix..] {
        lines.push(DiffLine {
            kind: ChangeKind::Keep,
            text: (*text).to_owned(),
        });
    }

    let added = lines
        .iter()
        .filter(|line| line.kind == ChangeKind::Add)
        .count() as u32;
    let removed = lines
        .iter()
        .filter(|line| line.kind == ChangeKind::Remove)
        .count() as u32;

    LineDiff {
        added,
        removed,
        lines,
    }
}

fn split(text: &str) -> Vec<&str> {
    if text.is_empty() {
        Vec::new()
    } else {
        text.split('\n').collect()
    }
}

/// Classic dynamic-programming LCS, walked backwards to emit the edit script.
fn lcs_diff(old: &[&str], new: &[&str]) -> Vec<DiffLine> {
    let rows = old.len() + 1;
    let cols = new.len() + 1;
    let mut table = vec![0u32; rows * cols];

    for i in (0..old.len()).rev() {
        for j in (0..new.len()).rev() {
            table[i * cols + j] = if old[i] == new[j] {
                table[(i + 1) * cols + j + 1] + 1
            } else {
                table[(i + 1) * cols + j].max(table[i * cols + j + 1])
            };
        }
    }

    let mut out = Vec::new();
    let (mut i, mut j) = (0usize, 0usize);
    while i < old.len() && j < new.len() {
        if old[i] == new[j] {
            out.push(DiffLine {
                kind: ChangeKind::Keep,
                text: old[i].to_owned(),
            });
            i += 1;
            j += 1;
        } else if table[(i + 1) * cols + j] >= table[i * cols + j + 1] {
            out.push(DiffLine {
                kind: ChangeKind::Remove,
                text: old[i].to_owned(),
            });
            i += 1;
        } else {
            out.push(DiffLine {
                kind: ChangeKind::Add,
                text: new[j].to_owned(),
            });
            j += 1;
        }
    }
    while i < old.len() {
        out.push(DiffLine {
            kind: ChangeKind::Remove,
            text: old[i].to_owned(),
        });
        i += 1;
    }
    while j < new.len() {
        out.push(DiffLine {
            kind: ChangeKind::Add,
            text: new[j].to_owned(),
        });
        j += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_texts_produce_no_change() {
        let diff = diff_lines("a\nb\nc", "a\nb\nc");
        assert!(diff.is_empty());
        assert_eq!(diff.to_unified("f.txt"), "");
    }

    #[test]
    fn a_single_line_change_is_counted_correctly() {
        let diff = diff_lines("a\nb\nc", "a\nB\nc");
        assert_eq!(diff.added, 1);
        assert_eq!(diff.removed, 1);
    }

    #[test]
    fn pure_insertions_are_not_reported_as_removals() {
        let diff = diff_lines("a\nc", "a\nb\nc");
        assert_eq!(diff.added, 1);
        assert_eq!(diff.removed, 0);
    }

    #[test]
    fn pure_deletions_are_not_reported_as_additions() {
        let diff = diff_lines("a\nb\nc", "a\nc");
        assert_eq!(diff.added, 0);
        assert_eq!(diff.removed, 1);
    }

    #[test]
    fn the_unified_form_carries_headers_and_markers() {
        let diff = diff_lines("a\nb\nc\nd\ne", "a\nb\nX\nd\ne");
        let unified = diff.to_unified("src/f.js");
        assert!(unified.starts_with("--- a/src/f.js\n+++ b/src/f.js\n"));
        assert!(unified.contains("@@ -"));
        assert!(unified.contains("-c"));
        assert!(unified.contains("+X"));
        assert!(unified.contains(" b"), "context lines are kept");
    }

    #[test]
    fn empty_to_content_is_all_additions() {
        let diff = diff_lines("", "a\nb");
        assert_eq!(diff.added, 2);
        assert_eq!(diff.removed, 0);
    }

    #[test]
    fn content_to_empty_is_all_removals() {
        let diff = diff_lines("a\nb", "");
        assert_eq!(diff.added, 0);
        assert_eq!(diff.removed, 2);
    }

    #[test]
    fn a_huge_rewrite_falls_back_without_hanging() {
        let before: String = (0..MAX_LCS_LINES + 100)
            .map(|n| format!("old {n}\n"))
            .collect();
        let after: String = (0..MAX_LCS_LINES + 100)
            .map(|n| format!("new {n}\n"))
            .collect();
        let diff = diff_lines(&before, &after);
        assert!(diff.added > 0 && diff.removed > 0);
    }

    #[test]
    fn a_change_at_the_very_start_still_produces_a_hunk() {
        let diff = diff_lines("a\nb\nc", "Z\nb\nc");
        let unified = diff.to_unified("f");
        assert!(unified.contains("-a"));
        assert!(unified.contains("+Z"));
    }
}
