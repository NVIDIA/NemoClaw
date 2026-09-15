# Tests

The pinned Rust toolchain needs a C linker and `protoc` on PATH (or `PROTOC`
pointing to it) to build the provider protocol. This branch was validated with
protoc 36.1 on Linux ARM64. No host package installation is part of the tests.

```sh
cargo test --workspace
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
```

## CI caches

Native CI disables incremental compilation but retains the existing debug-symbol
settings. The dependency cache keeps third-party build artifacts for both debug
and target-specific release profiles. Workspace libraries, test executables,
workspace binaries, and installed Cargo binaries are excluded. Dependency caches
are keyed by platform and the Rust toolchain, manifests, lockfile, and build
environment, rather than each source commit.

The checksum-addressed OpenTofu archives in `.build/downloads` use a separate
cache keyed by platform and `versions.json`. Source-only changes reuse that
archive cache without uploading it again. Bundle assembly still verifies every
archive checksum and builds a fresh bundle; `dist` is not cached. Protobuf's
compiler is still downloaded and checksum-verified during tool setup.

## Local coverage

Install the pinned coverage tool and the LLVM tools for the repository's Rust
version once:

```sh
cargo install cargo-llvm-cov --version 0.9.1 --locked
rustup component add llvm-tools-preview
```

Then run from the repository root:

```sh
cargo coverage
```

Open `target/llvm-cov/html/index.html` for the report. This alias runs the normal
workspace tests with coverage instrumentation and excludes the private
`nemoclaw-e2e` fixture implementation from the report; its tests still run and
contribute coverage to the other crates. Ignored bundle and live tests remain
opt-in. Prebuilt runtime bundles are not instrumented by this command.

Coverage artifacts stay under the Git-ignored `target/` directory. Coverage uses
a separate build directory, so the first run recompiles dependencies. On a
memory-constrained host, use `CARGO_BUILD_JOBS=2 cargo coverage`. The same linker
and `PROTOC` prerequisites apply as for ordinary tests.

To print a summary from the collected data without rerunning tests:

```sh
cargo llvm-cov report --ignore-filename-regex nemoclaw-e2e
```

There is no coverage threshold or CI coverage job.

## Integration and live qualification

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
  cargo test -p nemoclaw-e2e --test deployment --test fabric_deployment -- --ignored
```

CI runs the fixture lifecycle tests with `--test-threads=2`. Each Fabric
harness is an independent ignored test with its own temporary state and gRPC
fixture. To qualify one harness, append its test name, for example
`-- --ignored harness_codex`; to run all harnesses with CI's concurrency bound,
use `-- --ignored --test-threads=2`.

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
the pinned Go reference, covering the ten retained Fabric launch contracts. The
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

Run the maintained lifecycle test with absolute paths, separately from the image
upgrade test:

```sh
NEMOCLAW_LIVE_SPARK_CONFIG=/absolute/path/to/spark.yaml \
NEMOCLAW_LIVE_SPARK_STATE=/absolute/path/to/state \
NEMOCLAW_TEST_BUNDLE=/absolute/path/to/immutable/bundle \
  cargo test -p nemoclaw-e2e --test spark spark_apply_export_capacity -- --ignored
```

Use a dedicated immutable bundle copy for a long live run. Rebuilding `dist`
replaces development artifacts and is not safe while an operation still uses
that directory. [Agent fixture instructions](agents.md) cover native messaging
and Fabric's offline harness qualification.

The optional `fabric_live` test accepts absolute
`NEMOCLAW_LIVE_FABRIC_CONFIG`, `NEMOCLAW_LIVE_FABRIC_STATE`, and
`NEMOCLAW_TEST_BUNDLE` paths. Use a dedicated UID and state directory with an
external gateway and inference endpoint. It applies the deployment, checks
unchanged apply and export/reapply, exercises the native agent/Fabric SDK, and
destroys its owned registrations and sandbox. It retains JSON evidence and the
workspace. The hosted Fabric runtime must keep its identity throughout native
access and reconciliation. This test makes a real model request; ordinary apply
does not inject a Fabric conversation.

Use the separate `spark_image_change` test filter with the same three Spark
paths to qualify an explicit runtime image upgrade. The new YAML may differ
from retained intent only by its inference image pin. The test requires complete
artifact receipts, allows an established stopped service, and verifies that plan
is read-only and apply replaces only that process while preserving all other
bindings and prepared data. It retains `spark-artifact-validation.json`.

Runtime separation has focused checks:

```sh
cargo test -p nemoclaw-runtime
cargo test -p nemoclaw-sdk --test runtime_boundaries
```

The supervisor tests use an ordinary owned process and validated memory thresholds,
without a Spark document. They exercise readiness, pressure, failed observations,
cancellation, and the loading deadline. Cancellation must leave a neighboring
process alive. The backend HTTP fixture rejects unavailable, unauthorized, and
redirect responses before accepting readiness. The executable test checks the
new name and both environment contracts without starting model work.

The recipe test protects the preparation identity and exact pre-refactor vLLM
launch arguments, and rejects unqualified model/backend/hardware combinations.
The live image-change test above is the deployment acceptance gate: the new image
must preserve cached artifacts and independent bindings, return an agent response,
and produce no changes on subsequent apply and export/reapply. A fixture process
proves supervisor independence; it does not qualify another real serving backend.

The generic model lifecycle has a separate opt-in live test. Supply a fresh,
owned deployment configuration with a free gateway port and subnet, its state
directory, and an immutable bundle:

```sh
NEMOCLAW_TEST_BUNDLE=/absolute/path/to/bundle \
NEMOCLAW_LIVE_MODEL_CONFIG=/absolute/path/to/vllm.yaml \
NEMOCLAW_LIVE_MODEL_STATE=/absolute/path/to/state \
  cargo test -p nemoclaw-e2e --test model_live \
    selected_model_apply_export_and_watchdog_recovery -- --ignored --nocapture
```

It checks initial apply and an actual agent reply, unchanged apply, export and
reapply, absence of PLE preparation, and an operator-triggered watchdog stop.
Explicit recovery must preserve resource identities and the snapshot receipt.
Successful completion destroys workloads, retains storage, and writes
`model-proof.json` in the supplied state directory. Failures retain resources
for diagnosis; reconcile that state before starting another run. Retained gateway
storage includes its network, so a different deployment needs a different subnet.

For an established deployment whose gateway is running, select
`selected_model_continues_from_retained_state` with the same environment variables.
It runs the same lifecycle assertions without the fresh-plan assertion. Run only
one of these live tests against a given deployment at a time.

After intentional destroy, apply the retained configuration first. A read-only
plan cannot observe workspace resources through a stopped gateway and will ask
for that explicit reconciliation.

### SSH engine transport

The SDK's `ssh_live` tests are opt-in. Set `NEMOCLAW_TEST_SSH_ENGINE` to an
explicit SSH URL and `NEMOCLAW_TEST_ENGINE_ID` to an independently observed daemon
ID, then run `cargo test -p nemoclaw-sdk --test ssh_live ssh_observes -- --ignored`.
Run `ssh_failure` separately against rejected authentication, an untrusted host
key, or an unavailable endpoint; it must report observation failure, not absence.
The `ssh_upload` test additionally requires `NEMOCLAW_TEST_SSH_CONTAINER`, the
full ID of a stopped container labeled `nemoclaw.experiment=ssh-transport`. It
writes `/tmp/ssh-proof` and checks the streamed archive and unchanged identity.
The caller owns fixture setup and cleanup; never target an unrelated container.

The `remote_service` E2E fixture exercises the bundled CLI/provider boundary
with an isolated Docker-over-SSH simulator and OpenShell fixture. Run
`cargo test -p nemoclaw-e2e --test remote_service -- --ignored` with
`NEMOCLAW_TEST_BUNDLE` set. It checks read-only planning, missing/low capacity,
failed startup recovery, no-op, export/reapply, failed observation and daemon
retargeting without recreation, and retained storage on destroy. Its readiness
and artifact receipts are simulated; it does not download or serve a model.
The SDK `ssh_capacity` live test exercises the fixed collector on an explicitly
selected Linux ARM64 NVIDIA host without provisioning resources.

The existing `fabric_live` test also accepts an external gateway with a managed
SSH inference service. Managed applies retain their active agent-reply check,
including applies with no resource changes. The test checks managed runtime
bindings as well as the hosted agent identity across export/reapply and destroys
only the supplied deployment. The
[two-daemon evidence](validation/rust-dual-daemon-linux-arm64.json) records its
live rootless Podman run, controlled download interruption, protection trip,
engine retarget rejection, and retained model data.
