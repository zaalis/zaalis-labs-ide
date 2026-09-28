//! A local proxy that enforces [`DomainPolicy`] on outbound connections.
//!
//! # Why a proxy and not TLS interception
//!
//! Both protocols spoken here name the destination host *in plaintext* before
//! any TLS handshake: SOCKS5 carries it in the connect request, HTTP carries it
//! in `CONNECT host:443`. That is enough to allow or refuse by domain without
//! decrypting anything — so this proxy never sees request bodies, never needs a
//! certificate authority on the user's machine, and cannot itself become a
//! place where credentials leak.
//!
//! # What this does and does not guarantee
//!
//! Commands are pointed here through `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`,
//! which every ordinary tool honours — curl, npm, pip, cargo, git. A program
//! that deliberately ignores those variables and opens its own socket is *not*
//! stopped by this layer, so it is a control over what the agent's tooling
//! reaches, not a containment boundary. Kernel-level blocking is the sandbox's
//! job; this is reported honestly as `advisory` so nobody mistakes one for the
//! other.

use crate::policy::{DomainPolicy, NetDecision};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use zaalis_core::{Result, ZaalisError};

/// Cap on the request preamble we will read before deciding.
///
/// A client that sends megabytes before its request line is not a client.
const MAX_PREAMBLE: usize = 8 * 1024;

/// One refused connection, for the audit trail.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockedHost {
    pub host: String,
    pub reason: String,
}

/// A running proxy.
#[derive(Debug)]
pub struct EgressProxy {
    address: SocketAddr,
    blocked: Arc<Mutex<Vec<BlockedHost>>>,
    allowed_count: Arc<AtomicU64>,
    shutdown: tokio::sync::watch::Sender<bool>,
}

impl EgressProxy {
    /// Bind on loopback and start serving.
    ///
    /// Loopback only, and deliberately: an egress proxy reachable from the
    /// network is an open relay.
    pub async fn start(policy: DomainPolicy) -> Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|error| ZaalisError::io(format!("proxy réseau : {error}")))?;
        let address = listener
            .local_addr()
            .map_err(|error| ZaalisError::io(format!("proxy réseau : {error}")))?;
        let blocked = Arc::new(Mutex::new(Vec::new()));
        let allowed_count = Arc::new(AtomicU64::new(0));
        let (shutdown, mut stop) = tokio::sync::watch::channel(false);

        let policy = Arc::new(policy);
        let task_blocked = Arc::clone(&blocked);
        let task_allowed = Arc::clone(&allowed_count);
        tokio::spawn(async move {
            loop {
                let accepted = tokio::select! {
                    result = listener.accept() => result,
                    _ = stop.changed() => break,
                };
                let Ok((stream, _)) = accepted else { continue };
                let policy = Arc::clone(&policy);
                let blocked = Arc::clone(&task_blocked);
                let allowed = Arc::clone(&task_allowed);
                tokio::spawn(async move {
                    let _ = serve(stream, policy, blocked, allowed).await;
                });
            }
        });

        Ok(Self {
            address,
            blocked,
            allowed_count,
            shutdown,
        })
    }

    pub fn address(&self) -> SocketAddr {
        self.address
    }

    /// The `HTTP_PROXY`-style URL to hand to a child process.
    pub fn url(&self) -> String {
        format!("http://{}", self.address)
    }

    /// Environment variables that point a cooperating tool at this proxy.
    ///
    /// Both cases are set because the ecosystem never agreed on one: curl reads
    /// the lower-case names, most Windows tooling the upper-case ones, and some
    /// read whichever they find first.
    pub fn environment(&self) -> Vec<(String, String)> {
        let url = self.url();
        [
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
        ]
        .into_iter()
        .map(|name| (name.to_owned(), url.clone()))
        .chain(std::iter::once((
            // Loopback stays direct, or a local dev server would be proxied
            // through us and refused for not being on an allow list.
            "NO_PROXY".to_owned(),
            "localhost,127.0.0.1,::1".to_owned(),
        )))
        .collect()
    }

    pub fn blocked(&self) -> Vec<BlockedHost> {
        self.blocked.lock().expect("blocked lock poisoned").clone()
    }

    pub fn allowed_count(&self) -> u64 {
        self.allowed_count.load(Ordering::Relaxed)
    }
}

impl Drop for EgressProxy {
    fn drop(&mut self) {
        let _ = self.shutdown.send(true);
    }
}

async fn serve(
    client: TcpStream,
    policy: Arc<DomainPolicy>,
    blocked: Arc<Mutex<Vec<BlockedHost>>>,
    allowed: Arc<AtomicU64>,
) -> Result<()> {
    let mut first = [0_u8; 1];
    if client.peek(&mut first).await.is_err() {
        return Ok(());
    }
    // SOCKS5 always opens with its version byte; anything else is HTTP.
    if first[0] == 0x05 {
        socks5(client, policy, blocked, allowed).await
    } else {
        http(client, policy, blocked, allowed).await
    }
}

fn record(
    blocked: &Arc<Mutex<Vec<BlockedHost>>>,
    allowed: &Arc<AtomicU64>,
    host: &str,
    decision: &NetDecision,
) -> bool {
    match decision {
        NetDecision::Allow { .. } => {
            allowed.fetch_add(1, Ordering::Relaxed);
            true
        }
        NetDecision::Deny { reason } => {
            let mut blocked = blocked.lock().expect("blocked lock poisoned");
            // Bounded: a loop retrying a refused host must not grow this
            // without limit.
            if blocked.len() < 256
                && !blocked
                    .iter()
                    .any(|entry| entry.host == host && entry.reason == *reason)
            {
                blocked.push(BlockedHost {
                    host: host.to_owned(),
                    reason: reason.clone(),
                });
            }
            false
        }
    }
}

async fn pipe(mut client: TcpStream, host: &str, port: u16) -> Result<()> {
    let mut upstream = TcpStream::connect((host, port))
        .await
        .map_err(|error| ZaalisError::io(format!("connexion à {host} : {error}")))?;
    let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
    Ok(())
}

// ── HTTP ────────────────────────────────────────────────────────────────

async fn http(
    mut client: TcpStream,
    policy: Arc<DomainPolicy>,
    blocked: Arc<Mutex<Vec<BlockedHost>>>,
    allowed: Arc<AtomicU64>,
) -> Result<()> {
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 1024];
    // Read only as far as the end of the headers: the body belongs to the
    // tunnel, not to us.
    let header_end = loop {
        let read = client.read(&mut chunk).await.unwrap_or(0);
        if read == 0 {
            return Ok(());
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(at) = find_header_end(&buffer) {
            break at;
        }
        if buffer.len() > MAX_PREAMBLE {
            return refuse(&mut client, "requête trop longue").await;
        }
    };

    let head = String::from_utf8_lossy(&buffer[..header_end]).into_owned();
    let Some((method, target)) = request_line(&head) else {
        return refuse(&mut client, "requête illisible").await;
    };
    let Some((host, port)) = destination(&method, &target, &head) else {
        return refuse(&mut client, "hôte introuvable").await;
    };

    let decision = policy.decide(&host);
    if !record(&blocked, &allowed, &host, &decision) {
        let NetDecision::Deny { reason } = &decision else {
            unreachable!("record ne refuse que sur un refus")
        };
        return refuse(&mut client, reason).await;
    }

    if method.eq_ignore_ascii_case("CONNECT") {
        client
            .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            .await
            .map_err(|error| ZaalisError::io(error.to_string()))?;
        return pipe(client, &host, port).await;
    }

    // A plain proxied request: forward what we have already read, then tunnel.
    let mut upstream = TcpStream::connect((host.as_str(), port))
        .await
        .map_err(|error| ZaalisError::io(format!("connexion à {host} : {error}")))?;
    upstream
        .write_all(&buffer)
        .await
        .map_err(|error| ZaalisError::io(error.to_string()))?;
    let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
    Ok(())
}

async fn refuse(client: &mut TcpStream, reason: &str) -> Result<()> {
    // 403 with the reason in the body: the tool's error message then says why
    // the request failed instead of a bare connection reset the user has to
    // guess at.
    let body = format!("zaalis : accès réseau refusé — {reason}");
    let response = format!(
        "HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain; charset=utf-8\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = client.write_all(response.as_bytes()).await;
    let _ = client.shutdown().await;
    Ok(())
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|at| at + 4)
        .or_else(|| {
            buffer
                .windows(2)
                .position(|window| window == b"\n\n")
                .map(|at| at + 2)
        })
}

fn request_line(head: &str) -> Option<(String, String)> {
    let first = head.lines().next()?;
    let mut parts = first.split_whitespace();
    Some((parts.next()?.to_owned(), parts.next()?.to_owned()))
}

/// Host and port for a proxied request.
fn destination(method: &str, target: &str, head: &str) -> Option<(String, u16)> {
    if method.eq_ignore_ascii_case("CONNECT") {
        return split_host_port(target, 443);
    }
    // An absolute-form URI is what a proxied GET carries.
    if let Some(rest) = target
        .strip_prefix("http://")
        .or_else(|| target.strip_prefix("https://"))
    {
        let authority = rest.split('/').next().unwrap_or(rest);
        let authority = authority.split('@').next_back().unwrap_or(authority);
        let default = if target.starts_with("https://") { 443 } else { 80 };
        return split_host_port(authority, default);
    }
    // Origin-form: fall back to the Host header.
    let host = head
        .lines()
        .find_map(|line| line.split_once(':').filter(|(name, _)| name.eq_ignore_ascii_case("host")))
        .map(|(_, value)| value.trim())?;
    split_host_port(host, 80)
}

fn split_host_port(authority: &str, default_port: u16) -> Option<(String, u16)> {
    let authority = authority.trim();
    // IPv6 literals carry colons of their own, so the brackets decide.
    if let Some(rest) = authority.strip_prefix('[') {
        let (host, tail) = rest.split_once(']')?;
        let port = tail
            .strip_prefix(':')
            .and_then(|port| port.parse().ok())
            .unwrap_or(default_port);
        return Some((host.to_owned(), port));
    }
    match authority.rsplit_once(':') {
        Some((host, port)) if !host.is_empty() => {
            Some((host.to_owned(), port.parse().unwrap_or(default_port)))
        }
        _ => (!authority.is_empty()).then(|| (authority.to_owned(), default_port)),
    }
}

// ── SOCKS5 ──────────────────────────────────────────────────────────────

async fn socks5(
    mut client: TcpStream,
    policy: Arc<DomainPolicy>,
    blocked: Arc<Mutex<Vec<BlockedHost>>>,
    allowed: Arc<AtomicU64>,
) -> Result<()> {
    let mut greeting = [0_u8; 2];
    if client.read_exact(&mut greeting).await.is_err() {
        return Ok(());
    }
    let mut methods = vec![0_u8; greeting[1] as usize];
    if client.read_exact(&mut methods).await.is_err() {
        return Ok(());
    }
    // No authentication: the listener is loopback-only, so a credential here
    // would protect nothing and would have to be stored somewhere.
    if client.write_all(&[0x05, 0x00]).await.is_err() {
        return Ok(());
    }

    let mut request = [0_u8; 4];
    if client.read_exact(&mut request).await.is_err() {
        return Ok(());
    }
    if request[1] != 0x01 {
        // Only CONNECT. BIND and UDP ASSOCIATE would open paths this policy
        // cannot inspect.
        let _ = client.write_all(&socks_reply(0x07)).await;
        return Ok(());
    }

    let host = match request[3] {
        0x01 => {
            let mut octets = [0_u8; 4];
            client.read_exact(&mut octets).await.ok();
            std::net::Ipv4Addr::from(octets).to_string()
        }
        0x03 => {
            let mut length = [0_u8; 1];
            client.read_exact(&mut length).await.ok();
            let mut name = vec![0_u8; length[0] as usize];
            client.read_exact(&mut name).await.ok();
            String::from_utf8_lossy(&name).into_owned()
        }
        0x04 => {
            let mut octets = [0_u8; 16];
            client.read_exact(&mut octets).await.ok();
            std::net::Ipv6Addr::from(octets).to_string()
        }
        _ => {
            let _ = client.write_all(&socks_reply(0x08)).await;
            return Ok(());
        }
    };
    let mut port = [0_u8; 2];
    client.read_exact(&mut port).await.ok();
    let port = u16::from_be_bytes(port);

    let decision = policy.decide(&host);
    if !record(&blocked, &allowed, &host, &decision) {
        // 0x02 is "connection not allowed by ruleset", which is exactly what
        // happened — clients report it as a policy refusal rather than a
        // network fault.
        let _ = client.write_all(&socks_reply(0x02)).await;
        let _ = client.shutdown().await;
        return Ok(());
    }

    if client.write_all(&socks_reply(0x00)).await.is_err() {
        return Ok(());
    }
    pipe(client, &host, port).await
}

fn socks_reply(status: u8) -> [u8; 10] {
    // VER, REP, RSV, ATYP=IPv4, 0.0.0.0, port 0 — the bound address is not
    // meaningful for a CONNECT reply and clients ignore it.
    [0x05, status, 0x00, 0x01, 0, 0, 0, 0, 0, 0]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_connect_target_is_split_into_host_and_port() {
        assert_eq!(
            destination("CONNECT", "example.test:443", ""),
            Some(("example.test".into(), 443))
        );
        assert_eq!(
            destination("CONNECT", "example.test", ""),
            Some(("example.test".into(), 443))
        );
    }

    #[test]
    fn an_absolute_uri_and_a_host_header_both_resolve() {
        assert_eq!(
            destination("GET", "http://example.test/path", ""),
            Some(("example.test".into(), 80))
        );
        assert_eq!(
            destination("GET", "/path", "GET /path HTTP/1.1\r\nHost: example.test:8080\r\n"),
            Some(("example.test".into(), 8080))
        );
    }

    #[test]
    fn userinfo_in_a_uri_does_not_become_the_host() {
        // `http://github.com@evil.test/` reaches evil.test; reading the part
        // before the `@` as the host is a classic filter bypass.
        assert_eq!(
            destination("GET", "http://github.com@evil.test/x", ""),
            Some(("evil.test".into(), 80))
        );
    }

    #[test]
    fn an_ipv6_literal_keeps_its_address() {
        assert_eq!(
            split_host_port("[::1]:8443", 443),
            Some(("::1".into(), 8443))
        );
        assert_eq!(split_host_port("[::1]", 443), Some(("::1".into(), 443)));
    }

    #[test]
    fn the_end_of_the_headers_is_found_for_both_line_endings() {
        assert_eq!(find_header_end(b"GET / HTTP/1.1\r\n\r\nbody"), Some(18));
        assert_eq!(find_header_end(b"GET / HTTP/1.1\n\nbody"), Some(16));
        assert_eq!(find_header_end(b"GET / HTTP/1.1\r\n"), None);
    }

    #[tokio::test]
    async fn a_refused_host_gets_a_403_that_explains_itself() {
        let proxy = EgressProxy::start(DomainPolicy::default().with_allow(["allowed.test".into()]))
            .await
            .expect("proxy");
        let mut client = TcpStream::connect(proxy.address()).await.expect("connect");
        client
            .write_all(b"CONNECT blocked.test:443 HTTP/1.1\r\nHost: blocked.test:443\r\n\r\n")
            .await
            .expect("write");
        let mut response = Vec::new();
        client.read_to_end(&mut response).await.expect("read");
        let response = String::from_utf8_lossy(&response);
        assert!(response.starts_with("HTTP/1.1 403"), "{response}");
        assert!(response.contains("refusé"), "{response}");

        let blocked = proxy.blocked();
        assert_eq!(blocked.len(), 1);
        assert_eq!(blocked[0].host, "blocked.test");
        assert_eq!(proxy.allowed_count(), 0);
    }

    #[tokio::test]
    async fn an_allowed_host_is_tunnelled_through() {
        // A local echo server stands in for the destination, so the test proves
        // the tunnel actually carries bytes rather than only that the policy
        // said yes.
        let echo = TcpListener::bind(("127.0.0.1", 0)).await.expect("echo");
        let echo_port = echo.local_addr().unwrap().port();
        tokio::spawn(async move {
            if let Ok((mut stream, _)) = echo.accept().await {
                let mut buffer = [0_u8; 64];
                if let Ok(read) = stream.read(&mut buffer).await {
                    let _ = stream.write_all(&buffer[..read]).await;
                }
            }
        });

        let proxy = EgressProxy::start(DomainPolicy::default().with_allow(["127.0.0.1".into()]))
            .await
            .expect("proxy");
        let mut client = TcpStream::connect(proxy.address()).await.expect("connect");
        client
            .write_all(format!("CONNECT 127.0.0.1:{echo_port} HTTP/1.1\r\n\r\n").as_bytes())
            .await
            .expect("write");

        let mut header = [0_u8; 39];
        client.read_exact(&mut header).await.expect("header");
        assert!(String::from_utf8_lossy(&header).contains("200"));

        client.write_all(b"bonjour").await.expect("payload");
        let mut echoed = [0_u8; 7];
        client.read_exact(&mut echoed).await.expect("echo");
        assert_eq!(&echoed, b"bonjour");
        assert_eq!(proxy.allowed_count(), 1);
    }

    #[tokio::test]
    async fn socks5_refuses_with_the_ruleset_status() {
        let proxy = EgressProxy::start(DomainPolicy::default())
            .await
            .expect("proxy");
        let mut client = TcpStream::connect(proxy.address()).await.expect("connect");
        // Greeting: version 5, one method, "no authentication".
        client.write_all(&[0x05, 0x01, 0x00]).await.expect("hello");
        let mut chosen = [0_u8; 2];
        client.read_exact(&mut chosen).await.expect("choice");
        assert_eq!(chosen, [0x05, 0x00]);

        // CONNECT to a domain name.
        let host = b"evil.test";
        let mut request = vec![0x05, 0x01, 0x00, 0x03, host.len() as u8];
        request.extend_from_slice(host);
        request.extend_from_slice(&443_u16.to_be_bytes());
        client.write_all(&request).await.expect("request");

        let mut reply = [0_u8; 10];
        client.read_exact(&mut reply).await.expect("reply");
        assert_eq!(reply[1], 0x02, "refus par la politique attendu");
        assert_eq!(proxy.blocked()[0].host, "evil.test");
    }

    #[tokio::test]
    async fn the_proxy_environment_keeps_loopback_direct() {
        let proxy = EgressProxy::start(DomainPolicy::default())
            .await
            .expect("proxy");
        let environment = proxy.environment();
        let no_proxy = environment
            .iter()
            .find(|(name, _)| name == "NO_PROXY")
            .expect("NO_PROXY");
        assert!(no_proxy.1.contains("127.0.0.1"));
        assert!(environment
            .iter()
            .any(|(name, value)| name == "HTTPS_PROXY" && value.starts_with("http://127.0.0.1:")));
    }
}
