//! Anthropic Messages API adapter with native streaming tool use and thinking.

use crate::sse::SseDecoder;
use crate::transport::{self, WireParser};
use crate::types::ToolCallAccumulator;
use crate::{
    Capabilities, ImagePart, Message, ModelProvider, ProviderError, ProviderErrorKind,
    ProviderState, ProviderStream, StopReason, ToolSpec, TurnEvent, TurnRequest,
};
use async_trait::async_trait;
use reqwest::header::{HeaderMap, HeaderValue, CONTENT_TYPE};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;
use zaalis_core::{ProviderId, Usage};

#[derive(Debug, Clone)]
pub struct AnthropicConfig {
    pub base_url: String,
    pub api_key: String,
    pub default_model: String,
    pub api_version: String,
    pub capabilities: Capabilities,
}

impl AnthropicConfig {
    pub fn new(api_key: impl Into<String>) -> Self {
        Self {
            base_url: "https://api.anthropic.com/v1".to_owned(),
            api_key: api_key.into(),
            default_model: "claude-fable-5".to_owned(),
            api_version: "2023-06-01".to_owned(),
            capabilities: Capabilities {
                reasoning: true,
                streamed_reasoning: true,
                vision: true,
                max_context: 1_000_000,
                max_concurrency: 4,
                ..Capabilities::default()
            },
        }
    }

    pub fn with_base_url(mut self, base_url: impl Into<String>) -> Self {
        self.base_url = base_url.into();
        self
    }

    pub fn endpoint(&self) -> String {
        format!("{}/messages", self.base_url.trim_end_matches('/'))
    }
}

#[derive(Debug, Clone)]
pub struct AnthropicProvider {
    client: reqwest::Client,
    config: AnthropicConfig,
}

impl AnthropicProvider {
    pub fn new(config: AnthropicConfig) -> Result<Self, ProviderError> {
        if config.api_key.is_empty() {
            return Err(ProviderError::auth("aucune clé API Anthropic configurée"));
        }
        Ok(Self {
            client: transport::client()?,
            config,
        })
    }

    fn headers(&self) -> Result<HeaderMap, ProviderError> {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        headers.insert(
            reqwest::header::HeaderName::from_static("x-api-key"),
            HeaderValue::from_str(&self.config.api_key)
                .map_err(|_| ProviderError::auth("clé Anthropic invalide"))?,
        );
        headers.insert(
            reqwest::header::HeaderName::from_static("anthropic-version"),
            HeaderValue::from_str(&self.config.api_version)
                .map_err(|_| ProviderError::invalid("version Anthropic invalide"))?,
        );
        Ok(headers)
    }
}

#[async_trait]
impl ModelProvider for AnthropicProvider {
    fn id(&self) -> ProviderId {
        ProviderId::Claude
    }

    fn capabilities(&self) -> Capabilities {
        self.config.capabilities
    }

    fn default_model(&self) -> &str {
        &self.config.default_model
    }

    async fn stream_turn(
        &self,
        request: TurnRequest,
        cancel: CancellationToken,
    ) -> Result<ProviderStream, ProviderError> {
        if request.binding.provider != ProviderId::Claude {
            return Err(ProviderError::invalid("binding envoyé au mauvais provider"));
        }
        let response = transport::send(
            self.client
                .post(self.config.endpoint())
                .headers(self.headers()?)
                .json(&build_request(&self.config, &request, true)),
            &cancel,
            false,
        )
        .await?;
        Ok(transport::stream_response(
            response,
            cancel,
            AnthropicParser::default(),
        ))
    }
}

pub fn build_request(config: &AnthropicConfig, request: &TurnRequest, stream: bool) -> Value {
    let model = request
        .binding
        .model
        .as_deref()
        .unwrap_or(&config.default_model);
    let mut body = json!({
        "model": model,
        "messages": encode_messages(&request.messages),
        "max_tokens": request.max_output_tokens.unwrap_or(4_096),
        "stream": stream,
    });
    if !request.system.trim().is_empty() {
        body["system"] = Value::String(request.system.clone());
    }
    if !request.tools.is_empty() {
        body["tools"] = Value::Array(request.tools.iter().map(encode_tool).collect());
    }
    if let Some(temperature) = request.temperature {
        body["temperature"] = json!(temperature);
    }
    if !request.reasoning.is_off() && supports_adaptive_thinking(model) {
        body["thinking"] = json!({ "type": "adaptive", "display": "summarized" });
        let current = body["max_tokens"].as_u64().unwrap_or(4_096);
        body["max_tokens"] = json!(current.max(10_000));
    }
    body
}

fn supports_adaptive_thinking(model: &str) -> bool {
    model.contains("fable") || model.contains("opus") || model.contains("sonnet")
}

fn encode_tool(tool: &ToolSpec) -> Value {
    json!({
        "name": tool.name,
        "description": tool.description,
        "input_schema": tool.schema,
        "eager_input_streaming": true,
    })
}

fn encode_messages(messages: &[Message]) -> Vec<Value> {
    let mut encoded = Vec::new();
    for message in messages {
        match message {
            Message::User { text, images } => {
                let content = if images.is_empty() {
                    Value::String(text.clone())
                } else {
                    let mut parts = vec![json!({ "type": "text", "text": text })];
                    parts.extend(images.iter().map(encode_image));
                    Value::Array(parts)
                };
                encoded.push(json!({ "role": "user", "content": content }));
            }
            Message::Assistant {
                provider_state: Some(state),
                ..
            } if state.provider == ProviderId::Claude => encoded.push(state.value.clone()),
            Message::Assistant {
                text, tool_calls, ..
            } => {
                let mut content = Vec::new();
                if !text.is_empty() {
                    content.push(json!({ "type": "text", "text": text }));
                }
                content.extend(tool_calls.iter().map(|call| {
                    json!({
                        "type": "tool_use",
                        "id": call.id,
                        "name": call.name,
                        "input": call.arguments,
                    })
                }));
                encoded.push(json!({ "role": "assistant", "content": content }));
            }
            Message::Tool {
                call_id,
                content,
                is_error,
                ..
            } => {
                let block = json!({
                    "type": "tool_result",
                    "tool_use_id": call_id,
                    "content": content,
                    "is_error": is_error,
                });
                if let Some(Value::Object(last)) = encoded.last_mut() {
                    if last.get("role").and_then(Value::as_str) == Some("user") {
                        if let Some(parts) = last.get_mut("content").and_then(Value::as_array_mut) {
                            if parts.iter().all(|part| part["type"] == "tool_result") {
                                parts.push(block);
                                continue;
                            }
                        }
                    }
                }
                encoded.push(json!({ "role": "user", "content": [block] }));
            }
        }
    }
    encoded
}

fn encode_image(image: &ImagePart) -> Value {
    json!({
        "type": "image",
        "source": { "type": "base64", "media_type": image.mime, "data": image.data }
    })
}

#[derive(Debug, Default)]
struct AnthropicParser {
    decoder: SseDecoder,
    blocks: Vec<Value>,
    calls: ToolCallAccumulator,
    usage: Usage,
    stop_reason: Option<String>,
    failed: bool,
}

impl AnthropicParser {
    fn handle(&mut self, value: &Value, events: &mut Vec<TurnEvent>) {
        match value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
        {
            "message_start" => {
                if let Some(usage) = value.pointer("/message/usage") {
                    self.usage.input_tokens = number(usage, "input_tokens");
                    self.usage.output_tokens = number(usage, "output_tokens");
                    self.usage.cached_tokens = number(usage, "cache_read_input_tokens");
                }
            }
            "content_block_start" => {
                let index = index(value);
                let block = value
                    .get("content_block")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                ensure_slot(&mut self.blocks, index);
                self.blocks[index] = block.clone();
                if block["type"] == "tool_use" {
                    let id = block.get("id").and_then(Value::as_str);
                    let name = block.get("name").and_then(Value::as_str);
                    self.calls.push(index, id, name, None);
                    if let (Some(id), Some(name)) = (id, name) {
                        events.push(TurnEvent::ToolCallStarted {
                            id: id.to_owned(),
                            name: name.to_owned(),
                        });
                    }
                }
            }
            "content_block_delta" => self.delta(value, events),
            "message_delta" => {
                self.stop_reason = value
                    .pointer("/delta/stop_reason")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                if let Some(usage) = value.get("usage") {
                    self.usage.output_tokens = number(usage, "output_tokens");
                }
            }
            "error" => {
                self.failed = true;
                let kind = match value.pointer("/error/type").and_then(Value::as_str) {
                    Some("authentication_error") | Some("permission_error") => {
                        ProviderErrorKind::Auth
                    }
                    Some("rate_limit_error") => ProviderErrorKind::RateLimited,
                    Some("overloaded_error") => ProviderErrorKind::Transient,
                    _ => ProviderErrorKind::Transient,
                };
                events.push(TurnEvent::Failed {
                    error: ProviderError::new(
                        kind,
                        value
                            .pointer("/error/message")
                            .and_then(Value::as_str)
                            .unwrap_or("erreur Anthropic"),
                    ),
                });
            }
            _ => {}
        }
    }

    fn delta(&mut self, value: &Value, events: &mut Vec<TurnEvent>) {
        let index = index(value);
        ensure_slot(&mut self.blocks, index);
        let delta = value.get("delta").unwrap_or(&Value::Null);
        match delta
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
        {
            "text_delta" => {
                let text = delta
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                append_field(&mut self.blocks[index], "text", text);
                if !text.is_empty() {
                    events.push(TurnEvent::TextDelta {
                        text: text.to_owned(),
                    });
                }
            }
            "thinking_delta" => {
                let text = delta
                    .get("thinking")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                append_field(&mut self.blocks[index], "thinking", text);
                if !text.is_empty() {
                    events.push(TurnEvent::ReasoningDelta {
                        text: text.to_owned(),
                    });
                }
            }
            "signature_delta" => {
                let signature = delta
                    .get("signature")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                append_field(&mut self.blocks[index], "signature", signature);
            }
            "input_json_delta" => {
                let part = delta
                    .get("partial_json")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                self.calls.push(index, None, None, Some(part));
                let id = self
                    .calls
                    .identity(index)
                    .map(|(id, _)| id)
                    .unwrap_or_default();
                if !part.is_empty() {
                    events.push(TurnEvent::ToolCallDelta {
                        id: id.to_owned(),
                        arguments: part.to_owned(),
                    });
                }
            }
            _ => {}
        }
    }

    fn complete(mut self) -> Vec<TurnEvent> {
        let mut events = Vec::new();
        let calls = self.calls.finish();
        for call in &calls {
            if let Some(block) = self.blocks.iter_mut().find(|block| block["id"] == call.id) {
                block["input"] = call.arguments.clone();
            }
            events.push(TurnEvent::ToolCallCompleted { call: call.clone() });
        }
        if self.usage.input_tokens > 0 || self.usage.output_tokens > 0 {
            events.push(TurnEvent::Usage { usage: self.usage });
        }
        events.push(TurnEvent::AssistantState {
            state: ProviderState {
                provider: ProviderId::Claude,
                value: json!({ "role": "assistant", "content": self.blocks }),
            },
        });
        if !self.failed {
            events.push(TurnEvent::Completed {
                reason: match self.stop_reason.as_deref() {
                    Some("tool_use") => StopReason::ToolUse,
                    Some("max_tokens") => StopReason::MaxTokens,
                    _ if !calls.is_empty() => StopReason::ToolUse,
                    _ => StopReason::EndTurn,
                },
            });
        }
        events
    }
}

impl WireParser for AnthropicParser {
    fn push_bytes(&mut self, chunk: &[u8]) -> Vec<TurnEvent> {
        let mut events = Vec::new();
        for payload in self.decoder.push_bytes(chunk) {
            if let Ok(value) = serde_json::from_str::<Value>(&payload) {
                self.handle(&value, &mut events);
            }
        }
        events
    }

    fn finish(mut self) -> Vec<TurnEvent> {
        if let Some(payload) = self.decoder.finish() {
            if let Ok(value) = serde_json::from_str::<Value>(&payload) {
                self.handle(&value, &mut Vec::new());
            }
        }
        self.complete()
    }
}

fn index(value: &Value) -> usize {
    value.get("index").and_then(Value::as_u64).unwrap_or(0) as usize
}

fn ensure_slot(blocks: &mut Vec<Value>, index: usize) {
    while blocks.len() <= index {
        blocks.push(json!({}));
    }
}

fn append_field(value: &mut Value, field: &str, text: &str) {
    let current = value.get(field).and_then(Value::as_str).unwrap_or_default();
    value[field] = Value::String(format!("{current}{text}"));
}

fn number(value: &Value, field: &str) -> u64 {
    value.get(field).and_then(Value::as_u64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use zaalis_core::{ModelBinding, ReasoningLevel};

    fn request() -> TurnRequest {
        TurnRequest::new(
            ModelBinding::new(ProviderId::Claude, Some("claude-fable-5".into())),
            "système",
            vec![Message::user("lis")],
        )
        .with_tools(vec![ToolSpec {
            name: "read".into(),
            description: "Lire".into(),
            schema: json!({"type":"object"}),
        }])
    }

    #[test]
    fn request_uses_native_messages_tools_and_adaptive_thinking() {
        let mut request = request();
        request.reasoning = ReasoningLevel(2);
        let body = build_request(&AnthropicConfig::new("key"), &request, true);
        assert_eq!(body["tools"][0]["input_schema"]["type"], "object");
        assert_eq!(body["thinking"]["type"], "adaptive");
        assert_eq!(body["system"], "système");
    }

    #[test]
    fn tool_results_are_user_blocks_and_parallel_results_are_grouped() {
        let mut request = request();
        request
            .messages
            .push(Message::tool_result("a", "read", "A"));
        request
            .messages
            .push(Message::tool_result("b", "grep", "B"));
        let body = build_request(&AnthropicConfig::new("key"), &request, true);
        let last = body["messages"]
            .as_array()
            .expect("messages")
            .last()
            .expect("last");
        assert_eq!(last["role"], "user");
        assert_eq!(last["content"].as_array().expect("content").len(), 2);
    }

    #[test]
    fn stream_preserves_thinking_signature_tool_input_usage_and_state() {
        let fixture = concat!(
            "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":10}}}\n\n",
            "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\",\"signature\":\"\"}}\n\n",
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"réfléchis\"}}\n\n",
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"signature_delta\",\"signature\":\"sig\"}}\n\n",
            "data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"c1\",\"name\":\"read\",\"input\":{}}}\n\n",
            "data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"path\\\":\\\"a.rs\\\"}\"}}\n\n",
            "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":20}}\n\n",
        );
        let mut parser = AnthropicParser::default();
        let mut events = parser.push_bytes(fixture.as_bytes());
        events.extend(parser.finish());
        assert!(events
            .iter()
            .any(|event| matches!(event, TurnEvent::ReasoningDelta { .. })));
        let call = events
            .iter()
            .find_map(|event| match event {
                TurnEvent::ToolCallCompleted { call } => Some(call),
                _ => None,
            })
            .expect("call");
        assert_eq!(call.arguments["path"], "a.rs");
        let state = events
            .iter()
            .find_map(|event| match event {
                TurnEvent::AssistantState { state } => Some(state),
                _ => None,
            })
            .expect("state");
        assert_eq!(state.value["content"][0]["signature"], "sig");
        assert!(matches!(
            events.last(),
            Some(TurnEvent::Completed {
                reason: StopReason::ToolUse
            })
        ));
    }
}
