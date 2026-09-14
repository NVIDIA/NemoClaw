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

The SDK/CLI lifecycle tests require a verified native bundle (manifest plus CLI,
OpenTofu, and production provider). They use only the local gRPC fixture:

```sh
NEMOCLAW_TEST_BUNDLE=/absolute/path/to/bundle \
  cargo test -p nemoclaw-e2e --test deployment -- --ignored
```

These tests cover shared SDK/CLI state, interrupted creation, unchanged apply,
readiness failure without replacement, failed observation without state loss,
export/reapply, interrupted destroy, and retained workspace recovery. The
fixture returns protocol responses; it does not establish live agent inference.

Read-only live storage qualification requires an explicit OpenTofu runtime state
file containing the experiment's retained inference volume binding:

```sh
NEMOCLAW_TEST_RUNTIME_STATE=/absolute/path/to/runtime/terraform.tfstate \
  cargo test -p nemoclaw-sdk --test managed_live \
  retained_inference_volume_preserves_its_reference_binding -- --ignored
```

The separate `existing_spark_runtime_bindings_are_observed_without_mutations`
test requires both gateway and inference container bindings to exist. Neither
read-only test creates resources or establishes live agent inference. Retained
volume evidence is in `validation/rust-storage-linux-arm64.json`.
