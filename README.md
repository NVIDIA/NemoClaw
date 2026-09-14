# NemoClaw

Rust desired-state SDK and CLI, under construction on an independent branch.
The Go implementation and its validation remain on `v1-poc`.

See [DESIGN.md](DESIGN.md) for the accepted scope and implementation sequence.
The SDK currently exposes checked durable bindings and refresh semantics.
Runtime provisioning and provider protocol qualification are not implemented yet.

Run `cargo test --workspace`, `cargo fmt --check`, and
`cargo clippy --workspace --all-targets -- -D warnings`.

The toolchain is pinned in rust-toolchain.toml. Changes follow red/green tests
and small commits; commit bodies explain decisions and validation.
