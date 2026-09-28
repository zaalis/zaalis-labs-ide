//! Server-sent events, decoded incrementally.
//!
//! Every streaming provider zaalis talks to speaks SSE, so this is the one place
//! that has to get partial frames right. A chunk boundary lands mid-line often
//! enough that a naive `split('\n')` per chunk drops tokens — which looks like a
//! model "swallowing words" and is very hard to diagnose after the fact.

/// Accumulates bytes and yields complete `data:` payloads.
#[derive(Debug, Default)]
pub struct SseDecoder {
    buffer: Vec<u8>,
    data_lines: Vec<String>,
}

impl SseDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed a chunk, returning every payload that is now complete.
    ///
    /// The trailing partial line stays buffered for the next call.
    pub fn push(&mut self, chunk: &str) -> Vec<String> {
        self.push_bytes(chunk.as_bytes())
    }

    /// Feed raw network bytes. UTF-8 code points may straddle chunk boundaries;
    /// decoding only complete SSE lines preserves streamed Unicode text.
    pub fn push_bytes(&mut self, chunk: &[u8]) -> Vec<String> {
        self.buffer.extend_from_slice(chunk);
        let mut payloads = Vec::new();

        while let Some(position) = self.buffer.iter().position(|byte| *byte == b'\n') {
            let mut line = self.buffer.drain(..=position).collect::<Vec<_>>();
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            self.handle_line(&String::from_utf8_lossy(&line), &mut payloads);
        }
        payloads
    }

    fn handle_line(&mut self, line: &str, payloads: &mut Vec<String>) {
        if line.is_empty() {
            if !self.data_lines.is_empty() {
                payloads.push(self.data_lines.join("\n"));
                self.data_lines.clear();
            }
            return;
        }
        if line.starts_with(':') {
            return;
        }
        if let Some(rest) = line.strip_prefix("data:") {
            self.data_lines
                .push(rest.strip_prefix(' ').unwrap_or(rest).to_owned());
        }
        // `event:` and `id:` lines carry no model payload and are skipped.
    }

    /// Flush whatever is left when the connection closes.
    pub fn finish(&mut self) -> Option<String> {
        if !self.buffer.is_empty() {
            let bytes = std::mem::take(&mut self.buffer);
            let mut ignored = Vec::new();
            self.handle_line(&String::from_utf8_lossy(&bytes), &mut ignored);
        }
        (!self.data_lines.is_empty())
            .then(|| self.data_lines.drain(..).collect::<Vec<_>>().join("\n"))
    }
}

/// The sentinel every OpenAI-compatible endpoint sends before closing.
pub const DONE: &str = "[DONE]";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn complete_lines_are_returned_immediately() {
        let mut decoder = SseDecoder::new();
        let payloads = decoder.push("data: {\"a\":1}\n\ndata: {\"b\":2}\n\n");
        assert_eq!(payloads, vec![r#"{"a":1}"#, r#"{"b":2}"#]);
    }

    #[test]
    fn multiline_data_is_one_payload() {
        let mut decoder = SseDecoder::new();
        assert_eq!(
            decoder.push("data: first\ndata: second\n\n"),
            vec!["first\nsecond"]
        );
    }

    #[test]
    fn utf8_split_across_network_chunks_is_preserved() {
        let mut decoder = SseDecoder::new();
        let bytes = "data: réflexion\n\n".as_bytes();
        let split = bytes.iter().position(|byte| *byte >= 0x80).expect("utf8");
        assert!(decoder.push_bytes(&bytes[..=split]).is_empty());
        assert_eq!(decoder.push_bytes(&bytes[split + 1..]), vec!["réflexion"]);
    }

    #[test]
    fn a_line_split_across_chunks_is_not_lost() {
        // The failure mode this exists to prevent: half a token per chunk
        // boundary, silently dropped.
        let mut decoder = SseDecoder::new();
        assert!(decoder.push("data: {\"text\":\"bon").is_empty());
        assert!(decoder.push("jour\"}").is_empty());
        let payloads = decoder.push("\n\n");
        assert_eq!(payloads, vec![r#"{"text":"bonjour"}"#]);
    }

    #[test]
    fn crlf_endings_are_handled() {
        let mut decoder = SseDecoder::new();
        assert_eq!(decoder.push("data: x\r\n\r\n"), vec!["x"]);
    }

    #[test]
    fn comments_and_blank_lines_are_skipped() {
        let mut decoder = SseDecoder::new();
        let payloads = decoder.push(": ping\n\nevent: message\ndata: real\n\n");
        assert_eq!(payloads, vec!["real"]);
    }

    #[test]
    fn the_done_sentinel_comes_through_as_a_payload() {
        let mut decoder = SseDecoder::new();
        assert_eq!(decoder.push("data: [DONE]\n\n"), vec![DONE]);
    }

    #[test]
    fn a_final_line_without_a_newline_is_flushed() {
        let mut decoder = SseDecoder::new();
        assert!(decoder.push("data: tail").is_empty());
        assert_eq!(decoder.finish(), Some("tail".to_owned()));
    }

    #[test]
    fn finish_returns_nothing_when_the_buffer_is_clean() {
        let mut decoder = SseDecoder::new();
        decoder.push("data: x\n\n");
        assert_eq!(decoder.finish(), None);
    }

    #[test]
    fn many_small_chunks_reassemble_correctly() {
        let mut decoder = SseDecoder::new();
        let source = "data: {\"delta\":\"a\"}\n\ndata: {\"delta\":\"b\"}\n\n";
        let mut collected = Vec::new();
        for character in source.chars() {
            collected.extend(decoder.push(&character.to_string()));
        }
        assert_eq!(collected, vec![r#"{"delta":"a"}"#, r#"{"delta":"b"}"#]);
    }
}
