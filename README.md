# NemoClaw

Rust desired-state SDK and CLI, under construction on an independent branch.
The Go implementation and its validation remain on `v1-poc`.

See [DESIGN.md](DESIGN.md) for the accepted scope and implementation sequence.
The SDK exposes `plan`, `apply`, `export`, and `destroy`; the CLI delegates the
same four commands to it. The external OpenShell lifecycle is qualified through
real OpenTofu and a local gRPC fixture, including interrupted creation, readiness
failure, observation failure, export/reapply, and resumable destroy. Managed
Docker, Ollama, and Spark runtimes are still being ported; this is not yet parity.
See [test instructions](docs/testing.md).

Run `cargo test --workspace`, `cargo fmt --check`, and
`cargo clippy --workspace --all-targets -- -D warnings`.

The toolchain is pinned in rust-toolchain.toml. Changes follow red/green tests
and small commits; commit bodies explain decisions and validation.
