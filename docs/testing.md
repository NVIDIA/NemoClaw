# Tests

The pinned Rust toolchain needs a C linker and `protoc` on PATH (or `PROTOC`
pointing to it) to build the provider protocol. This branch was validated with
protoc 36.1 on Linux ARM64. No host package installation is part of the tests.

```sh
cargo test --workspace
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
```

The private `nemoclaw-e2e` crate runs the actual provider protocol through
OpenTofu 1.12.6. Supply an absolute executable path explicitly:

```sh
NEMOCLAW_TEST_TOFU=/absolute/path/to/tofu \
  cargo test -p nemoclaw-e2e --test provider_protocol -- --ignored
```

These tests launch a fixture provider built by that crate and use temporary
files. They create no Docker, OpenShell, or inference resources. The fixture
provider is not a production bundle component. Runtime bundle and live backend
qualification remain separate acceptance gates.

Build the production provider and qualify its full OpenShell graph against the
local gRPC fixture:

```sh
cargo build -p nemoclaw-provider --bin terraform-provider-nemoclaw
NEMOCLAW_TEST_TOFU=/absolute/path/to/tofu \
NEMOCLAW_TEST_PROVIDER=/absolute/path/to/terraform-provider-nemoclaw \
  cargo test -p nemoclaw-e2e --test opentofu_openshell -- --ignored
```
