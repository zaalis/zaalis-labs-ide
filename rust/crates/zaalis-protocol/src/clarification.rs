use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use zaalis_core::{RequestId, SessionId};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClarificationOption {
    pub label: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClarificationQuestion {
    pub id: String,
    pub prompt: String,
    #[serde(default)]
    pub options: Vec<ClarificationOption>,
    #[serde(default = "default_free_text")]
    pub allow_free_text: bool,
}
fn default_free_text() -> bool {
    true
}

pub type ClarificationAnswers = BTreeMap<String, String>;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ClarificationDecideParams {
    pub session_id: SessionId,
    pub request_id: RequestId,
    pub answers: ClarificationAnswers,
}
