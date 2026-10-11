use crate::{AgentSession, SessionConfig, SessionRunMode};
use serde_json::json;
use std::sync::Arc;
use tempfile::TempDir;
use tokio_util::sync::CancellationToken;
use zaalis_core::{
    AgentId, GrantScope, PermissionAnswer, PermissionMode, PermissionSet, ToolCallId,
};
use zaalis_fs::Workspace;
use zaalis_guard::Guard;
use zaalis_protocol::{Event, ToolOutcome};
use zaalis_providers::{PoolConfig, ProviderPool};
use zaalis_tools::{
    register_exec_tools, register_filesystem_tools, ToolContext, ToolDispatch, ToolInvocation,
    ToolRuntime,
};
fn fixture(mode: PermissionMode) -> (TempDir, AgentSession, ToolContext) {
    let dir = TempDir::new().unwrap();
    std::fs::write(dir.path().join("hello.txt"), "hello").unwrap();
    let workspace = Workspace::open(dir.path()).unwrap();
    let mut tools = ToolRuntime::new(Guard::new());
    register_filesystem_tools(&mut tools).unwrap();
    register_exec_tools(
        &mut tools,
        zaalis_exec::ExecRuntime::new(dir.path()).unwrap(),
    )
    .unwrap();
    let session = AgentSession::new(
        SessionConfig::new(workspace.clone(), SessionRunMode::Chat),
        Arc::new(ProviderPool::new(PoolConfig::default())),
        Arc::new(tools),
    );
    let ctx = ToolContext {
        agent_id: AgentId::new(),
        permissions: PermissionSet::new(mode),
        workspace,
    };
    (dir, session, ctx)
}
async fn invoke(
    session: &AgentSession,
    ctx: ToolContext,
    name: &str,
    input: serde_json::Value,
) -> ToolDispatch {
    session
        .inner
        .tools
        .invoke(
            ToolInvocation {
                call_id: ToolCallId::new(),
                name: name.into(),
                input,
            },
            ctx,
            CancellationToken::new(),
        )
        .await
}
fn value(result: ToolDispatch) -> serde_json::Value {
    if let ToolDispatch::Complete {
        outcome: ToolOutcome::Ok { result, .. },
        ..
    } = result
    {
        result
    } else {
        panic!("unexpected {result:?}")
    }
}
#[tokio::test]
async fn deferred_registry_search_describe_and_alias_read() {
    let (_dir, s, ctx) = fixture(PermissionMode::ReadOnly);
    assert!(!s
        .inner
        .tools
        .definitions_for_model()
        .iter()
        .any(|t| t.name == "execute_code"));
    assert!(s
        .inner
        .tools
        .definitions()
        .iter()
        .any(|t| t.name == "execute_code"));
    let found = value(
        invoke(
            &s,
            ctx.clone(),
            "tool_search",
            json!({"query":"execute_code"}),
        )
        .await,
    );
    assert!(found["tools"]
        .as_array()
        .unwrap()
        .iter()
        .any(|t| t["name"] == "execute_code"));
    let description = value(
        invoke(
            &s,
            ctx.clone(),
            "tool_describe",
            json!({"name":"read_file"}),
        )
        .await,
    );
    assert_eq!(description["input_schema"]["type"], "object");
    let read = value(
        invoke(
            &s,
            ctx,
            "tool_call",
            json!({"name":"read_file","arguments":{"path":"hello.txt"}}),
        )
        .await,
    );
    assert!(read.to_string().contains("hello"));
}
#[tokio::test]
async fn discovered_write_is_denied_by_read_only() {
    let (dir, s, ctx) = fixture(PermissionMode::ReadOnly);
    let result = value(
        invoke(
            &s,
            ctx,
            "tool_call",
            json!({"name":"write_file","arguments":{"path":"forbidden.txt","content":"no"}}),
        )
        .await,
    );
    assert_eq!(result["status"], "denied");
    assert!(!dir.path().join("forbidden.txt").exists());
}
#[tokio::test]
async fn discovered_write_waits_for_the_same_supervised_permission() {
    let (dir, s, ctx) = fixture(PermissionMode::Supervised);
    let mut events = s.subscribe();
    let copy = s.clone();
    let task = tokio::spawn(async move {
        invoke(
            &copy,
            ctx,
            "tool_call",
            json!({"name":"write_file","arguments":{"path":"approved.txt","content":"yes"}}),
        )
        .await
    });
    let id = tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            if let Event::PermissionRequested { request_id, .. } =
                events.recv().await.unwrap().event
            {
                break request_id;
            }
        }
    })
    .await
    .unwrap();
    assert!(!dir.path().join("approved.txt").exists());
    s.decide_permission(
        &id,
        PermissionAnswer::Allow {
            scope: GrantScope::Once,
        },
    )
    .unwrap();
    value(task.await.unwrap());
    assert_eq!(
        std::fs::read_to_string(dir.path().join("approved.txt")).unwrap(),
        "yes"
    );
}
#[tokio::test]
async fn python_orchestration_reads_through_guard_and_returns_json() {
    let (_dir, s, ctx) = fixture(PermissionMode::Bypass);
    let result=value(invoke(&s,ctx,"execute_code",json!({"code":"data = tools.read_file(path='hello.txt')\nresult = {'value': 6 * 7, 'read': data, 'quotes': \"'''\"}","timeout_ms":15000})).await);
    assert_eq!(result["execution"]["success"], true, "{result}");
    assert_eq!(result["result"]["value"], 42);
    assert_eq!(result["result"]["quotes"], "'''");
    assert!(result["result"]["read"].to_string().contains("hello"));
    assert_eq!(result["level"], "process_tree");
}
#[tokio::test]
async fn python_is_denied_before_creating_files_in_read_only() {
    let (dir, s, ctx) = fixture(PermissionMode::ReadOnly);
    let result = invoke(&s, ctx, "execute_code", json!({"code":"result = 42"})).await;
    assert!(matches!(
        result,
        ToolDispatch::Complete {
            outcome: ToolOutcome::Denied { .. },
            ..
        }
    ));
    assert!(!dir.path().join(".zaalis").exists());
}
#[tokio::test]
async fn terminal_background_and_process_wait_log_share_runtime() {
    let (_dir, s, ctx) = fixture(PermissionMode::Bypass);
    let started = value(
        invoke(
            &s,
            ctx.clone(),
            "terminal",
            json!({"command":"echo shared-background","background":true}),
        )
        .await,
    );
    let id = started["process_id"].as_str().unwrap();
    let waited = value(
        invoke(
            &s,
            ctx.clone(),
            "process_manage",
            json!({"action":"wait","process_id":id,"timeout_ms":10000}),
        )
        .await,
    );
    assert_eq!(waited["running"], false);
    assert!(waited["stdout"]
        .as_str()
        .unwrap()
        .contains("shared-background"));
    let log = value(
        invoke(
            &s,
            ctx,
            "process_manage",
            json!({"action":"log","process_id":id}),
        )
        .await,
    );
    assert!(log["stdout"]
        .as_str()
        .unwrap()
        .contains("shared-background"));
}
