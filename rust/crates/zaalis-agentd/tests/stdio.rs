use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use tempfile::TempDir;
use zaalis_protocol::{method, RpcMessage, RpcRequest};

#[test]
fn real_daemon_binary_answers_over_duplex_stdio() {
    let data = TempDir::new().expect("temp data");
    let mut child = Command::new(env!("CARGO_BIN_EXE_zaalis-agentd"))
        .arg("--stdio")
        .env("ZAALIS_AGENTD_DATA_DIR", data.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn agentd");
    let mut input = child.stdin.take().expect("stdin");
    let mut output = BufReader::new(child.stdout.take().expect("stdout"));
    let line =
        RpcMessage::Request(RpcRequest::new(7, method::HEALTH, serde_json::json!({}))).to_line();
    writeln!(input, "{line}").expect("write request");
    input.flush().expect("flush");
    let mut response = String::new();
    output.read_line(&mut response).expect("read response");
    let RpcMessage::Response(response) = RpcMessage::from_line(&response).expect("valid rpc")
    else {
        panic!("health must return a response");
    };
    assert!(response.is_ok());
    assert_eq!(response.result.expect("health")["sessions"], 0);
    drop(input);
    assert!(child.wait().expect("wait").success());
}
