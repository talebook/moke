This small crate compiles the production HTTP transport, deadline stream and
WebSocket events modules by path. It exercises real loopback TCP sockets without
the GUI/Reader toolchain:

```sh
cargo test --manifest-path tests/extension-transport/Cargo.toml --locked -- --test-threads=1
```

The HTTP fixture supplies a synthetic authenticated handler; it does not compile
Tauri or test the application's REST routing. Most timeout fixtures use shorter
budgets to keep the tests quick. The full-capacity WebSocket recovery test uses
the production 5-second deadline and the real event server.

The same tests are included in the normal `src-tauri` library test suite. This
crate is a portable companion, not evidence of a complete native build, Reader
flow or mobile device compatibility.
