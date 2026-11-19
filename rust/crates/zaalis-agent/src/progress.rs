//! Bound provisional text while a provider is deciding whether to call tools.
//! The full answer is released only when the round is known to be final.
pub(crate) const PROGRESS_CHARS: usize = 280;

#[derive(Default)]
pub(crate) struct ProgressPreview {
    chars: usize,
    bytes: usize,
}

impl ProgressPreview {
    pub fn push(&mut self, delta: &str) -> String {
        let prefix: String = delta.chars().take((PROGRESS_CHARS - 1).saturating_sub(self.chars)).collect();
        self.chars += prefix.chars().count();
        self.bytes += prefix.len();
        prefix
    }

    pub fn finish(&self, full: &str, final_answer: bool) -> String {
        let rest = &full[self.bytes..];
        if final_answer { rest.to_owned() }
        else if !rest.is_empty() { "…".into() }
        else { String::new() }
    }
}
