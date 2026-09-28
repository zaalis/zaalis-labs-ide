use std::sync::Arc;
use zaalis_store::{LegacyImporter, MemorySecretStore, Store};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args_os().skip(1);
    let data_dir = args.next().ok_or("usage: legacy_import_smoke <data-dir>")?;
    if args.next().is_some() {
        return Err("trop d'arguments".into());
    }
    let temporary = tempfile::tempdir()?;
    let store = Store::open(temporary.path().join("zaalis.db"))?;
    let importer = LegacyImporter::new(&store, Arc::new(MemorySecretStore::default()));
    let first = importer.import_data_dir(&data_dir)?;
    let second = importer.import_data_dir(&data_dir)?;
    println!(
        "legacy import OK: users={}, conversations={}, secrets={}, failures={}, idempotent_unchanged={}",
        first.users_imported,
        first.conversations_imported,
        first.secrets_imported,
        first.secrets_failed,
        second.files_unchanged
    );
    for warning in &first.warnings {
        println!(
            "legacy warning: user={}, secret={}, code={}",
            warning.user_id, warning.secret_name, warning.code
        );
    }
    Ok(())
}
