//! Text file loading that remembers how the file was written.
//!
//! An editing agent that normalises line endings turns a one-line fix into a
//! whole-file diff. The byte-order mark and the dominant line ending are
//! therefore captured on read and restored on write, so a `\r\n` file stays a
//! `\r\n` file.

use serde::{Deserialize, Serialize};
use std::path::Path;
use zaalis_core::{Result, ZaalisError};

/// How many bytes to inspect when deciding whether a file is binary.
const SNIFF_BYTES: usize = 8_192;

/// Line ending style.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Eol {
    /// `\n`
    Lf,
    /// `\r\n`
    Crlf,
}

impl Eol {
    pub fn as_str(self) -> &'static str {
        match self {
            Eol::Lf => "\n",
            Eol::Crlf => "\r\n",
        }
    }

    /// Pick the dominant style. Ties go to LF, and a file with no line ending at
    /// all keeps the platform default so a newly created file looks native.
    pub fn detect(content: &str) -> Self {
        let crlf = content.matches("\r\n").count();
        let lf = content.matches('\n').count() - crlf;
        if crlf > lf {
            Eol::Crlf
        } else if crlf == 0 && lf == 0 {
            Eol::platform_default()
        } else {
            Eol::Lf
        }
    }

    pub const fn platform_default() -> Self {
        if cfg!(windows) {
            Eol::Crlf
        } else {
            Eol::Lf
        }
    }
}

/// A text file plus the details needed to write it back unchanged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileText {
    /// Content with every line ending normalised to `\n`, so matching and
    /// patching never have to care about the original style.
    pub content: String,
    pub eol: Eol,
    pub bom: bool,
    /// Whether the file ended with a newline. Adding or dropping one is a real
    /// diff, and several linters complain about it.
    pub trailing_newline: bool,
}

impl FileText {
    /// Restore the original encoding for writing.
    pub fn encode(&self) -> Vec<u8> {
        let mut body = match self.eol {
            Eol::Lf => self.content.clone(),
            Eol::Crlf => self.content.replace('\n', "\r\n"),
        };
        if self.trailing_newline && !body.is_empty() && !body.ends_with(self.eol.as_str()) {
            body.push_str(self.eol.as_str());
        }
        if !self.trailing_newline {
            while body.ends_with('\n') || body.ends_with('\r') {
                body.pop();
            }
        }
        let mut bytes = Vec::with_capacity(body.len() + 3);
        if self.bom {
            bytes.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
        }
        bytes.extend_from_slice(body.as_bytes());
        bytes
    }

    /// Build from a normalised string, adopting the encoding of an existing file.
    pub fn with_content(&self, content: String) -> FileText {
        FileText {
            content,
            eol: self.eol,
            bom: self.bom,
            trailing_newline: self.trailing_newline,
        }
    }

    pub fn lines(&self) -> impl Iterator<Item = &str> {
        self.content.split('\n')
    }

    pub fn line_count(&self) -> usize {
        if self.content.is_empty() {
            0
        } else {
            self.content.split('\n').count()
        }
    }
}

/// Why a file could not be read as text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BinaryReason {
    /// Contains NUL bytes.
    NullBytes,
    /// Not valid UTF-8.
    InvalidUtf8,
}

/// Classify raw bytes.
pub fn sniff_binary(bytes: &[u8]) -> Option<BinaryReason> {
    let window = &bytes[..bytes.len().min(SNIFF_BYTES)];
    if window.contains(&0) {
        return Some(BinaryReason::NullBytes);
    }
    // Validate the sniff window, allowing for a multi-byte sequence cut in half
    // at the boundary.
    if let Err(error) = std::str::from_utf8(window) {
        let cut_at_boundary = window.len() == SNIFF_BYTES && error.error_len().is_none();
        if !cut_at_boundary {
            return Some(BinaryReason::InvalidUtf8);
        }
    }
    None
}

/// Read a file as text, refusing binaries and anything over `max_bytes`.
pub fn read_text(path: &Path, max_bytes: u64) -> Result<FileText> {
    let metadata = std::fs::metadata(path)?;
    if metadata.is_dir() {
        return Err(ZaalisError::invalid(format!(
            "{} est un dossier",
            path.display()
        )));
    }
    if metadata.len() > max_bytes {
        return Err(ZaalisError::invalid(format!(
            "fichier trop volumineux ({} octets, limite {max_bytes})",
            metadata.len()
        )));
    }

    let bytes = std::fs::read(path)?;
    if let Some(reason) = sniff_binary(&bytes) {
        return Err(ZaalisError::invalid(match reason {
            BinaryReason::NullBytes => "fichier binaire (octets nuls)".to_owned(),
            BinaryReason::InvalidUtf8 => "fichier non-UTF-8".to_owned(),
        }));
    }

    Ok(decode(&bytes))
}

/// Decode already-loaded bytes.
pub fn decode(bytes: &[u8]) -> FileText {
    let (bom, body) = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        (true, &bytes[3..])
    } else {
        (false, bytes)
    };
    let raw = String::from_utf8_lossy(body).into_owned();
    let eol = Eol::detect(&raw);
    let normalised = raw.replace("\r\n", "\n");
    let trailing_newline = normalised.ends_with('\n');
    let content = if trailing_newline {
        normalised[..normalised.len() - 1].to_owned()
    } else {
        normalised
    };
    FileText {
        content,
        eol,
        bom,
        trailing_newline,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crlf_survives_a_read_write_round_trip() {
        let original = b"const a = 1;\r\nconst b = 2;\r\n";
        let text = decode(original);
        assert_eq!(text.eol, Eol::Crlf);
        assert!(text.trailing_newline);
        // Matching sees plain \n regardless of the file's style.
        assert_eq!(text.content, "const a = 1;\nconst b = 2;");
        assert_eq!(text.encode(), original);
    }

    #[test]
    fn lf_survives_a_read_write_round_trip() {
        let original = b"alpha\nbeta\n";
        let text = decode(original);
        assert_eq!(text.eol, Eol::Lf);
        assert_eq!(text.encode(), original);
    }

    #[test]
    fn a_bom_survives_a_round_trip() {
        let original = b"\xEF\xBB\xBFhello\n";
        let text = decode(original);
        assert!(text.bom);
        assert_eq!(text.content, "hello");
        assert_eq!(text.encode(), original);
    }

    #[test]
    fn a_missing_trailing_newline_is_not_silently_added() {
        let original = b"no newline at end";
        let text = decode(original);
        assert!(!text.trailing_newline);
        assert_eq!(text.encode(), original);
    }

    #[test]
    fn an_edit_keeps_the_original_encoding() {
        let text = decode(b"\xEF\xBB\xBFalpha\r\nbeta\r\n");
        let edited = text.with_content("alpha\nGAMMA".to_owned());
        assert_eq!(edited.encode(), b"\xEF\xBB\xBFalpha\r\nGAMMA\r\n".to_vec());
    }

    #[test]
    fn mixed_endings_take_the_dominant_style() {
        assert_eq!(Eol::detect("a\r\nb\r\nc\nd"), Eol::Crlf);
        assert_eq!(Eol::detect("a\nb\nc\r\nd"), Eol::Lf);
        assert_eq!(Eol::detect("single line"), Eol::platform_default());
    }

    #[test]
    fn binaries_are_detected_before_being_treated_as_text() {
        assert_eq!(sniff_binary(b"plain text"), None);
        assert_eq!(
            sniff_binary(b"PNG\x00\x01\x02"),
            Some(BinaryReason::NullBytes)
        );
        assert_eq!(
            sniff_binary(&[0xFF, 0xFE, 0xFD]),
            Some(BinaryReason::InvalidUtf8)
        );
    }

    #[test]
    fn a_multibyte_character_split_by_the_sniff_window_is_not_called_binary() {
        // 'é' is two bytes; place one so the window cuts it in half.
        let mut bytes = vec![b'a'; SNIFF_BYTES - 1];
        bytes.extend_from_slice("é".as_bytes());
        assert_eq!(sniff_binary(&bytes), None);
    }

    #[test]
    fn line_counting_matches_intuition() {
        assert_eq!(decode(b"").line_count(), 0);
        assert_eq!(decode(b"one").line_count(), 1);
        assert_eq!(decode(b"one\ntwo\n").line_count(), 2);
        assert_eq!(decode(b"one\ntwo").line_count(), 2);
    }

    #[test]
    fn an_empty_file_round_trips_as_empty() {
        let text = decode(b"");
        assert_eq!(text.content, "");
        assert_eq!(text.encode(), Vec::<u8>::new());
    }
}
