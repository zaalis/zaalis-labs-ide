//! Zaalis-native extension surfaces. MCP calls are tools, Skills are bounded
//! workspace/user documents, and Hooks compile to ordinary guarded `run`
//! invocations. No extension bypasses `ToolRuntime` permissions.

mod computer;
mod hooks;
mod mcp;
mod skills;
mod web;

pub use hooks::{HookAction, HookEvent, HookInvocation, HookRegistry};
pub use mcp::{McpRegistry, McpServer, McpTransport};
pub use skills::{Skill, SkillRegistry};

use std::sync::Arc;
use zaalis_core::Result;
use zaalis_tools::ToolRuntime;

#[derive(Debug, Clone)]
pub struct ExtensionRuntime {
    pub mcp: Arc<McpRegistry>,
    pub skills: Arc<SkillRegistry>,
    pub hooks: Arc<HookRegistry>,
}

impl ExtensionRuntime {
    pub fn load(
        workspace: &zaalis_fs::Workspace,
        user_root: Option<&std::path::Path>,
    ) -> Result<Self> {
        Ok(Self {
            mcp: Arc::new(McpRegistry::load(workspace, user_root)?),
            skills: Arc::new(SkillRegistry::load(workspace, user_root)?),
            hooks: Arc::new(HookRegistry::load(workspace, user_root)?),
        })
    }

    pub fn register_tools(&self, runtime: &ToolRuntime) -> Result<()> {
        runtime.register(mcp::McpTool::new(Arc::clone(&self.mcp)))?;
        runtime.register(skills::SkillTool::new(Arc::clone(&self.skills)))?;
        if let Some(tool) = computer::ComputerTool::from_env()? {
            runtime.register(tool)?;
        }
        web::register_web_tools(runtime)?;
        Ok(())
    }
}
