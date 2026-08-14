//! The OpenAI chat-completions dialect.
//!
//! One adapter covers six of the eight providers zaalis supports — OpenAI,
//! Mistral, Moonshot, xAI, Ollama and llama.cpp — because they all speak this
//! wire format. Only the base URL, the auth header and the reasoning knob
//! differ, and those are configuration rather than code.

use crate::sse::{SseDecoder, DONE};
use crate::transport::{self, WireParser};
use crate::types::{
    Capabilities, ImagePart, Message, ModelProvider, ProviderError, ProviderErrorKind,
    ProviderState, ProviderStream, StopReason, ToolCallAccumulator, ToolInvocation, ToolSpec,
    TurnEvent, TurnRequest,
};
use async_trait::async_trait;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde_json::{json, Map, Value};
use std::collections::BTreeSet;
use tokio_util::sync::CancellationToken;
use zaalis_core::{ProviderId, ReasoningLevel, Usage};

/// How the API key travels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthScheme {
    Bearer,
    /// Anthropic's `x-api-key`, kept here so the same builder serves both.
    XApiKey,
}

/// How a provider expects the reasoning slider to be expressed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReasoningStyle {
    /// Not supported; the field is omitted.
    None,
    /// `reasoning_effort: "low" | "medium" | "high"`.
    Effort,
}

/// Endpoint configuration for one OpenAI-compatible provider.
#[derive(Debug, Clone)]
pub struct OpenAiConfig {
    pub provider: ProviderId,
    pub base_url: String,
    pub api_key: Option<String>,
    pub auth: AuthScheme,
    pub default_model: String,
    pub reasoning: ReasoningStyle,
    pub capabilities: Capabilities,
}

impl OpenAiConfig {
    /// Defaults for each provider that speaks this dialect.
    ///
    /// The base URLs match what `server.js` already calls, so the Rust path is a
    /// drop-in for the existing `/api/chat` behaviour.
    pub fn for_provider(provider: ProviderId, api_key: Option<String>) -> Option<Self> {
        let (base_url, default_model, reasoning, capabilities) = match provider {
            ProviderId::Codex => (
                "https://api.openai.com/v1",
                "gpt-5.6-sol",
                ReasoningStyle::Effort,
                Capabilities {
                    reasoning: true,
                    vision: true,
                    max_context: 400_000,
                    max_concurrency: 6,
                    ..Capabilities::default()
                },
            ),
            ProviderId::Mistral => (
                "https://api.mistral.ai/v1",
                "mistral-medium-3-5",
                ReasoningStyle::None,
                Capabilities {
                    reasoning: true,
                    streamed_reasoning: true,
                    vision: false,
                    max_context: 128_000,
                    max_concurrency: 4,
                    ..Capabilities::default()
                },
            ),
            ProviderId::Kimi => (
                "https://api.moonshot.ai/v1",
                "kimi-k3",
                ReasoningStyle::None,
                Capabilities {
                    reasoning: true,
                    max_context: 256_000,
                    max_concurrency: 4,
                    ..Capabilities::default()
                },
            ),
            ProviderId::Grok => (
                "https://api.x.ai/v1",
                "grok-4.5",
                // The grok-4.x models reason natively and reject
                // `reasoning_effort` outright, so it is never sent.
                ReasoningStyle::None,
                Capabilities {
                    reasoning: true,
                    vision: true,
                    max_context: 256_000,
                    max_concurrency: 4,
                    ..Capabilities::default()
                },
            ),
            ProviderId::Local => (
                // Ollama's OpenAI-compatible surface. Using it instead of
                // `/api/chat` is what gives local models native tool calling.
                "http://127.0.0.1:11434/v1",
                "llama3",
                ReasoningStyle::None,
                Capabilities {
                    native_tools: true,
                    parallel_tool_calls: false,
                    max_context: 32_768,
                    // One model in memory: extra concurrent requests queue at
                    // best and force a reload at worst.
                    max_concurrency: 1,
                    ..Capabilities::default()
                },
            ),
            ProviderId::Gguf => (
                "http://127.0.0.1:8091/v1",
                "local",
                ReasoningStyle::None,
                Capabilities {
                    native_tools: false,
                    parallel_tool_calls: false,
                    max_context: 32_768,
                    max_concurrency: 1,
                    ..Capabilities::default()
                },
            ),
            // These two have their own dialects.
            ProviderId::Claude | ProviderId::Gemini => return None,
        };

        Some(Self {
            provider,
            base_url: base_url.to_owned(),
            api_key,
            auth: AuthScheme::Bearer,
            default_model: default_model.to_owned(),
            reasoning,
            capabilities,
        })
    }

    /// Point at a different endpoint (self-hosted gateway, proxy, custom port).
    pub fn with_base_url(mut self, base_url: impl Into<String>) -> Self {
        self.base_url = base_url.into();
        self
    }

    pub fn endpoint(&self) -> String {
        format!("{}/chat/completions", self.base_url.trim_end_matches('/'))
    }

    /// Whether a local engine needs no key at all.
    pub fn needs_key(&self) -> bool {
        !self.provider.is_local()
    }
}

/// HTTP implementation for every OpenAI-compatible endpoint.
#[derive(Debug, Clone)]
pub struct OpenAiProvider {
    client: reqwest::Client,
    config: OpenAiConfig,
}

impl OpenAiProvider {
    pub fn new(config: OpenAiConfig) -> Result<Self, ProviderError> {
        let client = transport::client()?;
        Ok(Self { client, config })
    }

    pub fn config(&self) -> &OpenAiConfig {
        &self.config
    }

    fn headers(&self) -> Result<HeaderMap, ProviderError> {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        if self.config.needs_key() && self.config.api_key.as_deref().is_none_or(str::is_empty) {
            return Err(ProviderError::auth(format!(
                "aucune clé API configurée pour {}",
                self.config.provider.vendor()
            )));
        }
        if let Some(key) = self.config.api_key.as_deref().filter(|key| !key.is_empty()) {
            let (name, value) = match self.config.auth {
                AuthScheme::Bearer => (
                    AUTHORIZATION,
                    HeaderValue::from_str(&format!("Bearer {key}")),
                ),
                AuthScheme::XApiKey => (
                    reqwest::header::HeaderName::from_static("x-api-key"),
                    HeaderValue::from_str(key),
                ),
            };
            headers.insert(
                name,
                value.map_err(|_| ProviderError::auth("clé API invalide"))?,
            );
        }
        Ok(headers)
    }
}

#[async_trait]
impl ModelProvider for OpenAiProvider {
    fn id(&self) -> ProviderId {
        self.config.provider
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
        if request.binding.provider != self.config.provider {
            return Err(ProviderError::invalid(format!(
                "binding {} envoyé au provider {}",
                request.binding.provider, self.config.provider
            )));
        }
        let response = transport::send(
            self.client
                .post(self.config.endpoint())
                .headers(self.headers()?)
                .json(&build_request(&self.config, &request, true)),
            &cancel,
            self.config.provider.is_local(),
        )
        .await?;
        Ok(transport::stream_response(
            response,
            cancel,
            StreamParser::for_provider(self.config.provider),
        ))
    }
}

/// Build the request body.
pub fn build_request(config: &OpenAiConfig, request: &TurnRequest, stream: bool) -> Value {
    let model = request
        .binding
        .model
        .clone()
        .unwrap_or_else(|| config.default_model.clone());

    let mut messages = Vec::new();
    if !request.system.trim().is_empty() {
        messages.push(json!({ "role": "system", "content": request.system }));
    }
    // A provider without native tool calling (GGUF/llama.cpp) is given the tools
    // as a strict JSON protocol instead. The instructions and the parser in
    // `finish` are two halves of the same contract.
    let fallback_tools = !request.tools.is_empty() && !config.capabilities.native_tools;
    if fallback_tools {
        messages.push(json!({
            "role": "system",
            "content": fallback_tool_instructions(&request.tools),
        }));
    }
    for message in &request.messages {
        messages.push(encode_message(
            message,
            config.provider,
            config.capabilities.vision,
        ));
    }

    let mut body = json!({
        "model": model,
        "messages": messages,
        "stream": stream,
    });

    if !request.tools.is_empty() && config.capabilities.native_tools {
        body["tools"] = Value::Array(
            request
                .tools
                .iter()
                .map(|tool| encode_tool(config.provider, tool))
                .collect(),
        );
        body["tool_choice"] = json!("auto");
    }
    if let Some(max) = request.max_output_tokens {
        body["max_tokens"] = json!(max);
    }
    if let Some(temperature) = request.temperature {
        body["temperature"] = json!(temperature);
    }
    if config.reasoning == ReasoningStyle::Effort {
        if let Some(effort) = effort_label(request.reasoning) {
            body["reasoning_effort"] = json!(effort);
        }
    }
    // Ask for usage on the final streamed chunk; providers that ignore the
    // option simply omit it, which the parser already tolerates.
    if stream {
        body["stream_options"] = json!({ "include_usage": true });
    }
    body
}

fn effort_label(level: ReasoningLevel) -> Option<&'static str> {
    match level.0 {
        0 => None,
        1 => Some("low"),
        2 => Some("medium"),
        _ => Some("high"),
    }
}

fn encode_tool(provider: ProviderId, tool: &ToolSpec) -> Value {
    // Moonshot validates a strict JSON Schema subset for every nested node of
    // function parameters. Keep the canonical schema provider-neutral, then
    // project it only on the Kimi wire path so no tool behaviour or other
    // provider is affected.
    let parameters = if provider == ProviderId::Kimi {
        normalise_moonshot_schema(&tool.schema)
    } else {
        tool.schema.clone()
    };
    json!({
        "type": "function",
        "function": {
            "name": tool.name,
            "description": tool.description,
            "parameters": parameters,
        }
    })
}

fn normalise_moonshot_schema(schema: &Value) -> Value {
    let Value::Object(original) = schema else {
        return schema.clone();
    };
    let mut normalised = original.clone();

    for key in ["properties", "$defs", "definitions"] {
        if let Some(Value::Object(children)) = original.get(key) {
            normalised.insert(
                key.into(),
                Value::Object(
                    children
                        .iter()
                        .map(|(name, child)| (name.clone(), normalise_moonshot_schema(child)))
                        .collect(),
                ),
            );
        }
    }
    for key in ["items", "additionalProperties", "not"] {
        if let Some(child) = original.get(key) {
            normalised.insert(key.into(), normalise_moonshot_schema(child));
        }
    }
    for key in ["oneOf", "anyOf", "allOf"] {
        if let Some(Value::Array(children)) = original.get(key) {
            normalised.insert(
                key.into(),
                Value::Array(children.iter().map(normalise_moonshot_schema).collect()),
            );
        }
    }

    if normalised.get("type").is_none() {
        if let Some(kind) = inferred_moonshot_type(&normalised) {
            normalised.insert("type".into(), Value::String(kind.into()));
        }
    }
    if normalised.get("type").and_then(Value::as_str) == Some("object")
        && !normalised.contains_key("required")
    {
        // An omitted `required` means the same thing as an empty array in JSON
        // Schema, but Moonshot's validator requires it to be explicit.
        normalised.insert("required".into(), Value::Array(Vec::new()));
    }
    Value::Object(normalised)
}

fn inferred_moonshot_type(schema: &Map<String, Value>) -> Option<&'static str> {
    if let Some(value) = schema.get("const") {
        return value_type(value);
    }
    if let Some(Value::Array(values)) = schema.get("enum") {
        let mut types = BTreeSet::new();
        for value in values {
            types.insert(value_type(value)?);
        }
        if types.len() == 1 {
            return types.into_iter().next();
        }
    }
    if schema.contains_key("properties")
        || schema.contains_key("required")
        || schema.contains_key("additionalProperties")
    {
        return Some("object");
    }
    if schema.contains_key("items") {
        return Some("array");
    }
    let variants = ["oneOf", "anyOf", "allOf"]
        .into_iter()
        .find_map(|key| schema.get(key).and_then(Value::as_array))?;
    (!variants.is_empty()
        && variants
            .iter()
            .all(|variant| variant.get("type").and_then(Value::as_str) == Some("object")))
    .then_some("object")
}

fn value_type(value: &Value) -> Option<&'static str> {
    match value {
        Value::String(_) => Some("string"),
        Value::Bool(_) => Some("boolean"),
        Value::Array(_) => Some("array"),
        Value::Object(_) => Some("object"),
        Value::Number(number) if number.is_i64() || number.is_u64() => Some("integer"),
        Value::Number(_) => Some("number"),
        Value::Null => None,
    }
}

/// The strict-JSON tool protocol handed to a model that has no native tool
/// calling. Its shape is exactly what [`parse_fallback_tool_call`] accepts.
fn fallback_tool_instructions(tools: &[ToolSpec]) -> String {
    let mut out = String::from(
        "Tu ne disposes pas d'appels d'outils natifs. Pour APPELER un outil, réponds STRICTEMENT et UNIQUEMENT par un objet JSON, sans aucun texte autour :\n\
        {\"tool_call\":{\"name\":\"<nom>\",\"arguments\":{ ... }}}\n\
        Les arguments doivent respecter le schéma de l'outil ci-dessous. Toute sortie non conforme est rejetée sans être exécutée. Si aucun outil n'est nécessaire, réponds normalement en texte (aucun JSON).\n\nOutils disponibles :\n",
    );
    for tool in tools {
        out.push_str(&format!(
            "- {} : {}\n  schéma des arguments : {}\n",
            tool.name, tool.description, tool.schema
        ));
    }
    out
}

/// Extract a tool call from a fallback model's answer, strictly.
///
/// The whole answer (optionally inside one ```code fence) must be the envelope
/// `{"tool_call":{"name":…,"arguments":{…}}}`. Anything else — extra prose, a
/// missing name, a non-object `arguments`, malformed JSON — returns `None`, so
/// the runtime never executes on an ambiguous output. Argument *validity* is
/// then enforced by the tool itself when it deserialises them.
fn parse_fallback_tool_call(text: &str) -> Option<ToolInvocation> {
    let mut trimmed = text.trim();
    if let Some(rest) = trimmed
        .strip_prefix("```json")
        .or_else(|| trimmed.strip_prefix("```"))
    {
        trimmed = rest.trim_start();
    }
    if let Some(rest) = trimmed.strip_suffix("```") {
        trimmed = rest.trim_end();
    }
    let value: Value = serde_json::from_str(trimmed.trim()).ok()?;
    let call = value.get("tool_call")?;
    let name = call.get("name").and_then(Value::as_str)?.trim().to_owned();
    if name.is_empty() {
        return None;
    }
    let arguments = call.get("arguments").cloned().unwrap_or_else(|| json!({}));
    if !arguments.is_object() {
        return None;
    }
    Some(ToolInvocation {
        id: format!("gguf_{name}"),
        name,
        arguments,
    })
}

fn encode_message(message: &Message, provider: ProviderId, vision: bool) -> Value {
    match message {
        Message::User { text, images } if images.is_empty() || !vision => {
            json!({ "role": "user", "content": text })
        }
        Message::User { text, images } => {
            let mut parts = vec![json!({ "type": "text", "text": text })];
            parts.extend(images.iter().map(encode_image));
            json!({ "role": "user", "content": parts })
        }
        Message::Assistant {
            provider_state: Some(state),
            ..
        } if state.provider == provider => state.value.clone(),
        Message::Assistant {
            text, tool_calls, ..
        } => {
            let mut value = json!({ "role": "assistant", "content": text });
            // Native `tool_calls` are only understood where native tools are on.
            // Under the GGUF fallback the call already lives in `text` as the
            // JSON envelope, so no native array is attached.
            if !tool_calls.is_empty() && provider != ProviderId::Gguf {
                value["tool_calls"] = Value::Array(
                    tool_calls
                        .iter()
                        .map(|call| {
                            json!({
                                "id": call.id,
                                "type": "function",
                                "function": {
                                    "name": call.name,
                                    "arguments": call.arguments.to_string(),
                                }
                            })
                        })
                        .collect(),
                );
            }
            value
        }
        // A model without native tools cannot read a `role:"tool"` message, so
        // the result is handed back as ordinary user text instead.
        Message::Tool {
            call_id,
            name,
            content,
            ..
        } => {
            if provider == ProviderId::Gguf {
                json!({
                    "role": "user",
                    "content": format!("[Résultat de l'outil {name}]\n{content}"),
                })
            } else {
                json!({
                    "role": "tool",
                    "tool_call_id": call_id,
                    "content": content,
                })
            }
        }
    }
}

fn encode_image(image: &ImagePart) -> Value {
    json!({
        "type": "image_url",
        "image_url": { "url": format!("data:{};base64,{}", image.mime, image.data) }
    })
}

/// Incremental parser for one streamed response.
#[derive(Debug, Default)]
pub struct StreamParser {
    decoder: SseDecoder,
    calls: ToolCallAccumulator,
    finish_reason: Option<String>,
    started_calls: BTreeSet<usize>,
    usage: Option<Usage>,
    done: bool,
    failed: bool,
    provider: Option<ProviderId>,
    text: String,
    reasoning: String,
    content_parts: Vec<Value>,
}

impl StreamParser {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn for_provider(provider: ProviderId) -> Self {
        Self {
            provider: Some(provider),
            ..Self::default()
        }
    }

    /// Feed raw bytes, returning the events they produced.
    pub fn push(&mut self, chunk: &str) -> Vec<TurnEvent> {
        self.push_bytes(chunk.as_bytes())
    }

    /// Feed an arbitrary network chunk without assuming UTF-8 boundaries.
    pub fn push_bytes(&mut self, chunk: &[u8]) -> Vec<TurnEvent> {
        let mut events = Vec::new();
        for payload in self.decoder.push_bytes(chunk) {
            if payload == DONE {
                self.done = true;
                continue;
            }
            match serde_json::from_str::<Value>(&payload) {
                Ok(value) => self.handle(&value, &mut events),
                // A malformed chunk in the middle of a stream is not worth
                // aborting a turn over; the next one usually parses.
                Err(_) => continue,
            }
        }
        events
    }

    fn handle(&mut self, value: &Value, events: &mut Vec<TurnEvent>) {
        if let Some(error) = value.get("error") {
            self.failed = true;
            events.push(TurnEvent::Failed {
                error: ProviderError::new(
                    ProviderErrorKind::Transient,
                    error
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("erreur du fournisseur")
                        .to_owned(),
                ),
            });
            return;
        }

        if let Some(usage) = value.get("usage").filter(|usage| !usage.is_null()) {
            self.usage = Some(parse_usage(usage));
        }

        let Some(choice) = value.get("choices").and_then(|c| c.get(0)) else {
            return;
        };
        if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
            self.finish_reason = Some(reason.to_owned());
        }

        let delta = choice.get("delta").or_else(|| choice.get("message"));
        let Some(delta) = delta else { return };

        if let Some(content) = delta.get("content") {
            emit_content(content, events);
            collect_content(content, &mut self.text, &mut self.content_parts);
        }
        // Several providers expose reasoning under their own key; accept all the
        // spellings rather than special-casing per vendor.
        for key in ["reasoning_content", "reasoning", "thinking"] {
            if let Some(text) = delta.get(key).and_then(Value::as_str) {
                if !text.is_empty() {
                    events.push(TurnEvent::ReasoningDelta {
                        text: text.to_owned(),
                    });
                    self.reasoning.push_str(text);
                }
            }
        }

        if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
            for (position, call) in calls.iter().enumerate() {
                let index = call
                    .get("index")
                    .and_then(Value::as_u64)
                    .map(|value| value as usize)
                    .unwrap_or(position);
                let id = call.get("id").and_then(Value::as_str);
                let function = call.get("function");
                let name = function.and_then(|f| f.get("name")).and_then(Value::as_str);
                let arguments_value = function.and_then(|f| f.get("arguments"));
                let owned_arguments = arguments_value
                    .filter(|arguments| !arguments.is_string())
                    .map(Value::to_string);
                let arguments = arguments_value
                    .and_then(Value::as_str)
                    .or(owned_arguments.as_deref());

                self.calls.push(index, id, name, arguments);
                if !self.started_calls.contains(&index) {
                    if let Some((id, name)) = self.calls.identity(index) {
                        events.push(TurnEvent::ToolCallStarted {
                            id: id.to_owned(),
                            name: name.to_owned(),
                        });
                        self.started_calls.insert(index);
                    }
                }
                if let Some(arguments) = arguments.filter(|arguments| !arguments.is_empty()) {
                    let id = self
                        .calls
                        .identity(index)
                        .map(|(id, _)| id)
                        .unwrap_or_default();
                    events.push(TurnEvent::ToolCallDelta {
                        id: id.to_owned(),
                        arguments: arguments.to_owned(),
                    });
                }
            }
        }
    }

    /// Close the stream and emit the terminal events.
    pub fn finish(mut self) -> Vec<TurnEvent> {
        let mut events = Vec::new();
        if let Some(payload) = self.decoder.finish() {
            if payload != DONE {
                if let Ok(value) = serde_json::from_str::<Value>(&payload) {
                    self.handle(&value, &mut events);
                }
            }
        }

        let mut calls = self.calls.finish();
        // GGUF fallback: no native tool call arrived, so try to read a strict
        // JSON envelope out of the text. Anything that is not exactly the
        // envelope is left as a normal answer — fail-closed, nothing runs.
        if calls.is_empty() && self.provider == Some(ProviderId::Gguf) {
            if let Some(call) = parse_fallback_tool_call(&self.text) {
                calls.push(call);
            }
        }
        let has_calls = !calls.is_empty();
        for call in &calls {
            events.push(TurnEvent::ToolCallCompleted { call: call.clone() });
        }
        if let Some(usage) = self.usage {
            events.push(TurnEvent::Usage { usage });
        }
        if let Some(provider) = self.provider {
            let content = if self.content_parts.is_empty() {
                Value::String(self.text)
            } else {
                Value::Array(self.content_parts)
            };
            let mut state = json!({ "role": "assistant", "content": content });
            if !self.reasoning.is_empty() {
                state["reasoning_content"] = Value::String(self.reasoning);
            }
            // The GGUF fallback state carries the call in its `content` text, so
            // no native `tool_calls` array is replayed to it.
            if !calls.is_empty() && provider != ProviderId::Gguf {
                state["tool_calls"] = Value::Array(
                    calls
                        .iter()
                        .map(|call| {
                            json!({
                                "id": call.id,
                                "type": "function",
                                "function": {
                                    "name": call.name,
                                    "arguments": call.arguments.to_string(),
                                }
                            })
                        })
                        .collect(),
                );
            }
            events.push(TurnEvent::AssistantState {
                state: ProviderState {
                    provider,
                    value: state,
                },
            });
        }
        if !self.failed {
            events.push(TurnEvent::Completed {
                reason: match self.finish_reason.as_deref() {
                    Some("tool_calls") => StopReason::ToolUse,
                    Some("length") => StopReason::MaxTokens,
                    _ if has_calls => StopReason::ToolUse,
                    _ => StopReason::EndTurn,
                },
            });
        }
        events
    }
}

impl WireParser for StreamParser {
    fn push_bytes(&mut self, chunk: &[u8]) -> Vec<TurnEvent> {
        StreamParser::push_bytes(self, chunk)
    }

    fn finish(self) -> Vec<TurnEvent> {
        StreamParser::finish(self)
    }
}

fn emit_content(content: &Value, events: &mut Vec<TurnEvent>) {
    match content {
        Value::String(text) if !text.is_empty() => {
            events.push(TurnEvent::TextDelta { text: text.clone() });
        }
        Value::Array(parts) => {
            for part in parts {
                let kind = part.get("type").and_then(Value::as_str).unwrap_or_default();
                let text = part
                    .get("text")
                    .or_else(|| part.get("thinking"))
                    .or_else(|| part.get("content"))
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if text.is_empty() {
                    continue;
                }
                if kind.contains("think") || kind.contains("reason") {
                    events.push(TurnEvent::ReasoningDelta {
                        text: text.to_owned(),
                    });
                } else {
                    events.push(TurnEvent::TextDelta {
                        text: text.to_owned(),
                    });
                }
            }
        }
        _ => {}
    }
}

fn collect_content(content: &Value, text: &mut String, content_parts: &mut Vec<Value>) {
    match content {
        Value::String(delta) => text.push_str(delta),
        Value::Array(parts) => content_parts.extend(parts.iter().cloned()),
        _ => {}
    }
}

/// Parse a non-streamed response in one go, for providers or models where
/// streaming is unavailable.
pub fn parse_complete(value: &Value) -> Vec<TurnEvent> {
    let mut parser = StreamParser::new();
    let mut events = Vec::new();
    parser.handle(value, &mut events);
    events.extend(parser.finish());
    events
}

fn parse_usage(value: &Value) -> Usage {
    let number = |key: &str| value.get(key).and_then(Value::as_u64).unwrap_or(0);
    Usage {
        input_tokens: number("prompt_tokens"),
        output_tokens: number("completion_tokens"),
        cached_tokens: value
            .get("prompt_tokens_details")
            .and_then(|details| details.get("cached_tokens"))
            .and_then(Value::as_u64)
            .unwrap_or(0),
        reasoning_tokens: value
            .get("completion_tokens_details")
            .and_then(|details| details.get("reasoning_tokens"))
            .and_then(Value::as_u64)
            .unwrap_or(0),
        ..Usage::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::ToolInvocation;
    use zaalis_core::ModelBinding;

    fn config() -> OpenAiConfig {
        OpenAiConfig::for_provider(ProviderId::Mistral, Some("key".into())).expect("config")
    }

    fn request() -> TurnRequest {
        TurnRequest::new(
            ModelBinding::new(ProviderId::Mistral, Some("mistral-medium-3-5".into())),
            "tu es un agent",
            vec![Message::user("bonjour")],
        )
    }

    #[test]
    fn one_adapter_serves_every_openai_compatible_provider() {
        for provider in [
            ProviderId::Codex,
            ProviderId::Mistral,
            ProviderId::Kimi,
            ProviderId::Grok,
            ProviderId::Local,
            ProviderId::Gguf,
        ] {
            assert!(
                OpenAiConfig::for_provider(provider, None).is_some(),
                "{provider} doit être couvert"
            );
        }
        // The two with their own dialects are handled elsewhere.
        assert!(OpenAiConfig::for_provider(ProviderId::Claude, None).is_none());
        assert!(OpenAiConfig::for_provider(ProviderId::Gemini, None).is_none());
    }

    #[test]
    fn local_engines_declare_serial_concurrency() {
        // The correction that keeps a team of agents on a local model from being
        // slower than running them one at a time.
        for provider in [ProviderId::Local, ProviderId::Gguf] {
            let config = OpenAiConfig::for_provider(provider, None).expect("config");
            assert_eq!(config.capabilities.max_concurrency, 1);
            assert!(!config.needs_key());
        }
        assert!(config().needs_key());
    }

    #[test]
    fn the_request_carries_the_system_prompt_and_messages() {
        let body = build_request(&config(), &request(), true);
        assert_eq!(body["model"], "mistral-medium-3-5");
        assert_eq!(body["stream"], true);
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["messages"][1]["role"], "user");
        assert_eq!(body["messages"][1]["content"], "bonjour");
    }

    #[test]
    fn tools_are_sent_in_the_native_format() {
        let tools = vec![ToolSpec {
            name: "read".into(),
            description: "Lire un fichier".into(),
            schema: json!({"type": "object", "properties": {"path": {"type": "string"}}}),
        }];
        let body = build_request(&config(), &request().with_tools(tools), true);
        assert_eq!(body["tools"][0]["type"], "function");
        assert_eq!(body["tools"][0]["function"]["name"], "read");
        assert_eq!(body["tool_choice"], "auto");
    }

    #[test]
    fn kimi_normalises_strict_nested_function_schemas() {
        let tools = vec![ToolSpec {
            name: "glob".into(),
            description: "Lister".into(),
            schema: json!({
                "type":"object",
                "properties":{"kind":{"enum":["file","dir"]}},
                "oneOf":[{"type":"object","properties":{"action":{"const":"list"}}}]
            }),
        }];
        let kimi =
            OpenAiConfig::for_provider(ProviderId::Kimi, Some("key".into())).expect("config");
        let body = build_request(&kimi, &request().with_tools(tools), true);
        let schema = &body["tools"][0]["function"]["parameters"];

        assert_eq!(schema["properties"]["kind"]["type"], "string");
        assert_eq!(schema["oneOf"][0]["properties"]["action"]["type"], "string");
        assert_eq!(schema["oneOf"][0]["required"], json!([]));
    }

    #[test]
    fn a_provider_without_native_tools_omits_them_entirely() {
        let mut config = OpenAiConfig::for_provider(ProviderId::Gguf, None).expect("config");
        config.capabilities.native_tools = false;
        let tools = vec![ToolSpec {
            name: "read".into(),
            description: String::new(),
            schema: json!({}),
        }];
        let body = build_request(&config, &request().with_tools(tools), true);
        assert!(body.get("tools").is_none());
    }

    #[test]
    fn reasoning_effort_is_only_sent_where_it_is_supported() {
        let mut request = request();
        request.reasoning = ReasoningLevel(3);

        // Mistral has no effort knob.
        assert!(build_request(&config(), &request, true)
            .get("reasoning_effort")
            .is_none());

        let openai = OpenAiConfig::for_provider(ProviderId::Codex, None).expect("config");
        assert_eq!(
            build_request(&openai, &request, true)["reasoning_effort"],
            "high"
        );

        // Grok rejects the parameter outright, so it is never sent.
        let grok = OpenAiConfig::for_provider(ProviderId::Grok, None).expect("config");
        assert!(build_request(&grok, &request, true)
            .get("reasoning_effort")
            .is_none());
    }

    #[test]
    fn reasoning_off_sends_nothing() {
        let openai = OpenAiConfig::for_provider(ProviderId::Codex, None).expect("config");
        let body = build_request(&openai, &request(), true);
        assert!(body.get("reasoning_effort").is_none());
    }

    #[test]
    fn a_tool_result_is_encoded_with_its_call_id() {
        let mut request = request();
        request.messages.push(Message::Assistant {
            text: String::new(),
            reasoning: None,
            tool_calls: vec![ToolInvocation {
                id: "c1".into(),
                name: "read".into(),
                arguments: json!({"path": "a.js"}),
            }],
            provider_state: None,
        });
        request
            .messages
            .push(Message::tool_result("c1", "read", "contenu"));

        let body = build_request(&config(), &request, true);
        let assistant = &body["messages"][2];
        assert_eq!(assistant["tool_calls"][0]["id"], "c1");
        // Arguments travel as a JSON *string*, which is what the dialect wants.
        assert_eq!(
            assistant["tool_calls"][0]["function"]["arguments"],
            r#"{"path":"a.js"}"#
        );
        let tool = &body["messages"][3];
        assert_eq!(tool["role"], "tool");
        assert_eq!(tool["tool_call_id"], "c1");
    }

    #[test]
    fn images_are_dropped_for_providers_without_vision() {
        let mut request = request();
        request.messages = vec![Message::User {
            text: "décris".into(),
            images: vec![ImagePart {
                mime: "image/png".into(),
                data: "AAAA".into(),
            }],
        }];

        let mut vision = config();
        vision.capabilities.vision = true;
        let with_vision = build_request(&vision, &request, true);
        assert!(with_vision["messages"][1]["content"].is_array());

        let mut blind = config();
        blind.capabilities.vision = false;
        let without = build_request(&blind, &request, true);
        assert!(without["messages"][1]["content"].is_string());
    }

    #[test]
    fn a_streamed_answer_becomes_text_deltas() {
        let mut parser = StreamParser::new();
        let mut events = parser.push(
            "data: {\"choices\":[{\"delta\":{\"content\":\"bon\"}}]}\n\n\
             data: {\"choices\":[{\"delta\":{\"content\":\"jour\"}}]}\n\n",
        );
        events.extend(parser.finish());

        let text: String = events
            .iter()
            .filter_map(|event| match event {
                TurnEvent::TextDelta { text } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(text, "bonjour");
        assert!(matches!(
            events.last(),
            Some(TurnEvent::Completed {
                reason: StopReason::EndTurn
            })
        ));
    }

    #[test]
    fn a_streamed_tool_call_is_reassembled() {
        let mut parser = StreamParser::new();
        let mut events = parser.push(
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c1\",\"function\":{\"name\":\"read\",\"arguments\":\"\"}}]}}]}\n\n\
             data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"path\\\":\"}}]}}]}\n\n\
             data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"a.js\\\"}\"}}]}}],\"finish_reason\":\"tool_calls\"}\n\n\
             data: [DONE]\n\n",
        );
        events.extend(parser.finish());

        let completed: Vec<_> = events
            .iter()
            .filter_map(|event| match event {
                TurnEvent::ToolCallCompleted { call } => Some(call),
                _ => None,
            })
            .collect();
        assert_eq!(completed.len(), 1);
        assert_eq!(completed[0].name, "read");
        assert_eq!(completed[0].arguments["path"], "a.js");
        assert!(matches!(
            events.last(),
            Some(TurnEvent::Completed {
                reason: StopReason::ToolUse
            })
        ));
    }

    #[test]
    fn two_parallel_tool_calls_stay_separate() {
        let mut parser = StreamParser::new();
        let mut events = parser.push(
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[\
             {\"index\":0,\"id\":\"a\",\"function\":{\"name\":\"read\",\"arguments\":\"{}\"}},\
             {\"index\":1,\"id\":\"b\",\"function\":{\"name\":\"grep\",\"arguments\":\"{}\"}}]}}]}\n\n",
        );
        events.extend(parser.finish());

        let names: Vec<_> = events
            .iter()
            .filter_map(|event| match event {
                TurnEvent::ToolCallCompleted { call } => Some(call.name.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(names, vec!["read", "grep"]);
    }

    #[test]
    fn reasoning_deltas_are_recognised_under_any_spelling() {
        for key in ["reasoning_content", "reasoning", "thinking"] {
            let mut parser = StreamParser::new();
            let events = parser.push(&format!(
                "data: {{\"choices\":[{{\"delta\":{{\"{key}\":\"je réfléchis\"}}}}]}}\n\n"
            ));
            assert!(
                events
                    .iter()
                    .any(|event| matches!(event, TurnEvent::ReasoningDelta { .. })),
                "« {key} » doit produire un delta de raisonnement"
            );
        }
    }

    #[test]
    fn usage_is_reported_when_the_provider_sends_it() {
        let mut parser = StreamParser::new();
        parser.push(
            "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":120,\"completion_tokens\":45}}\n\n",
        );
        let events = parser.finish();
        let usage = events.iter().find_map(|event| match event {
            TurnEvent::Usage { usage } => Some(*usage),
            _ => None,
        });
        let usage = usage.expect("usage");
        assert_eq!(usage.input_tokens, 120);
        assert_eq!(usage.output_tokens, 45);
    }

    #[test]
    fn a_provider_error_inside_the_stream_becomes_a_failure_event() {
        let mut parser = StreamParser::new();
        let events = parser.push("data: {\"error\":{\"message\":\"quota dépassé\"}}\n\n");
        assert!(matches!(events[0], TurnEvent::Failed { .. }));
    }

    #[test]
    fn a_malformed_chunk_does_not_abort_the_turn() {
        let mut parser = StreamParser::new();
        let mut events = parser.push("data: {not json}\n\n");
        assert!(events.is_empty());
        events.extend(parser.push("data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\n"));
        assert!(matches!(events[0], TurnEvent::TextDelta { .. }));
    }

    #[test]
    fn a_non_streamed_response_produces_the_same_events() {
        // Same vocabulary whether or not the provider streams, so the runtime
        // never needs two code paths.
        let value = json!({
            "choices": [{
                "message": {"content": "réponse complète"},
                "finish_reason": "stop"
            }],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5}
        });
        let events = parse_complete(&value);
        assert!(matches!(events[0], TurnEvent::TextDelta { .. }));
        assert!(events
            .iter()
            .any(|event| matches!(event, TurnEvent::Usage { .. })));
        assert!(matches!(
            events.last(),
            Some(TurnEvent::Completed {
                reason: StopReason::EndTurn
            })
        ));
    }

    #[test]
    fn endpoints_are_built_without_double_slashes() {
        let mut config = config();
        config.base_url = "https://api.mistral.ai/v1/".into();
        assert_eq!(
            config.endpoint(),
            "https://api.mistral.ai/v1/chat/completions"
        );
    }

    #[test]
    fn gguf_receives_tools_as_a_strict_json_protocol_not_natively() {
        let config = OpenAiConfig::for_provider(ProviderId::Gguf, None).expect("config");
        let tools = vec![ToolSpec {
            name: "read".into(),
            description: "Lire un fichier".into(),
            schema: json!({"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}),
        }];
        let request = TurnRequest::new(
            ModelBinding::new(ProviderId::Gguf, Some("local".into())),
            "tu es un agent",
            vec![Message::user("lis a.js")],
        )
        .with_tools(tools);
        let body = build_request(&config, &request, true);
        // No native tools for a provider that cannot call them…
        assert!(body.get("tools").is_none());
        // …the tool travels inside a system message describing the JSON protocol.
        let carries_protocol = body["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|message| message["role"] == "system")
            .any(|message| {
                let content = message["content"].as_str().unwrap_or("");
                content.contains("tool_call") && content.contains("read")
            });
        assert!(carries_protocol, "le protocole JSON doit décrire l'outil");
    }

    #[test]
    fn a_gguf_tool_result_is_replayed_as_user_text() {
        let value = encode_message(
            &Message::tool_result("c1", "read", "contenu"),
            ProviderId::Gguf,
            false,
        );
        assert_eq!(value["role"], "user");
        let content = value["content"].as_str().unwrap();
        assert!(content.contains("read") && content.contains("contenu"));
    }

    #[test]
    fn the_fallback_parser_is_strict_and_fail_closed() {
        // Not JSON, prose around the envelope, empty name, non-object args: all
        // refused, so nothing runs on an ambiguous answer.
        assert!(parse_fallback_tool_call("je vais lire le fichier").is_none());
        assert!(
            parse_fallback_tool_call("Voici : {\"tool_call\":{\"name\":\"read\"}} — fait")
                .is_none()
        );
        assert!(parse_fallback_tool_call("{\"tool_call\":{\"name\":\"\"}}").is_none());
        assert!(
            parse_fallback_tool_call("{\"tool_call\":{\"name\":\"read\",\"arguments\":42}}")
                .is_none()
        );

        let call = parse_fallback_tool_call(
            "{\"tool_call\":{\"name\":\"read\",\"arguments\":{\"path\":\"a.js\"}}}",
        )
        .expect("valid envelope");
        assert_eq!(call.name, "read");
        assert_eq!(call.arguments["path"], "a.js");

        // A single code fence is tolerated; a missing arguments object defaults.
        let fenced = parse_fallback_tool_call("```json\n{\"tool_call\":{\"name\":\"grep\"}}\n```")
            .expect("fenced envelope");
        assert_eq!(fenced.name, "grep");
        assert_eq!(fenced.arguments, json!({}));
    }

    #[test]
    fn a_gguf_stream_emitting_the_envelope_yields_one_tool_call() {
        let envelope = "{\"tool_call\":{\"name\":\"read\",\"arguments\":{\"path\":\"a.js\"}}}";
        let chunk = format!(
            "data: {}\n\n",
            json!({"choices":[{"delta":{"content": envelope}}]})
        );
        let mut parser = StreamParser::for_provider(ProviderId::Gguf);
        parser.push(&chunk);
        let events = parser.finish();
        let call = events
            .iter()
            .find_map(|event| match event {
                TurnEvent::ToolCallCompleted { call } => Some(call),
                _ => None,
            })
            .expect("the envelope must become a tool call");
        assert_eq!(call.name, "read");
        assert_eq!(call.arguments["path"], "a.js");
        assert!(matches!(
            events.last(),
            Some(TurnEvent::Completed {
                reason: StopReason::ToolUse
            })
        ));
    }

    #[test]
    fn ordinary_gguf_text_is_not_mistaken_for_a_tool_call() {
        let chunk = format!(
            "data: {}\n\n",
            json!({"choices":[{"delta":{"content":"Voici la réponse en texte."}}]})
        );
        let mut parser = StreamParser::for_provider(ProviderId::Gguf);
        parser.push(&chunk);
        let events = parser.finish();
        assert!(!events
            .iter()
            .any(|event| matches!(event, TurnEvent::ToolCallCompleted { .. })));
        assert!(matches!(
            events.last(),
            Some(TurnEvent::Completed {
                reason: StopReason::EndTurn
            })
        ));
    }
}
