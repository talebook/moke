// Exercise the exact host-side file writer without compiling the GUI/Reader
// dependency graph. serde_json is already a dev-dependency of this test crate.
#[path = "../../src/discovery_registry.rs"]
mod registry;
