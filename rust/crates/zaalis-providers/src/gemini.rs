//! Google Gemini GenerateContent adapter.
//!
//! Zaalis keeps the complete model `parts` array because Gemini thought
//! signatures must be replayed byte-for-byte during native function calling.

use crate::sse::SseDecoder;
use crate::transport::{self, WireParser};
use crate::{
    Capabilities, ImagePart, Message, ModelProvider, ProviderError, ProviderErrorKind,
    ProviderState, ProviderStream, StopReason, ToolInvocation, ToolSpec, TurnEvent, TurnRequest,
};
use async_trait::async_trait;
use reqwest::header::{HeaderMap, HeaderValue, CONTENT_TYPE};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;
use zaalis_core::{ProviderId, Usage};

#[derive(Debug, Clone)]
pub struct GeminiConfig {
    pub base_url: String,
    pub api_key: String,
    pub default_model: String,
    pub capabilities: Capabilities,
}

impl GeminiConfig {
    pub fn new(api_key: impl Into<String>) -> Self {
        Self {
            base_url: "https://generativelanguage.googleapis.com/v1beta".to_owned(),
            api_key: api_key.into(),
            default_model: "gemini-3.5-flash".to_owned(),
            capabilities: Capabilities {
                reasoning: true,
                streamed_reasoning: true,
                vision: true,
                max_context: 1_048_576,
                max_concurrency: 4,
                ..Capabilities::default()
            },
        }
    }

    pub fn with_base_url(mut self, base_url: impl Into<String>) -> Self {
        self.base_url = base_url.into();
        self
    }

    fn endpoint(&self, model: &str) -> String {
        format!(
            "{}/models/{model}:streamGenerateContent?alt=sse",
            self.base_url.trim_end_matches('/')
        )
    }
}

#[derive(Debug, Clone)]
pub struct GeminiProvider {
    client: reqwest::Client,
    config: GeminiConfig,
}

impl GeminiProvider {
    pub fn new(config: GeminiConfig) -> Result<Self, ProviderError> {
        if config.api_key.is_empty() {
            return Err(ProviderError::auth("aucune clé API Google configurée"));
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
            reqwest::header::HeaderName::from_static("x-goog-api-key"),
            HeaderValue::from_str(&self.config.api_key)
                .map_err(|_| ProviderError::auth("clé Google invalide"))?,
        );
        Ok(headers)
    }
}

#[async_trait]
impl ModelProvider for GeminiProvider {
    fn id(&self) -> ProviderId {
        ProviderId::Gemini
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
        if request.binding.provider != ProviderId::Gemini {
            return Err(ProviderError::invalid("binding envoyé au mauvais provider"));
        }
        let model = request
            .binding
            .model
            .as_deref()
            .unwrap_or(&self.config.default_model);
        if !model
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        {
            return Err(ProviderError::invalid(
                "identifiant de modèle Gemini invalide",
            ));
        }
        let response = transport::send(
            self.client
                .post(self.config.endpoint(model))
                .headers(self.headers()?)
                .json(&build_request(&self.config, &request)),
            &cancel,
            false,
        )
        .await?;
        Ok(transport::stream_response(
            response,
            cancel,
            GeminiParser::default(),
        ))
    }
}

pub fn build_request(_config: &GeminiConfig, request: &TurnRequest) -> Value {
    let mut body = json!({ "contents": encode_messages(&request.messages) });
    if !request.system.trim().is_empty() {
        body["systemInstruction"] = json!({ "parts": [{ "text": request.system }] });
    }
    if !request.tools.is_empty() {
        body["tools"] = json!([{
            "functionDeclarations": request.tools.iter().map(encode_tool).collect::<Vec<_>>()
        }]);
        body["toolConfig"] = json!({ "functionCallingConfig": { "mode": "AUTO" } });
    }
    let mut generation = serde_json::Map::new();
    if let Some(max) = request.max_output_tokens {
        generation.insert("maxOutputTokens".to_owned(), json!(max));
    }
    if let Some(temperature) = request.temperature {
        generation.insert("temperature".to_owned(), json!(temperature));
    }
    if !request.reasoning.is_off() {
        let budgets = [0, 1_024, 2_048, 4_096, 8_192];
        generation.insert(
            "thinkingConfig".to_owned(),
            json!({ "thinkingBudget": budgets[usize::from(request.reasoning.0.min(4))] }),
        );
    }
    if !generation.is_empty() {
        body["generationConfig"] = Value::Object(generation);
    }
    body
}

fn encode_tool(tool: &ToolSpec) -> Value {
    json!({ "name": tool.name, "description": tool.description, "parameters": tool.schema })
}

fn encode_messages(messages: &[Message]) -> Vec<Value> {
    let mut encoded = Vec::new();
    for message in messages {
        match message {
            Message::User { text, images } => {
                let mut parts = vec![json!({ "text": text })];
                parts.extend(images.iter().map(encode_image));
                encoded.push(json!({ "role": "user", "parts": parts }));
            }
            Message::Assistant {
                provider_state: Some(state),
                ..
            } if state.provider == ProviderId::Gemini => encoded.push(state.value.clone()),
            Message::Assistant {
                text, tool_calls, ..
            } => {
                let mut parts = Vec::new();
                if !text.is_empty() {
                    parts.push(json!({ "text": text }));
                }
                parts.extend(tool_calls.iter().map(
                    |call| json!({ "functionCall": { "name": call.name, "args": call.arguments } }),
                ));
                encoded.push(json!({ "role": "model", "parts": parts }));
            }
            Message::Tool {
                name,
                content,
                is_error,
                ..
            } => {
                let result = serde_json::from_str::<Value>(content)
                    .unwrap_or_else(|_| Value::String(content.clone()));
                let part = json!({
                    "functionResponse": {
                        "name": name,
                        "response": { "result": result, "isError": is_error }
                    }
                });
                if let Some(Value::Object(last)) = encoded.last_mut() {
                    if last.get("role").and_then(Value::as_str) == Some("user") {
                        if let Some(parts) = last.get_mut("parts").and_then(Value::as_array_mut) {
                            if parts
                                .iter()
                                .all(|part| part.get("functionResponse").is_some())
                            {
                                parts.push(part);
                                continue;
                            }
                        }
                    }
                }
                encoded.push(json!({ "role": "user", "parts": [part] }));
            }
        }
    }
    encoded
}

fn encode_image(image: &ImagePart) -> Value {
    json!({ "inlineData": { "mimeType": image.mime, "data": image.data } })
}

#[derive(Debug, Default)]
struct GeminiParser {
    decoder: SseDecoder,
    parts: Vec<Value>,
    calls: Vec<ToolInvocation>,
    usage: Usage,
    finish_reason: Option<String>,
    failed: bool,
}

impl GeminiParser {
    fn handle(&mut self, value: &Value, events: &mut Vec<TurnEvent>) {
        if let Some(error) = value.get("error") {
            self.failed = true;
            events.push(TurnEvent::Failed {
                error: ProviderError::new(
                    ProviderErrorKind::Transient,
                    error
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("erreur Gemini"),
                ),
            });
            return;
        }
        if let Some(usage) = value.get("usageMetadata") {
            self.usage.input_tokens = number(usage, "promptTokenCount");
            self.usage.output_tokens = number(usage, "candidatesTokenCount");
            self.usage.cached_tokens = number(usage, "cachedContentTokenCount");
            self.usage.reasoning_tokens = number(usage, "thoughtsTokenCount");
        }
        let Some(candidate) = value.pointer("/candidates/0") else {
            return;
        };
        if let Some(reason) = candidate.get("finishReason").and_then(Value::as_str) {
            self.finish_reason = Some(reason.to_owned());
        }
        let Some(parts) = candidate
            .pointer("/content/parts")
            .and_then(Value::as_array)
        else {
            return;
        };
        for part in parts {
            self.parts.push(part.clone());
            if let Some(text) = part
                .get("text")
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
            {
                if part
                    .get("thought")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    events.push(TurnEvent::ReasoningDelta {
                        text: text.to_owned(),
                    });
                } else {
                    events.push(TurnEvent::TextDelta {
                        text: text.to_owned(),
                    });
                }
            }
            if let Some(function) = part.get("functionCall") {
                let name = function
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if name.is_empty() {
                    continue;
                }
                let id = format!("gemini_call_{}", self.calls.len());
                let arguments = function.get("args").cloned().unwrap_or_else(|| json!({}));
                events.push(TurnEvent::ToolCallStarted {
                    id: id.clone(),
                    name: name.to_owned(),
                });
                events.push(TurnEvent::ToolCallDelta {
                    id: id.clone(),
                    arguments: arguments.to_string(),
                });
                self.calls.push(ToolInvocation {
                    id,
                    name: name.to_owned(),
                    arguments,
                });
            }
        }
    }

    fn complete(self) -> Vec<TurnEvent> {
        let mut events = self
            .calls
            .iter()
            .cloned()
            .map(|call| TurnEvent::ToolCallCompleted { call })
            .collect::<Vec<_>>();
        if self.usage.input_tokens > 0 || self.usage.output_tokens > 0 {
            events.push(TurnEvent::Usage { usage: self.usage });
        }
        events.push(TurnEvent::AssistantState {
            state: ProviderState {
                provider: ProviderId::Gemini,
                value: json!({ "role": "model", "parts": self.parts }),
            },
        });
        if !self.failed {
            events.push(TurnEvent::Completed {
                reason: match self.finish_reason.as_deref() {
                    Some("MAX_TOKENS") => StopReason::MaxTokens,
                    _ if !self.calls.is_empty() => StopReason::ToolUse,
                    _ => StopReason::EndTurn,
                },
            });
        }
        events
    }
}

impl WireParser for GeminiParser {
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

fn number(value: &Value, field: &str) -> u64 {
    value.get(field).and_then(Value::as_u64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use zaalis_core::{ModelBinding, ReasoningLevel};

    fn request() -> TurnRequest {
        TurnRequest::new(
            ModelBinding::new(ProviderId::Gemini, Some("gemini-3.5-flash".into())),
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
    fn request_uses_generate_content_native_tools_and_thinking() {
        let mut request = request();
        request.reasoning = ReasoningLevel(3);
        let body = build_request(&GeminiConfig::new("key"), &request);
        assert_eq!(body["tools"][0]["functionDeclarations"][0]["name"], "read");
        assert_eq!(
            body["generationConfig"]["thinkingConfig"]["thinkingBudget"],
            4_096
        );
        assert_eq!(body["systemInstruction"]["parts"][0]["text"], "système");
    }

    #[test]
    fn a_saved_model_state_is_replayed_with_its_thought_signature() {
        let mut request = request();
        request.messages.push(Message::Assistant {
            text: String::new(),
            reasoning: None,
            tool_calls: Vec::new(),
            provider_state: Some(ProviderState {
                provider: ProviderId::Gemini,
                value: json!({"role":"model","parts":[{"functionCall":{"name":"read","args":{}},"thoughtSignature":"sig"}]}),
            }),
        });
        let body = build_request(&GeminiConfig::new("key"), &request);
        assert_eq!(body["contents"][1]["parts"][0]["thoughtSignature"], "sig");
    }

    #[test]
    fn stream_emits_reasoning_tool_usage_and_preserves_signature() {
        let fixture = concat!(
            "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"analyse\",\"thought\":true}]}}]}\n\n",
            "data: {\"candidates\":[{\"content\":{\"parts\":[{\"functionCall\":{\"name\":\"read\",\"args\":{\"path\":\"a.rs\"}},\"thoughtSignature\":\"sig\"}]},\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"promptTokenCount\":5,\"candidatesTokenCount\":8,\"thoughtsTokenCount\":2}}\n\n"
        );
        let mut parser = GeminiParser::default();
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
        assert_eq!(state.value["parts"][1]["thoughtSignature"], "sig");
        assert!(matches!(
            events.last(),
            Some(TurnEvent::Completed {
                reason: StopReason::ToolUse
            })
        ));
    }
}
