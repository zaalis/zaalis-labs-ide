//! Duplex transports. Stdio is trusted through process ownership; WebSocket is
//! loopback-only and requires a high-entropy bearer token on the handshake.

use crate::Daemon;
use futures_util::{SinkExt, StreamExt};
use std::net::SocketAddr;
use std::sync::Arc;
use subtle::ConstantTimeEq;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::Message;
use zaalis_core::{Result, ZaalisError};
use zaalis_protocol::{event_notification, RpcError, RpcMessage, RpcResponse};
use zeroize::Zeroizing;

pub async fn serve_stdio(daemon: Arc<Daemon>) -> Result<()> {
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut output = tokio::io::stdout();
    let mut events = daemon.subscribe();
    loop {
        tokio::select! {
            line = lines.next_line() => {
                let Some(line) = line? else { break };
                let messages = handle_line(&daemon, &line).await;
                for message in messages {
                    output.write_all(message.to_line().as_bytes()).await?;
                    output.write_all(b"\n").await?;
                }
                output.flush().await?;
            }
            frame = events.recv() => match frame {
                Ok(frame) => {
                    let message = RpcMessage::Notification(event_notification(frame));
                    output.write_all(message.to_line().as_bytes()).await?;
                    output.write_all(b"\n").await?;
                    output.flush().await?;
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    }
    Ok(())
}

pub async fn serve_websocket(
    daemon: Arc<Daemon>,
    address: SocketAddr,
    token: Zeroizing<String>,
) -> Result<()> {
    if !address.ip().is_loopback() {
        return Err(ZaalisError::config(
            "agentd WebSocket doit écouter sur loopback",
        ));
    }
    if token.len() < 32 {
        return Err(ZaalisError::config(
            "jeton agentd trop court (32 octets minimum)",
        ));
    }
    let listener = TcpListener::bind(address).await?;
    loop {
        let (stream, peer) = listener.accept().await?;
        if !peer.ip().is_loopback() {
            continue;
        }
        let daemon = Arc::clone(&daemon);
        let expected = token.clone();
        tokio::spawn(async move {
            let _ = serve_socket(daemon, stream, expected).await;
        });
    }
}

async fn serve_socket(
    daemon: Arc<Daemon>,
    stream: TcpStream,
    token: Zeroizing<String>,
) -> Result<()> {
    let websocket =
        tokio_tungstenite::accept_hdr_async(stream, |request: &Request, response: Response| {
            let authorized = request
                .headers()
                .get("authorization")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.strip_prefix("Bearer "))
                .is_some_and(|value| constant_time_equal(value.as_bytes(), token.as_bytes()));
            if authorized {
                Ok(response)
            } else {
                let mut denied = ErrorResponse::new(Some("unauthorized".into()));
                *denied.status_mut() = StatusCode::UNAUTHORIZED;
                Err(denied)
            }
        })
        .await
        .map_err(|error| ZaalisError::io(format!("WebSocket: {error}")))?;
    let (mut sink, mut source) = websocket.split();
    let mut events = daemon.subscribe();
    loop {
        tokio::select! {
            message = source.next() => match message {
                Some(Ok(Message::Text(line))) => {
                    for response in handle_line(&daemon, &line).await {
                        sink.send(Message::Text(response.to_line().into())).await
                            .map_err(|error| ZaalisError::io(format!("WebSocket: {error}")))?;
                    }
                }
                Some(Ok(Message::Ping(bytes))) => { sink.send(Message::Pong(bytes)).await.map_err(ws_error)?; }
                Some(Ok(Message::Close(_))) | None => break,
                Some(Err(error)) => return Err(ws_error(error)),
                _ => {}
            },
            frame = events.recv() => match frame {
                Ok(frame) => sink.send(Message::Text(RpcMessage::Notification(event_notification(frame)).to_line().into())).await.map_err(ws_error)?,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    }
    Ok(())
}

async fn handle_line(daemon: &Daemon, line: &str) -> Vec<RpcMessage> {
    let request = match RpcMessage::from_line(line) {
        Ok(RpcMessage::Request(request)) => request,
        Ok(_) => return Vec::new(),
        Err(error) => {
            return vec![RpcMessage::Response(RpcResponse::err(
                zaalis_protocol::RpcId::Number(0),
                RpcError::new(RpcError::PARSE_ERROR, error.to_string()),
            ))]
        }
    };
    let output = daemon.dispatch(request).await;
    let mut messages = vec![RpcMessage::Response(output.response)];
    messages.extend(output.replay);
    messages
}

fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    left.len() == right.len() && left.ct_eq(right).into()
}

fn ws_error(error: tokio_tungstenite::tungstenite::Error) -> ZaalisError {
    ZaalisError::io(format!("WebSocket: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_comparison_rejects_prefixes_and_differences() {
        assert!(constant_time_equal(
            b"abcdefghijklmnopqrstuvwxyz123456",
            b"abcdefghijklmnopqrstuvwxyz123456"
        ));
        assert!(!constant_time_equal(
            b"abcdefghijklmnopqrstuvwxyz123456",
            b"abcdefghijklmnopqrstuvwxyz123457"
        ));
        assert!(!constant_time_equal(b"abc", b"abcd"));
    }
}
