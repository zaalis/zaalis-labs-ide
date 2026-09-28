#[cfg(unix)]
fn main() {
    use nono::{AccessMode, CapabilitySet, Sandbox};
    use std::os::unix::process::CommandExt;

    let mut args = std::env::args_os().skip(1);
    let first = args.next();
    if first.as_deref() == Some(std::ffi::OsStr::new("--probe")) {
        let support = Sandbox::support_info();
        println!("{support:?}");
        std::process::exit(if Sandbox::is_supported() { 0 } else { 77 });
    }
    let Some(workspace) = first else {
        eprintln!("workspace sandbox absent");
        std::process::exit(64);
    };
    let Some(command) = args.next() else {
        eprintln!("commande sandbox absente");
        std::process::exit(64);
    };
    if args.next().is_some() {
        eprintln!("arguments sandbox surnumeraires");
        std::process::exit(64);
    }
    let workspace = std::path::PathBuf::from(workspace);
    if !workspace.is_absolute() || !workspace.is_dir() {
        eprintln!("workspace sandbox invalide");
        std::process::exit(64);
    }
    let mut capabilities = CapabilitySet::new();
    for path in ["/usr", "/bin", "/lib", "/lib64", "/etc/ssl/certs"] {
        if std::path::Path::new(path).exists() {
            capabilities = match capabilities.allow_path(path, AccessMode::Read) {
                Ok(next) => next,
                Err(error) => {
                    eprintln!("politique sandbox invalide pour {path}: {error}");
                    std::process::exit(77);
                }
            };
        }
    }
    for path in ["/etc/ld.so.cache", "/etc/localtime", "/dev/urandom"] {
        if std::path::Path::new(path).is_file() {
            capabilities = match capabilities.allow_file(path, AccessMode::Read) {
                Ok(next) => next,
                Err(error) => {
                    eprintln!("politique sandbox invalide pour {path}: {error}");
                    std::process::exit(77);
                }
            };
        }
    }
    if std::path::Path::new("/dev/null").exists() {
        capabilities = match capabilities.allow_file("/dev/null", AccessMode::ReadWrite) {
            Ok(next) => next,
            Err(error) => {
                eprintln!("politique sandbox invalide pour /dev/null: {error}");
                std::process::exit(77);
            }
        };
    }
    capabilities = match capabilities.allow_path(&workspace, AccessMode::ReadWrite) {
        Ok(next) => next.block_network(),
        Err(error) => {
            eprintln!("politique workspace invalide: {error}");
            std::process::exit(77);
        }
    };
    if let Err(error) = Sandbox::apply(&capabilities) {
        eprintln!("sandbox strict refuse: {error}");
        std::process::exit(77);
    }
    let error = std::process::Command::new("/bin/sh")
        .args(["-c", command.to_string_lossy().as_ref()])
        .current_dir(workspace)
        .exec();
    eprintln!("exec sandbox impossible: {error}");
    std::process::exit(126);
}

#[cfg(not(unix))]
fn main() {
    eprintln!("zaalis-sandbox est reserve aux plateformes Unix");
    std::process::exit(77);
}
