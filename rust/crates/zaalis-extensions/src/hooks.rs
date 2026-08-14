use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use zaalis_core::{Result, ZaalisError};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum HookEvent {
    SessionStart,
    UserPromptSubmit,
    PreToolUse,
    PostToolUse,
    Stop,
    AgentSpawn,
    AgentComplete,
    SessionEnd,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HookAction {
    pub command: String,
    #[serde(default = "default_timeout")]
    pub timeout_ms: u64,
    #[serde(default)]
    pub blocking: bool,
}
fn default_timeout() -> u64 {
    30_000
}

#[derive(Debug, Clone, PartialEq)]
pub struct HookInvocation {
    pub event: HookEvent,
    pub command: String,
    pub timeout_ms: u64,
    pub blocking: bool,
    pub context: Value,
}

#[derive(Debug, Default)]
pub struct HookRegistry {
    hooks: BTreeMap<HookEvent, Vec<HookAction>>,
}

impl HookRegistry {
    pub fn load(workspace: &zaalis_fs::Workspace, user_root: Option<&Path>) -> Result<Self> {
        let mut registry = Self::default();
        if let Some(root) = user_root {
            registry.load_file(&root.join("hooks.json"))?;
        }
        registry.load_file(&workspace.root().join(".zaalis/hooks.json"))?;
        Ok(registry)
    }
    fn load_file(&mut self, path: &Path) -> Result<()> {
        if !path.exists() {
            return Ok(());
        }
        if fs::symlink_metadata(path)?.file_type().is_symlink() {
            return Err(ZaalisError::invalid("hooks.json ne peut pas être un lien"));
        }
        if fs::metadata(path)?.len() > 256 * 1024 {
            return Err(ZaalisError::invalid("hooks.json trop volumineux"));
        }
        let config: BTreeMap<HookEvent, Vec<HookAction>> =
            serde_json::from_slice(&fs::read(path)?)?;
        for (event, actions) in config {
            let target = self.hooks.entry(event).or_default();
            for action in actions {
                if action.command.trim().is_empty() || action.command.len() > 8192 {
                    return Err(ZaalisError::invalid("commande Hook invalide"));
                }
                if target.len() >= 32 {
                    return Err(ZaalisError::invalid("trop de Hooks pour un événement"));
                }
                target.push(HookAction {
                    timeout_ms: action.timeout_ms.clamp(100, 120_000),
                    ..action
                });
            }
        }
        Ok(())
    }
    pub fn invocations(&self, event: HookEvent, context: Value) -> Vec<HookInvocation> {
        self.hooks
            .get(&event)
            .into_iter()
            .flatten()
            .map(|action| HookInvocation {
                event,
                command: action.command.clone(),
                timeout_ms: action.timeout_ms,
                blocking: action.blocking,
                context: context.clone(),
            })
            .collect()
    }
    pub fn is_empty(&self) -> bool {
        self.hooks.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;
    #[test]
    fn project_hooks_override_nothing_and_are_bounded() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("p");
        fs::create_dir_all(root.join(".zaalis")).unwrap();
        fs::write(
            root.join(".zaalis/hooks.json"),
            r#"{"PreToolUse":[{"command":"npm test","blocking":true}]}"#,
        )
        .unwrap();
        let hooks = HookRegistry::load(&zaalis_fs::Workspace::open(root).unwrap(), None).unwrap();
        let calls = hooks.invocations(HookEvent::PreToolUse, serde_json::json!({"tool":"write"}));
        assert_eq!(calls.len(), 1);
        assert!(calls[0].blocking);
    }
}
