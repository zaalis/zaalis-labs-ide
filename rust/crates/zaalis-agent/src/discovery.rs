use crate::session::SessionInner;
use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::{Arc, Weak};
use tokio_util::sync::CancellationToken;
use zaalis_core::{
    now_ms, AccessKind, PermissionAnswer, Result, Segment, SegmentKind, ToolCallId, ZaalisError,
};
use zaalis_guard::AccessRequest;
use zaalis_protocol::{Event, ToolOutcome};
use zaalis_tools::{Tool, ToolContext, ToolDefinition, ToolDispatch, ToolInvocation, ToolResult};

#[derive(Debug)]
pub(crate) struct DiscoveryTool {
    session: Weak<SessionInner>,
    name: &'static str,
}
impl DiscoveryTool {
    pub fn new(session: Weak<SessionInner>, name: &'static str) -> Self {
        Self { session, name }
    }
}
#[async_trait]
impl Tool for DiscoveryTool {
    fn definition(&self) -> ToolDefinition {
        let description=match self.name {
            "tool_search"=>"Search the COMPLETE current tool registry by keyword/family, including deferred assistant tools. Returns names/descriptions. Availability is verified by calling the tool; optional services may require credentials.",
            "tool_describe"=>"Retrieve the precise schema of a named tool, including deferred tools. Read this before tool_call.",
            _=>"Call a discovered tool with name and arguments. The nested call passes through the original permission guard; discovery never grants additional access."
        };
        ToolDefinition {
            name: self.name.into(),
            description: description.into(),
            input_schema: json!({"type":"object","properties":{"server":{"type":"string"},"query":{"type":"string"},"name":{"type":"string"},"limit":{"type":"integer"},"arguments":{"type":"object","additionalProperties":true}},"additionalProperties":false}),
        }
    }
    fn access(&self, _: &Value, ctx: &ToolContext) -> Result<AccessRequest> {
        Ok(AccessRequest::new(
            ctx.agent_id.clone(),
            self.name,
            AccessKind::Read,
        ))
    }
    async fn execute(
        &self,
        input: Value,
        ctx: ToolContext,
        cancel: CancellationToken,
    ) -> Result<ToolResult> {
        let session = self.session.upgrade().ok_or_else(ZaalisError::cancelled)?;
        let mut definitions = session.tools.definitions();
        // Explicit MCP discovery only. Tool listing is metadata; calls still
        // pass through the registered mcp tool with its original guard.
        if input.get("server").is_some()
            || input
                .get("query")
                .and_then(Value::as_str)
                .is_some_and(|q| q.to_lowercase().contains("mcp"))
            || input
                .get("name")
                .and_then(Value::as_str)
                .is_some_and(|n| n.starts_with("mcp:"))
        {
            if session.tools.get_tool("mcp_discover").is_some() {
                if let Ok(ToolOutcome::Ok { result, .. }) = guarded_call(
                    &session,
                    "mcp_discover",
                    json!({"server":input.get("server")}),
                    ctx.clone(),
                    cancel.clone(),
                )
                .await
                {
                    if let Some(tools) = result.get("tools").and_then(Value::as_array) {
                        for t in tools {
                            if let (Some(name), Some(schema)) =
                                (t.get("name").and_then(Value::as_str), t.get("input_schema"))
                            {
                                definitions.push(ToolDefinition {
                                    name: name.into(),
                                    description: t
                                        .get("description")
                                        .and_then(Value::as_str)
                                        .unwrap_or("MCP tool")
                                        .into(),
                                    input_schema: schema.clone(),
                                });
                            }
                        }
                    }
                }
            }
            if let Some(ext) = &session.config.extensions {
                for server in ext.mcp.list().into_iter().take(32) {
                    if input
                        .get("server")
                        .and_then(Value::as_str)
                        .is_some_and(|s| s != server)
                    {
                        continue;
                    }
                    if let Ok(Ok(tools)) = tokio::time::timeout(
                        std::time::Duration::from_secs(5),
                        ext.mcp.tools(&server, cancel.clone()),
                    )
                    .await
                    {
                        for tool in tools.into_iter().take(100) {
                            if let Some(name) = tool.get("name").and_then(Value::as_str) {
                                definitions.push(ToolDefinition {
                                    name: format!("mcp:{server}:{name}"),
                                    description: tool
                                        .get("description")
                                        .and_then(Value::as_str)
                                        .unwrap_or("MCP tool")
                                        .into(),
                                    input_schema: tool.get("inputSchema").cloned().unwrap_or(
                                        json!({"type":"object","additionalProperties":true}),
                                    ),
                                });
                            }
                        }
                    }
                }
            }
        }
        let value = if self.name == "tool_search" {
            let terms = input
                .get("query")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_lowercase();
            let limit = input
                .get("limit")
                .and_then(Value::as_u64)
                .unwrap_or(20)
                .clamp(1, 160) as usize;
            let hits: Vec<_> = definitions
                .iter()
                .filter(|d| {
                    terms.split_whitespace().all(|t| {
                        format!("{} {}", d.name, d.description)
                            .to_lowercase()
                            .contains(t)
                    })
                })
                .map(|d| json!({"name":d.name,"description":d.description}))
                .collect();
            json!({"total":hits.len(),"tools":hits.into_iter().take(limit).collect::<Vec<_>>()})
        } else {
            let name = input
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(|| ZaalisError::invalid("tool name required"))?;
            if self.name == "tool_describe" {
                serde_json::to_value(
                    definitions
                        .iter()
                        .find(|d| d.name == name)
                        .ok_or_else(|| ZaalisError::not_found(name))?,
                )?
            } else {
                if name == "tool_call" {
                    return Err(ZaalisError::invalid("recursive dispatch refused"));
                }
                let args = input.get("arguments").cloned().unwrap_or(json!({}));
                let outcome = guarded_call(&session, name, args, ctx, cancel).await?;
                match outcome {
                    ToolOutcome::Ok { result, .. } => result,
                    other => serde_json::to_value(other)?,
                }
            }
        };
        Ok(ToolResult {
            summary: format!("{} completed", self.name),
            value,
        })
    }
}

pub(crate) async fn guarded_call(
    session: &Arc<SessionInner>,
    name: &str,
    input: Value,
    ctx: ToolContext,
    cancel: CancellationToken,
) -> Result<ToolOutcome> {
    let (name, input) = if let Some(rest) = name.strip_prefix("mcp:") {
        let (server, tool) = rest
            .split_once(':')
            .ok_or_else(|| ZaalisError::invalid("MCP tool name requires server and tool"))?;
        let dispatch = if session.tools.get_tool("mcp_dynamic").is_some()
            && !matches!(server, "blender" | "opale" | "brain")
        {
            "mcp_dynamic"
        } else {
            "mcp"
        };
        (
            dispatch,
            json!({"server":server,"tool":tool,"arguments":input}),
        )
    } else {
        (name, input)
    };
    let call_id = ToolCallId::new();
    let mut segment = Segment::new(
        ctx.agent_id.clone(),
        SegmentKind::ToolCall {
            call_id: call_id.clone(),
            tool: name.into(),
        },
        0,
        now_ms(),
    );
    session.events.emit(Event::SegmentStarted {
        segment: segment.clone(),
    });
    session.events.emit(Event::ToolStarted {
        segment_id: segment.id.clone(),
        call_id: call_id.clone(),
        tool: name.into(),
        input: input.clone(),
        title: name.into(),
    });
    let dispatch = session
        .tools
        .invoke(
            ToolInvocation {
                call_id: call_id.clone(),
                name: name.into(),
                input,
            },
            ctx.clone(),
            cancel.clone(),
        )
        .await;
    let dispatch = if let ToolDispatch::PermissionRequired(prompt) = dispatch {
        let receiver = session
            .interactions
            .wait_permission(prompt.request_id.clone())?;
        session.events.emit(Event::PermissionRequested {
            request_id: prompt.request_id.clone(),
            agent_id: ctx.agent_id.clone(),
            tool: prompt.tool,
            summary: prompt.summary,
            target: prompt.target,
            reason: "permission required for discovered tool".into(),
            risks: prompt.risks,
        });
        let answer = tokio::select! {a=receiver=>a.map_err(|_|ZaalisError::cancelled())?,()=cancel.cancelled()=>{session.tools.cancel_pending(&prompt.request_id)?;return Err(ZaalisError::cancelled());}};
        session.events.emit(Event::PermissionResolved {
            request_id: prompt.request_id.clone(),
            allowed: matches!(answer, PermissionAnswer::Allow { .. }),
            reason: "human decision".into(),
        });
        session.tools.resolve(&prompt.request_id, answer).await?
    } else {
        dispatch
    };
    if let ToolDispatch::Complete { outcome, .. } = dispatch {
        let mut event_outcome = outcome.clone();
        crate::runner::detach_tool_images(&mut event_outcome);
        session.events.emit(Event::ToolCompleted {
            call_id,
            outcome: event_outcome,
        });
        segment.complete(now_ms());
        session.events.emit(Event::SegmentCompleted {
            segment_id: segment.id.clone(),
            duration_ms: segment.duration_ms(),
        });
        Ok(outcome)
    } else {
        Err(ZaalisError::invalid("nested call not resolved"))
    }
}

#[derive(Debug)]
struct AliasTool {
    name: &'static str,
    tool: Arc<dyn Tool>,
    action: Option<&'static str>,
    background_tool: Option<Arc<dyn Tool>>,
}
impl AliasTool {
    fn args(&self, mut i: Value) -> Value {
        if self.name == "terminal" {
            if let Some(o) = i.as_object_mut() {
                let background = o
                    .remove("background")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                if background {
                    o.remove("timeout_ms");
                    o.insert("action".into(), json!("start"));
                }
            }
        }
        if let Some(action) = self.action {
            if let Some(o) = i.as_object_mut() {
                o.insert("action".into(), json!(action));
            }
        }
        if let Some(o) = i.as_object_mut() {
            if self.name == "browser_back" {
                o.insert("action".into(), json!("back"));
            }
        }
        i
    }
    fn selected(&self, i: &Value) -> Arc<dyn Tool> {
        if self.name == "terminal" && i.get("background").and_then(Value::as_bool) == Some(true) {
            self.background_tool
                .clone()
                .unwrap_or_else(|| self.tool.clone())
        } else {
            self.tool.clone()
        }
    }
}
#[async_trait]
impl Tool for AliasTool {
    fn definition(&self) -> ToolDefinition {
        let mut d = self.tool.definition();
        d.name = self.name.into();
        d.description = format!(
            "Compatibility name for {}. {}",
            self.tool.definition().name,
            d.description
        );
        if self.action.is_some() {
            if let Some(required) = d
                .input_schema
                .get_mut("required")
                .and_then(Value::as_array_mut)
            {
                required.retain(|r| r != "action");
            }
        }
        if let Some(p) = d
            .input_schema
            .get_mut("properties")
            .and_then(Value::as_object_mut)
        {
            if self.name == "terminal" {
                p.insert("background".into(), json!({"type":"boolean"}));
            }
            if self.name == "browser_scroll" {
                p.insert(
                    "direction".into(),
                    json!({"type":"string","enum":["up","down","left","right"]}),
                );
                p.insert("amount".into(), json!({"type":"integer"}));
            }
            if matches!(self.name, "browser_press" | "browser_press_key") {
                p.insert("key".into(), json!({"type":"string"}));
            }
        }
        d
    }
    fn access(&self, i: &Value, ctx: &ToolContext) -> Result<AccessRequest> {
        let mut access = self.selected(i).access(&self.args(i.clone()), ctx)?;
        access.tool = self.name.into();
        Ok(access)
    }
    async fn execute(
        &self,
        i: Value,
        ctx: ToolContext,
        cancel: CancellationToken,
    ) -> Result<ToolResult> {
        self.selected(&i).execute(self.args(i), ctx, cancel).await
    }
}
pub(crate) fn register(session: &Arc<SessionInner>) {
    for name in ["tool_search", "tool_describe", "tool_call"] {
        session
            .tools
            .register(DiscoveryTool::new(Arc::downgrade(session), name))
            .expect("discovery tool");
    }
    for (name, target, action) in [
        ("read_file", "read", None),
        ("write_file", "write", None),
        ("search_files", "grep", None),
        ("patch", "apply_patch", None),
        ("terminal", "run", None),
        ("process_manage", "process", None),
        ("todo_list", "todo", None),
        ("web_extract", "web_fetch", None),
        ("computer_use", "computer", None),
        ("browser_navigate", "browser", Some("open")),
        ("browser_snapshot", "browser", Some("read_page")),
        ("browser_click", "browser", Some("click")),
        ("browser_type", "browser", Some("fill")),
        ("browser_scroll", "browser", Some("scroll")),
        ("browser_back", "browser", Some("back")),
        ("browser_press", "browser", Some("press")),
        ("browser_press_key", "browser", Some("press")),
        ("browser_exec", "browser", Some("execute_js")),
        ("browser_close", "browser", Some("close_tab")),
        ("browser_tab", "browser", Some("select_tab")),
        ("browser_console", "browser", Some("read_console")),
        ("browser_network", "browser", Some("read_network")),
        ("browser_screenshot", "browser", Some("screenshot")),
    ] {
        let tool = session.tools.get_tool(target).or_else(|| {
            if target == "browser" {
                session.tools.get_tool("assistant_browser")
            } else {
                None
            }
        });
        if let Some(tool) = tool {
            session
                .tools
                .register_deferred(AliasTool {
                    name,
                    tool,
                    action,
                    background_tool: session.tools.get_tool("process"),
                })
                .expect("tool alias");
        }
    }
}
