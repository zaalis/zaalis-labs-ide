//! Workspace-confined filesystem access.
//!
//! Every path a model can reach goes through [`path::Workspace::resolve`],
//! which canonicalises before deciding — closing the symlink and junction hole
//! the previous lexical check left open. Nothing else in the codebase should
//! call `std::fs` on a model-supplied path.
//!
//! ```no_run
//! use zaalis_fs::{path::Workspace, read::{read_file, ReadOptions}};
//!
//! let workspace = Workspace::open("C:/projet")?;
//! let path = workspace.resolve("src/app.js")?;      // refuses `../`, links out, ADS…
//! let content = read_file(&path, &ReadOptions::default())?;
//! # Ok::<(), zaalis_core::ZaalisError>(())
//! ```

pub mod diff;
pub mod edit;
pub mod listing;
pub mod path;
pub mod read;
pub mod search;
pub mod text;

pub use diff::{diff_lines, ChangeKind, DiffLine, LineDiff};
pub use edit::{apply_hunks, parse_search_replace, snapshot, FileEdit, Hunk, Transaction};
pub use listing::{list, tree, DirEntryInfo, ListResult, TreeResult};
pub use path::{ResolvedPath, Workspace, ALWAYS_SKIPPED_DIRS, SENSITIVE_PATTERNS};
pub use read::{read_file, FileRead, NumberedLine, ReadOptions};
pub use search::{
    glob, grep, EntryKind, GlobEntry, GlobOptions, GlobResult, GrepFile, GrepMatch, GrepOptions,
    GrepResult,
};
pub use text::{decode, read_text, Eol, FileText};

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    /// The whole read → edit → verify loop an agent performs, exercised end to
    /// end so a regression in any single stage shows up here too.
    #[test]
    fn an_agent_can_read_edit_and_reread_a_file() {
        let dir = TempDir::new().expect("tempdir");
        fs::create_dir_all(dir.path().join("src")).expect("mkdir");
        fs::write(
            dir.path().join("src/auth.js"),
            "function login() {\n  return false;\n}\n",
        )
        .expect("write");

        let workspace = Workspace::open(dir.path()).expect("open");

        // 1. Locate.
        let hits = grep(
            &workspace,
            &GrepOptions {
                pattern: "return false".into(),
                path: None,
                include: Some("*.js".into()),
                case_sensitive: false,
                context: 0,
                max_matches: None,
                include_ignored: false,
                include_sensitive: false,
            },
        )
        .expect("grep");
        assert_eq!(hits.files_with_matches, 1);
        let target = hits.files[0].path.clone();

        // 2. Read with line numbers.
        let path = workspace.resolve(&target).expect("resolve");
        let before = read_file(&path, &ReadOptions::default()).expect("read");
        assert_eq!(before.total_lines, 3);
        assert!(before.to_prompt_text().contains("2 | "));

        // 3. Edit atomically.
        let mut transaction = Transaction::new();
        transaction
            .edit(&path, &[Hunk::new("return false;", "return true;")])
            .expect("stage");
        let edits = transaction.commit().expect("commit");
        assert_eq!(edits[0].added, 1);
        assert_eq!(edits[0].removed, 1);
        assert!(edits[0].diff.contains("+  return true;"));

        // 4. Verify from disk.
        let after = read_file(&path, &ReadOptions::default()).expect("read");
        assert_eq!(after.lines[1].text, "  return true;");
    }

    /// The path checks that actually keep a model inside the project, in one
    /// place so the guarantee is visible as a single list.
    #[test]
    fn the_confinement_rules_hold_as_a_whole() {
        let dir = TempDir::new().expect("tempdir");
        fs::write(dir.path().join("ok.txt"), "fine").expect("write");
        let workspace = Workspace::open(dir.path()).expect("open");

        let refused = [
            "../escape",
            "..\\escape",
            "src/../../escape",
            "/etc/passwd",
            "C:/Windows/System32/config/SAM",
            "//server/share/file",
            "\\\\?\\C:\\Windows",
            "ok.txt:stream",
            "CON",
            "com1.txt",
            "trailing.",
            "dir /file",
            "",
        ];
        for input in refused {
            assert!(
                workspace.resolve(input).is_err(),
                "« {input} » doit être refusé"
            );
        }

        let accepted = ["ok.txt", "./ok.txt", ".", "new/deep/file.txt"];
        for input in accepted {
            assert!(
                workspace.resolve(input).is_ok(),
                "« {input} » doit être accepté"
            );
        }
    }
}
