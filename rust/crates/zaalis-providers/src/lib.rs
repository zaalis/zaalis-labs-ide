//! Provider-neutral model access for the zaalis agent runtime.
//!
//! Provider adapters translate their wire format into [`TurnEvent`]. The agent
//! loop therefore handles text, reasoning, tool calls, usage and cancellation
//! without knowing which vendor produced them.

mod anthropic;
mod gemini;
mod openai;
mod pool;
mod sse;
mod transport;
mod types;

pub use anthropic::{build_request as build_anthropic_request, AnthropicConfig, AnthropicProvider};
pub use gemini::{build_request as build_gemini_request, GeminiConfig, GeminiProvider};
pub use openai::{build_request as build_openai_request, parse_complete as parse_openai_complete};
pub use openai::{AuthScheme, OpenAiConfig, OpenAiProvider, StreamParser as OpenAiStreamParser};
pub use pool::{PoolConfig, ProviderPool, ProviderStats};
pub use sse::{SseDecoder, DONE};
pub use types::{
    Capabilities, ImagePart, Message, ModelProvider, ProviderError, ProviderErrorKind,
    ProviderState, ProviderStream, StopReason, ToolInvocation, ToolSpec, TurnEvent, TurnRequest,
};
