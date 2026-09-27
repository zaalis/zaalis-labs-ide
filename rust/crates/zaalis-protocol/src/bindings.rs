//! JavaScript bindings generated from the Rust protocol.
//!
//! `rust-agent-bridge.js` and the browser renderers switch on method names and
//! event tags that are *defined here*, in Rust. Until this module existed they
//! were retyped by hand on the JavaScript side, so adding an event meant
//! remembering to edit a file in another language — and forgetting produced a
//! silent failure: the core emitted an event nobody rendered, with no error
//! anywhere.
//!
//! So the strings are enumerated from the types themselves ([`ClientMethod`],
//! [`EventKind`]) and written out as a frozen JavaScript module. The test at
//! the bottom fails when the checked-in file no longer matches, which turns
//! "someone forgot" into a red build.

use crate::event::EventKind;
use crate::method::ClientMethod;
use crate::PROTOCOL_VERSION;
use strum::IntoEnumIterator;

/// Where the generated module lives, relative to the repository root.
pub const BINDINGS_PATH: &str = "interface/script/protocol.generated.js";

/// Every event tag, in declaration order.
pub fn event_tags() -> Vec<&'static str> {
    EventKind::iter().map(<&'static str>::from).collect()
}

/// Every callable method name, in declaration order.
pub fn method_names() -> Vec<&'static str> {
    ClientMethod::iter().map(ClientMethod::as_str).collect()
}

/// Render the JavaScript module.
pub fn render() -> String {
    let mut out = String::new();
    out.push_str(
        "// Généré depuis rust/crates/zaalis-protocol — ne pas modifier à la main.\n\
         // Régénérer : cargo run -p zaalis-protocol --bin generate-bindings\n\
         'use strict';\n\n",
    );
    out.push_str(&format!("const PROTOCOL_VERSION = {PROTOCOL_VERSION};\n\n"));

    out.push_str("// Méthodes JSON-RPC appelables par un client.\nconst METHODS = Object.freeze({\n");
    for method in ClientMethod::iter() {
        out.push_str(&format!(
            "  {}: '{}',\n",
            javascript_key(method.as_str()),
            method.as_str()
        ));
    }
    out.push_str("});\n\n");

    out.push_str("// Valeurs possibles du champ `type` d'un événement.\nconst EVENTS = Object.freeze({\n");
    for tag in event_tags() {
        out.push_str(&format!("  {}: '{}',\n", javascript_key(tag), tag));
    }
    out.push_str("});\n\n");

    out.push_str(
        "const EVENT_TAGS = Object.freeze(Object.values(EVENTS));\n\
         const METHOD_NAMES = Object.freeze(Object.values(METHODS));\n\n\
         module.exports = { PROTOCOL_VERSION, METHODS, METHOD_NAMES, EVENTS, EVENT_TAGS };\n",
    );
    out
}

/// `session.create` → `SESSION_CREATE`, so a typo is a `ReferenceError` on the
/// JavaScript side rather than an `undefined` that silently never matches.
fn javascript_key(name: &str) -> String {
    name.replace(['.', '-'], "_").to_uppercase()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::Event;
    use zaalis_core::{SegmentId, Usage};

    #[test]
    fn every_event_tag_is_enumerated() {
        let tags = event_tags();
        assert!(tags.len() > 10, "trop peu d'événements : {tags:?}");
        assert!(tags.contains(&"text_delta"));
        assert!(tags.contains(&"tool_completed"));
        // Snake case, because that is what serde writes on the wire.
        assert!(
            tags.iter().all(|tag| tag
                .chars()
                .all(|c| c.is_ascii_lowercase() || c == '_')),
            "{tags:?}"
        );
    }

    #[test]
    fn the_generated_tag_matches_what_serde_actually_writes() {
        // The whole point is that the JavaScript side switches on these
        // strings. If strum and serde ever disagreed, the bindings would be
        // confidently wrong — worse than being absent.
        let event = Event::TextDelta {
            segment_id: SegmentId::from_raw("seg_1"),
            text: "x".into(),
        };
        let json = serde_json::to_value(&event).expect("serialize");
        assert_eq!(json["type"], "text_delta");
        assert_eq!(<&'static str>::from(EventKind::TextDelta), "text_delta");

        let completed = Event::TurnCompleted {
            usage: Usage::default(),
            summary: None,
        };
        assert_eq!(
            serde_json::to_value(&completed).expect("serialize")["type"],
            <&'static str>::from(EventKind::TurnCompleted)
        );
    }

    #[test]
    fn every_method_round_trips_through_its_wire_name() {
        for method in ClientMethod::iter() {
            assert_eq!(
                ClientMethod::parse(method.as_str()),
                Some(method),
                "{method:?} ne se relit pas"
            );
        }
        assert_eq!(method_names().len(), ClientMethod::iter().count());
    }

    #[test]
    fn the_rendered_module_is_valid_and_complete() {
        let rendered = render();
        assert!(rendered.contains("SESSION_CREATE: 'session.create'"));
        assert!(rendered.contains("TEXT_DELTA: 'text_delta'"));
        assert!(rendered.contains("module.exports"));
        for tag in event_tags() {
            assert!(rendered.contains(&format!("'{tag}'")), "{tag} absent");
        }
    }

    /// Fails when the checked-in bindings are stale.
    ///
    /// This is the test that makes the generator load-bearing: without it the
    /// generated file is a snapshot someone forgot to refresh.
    #[test]
    fn the_checked_in_bindings_are_up_to_date() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .join(BINDINGS_PATH);
        let Ok(on_disk) = std::fs::read_to_string(&path) else {
            panic!(
                "bindings absents : {} — lancez `cargo run -p zaalis-protocol --bin generate-bindings`",
                path.display()
            );
        };
        assert_eq!(
            on_disk.replace("\r\n", "\n"),
            render(),
            "bindings périmés — lancez `cargo run -p zaalis-protocol --bin generate-bindings`"
        );
    }
}
