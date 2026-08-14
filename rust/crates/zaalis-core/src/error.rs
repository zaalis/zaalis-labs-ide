//! The error type crossing crate boundaries.
//!
//! Every variant maps to a stable machine-readable code, because a client that
//! has to match on error *prose* is a client that breaks on the next
//! translation.

use serde::{Deserialize, Serialize};
use std::fmt;

/// Stable machine-readable error code.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    /// The request did not make sense.
    InvalidRequest,
    /// The named thing does not exist.
    NotFound,
    /// A path resolved outside the workspace.
    OutsideWorkspace,
    /// The guard refused.
    PermissionDenied,
    /// The user refused an approval prompt.
    UserDenied,
    /// A limit was reached.
    BudgetExceeded,
    /// The operation ran out of time.
    Timeout,
    /// The operation was interrupted.
    Cancelled,
    /// The provider refused or failed.
    Provider,
    /// The provider is rate-limiting us.
    RateLimited,
    /// A tool failed while running.
    ToolFailure,
    /// The filesystem or a process failed.
    Io,
    /// Something is wrong with the configuration.
    Config,
    /// The feature is not implemented yet. Used deliberately during migration
    /// so an unfinished path fails loudly instead of silently degrading.
    Unsupported,
    /// A bug.
    Internal,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::InvalidRequest => "invalid_request",
            ErrorCode::NotFound => "not_found",
            ErrorCode::OutsideWorkspace => "outside_workspace",
            ErrorCode::PermissionDenied => "permission_denied",
            ErrorCode::UserDenied => "user_denied",
            ErrorCode::BudgetExceeded => "budget_exceeded",
            ErrorCode::Timeout => "timeout",
            ErrorCode::Cancelled => "cancelled",
            ErrorCode::Provider => "provider",
            ErrorCode::RateLimited => "rate_limited",
            ErrorCode::ToolFailure => "tool_failure",
            ErrorCode::Io => "io",
            ErrorCode::Config => "config",
            ErrorCode::Unsupported => "unsupported",
            ErrorCode::Internal => "internal",
        }
    }

    /// Whether retrying the same operation could plausibly succeed.
    pub fn is_retryable(self) -> bool {
        matches!(
            self,
            ErrorCode::RateLimited | ErrorCode::Timeout | ErrorCode::Provider
        )
    }
}

impl fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// An error with a code, a message and optional structured detail.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ZaalisError {
    pub code: ErrorCode,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<serde_json::Value>,
}

impl ZaalisError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            detail: None,
        }
    }

    pub fn with_detail(mut self, detail: serde_json::Value) -> Self {
        self.detail = Some(detail);
        self
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidRequest, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::NotFound, message)
    }

    pub fn outside_workspace(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::OutsideWorkspace, message)
    }

    pub fn denied(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::PermissionDenied, message)
    }

    pub fn cancelled() -> Self {
        Self::new(ErrorCode::Cancelled, "Opération interrompue.")
    }

    pub fn timeout(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Timeout, message)
    }

    pub fn provider(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Provider, message)
    }

    pub fn tool(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::ToolFailure, message)
    }

    pub fn io(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Io, message)
    }

    pub fn config(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Config, message)
    }

    pub fn unsupported(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Unsupported, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Internal, message)
    }

    pub fn is_retryable(&self) -> bool {
        self.code.is_retryable()
    }
}

impl fmt::Display for ZaalisError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

impl std::error::Error for ZaalisError {}

impl From<std::io::Error> for ZaalisError {
    fn from(value: std::io::Error) -> Self {
        let code = match value.kind() {
            std::io::ErrorKind::NotFound => ErrorCode::NotFound,
            std::io::ErrorKind::PermissionDenied => ErrorCode::PermissionDenied,
            std::io::ErrorKind::TimedOut => ErrorCode::Timeout,
            _ => ErrorCode::Io,
        };
        ZaalisError::new(code, value.to_string())
    }
}

impl From<serde_json::Error> for ZaalisError {
    fn from(value: serde_json::Error) -> Self {
        ZaalisError::new(ErrorCode::InvalidRequest, value.to_string())
    }
}

pub type Result<T> = std::result::Result<T, ZaalisError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_round_trip_with_their_code() {
        let error =
            ZaalisError::denied("mode read-only").with_detail(serde_json::json!({"tool": "write"}));
        let json = serde_json::to_string(&error).expect("serialize");
        let back: ZaalisError = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, error);
        assert_eq!(back.code, ErrorCode::PermissionDenied);
    }

    #[test]
    fn only_transient_failures_are_retryable() {
        assert!(ErrorCode::RateLimited.is_retryable());
        assert!(ErrorCode::Timeout.is_retryable());
        assert!(!ErrorCode::PermissionDenied.is_retryable());
        assert!(!ErrorCode::InvalidRequest.is_retryable());
    }

    #[test]
    fn io_errors_keep_their_meaning() {
        let missing = std::io::Error::new(std::io::ErrorKind::NotFound, "nope");
        assert_eq!(ZaalisError::from(missing).code, ErrorCode::NotFound);

        let refused = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "nope");
        assert_eq!(ZaalisError::from(refused).code, ErrorCode::PermissionDenied);
    }

    #[test]
    fn display_carries_the_code() {
        let error = ZaalisError::timeout("30s");
        assert_eq!(error.to_string(), "[timeout] 30s");
    }
}
