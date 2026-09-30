//! Per-domain egress policy for commands the agent runs.
//!
//! Zaalis already refuses an SSRF target in its own `web_fetch`, but that check
//! lives in the tool — a shell command the agent runs in `auto` mode went out
//! to the network with nothing in its way. The gap mattered most exactly where
//! supervision is thinnest: an unattended agent that can run `curl` can reach
//! anywhere, including somewhere to send what it just read.
//!
//! [`DomainPolicy`] decides, [`EgressProxy`] enforces. The enforcement is
//! honest about its own limits — see [`proxy`] — and the capability it reports
//! says `advisory`, because a program determined to ignore the proxy variables
//! is stopped by the sandbox, not by this.

pub mod policy;
pub mod proxy;

pub use policy::{DomainPolicy, NetDecision};
pub use proxy::{BlockedHost, EgressProxy};

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    /// The end-to-end shape: allowed host tunnels, denied host is refused, and
    /// both outcomes are visible afterwards.
    #[tokio::test]
    async fn the_policy_and_the_proxy_agree_on_one_session() {
        let echo = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("echo");
        let port = echo.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = echo.accept().await {
                tokio::spawn(async move {
                    let mut buffer = [0_u8; 32];
                    if let Ok(read) = stream.read(&mut buffer).await {
                        let _ = stream.write_all(&buffer[..read]).await;
                    }
                });
            }
        });

        let proxy = EgressProxy::start(DomainPolicy::default().with_allow(["127.0.0.1".into()]))
            .await
            .expect("proxy");

        let mut allowed = TcpStream::connect(proxy.address()).await.expect("connect");
        allowed
            .write_all(format!("CONNECT 127.0.0.1:{port} HTTP/1.1\r\n\r\n").as_bytes())
            .await
            .expect("connect request");
        let mut header = [0_u8; 39];
        allowed.read_exact(&mut header).await.expect("established");
        allowed.write_all(b"ok").await.expect("payload");
        let mut echoed = [0_u8; 2];
        allowed.read_exact(&mut echoed).await.expect("echo");
        assert_eq!(&echoed, b"ok");

        let mut refused = TcpStream::connect(proxy.address()).await.expect("connect");
        refused
            .write_all(b"CONNECT exfiltration.test:443 HTTP/1.1\r\n\r\n")
            .await
            .expect("connect request");
        let mut response = Vec::new();
        refused.read_to_end(&mut response).await.expect("read");
        assert!(String::from_utf8_lossy(&response).starts_with("HTTP/1.1 403"));

        assert_eq!(proxy.allowed_count(), 1);
        assert_eq!(proxy.blocked().len(), 1);
        assert_eq!(proxy.blocked()[0].host, "exfiltration.test");
    }
}
