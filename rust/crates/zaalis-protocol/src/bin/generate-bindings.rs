//! Write the JavaScript protocol bindings.
//!
//! Run from the repository root: `cargo run -p zaalis-protocol --bin
//! generate-bindings`. The companion test in `bindings.rs` fails when the
//! checked-in file is out of date, so this is never optional after touching a
//! method or an event.

use std::path::PathBuf;
use zaalis_protocol::bindings::{render, BINDINGS_PATH};

fn main() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let target = root.join(BINDINGS_PATH);
    if let Some(parent) = target.parent() {
        if let Err(error) = std::fs::create_dir_all(parent) {
            eprintln!("generate-bindings: {} : {error}", parent.display());
            std::process::exit(1);
        }
    }
    if let Err(error) = std::fs::write(&target, render()) {
        eprintln!("generate-bindings: {} : {error}", target.display());
        std::process::exit(1);
    }
    println!("écrit {}", target.display());
}
