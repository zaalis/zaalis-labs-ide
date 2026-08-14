use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use zaalis_agentd::providers::{build_pool, ProviderSecrets};
use zaalis_agentd::transport::{serve_stdio, serve_websocket};
use zaalis_agentd::Daemon;
use zaalis_core::{Result, ZaalisError};
use zaalis_store::Store;
use zeroize::Zeroizing;

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("agentd: {}", error.message);
        std::process::exit(1);
    }
}

async fn run() -> Result<()> {
    let data_root = data_root()?;
    let store = Arc::new(Store::open(data_root.join("state.db"))?);
    let daemon = Arc::new(Daemon::new(
        build_pool(ProviderSecrets::from_environment())?,
        store,
        data_root.join("checkpoints"),
    )?);
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        None | Some("--stdio") => serve_stdio(daemon).await,
        Some("--ws") => {
            let address: SocketAddr = args
                .next()
                .unwrap_or_else(|| "127.0.0.1:0".into())
                .parse()
                .map_err(|_| ZaalisError::config("adresse WebSocket invalide"))?;
            let token = std::env::var("ZAALIS_AGENTD_TOKEN")
                .map_err(|_| ZaalisError::config("ZAALIS_AGENTD_TOKEN requis en mode WebSocket"))?;
            serve_websocket(daemon, address, Zeroizing::new(token)).await
        }
        Some(other) => Err(ZaalisError::invalid(format!(
            "argument agentd inconnu : {other}"
        ))),
    }
}

fn data_root() -> Result<PathBuf> {
    if let Some(path) = std::env::var_os("ZAALIS_AGENTD_DATA_DIR") {
        return Ok(PathBuf::from(path));
    }
    #[cfg(target_os = "windows")]
    let base = std::env::var_os("LOCALAPPDATA");
    #[cfg(not(target_os = "windows"))]
    let base = std::env::var_os("XDG_DATA_HOME").or_else(|| {
        std::env::var_os("HOME")
            .map(|home| PathBuf::from(home).join(".local/share").into_os_string())
    });
    base.map(|path| PathBuf::from(path).join("zaalis/agentd"))
        .ok_or_else(|| ZaalisError::config("répertoire de données utilisateur introuvable"))
}
