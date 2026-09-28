//! JSON-RPC 2.0 envelope.
//!
//! The transport is duplex and symmetric: both sides may send requests. That is
//! not decoration — an interactive permission prompt is a question the *core*
//! asks the *client*, and the previous one-way NDJSON stream simply could not
//! express it. The old engine worked around the gap by refusing instead of
//! asking, which is why `supervised` mode never actually prompted anyone.

use serde::{Deserialize, Serialize};
use std::fmt;

/// Request/response correlation id. JSON-RPC allows numbers or strings.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RpcId {
    Number(i64),
    Text(String),
}

impl From<i64> for RpcId {
    fn from(value: i64) -> Self {
        RpcId::Number(value)
    }
}

impl From<String> for RpcId {
    fn from(value: String) -> Self {
        RpcId::Text(value)
    }
}

impl From<&str> for RpcId {
    fn from(value: &str) -> Self {
        RpcId::Text(value.to_owned())
    }
}

impl fmt::Display for RpcId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RpcId::Number(value) => write!(f, "{value}"),
            RpcId::Text(value) => f.write_str(value),
        }
    }
}

/// The literal `"2.0"`, validated on the way in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct JsonRpcVersion;

impl Serialize for JsonRpcVersion {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str("2.0")
    }
}

impl<'de> Deserialize<'de> for JsonRpcVersion {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        if value == "2.0" {
            Ok(JsonRpcVersion)
        } else {
            Err(serde::de::Error::custom(format!(
                "unsupported jsonrpc version: {value}"
            )))
        }
    }
}

/// A call that expects an answer.
///
/// `deny_unknown_fields` is load-bearing, not hygiene: [`RpcMessage`] discriminates
/// the three shapes by which fields are present, and without it a request would
/// also parse as a response (whose `result` and `error` are both optional).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RpcRequest {
    pub jsonrpc: JsonRpcVersion,
    pub id: RpcId,
    pub method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<serde_json::Value>,
}

impl RpcRequest {
    pub fn new(id: impl Into<RpcId>, method: impl Into<String>, params: serde_json::Value) -> Self {
        Self {
            jsonrpc: JsonRpcVersion,
            id: id.into(),
            method: method.into(),
            params: Some(params),
        }
    }
}

/// A one-way message. Every streamed event is one of these.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RpcNotification {
    pub jsonrpc: JsonRpcVersion,
    pub method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<serde_json::Value>,
}

impl RpcNotification {
    pub fn new(method: impl Into<String>, params: serde_json::Value) -> Self {
        Self {
            jsonrpc: JsonRpcVersion,
            method: method.into(),
            params: Some(params),
        }
    }
}

/// An error returned in place of a result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RpcError {
    pub code: i32,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

impl RpcError {
    // The reserved JSON-RPC range.
    pub const PARSE_ERROR: i32 = -32700;
    pub const INVALID_REQUEST: i32 = -32600;
    pub const METHOD_NOT_FOUND: i32 = -32601;
    pub const INVALID_PARAMS: i32 = -32602;
    pub const INTERNAL_ERROR: i32 = -32603;
    /// Application errors live above the reserved range. The precise zaalis
    /// code travels in `data.code` so a client never has to parse prose.
    pub const APPLICATION: i32 = -32000;

    pub fn new(code: i32, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }

    pub fn method_not_found(method: &str) -> Self {
        Self::new(
            Self::METHOD_NOT_FOUND,
            format!("méthode inconnue : {method}"),
        )
    }

    pub fn invalid_params(message: impl Into<String>) -> Self {
        Self::new(Self::INVALID_PARAMS, message)
    }
}

impl From<zaalis_core::ZaalisError> for RpcError {
    fn from(value: zaalis_core::ZaalisError) -> Self {
        let mut data = serde_json::json!({ "code": value.code.as_str() });
        if let Some(detail) = value.detail {
            data["detail"] = detail;
        }
        RpcError {
            code: match value.code {
                zaalis_core::ErrorCode::InvalidRequest => RpcError::INVALID_PARAMS,
                zaalis_core::ErrorCode::Internal => RpcError::INTERNAL_ERROR,
                _ => RpcError::APPLICATION,
            },
            message: value.message,
            data: Some(data),
        }
    }
}

/// The answer to an [`RpcRequest`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RpcResponse {
    pub jsonrpc: JsonRpcVersion,
    pub id: RpcId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

impl RpcResponse {
    pub fn ok(id: RpcId, result: serde_json::Value) -> Self {
        Self {
            jsonrpc: JsonRpcVersion,
            id,
            result: Some(result),
            error: None,
        }
    }

    pub fn err(id: RpcId, error: RpcError) -> Self {
        Self {
            jsonrpc: JsonRpcVersion,
            id,
            result: None,
            error: Some(error),
        }
    }

    pub fn is_ok(&self) -> bool {
        self.error.is_none()
    }
}

/// Anything that can arrive on the wire, in either direction.
///
/// Deserialisation order matters: a response carries `id` but no `method`, a
/// request carries both, a notification carries `method` but no `id`. Untagged
/// matching tries the variants in declaration order, so the most constrained
/// shape has to come first.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RpcMessage {
    Response(RpcResponse),
    Request(RpcRequest),
    Notification(RpcNotification),
}

impl RpcMessage {
    /// Parse one line of the wire format.
    pub fn from_line(line: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(line.trim())
    }

    /// Render as a single line. Newline-delimited JSON is the framing on both
    /// stdio (CLI) and WebSocket text frames (IDE), so one encoder covers both.
    pub fn to_line(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|error| {
            // Serialising our own owned types cannot fail on anything but a
            // non-string map key, which none of these have. Emit a well-formed
            // internal error rather than panicking on a transport thread.
            format!(
                r#"{{"jsonrpc":"2.0","method":"transport.error","params":{{"message":{}}}}}"#,
                serde_json::Value::String(error.to_string())
            )
        })
    }

    pub fn method(&self) -> Option<&str> {
        match self {
            RpcMessage::Request(request) => Some(&request.method),
            RpcMessage::Notification(notification) => Some(&notification.method),
            RpcMessage::Response(_) => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_must_be_exactly_two_zero() {
        let good = r#"{"jsonrpc":"2.0","method":"ping"}"#;
        assert!(RpcMessage::from_line(good).is_ok());

        let bad = r#"{"jsonrpc":"1.0","method":"ping"}"#;
        assert!(RpcMessage::from_line(bad).is_err());
    }

    #[test]
    fn a_request_is_not_mistaken_for_a_notification() {
        let line = r#"{"jsonrpc":"2.0","id":7,"method":"session.prompt","params":{}}"#;
        match RpcMessage::from_line(line).expect("parse") {
            RpcMessage::Request(request) => {
                assert_eq!(request.id, RpcId::Number(7));
                assert_eq!(request.method, "session.prompt");
            }
            other => panic!("expected a request, got {other:?}"),
        }
    }

    #[test]
    fn a_notification_is_not_mistaken_for_a_request() {
        let line = r#"{"jsonrpc":"2.0","method":"session.event","params":{"seq":1}}"#;
        match RpcMessage::from_line(line).expect("parse") {
            RpcMessage::Notification(notification) => {
                assert_eq!(notification.method, "session.event");
            }
            other => panic!("expected a notification, got {other:?}"),
        }
    }

    #[test]
    fn a_response_is_not_mistaken_for_a_request() {
        let line = r#"{"jsonrpc":"2.0","id":"abc","result":{"ok":true}}"#;
        match RpcMessage::from_line(line).expect("parse") {
            RpcMessage::Response(response) => {
                assert_eq!(response.id, RpcId::Text("abc".into()));
                assert!(response.is_ok());
            }
            other => panic!("expected a response, got {other:?}"),
        }
    }

    #[test]
    fn every_message_shape_survives_a_round_trip() {
        let messages = vec![
            RpcMessage::Request(RpcRequest::new(1, "session.create", serde_json::json!({}))),
            RpcMessage::Notification(RpcNotification::new(
                "session.event",
                serde_json::json!({"seq": 3}),
            )),
            RpcMessage::Response(RpcResponse::ok(
                RpcId::Number(1),
                serde_json::json!({"session_id": "ses_1"}),
            )),
            RpcMessage::Response(RpcResponse::err(
                RpcId::Number(2),
                RpcError::invalid_params("missing root"),
            )),
        ];
        for message in messages {
            let line = message.to_line();
            assert!(
                !line.contains('\n'),
                "framing requires one line per message"
            );
            let back = RpcMessage::from_line(&line).expect("round trip");
            assert_eq!(back, message);
        }
    }

    #[test]
    fn core_errors_keep_their_machine_code_in_data() {
        let error: RpcError = zaalis_core::ZaalisError::denied("mode read-only").into();
        assert_eq!(error.code, RpcError::APPLICATION);
        assert_eq!(
            error.data.expect("data")["code"],
            serde_json::json!("permission_denied")
        );
    }

    #[test]
    fn invalid_requests_map_onto_the_reserved_json_rpc_code() {
        let error: RpcError = zaalis_core::ZaalisError::invalid("bad params").into();
        assert_eq!(error.code, RpcError::INVALID_PARAMS);
    }
}
