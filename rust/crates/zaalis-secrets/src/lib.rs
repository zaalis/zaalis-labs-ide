//! Secret detection and masking.
//!
//! The vault encrypts API keys at rest, which says nothing about the key that
//! `printenv`, a stack trace or a verbose install log prints onto a command's
//! stdout. That output is handed straight to the model, written into the
//! transcript and rendered in the UI, so one careless command turns a stored
//! secret into a leaked one — and the model may then quote it back in an answer
//! the user pastes somewhere public.
//!
//! Two layers, most reliable first:
//!
//! 1. **Registered literals.** The daemon knows the exact provider keys it was
//!    started with, so it registers them here. An exact match cannot produce a
//!    false negative on the secrets that matter most.
//! 2. **Shape rules.** Vendor-prefixed tokens (`sk-…`, `ghp_…`, `AIza…`), JWTs,
//!    PEM private key blocks, and `NAME=VALUE` pairs whose name reads like a
//!    credential. These catch keys this process never held — a token in a
//!    checked-in `.env`, a colleague's key in a CI log.
//!
//! Masking is deliberately lossy and has no reverse: the marker says a secret
//! was there, never how much of it. Showing a prefix "for context" is how
//! redaction leaks in practice.

use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::sync::{OnceLock, RwLock};

/// Shortest literal worth registering.
///
/// Below this a "secret" is more likely to be a word that occurs in ordinary
/// output, and masking every occurrence of it would shred the text it appears
/// in.
const MIN_LITERAL_LENGTH: usize = 12;

/// Shortest value an assignment heuristic will mask.
const MIN_ASSIGNED_LENGTH: usize = 8;

/// What replaced a secret, when the source is a shape rule.
const MASK: &str = "[secret masqué]";

/// Characters that can appear inside a credential token.
///
/// ASCII-only on purpose: every index this scanner produces then lands on a
/// UTF-8 character boundary, because no continuation byte is ASCII.
fn is_token_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'+' | b'/' | b'=' | b'~')
}

/// A vendor token shape: a literal prefix plus a minimum total length.
struct Shape {
    prefix: &'static str,
    min_length: usize,
    label: &'static str,
}

/// Prefixes that identify a credential on sight.
///
/// Every entry is anchored at the start of a token, so `sk-` does not match the
/// middle of `task-runner`, and carries a minimum length, so the bare prefix in
/// documentation (`export SK_KEY=sk-…`) does not trip it.
const SHAPES: &[Shape] = &[
    Shape {
        prefix: "sk-ant-",
        min_length: 30,
        label: "clé Anthropic",
    },
    Shape {
        prefix: "sk-proj-",
        min_length: 30,
        label: "clé OpenAI",
    },
    Shape {
        prefix: "sk-or-",
        min_length: 30,
        label: "clé OpenRouter",
    },
    Shape {
        prefix: "sk-",
        min_length: 24,
        label: "clé de type OpenAI",
    },
    Shape {
        prefix: "github_pat_",
        min_length: 30,
        label: "jeton GitHub",
    },
    Shape {
        prefix: "ghp_",
        min_length: 20,
        label: "jeton GitHub",
    },
    Shape {
        prefix: "gho_",
        min_length: 20,
        label: "jeton GitHub",
    },
    Shape {
        prefix: "ghu_",
        min_length: 20,
        label: "jeton GitHub",
    },
    Shape {
        prefix: "ghs_",
        min_length: 20,
        label: "jeton GitHub",
    },
    Shape {
        prefix: "ghr_",
        min_length: 20,
        label: "jeton GitHub",
    },
    Shape {
        prefix: "glpat-",
        min_length: 20,
        label: "jeton GitLab",
    },
    Shape {
        prefix: "AIza",
        min_length: 35,
        label: "clé Google",
    },
    Shape {
        prefix: "ya29.",
        min_length: 30,
        label: "jeton OAuth Google",
    },
    Shape {
        prefix: "xoxb-",
        min_length: 24,
        label: "jeton Slack",
    },
    Shape {
        prefix: "xoxp-",
        min_length: 24,
        label: "jeton Slack",
    },
    Shape {
        prefix: "xoxa-",
        min_length: 24,
        label: "jeton Slack",
    },
    Shape {
        prefix: "xapp-",
        min_length: 24,
        label: "jeton Slack",
    },
    Shape {
        prefix: "hf_",
        min_length: 20,
        label: "jeton Hugging Face",
    },
    Shape {
        prefix: "gsk_",
        min_length: 20,
        label: "clé Groq",
    },
    Shape {
        prefix: "xai-",
        min_length: 24,
        label: "clé xAI",
    },
    Shape {
        prefix: "npm_",
        min_length: 30,
        label: "jeton npm",
    },
    Shape {
        prefix: "dop_v1_",
        min_length: 30,
        label: "jeton DigitalOcean",
    },
    Shape {
        prefix: "SG.",
        min_length: 40,
        label: "clé SendGrid",
    },
    Shape {
        prefix: "shpat_",
        min_length: 30,
        label: "jeton Shopify",
    },
];

/// Names whose value is a credential whatever it looks like.
const SENSITIVE_NAMES: &[&str] = &[
    "password",
    "passwd",
    "pwd",
    "secret",
    "token",
    "api_key",
    "apikey",
    "api-key",
    "access_key",
    "accesskey",
    "private_key",
    "privatekey",
    "client_secret",
    "auth",
    "credential",
    "session_key",
    "encryption_key",
    "signing_key",
];

/// Names that contain a sensitive word but never hold the credential itself.
///
/// Without this list, `printenv` output masks its own structure: the *name* of
/// the file that holds a key is not a key, and hiding it makes the output
/// unreadable for no security gain.
const SENSITIVE_NAME_EXCEPTIONS: &[&str] = &[
    "token_count",
    "tokens",
    "max_tokens",
    "token_limit",
    "token_usage",
    "secret_path",
    "secret_file",
    "secret_name",
    "key_file",
    "keyfile",
    "password_file",
    "auth_url",
    "auth_type",
    "auth_method",
    "credential_path",
    "credentials_file",
];

/// One exactly-known secret.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Literal {
    value: String,
    label: String,
}

/// A set of known secrets, plus the shape rules that need no registration.
///
/// Prefer the process-wide [`sanitize`] for output paths; construct a
/// `Sanitizer` directly when a caller needs an isolated set (tests, or a
/// per-session scope).
#[derive(Debug, Default)]
pub struct Sanitizer {
    literals: Vec<Literal>,
}

impl Sanitizer {
    pub fn new() -> Self {
        Self::default()
    }

    /// Remember one exact secret.
    ///
    /// Short values are ignored rather than rejected: a caller registering
    /// every configured key should not have to know which of them are too
    /// short to mask safely.
    pub fn register(&mut self, label: impl Into<String>, value: impl Into<String>) {
        let value = value.into();
        if value.trim().len() < MIN_LITERAL_LENGTH {
            return;
        }
        let literal = Literal {
            value: value.trim().to_owned(),
            label: label.into(),
        };
        if !self.literals.iter().any(|known| known.value == literal.value) {
            self.literals.push(literal);
        }
        // Longest first, so a key that contains another key's prefix still
        // masks as a whole rather than leaving a tail behind.
        self.literals
            .sort_by(|left, right| right.value.len().cmp(&left.value.len()));
    }

    pub fn is_empty(&self) -> bool {
        self.literals.is_empty()
    }

    /// Mask every secret in `text`.
    ///
    /// Returns the input untouched when nothing matched, so the common case
    /// costs a scan and no allocation.
    pub fn sanitize<'a>(&self, text: &'a str) -> Cow<'a, str> {
        let masked = self.mask_literals(text);
        match mask_shapes(&masked) {
            Cow::Borrowed(_) => masked,
            Cow::Owned(owned) => Cow::Owned(owned),
        }
    }

    /// Whether `text` carries something this sanitizer would mask.
    pub fn detects(&self, text: &str) -> bool {
        matches!(self.sanitize(text), Cow::Owned(_))
    }

    fn mask_literals<'a>(&self, text: &'a str) -> Cow<'a, str> {
        let mut result: Option<String> = None;
        for literal in &self.literals {
            let source = result.as_deref().unwrap_or(text);
            if !source.contains(literal.value.as_str()) {
                continue;
            }
            let replacement = format!("[secret masqué : {}]", literal.label);
            result = Some(source.replace(literal.value.as_str(), &replacement));
        }
        match result {
            Some(owned) => Cow::Owned(owned),
            None => Cow::Borrowed(text),
        }
    }
}

fn registry() -> &'static RwLock<Sanitizer> {
    static REGISTRY: OnceLock<RwLock<Sanitizer>> = OnceLock::new();
    REGISTRY.get_or_init(|| RwLock::new(Sanitizer::new()))
}

/// Register one exact secret process-wide.
///
/// Called once at startup with the provider keys the daemon was handed, which
/// is what lets output masking catch the keys that actually exist on this
/// machine rather than only the ones with a recognisable shape.
pub fn register_secret(label: impl Into<String>, value: impl Into<String>) {
    if let Ok(mut registry) = registry().write() {
        registry.register(label, value);
    }
}

/// Forget every registered literal. Shape rules are unaffected.
pub fn clear_registered_secrets() {
    if let Ok(mut registry) = registry().write() {
        registry.literals.clear();
    }
}

/// Mask every secret in `text` using the process-wide registry.
///
/// A poisoned registry falls back to shape rules alone rather than returning
/// the raw text: losing the literal layer is recoverable, printing the key is
/// not.
pub fn sanitize(text: &str) -> Cow<'_, str> {
    match registry().read() {
        Ok(registry) => match registry.sanitize(text) {
            Cow::Borrowed(borrowed) => Cow::Borrowed(borrowed),
            Cow::Owned(owned) => Cow::Owned(owned),
        },
        Err(_) => mask_shapes(text),
    }
}

/// Mask in place, for the many call sites holding an owned `String`.
pub fn sanitize_in_place(text: &mut String) {
    if let Cow::Owned(masked) = sanitize(text.as_str()) {
        *text = masked;
    }
}

/// Apply the shape rules alone, with no registered literals.
pub fn mask_shapes(text: &str) -> Cow<'_, str> {
    let masked = mask_pem_blocks(text);
    let masked_tokens = match mask_tokens(&masked) {
        Cow::Borrowed(_) => masked,
        Cow::Owned(owned) => Cow::Owned(owned),
    };
    match mask_assignments(&masked_tokens) {
        Cow::Borrowed(_) => masked_tokens,
        Cow::Owned(owned) => Cow::Owned(owned),
    }
}

/// Mask whole `-----BEGIN … PRIVATE KEY-----` blocks.
///
/// The body is base64 with newlines, so the token scanner would only nibble at
/// individual lines and leave a reconstructable key behind.
fn mask_pem_blocks(text: &str) -> Cow<'_, str> {
    const BEGIN: &str = "-----BEGIN";
    const END: &str = "-----END";
    if !text.contains(BEGIN) {
        return Cow::Borrowed(text);
    }
    let mut result = String::with_capacity(text.len());
    let mut rest = text;
    let mut masked_any = false;
    while let Some(start) = rest.find(BEGIN) {
        let header_end = match rest[start..].find('\n') {
            Some(offset) => start + offset,
            None => break,
        };
        let header = &rest[start..header_end];
        if !header.contains("PRIVATE KEY") {
            result.push_str(&rest[..header_end]);
            rest = &rest[header_end..];
            continue;
        }
        let Some(end_offset) = rest[header_end..].find(END) else {
            break;
        };
        let end_start = header_end + end_offset;
        let block_end = match rest[end_start..].find('\n') {
            Some(offset) => end_start + offset,
            None => rest.len(),
        };
        result.push_str(&rest[..start]);
        result.push_str("[clé privée masquée]");
        rest = &rest[block_end..];
        masked_any = true;
    }
    if !masked_any {
        return Cow::Borrowed(text);
    }
    result.push_str(rest);
    Cow::Owned(result)
}

/// Mask tokens whose prefix identifies a vendor credential, plus JWTs.
fn mask_tokens(text: &str) -> Cow<'_, str> {
    let bytes = text.as_bytes();
    let mut result: Option<String> = None;
    let mut copied = 0;
    let mut index = 0;

    while index < bytes.len() {
        if !is_token_byte(bytes[index]) {
            index += 1;
            continue;
        }
        let start = index;
        while index < bytes.len() && is_token_byte(bytes[index]) {
            index += 1;
        }
        let token = &text[start..index];
        let Some(label) = classify_token(token) else {
            continue;
        };
        let result = result.get_or_insert_with(|| String::with_capacity(text.len()));
        result.push_str(&text[copied..start]);
        result.push_str(&format!("[{label} masquée]"));
        copied = index;
    }

    match result {
        Some(mut owned) => {
            owned.push_str(&text[copied..]);
            Cow::Owned(owned)
        }
        None => Cow::Borrowed(text),
    }
}

fn classify_token(token: &str) -> Option<&'static str> {
    for shape in SHAPES {
        if token.len() >= shape.min_length && token.starts_with(shape.prefix) {
            return Some(shape.label);
        }
    }
    if is_aws_access_key(token) {
        return Some("clé d'accès AWS");
    }
    if is_jwt(token) {
        return Some("jeton JWT");
    }
    None
}

/// `AKIA`/`ASIA` plus sixteen upper-case alphanumerics, and nothing else.
fn is_aws_access_key(token: &str) -> bool {
    token.len() == 20
        && (token.starts_with("AKIA") || token.starts_with("ASIA"))
        && token
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
}

/// Three base64url segments, the first of which is a JSON header.
///
/// `eyJ` is `{"` in base64, so requiring it keeps ordinary dotted identifiers
/// out while catching every real JWT.
fn is_jwt(token: &str) -> bool {
    if !token.starts_with("eyJ") || token.len() < 40 {
        return false;
    }
    let segments: Vec<&str> = token.split('.').collect();
    segments.len() == 3
        && segments.iter().all(|segment| {
            !segment.is_empty()
                && segment
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'='))
        })
}

/// Mask the value of `NAME=VALUE` / `NAME: VALUE` when the name reads like a
/// credential.
///
/// This is the rule that catches a plain `printenv` or a leaked `.env`, where
/// the value has no vendor prefix at all.
fn mask_assignments(text: &str) -> Cow<'_, str> {
    if !text.contains('=') && !text.contains(':') {
        return Cow::Borrowed(text);
    }
    let mut result = String::with_capacity(text.len());
    let mut masked_any = false;

    // `split_inclusive` keeps the newline on each piece, so reassembling the
    // text needs no separator bookkeeping.
    for line in text.split_inclusive('\n') {
        match mask_assignment_line(line) {
            Some(masked) => {
                result.push_str(&masked);
                masked_any = true;
            }
            None => result.push_str(line),
        }
    }

    if masked_any {
        Cow::Owned(result)
    } else {
        Cow::Borrowed(text)
    }
}

fn mask_assignment_line(line: &str) -> Option<String> {
    let separator = line
        .find('=')
        .into_iter()
        .chain(line.find(':'))
        .min_by_key(|index| *index)?;
    let (name_part, value_part) = line.split_at(separator);
    let value_part = &value_part[1..];

    let name = name_part
        .trim()
        .trim_start_matches(['"', '\'', '$', '{', '-'])
        .trim_end_matches(['"', '\''])
        .rsplit([' ', '\t', '.', ',', '(', '[', '{'])
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    if !looks_sensitive_name(&name) {
        return None;
    }

    let trailing_newline = value_part.ends_with('\n');
    let value = value_part.trim_end_matches(['\n', '\r']);
    let leading_spaces = value.len() - value.trim_start().len();
    let value = value.trim_start();

    // `Authorization: Bearer <token>` is the one shape whose value legitimately
    // carries a space; the credential is what follows the scheme.
    let (scheme, credential) = match value.split_once(' ') {
        Some((scheme, rest))
            if matches!(
                scheme.to_ascii_lowercase().as_str(),
                "bearer" | "basic" | "token"
            ) =>
        {
            (Some(scheme), rest.trim())
        }
        Some(_) => return None, // a sentence, not a credential
        None => (None, value),
    };

    let bare = credential.trim_matches(['"', '\'', '`']);
    if bare.len() < MIN_ASSIGNED_LENGTH || bare.contains(' ') {
        return None;
    }

    let mut masked = String::with_capacity(line.len());
    masked.push_str(name_part);
    masked.push_str(&line[separator..=separator]);
    masked.push_str(&" ".repeat(leading_spaces));
    if let Some(scheme) = scheme {
        masked.push_str(scheme);
        masked.push(' ');
    }
    masked.push_str(MASK);
    if trailing_newline {
        masked.push('\n');
    }
    Some(masked)
}

fn looks_sensitive_name(name: &str) -> bool {
    if name.is_empty() {
        return false;
    }
    if SENSITIVE_NAME_EXCEPTIONS
        .iter()
        .any(|exception| name.contains(exception))
    {
        return false;
    }
    SENSITIVE_NAMES.iter().any(|marker| name.contains(marker))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordinary_output_is_returned_untouched_and_unallocated() {
        let text = "Compiling zaalis-core v1.0.15\n    Finished in 4.21s\n";
        assert!(matches!(mask_shapes(text), Cow::Borrowed(_)));
    }

    #[test]
    fn a_registered_key_is_masked_wherever_it_appears() {
        let mut sanitizer = Sanitizer::new();
        sanitizer.register("clé OpenAI", "abcdefghijklmnopqrstuvwxyz0123");
        let masked = sanitizer
            .sanitize("curl -H 'x: abcdefghijklmnopqrstuvwxyz0123' https://api.example");
        assert!(!masked.contains("abcdefghijklmnopqrstuvwxyz0123"));
        assert!(masked.contains("[secret masqué : clé OpenAI]"));
    }

    #[test]
    fn a_short_value_is_never_registered_because_masking_it_would_shred_the_output() {
        let mut sanitizer = Sanitizer::new();
        sanitizer.register("trop court", "dev");
        assert!(sanitizer.is_empty());
        assert_eq!(sanitizer.sanitize("dev server started"), "dev server started");
    }

    #[test]
    fn vendor_prefixed_tokens_are_masked() {
        for token in [
            "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "sk-proj-BBBBBBBBBBBBBBBBBBBBBBBBBBBB",
            "ghp_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
            "github_pat_DDDDDDDDDDDDDDDDDDDDDDDDDD",
            "AIzaEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE",
            "xoxb-111111111111-222222222222-abcdefghij",
            "hf_FFFFFFFFFFFFFFFFFFFFFFFFF",
            "glpat-GGGGGGGGGGGGGGGGGGGG",
            "AKIAIOSFODNN7EXAMPLE",
        ] {
            let text = format!("echo {token}");
            let masked = mask_shapes(&text);
            assert!(
                !masked.contains(token),
                "« {token} » doit être masqué, obtenu : {masked}"
            );
        }
    }

    #[test]
    fn a_bare_prefix_in_prose_is_not_a_secret() {
        // The prefix alone carries no key material, and masking it would hide
        // documentation that tells the user what to configure.
        for text in [
            "les clés commencent par sk-",
            "use a ghp_ token",
            "task-runner started",
            "sk-short",
        ] {
            assert!(
                matches!(mask_shapes(text), Cow::Borrowed(_)),
                "« {text} » ne doit pas être masqué"
            );
        }
    }

    #[test]
    fn a_jwt_is_masked_but_a_dotted_identifier_is_not() {
        let jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP";
        assert!(!mask_shapes(jwt).contains(jwt));
        assert!(matches!(
            mask_shapes("com.example.app.service.handler"),
            Cow::Borrowed(_)
        ));
    }

    #[test]
    fn a_private_key_block_is_masked_whole() {
        let text = "avant\n-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA1234\nabcd\n-----END RSA PRIVATE KEY-----\naprès\n";
        let masked = mask_shapes(text);
        assert!(masked.contains("[clé privée masquée]"));
        assert!(!masked.contains("MIIEpAIBAAKCAQEA1234"));
        assert!(masked.contains("avant"));
        assert!(masked.contains("après"));
    }

    #[test]
    fn a_public_key_block_is_left_alone() {
        let text = "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkq\n-----END PUBLIC KEY-----\n";
        assert!(mask_shapes(text).contains("MIIBIjANBgkq"));
    }

    #[test]
    fn an_env_dump_masks_values_by_name() {
        let text = "PATH=/usr/bin\nOPENAI_API_KEY=zzzzzzzzzzzzzzzzzzzz\nDB_PASSWORD=hunter2hunter2\nHOME=/home/dev\n";
        let masked = mask_shapes(text);
        assert!(!masked.contains("zzzzzzzzzzzzzzzzzzzz"));
        assert!(!masked.contains("hunter2hunter2"));
        // Everything that is not a credential survives, or the output becomes
        // useless to the model that has to act on it.
        assert!(masked.contains("PATH=/usr/bin"));
        assert!(masked.contains("HOME=/home/dev"));
    }

    #[test]
    fn a_name_that_only_mentions_a_secret_is_not_masked() {
        let text = "SECRET_PATH=/etc/zaalis/keys\nMAX_TOKENS=4096\nAUTH_URL=https://example.test/oauth\n";
        assert!(matches!(mask_shapes(text), Cow::Borrowed(_)));
    }

    #[test]
    fn an_authorization_header_keeps_its_scheme_and_loses_its_token() {
        let masked = mask_shapes("Authorization: Bearer abcdefghijklmnop\n");
        assert!(masked.contains("Bearer"));
        assert!(!masked.contains("abcdefghijklmnop"));
    }

    #[test]
    fn a_sentence_after_a_sensitive_name_is_not_a_credential() {
        let text = "password: the value was rejected by the server\n";
        assert!(matches!(mask_shapes(text), Cow::Borrowed(_)));
    }

    #[test]
    fn masking_preserves_surrounding_text_exactly() {
        let masked = mask_shapes("before ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA after");
        assert!(masked.starts_with("before "));
        assert!(masked.ends_with(" after"));
    }

    #[test]
    fn non_ascii_output_is_not_corrupted() {
        let text = "compilation terminée — 4 crates à jour, clé ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n";
        let masked = mask_shapes(text);
        assert!(masked.contains("compilation terminée — 4 crates à jour"));
        assert!(!masked.contains("ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"));
    }

    #[test]
    fn the_process_registry_masks_and_can_be_cleared() {
        clear_registered_secrets();
        register_secret("clé de test", "ZZZZZZZZZZZZZZZZZZZZZZZZ");
        assert!(!sanitize("valeur ZZZZZZZZZZZZZZZZZZZZZZZZ").contains("ZZZZZZZZZZZZZZZZZZZZZZZZ"));
        clear_registered_secrets();
        assert_eq!(
            sanitize("valeur ZZZZZZZZZZZZZZZZZZZZZZZZ"),
            "valeur ZZZZZZZZZZZZZZZZZZZZZZZZ"
        );
    }

    #[test]
    fn sanitize_in_place_rewrites_only_when_needed() {
        let mut clean = String::from("tout va bien");
        sanitize_in_place(&mut clean);
        assert_eq!(clean, "tout va bien");

        let mut dirty = String::from("token ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
        sanitize_in_place(&mut dirty);
        assert!(!dirty.contains("ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"));
    }

    #[test]
    fn the_longest_registered_secret_wins_when_one_contains_another() {
        let mut sanitizer = Sanitizer::new();
        sanitizer.register("courte", "AAAAAAAAAAAAAAAA");
        sanitizer.register("longue", "AAAAAAAAAAAAAAAABBBBBBBB");
        let masked = sanitizer.sanitize("valeur AAAAAAAAAAAAAAAABBBBBBBB");
        assert!(masked.contains("longue"));
        assert!(!masked.contains('B'));
    }
}
