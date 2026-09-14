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

Managed Ollama's deterministic bundle test uses local Docker and model HTTP
fixtures, not live containers or model downloads:

```sh
NEMOCLAW_TEST_BUNDLE=/absolute/path/to/bundle \
  cargo test -p nemoclaw-e2e --test ollama -- --ignored
```

Authenticated OpenShell, stalled exec streams, and launch compatibility run in
the default workspace suite. `agent_compatibility` uses fixtures generated from
the pinned Go reference, covering all eleven native launch contracts. The
`tls` test generates certificates and verifies both trust directions and bearer
references through a real TLS connection.

The native CI matrix builds and executes bundles on Linux ARM64/x64, macOS
ARM64/x64, and Windows x64. CI's protocol and lifecycle fixtures do not establish
local Docker, Podman, GPU, or real model availability on those platforms. Build
logs and runtime evidence must be reported separately.

For complete Spark qualification, use the concrete `examples/spark.yaml` on an
available GB10 host. Change its deployment UID, gateway port, and network only
when creating a separate experiment. Build the pinned local runtime artifact
first, check capacity, and preserve the same state directory throughout:

```sh
nemoclaw plan --state-dir .local/spark --file examples/spark.yaml
nemoclaw apply --state-dir .local/spark --file examples/spark.yaml
nemoclaw export --state-dir .local/spark > .local/spark-export.yaml
nemoclaw apply --state-dir .local/spark --file .local/spark-export.yaml
```

A successful Spark apply includes an actual agent response through OpenShell.
Unchanged apply must have no resource changes and retain process/storage IDs and
artifact receipts. The download and preparation fixtures cover deterministic
interruption boundaries; live evidence also records an interrupted download and
explicit recovery. Test capacity rejection with synthetic capacity observations,
not deliberate host exhaustion. Test the resident supervisor's SIGUSR1 operator
trip only on an explicitly owned experiment, then confirm that it remains stopped
until explicit apply. Do not confuse that controlled trip with a naturally
occurring host-pressure event.

Use a dedicated immutable bundle copy for a long live run. Rebuilding `dist`
replaces development artifacts and is not safe while an operation still uses
that directory. [Agent fixture instructions](agents.md) cover native messaging
and Fabric's offline harness qualification.
