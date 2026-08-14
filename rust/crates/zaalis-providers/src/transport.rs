//! HTTP and stream plumbing shared by every wire-format adapter.

use crate::{ProviderError, ProviderErrorKind, ProviderStream, StopReason, TurnEvent};
use async_stream::stream;
use futures_util::StreamExt;
use reqwest::header::RETRY_AFTER;
use serde_json::Value;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

pub(crate) trait WireParser: Send + 'static {
    fn push_bytes(&mut self, chunk: &[u8]) -> Vec<TurnEvent>;
    fn finish(self) -> Vec<TurnEvent>;
}

pub(crate) fn client() -> Result<reqwest::Client, ProviderError> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| ProviderError::transient(error.to_string()))
}

pub(crate) async fn send(
    request: reqwest::RequestBuilder,
    cancel: &CancellationToken,
    local: bool,
) -> Result<reqwest::Response, ProviderError> {
    let response = tokio::select! {
        _ = cancel.cancelled() => {
            return Err(ProviderError::new(ProviderErrorKind::Cancelled, "requête annulée"));
        }
        response = request.send() => response.map_err(|error| classify_transport(error, local))?,
    };
    if response.status().is_success() {
        Ok(response)
    } else {
        Err(classify_response(response).await)
    }
}

pub(crate) fn stream_response<P>(
    response: reqwest::Response,
    cancel: CancellationToken,
    mut parser: P,
) -> ProviderStream
where
    P: WireParser,
{
    let mut bytes = response.bytes_stream();
    let output = stream! {
        loop {
            let next = tokio::select! {
                _ = cancel.cancelled() => {
                    yield TurnEvent::Completed { reason: StopReason::Cancelled };
                    return;
                }
                next = bytes.next() => next,
            };
            match next {
                Some(Ok(chunk)) => {
                    for event in parser.push_bytes(&chunk) {
                        let terminal = matches!(event, TurnEvent::Failed { .. });
                        yield event;
                        if terminal {
                            return;
                        }
                    }
                }
                Some(Err(error)) => {
                    yield TurnEvent::Failed { error: classify_transport(error, false) };
                    return;
                }
                None => break,
            }
        }
        for event in parser.finish() {
            yield event;
        }
    };
    Box::pin(output)
}

fn classify_transport(error: reqwest::Error, local: bool) -> ProviderError {
    let kind = if error.is_timeout() {
        ProviderErrorKind::Timeout
    } else if local && (error.is_connect() || error.is_request()) {
        ProviderErrorKind::Unavailable
    } else {
        ProviderErrorKind::Transient
    };
    ProviderError::new(kind, error.to_string())
}

async fn classify_response(response: reqwest::Response) -> ProviderError {
    let status = response.status();
    let retry_after_ms = response
        .headers()
        .get(RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .map(|seconds| seconds.saturating_mul(1_000));
    let body = response.text().await.unwrap_or_default();
    let parsed = serde_json::from_str::<Value>(&body).ok();
    let message = parsed
        .as_ref()
        .and_then(|value| value.get("error"))
        .and_then(|error| error.get("message").or(Some(error)))
        .and_then(Value::as_str)
        .unwrap_or(body.as_str());
    let message = if message.is_empty() {
        format!("HTTP {}", status.as_u16())
    } else {
        message.chars().take(4_096).collect()
    };
    match status.as_u16() {
        401 | 403 => ProviderError::auth(message),
        404 => ProviderError::new(ProviderErrorKind::ModelUnavailable, message),
        408 => ProviderError::new(ProviderErrorKind::Timeout, message),
        429 => ProviderError::rate_limited(message, retry_after_ms),
        500..=599 => ProviderError::transient(message),
        _ => ProviderError::invalid(message),
    }
}
