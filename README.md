# NemoClaw

Rust desired-state SDK, CLI, and OpenTofu provider on an independent branch.
The implementation has reached the experimental scope of `v1-poc` at
`b549ccd43e6102b72aa9c65ee17abfe3c429fc0b`, including its documented limitations.

The SDK exposes `plan`, `apply`, `export`, and `destroy`; the CLI delegates the
same four commands to it. Qualification covers real OpenTofu, five native bundle
targets, managed OpenShell, Ollama, Spark model preparation and inference,
watchdog recovery, and the retained native agent/Fabric interfaces.
See the [parity evidence and limits](docs/validation/README.md) and
[architecture findings](RFC-desired-state.md). Project adoption remains a separate
decision; this branch is an experiment.
See [build instructions](docs/build.md), [CLI and lifecycle usage](docs/usage.md),
[SDK access](docs/sdk.md), [agent runtimes](docs/agents.md), and
[test instructions](docs/testing.md).

Run `cargo test --workspace`, `cargo fmt --check`, and
`cargo clippy --workspace --all-targets -- -D warnings`.

The toolchain is pinned in rust-toolchain.toml. Changes follow red/green tests
and small commits; commit bodies explain decisions and validation.
