# Rust implementation

This orphan branch implements the desired-state SDK and its CLI and OpenTofu
provider consumers. Read DESIGN.md before changing boundaries.

Write a behavioral test, observe it fail, implement the behavior, and run the
focused tests before committing. Keep commits green and small; explain the
failure, decision, and validation in commit bodies. Do not maintain a journal.
Use Conventional Commits and SPDX Apache-2.0 source headers.
Run cargo fmt --check, cargo clippy --workspace --all-targets -- -D warnings,
and cargo test --workspace for the implemented workspace.

Preserve other worktrees and live resources. Push this branch to origin/v1;
never force-push or change origin/v1-poc. Do not publish packages or images.
Live tests require explicit configuration and must touch only their owned
resources. Ask before changing system packages, drivers, or kernel settings.
