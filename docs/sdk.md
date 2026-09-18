<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Programmatic Access

`nemoclaw-sdk` owns the same operations used by the CLI.
Callers supply a verified runtime bundle, a persistent state directory, and a cancellation token.
The SDK runs bundled OpenTofu and its provider as child processes; it is not an embedded OpenTofu engine.

## Build a Local Application

Use a path dependency on this checkout; the crate is marked `publish = false` and these instructions do not assume a registry release.
Use the Rust toolchain from [the build guide](build.md), and build a matching native bundle before making deployment calls.
In your application's `Cargo.toml`, replace the path below with the absolute path to this checkout:

```toml
[dependencies]
nemoclaw-sdk = { path = "/path/to/NemoClaw/crates/nemoclaw-sdk" }
tokio = { version = "1", features = ["macros", "rt-multi-thread", "signal"] }
serde_json = "1"
```

The SDK build also needs the pinned Protocol Buffers compiler and native C toolchain described in the build guide.
An application outside this workspace resolves its own dependencies and lockfile.
Keep its SDK checkout, built bundle, and input schema matched; the `v1alpha1` API string alone does not establish compatibility.

## Preview a Deployment

The program below reads `deployment.yaml`, uses the state directory `.local/deployment`, and selects a Linux ARM64 bundle.
Replace the bundle path with the matching target or a preserved complete bundle.
Run from a directory where those paths resolve and supply the configuration's environment credential references to the application process.
Plan can write local state and contact services, but does not create runtime resources or invoke inference.

```rust
use nemoclaw_sdk::{CancellationToken, Deployment, config::Document};
use std::{path::Path, sync::Arc};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let document = Document::parse(std::fs::File::open("deployment.yaml")?)?;
    let deployment = Deployment::new(Path::new(".local/deployment"), Path::new("dist/linux_arm64"))
        .with_progress(Arc::new(|event| eprintln!("Deployment progress: {event:?}")));
    let cancel = CancellationToken::new();
    let signal = cancel.clone();
    tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            signal.cancel();
        }
    });
    let preview = deployment.plan(&document, &cancel).await?;
    println!("{}", serde_json::to_string_pretty(&preview)?);
    Ok(())
}
```

Inspect both `changes` and `deferred` in the result.
An empty change list with deferred checks is not a complete no-change plan.
The progress callback reports phase changes, `Progress::Resource`, `Progress::Waiting`, and `Progress::Completed` events.
Resource events adapt OpenTofu's machine-readable UI into fixed resource-kind, action, and status labels with an `elapsed` duration; raw messages, addresses, IDs, and output values are omitted.
Resources of the same kind share a label.
Waiting events report a fixed operation label when a timed step starts and every 10 seconds while it remains pending.
Completed events contain a fixed `operation` label, an `elapsed` duration, and a `StepOutcome` of `Succeeded`, `Failed`, or `Cancelled`.
They cover bundle verification, OpenTofu commands, sandbox/runtime readiness, and the `fabric.health` request, and contain no diagnostic payloads.
Callbacks run synchronously; keep them short.
A timed step reports when it returns, including cooperative cancellation; dropping its future does not emit a completed event.

## Choose the Lifecycle Operation

| Method | Input and result | Effect |
|---|---|---|
| `plan(&document, &cancel)` | `OperationResult` with changes and any deferred checks | Observes and previews the desired deployment |
| `apply(&document, &cancel)` | `OperationResult` after checked planning/readiness | Can create/change resources, download models, and check readiness without generation |
| `export(&cancel)` | Observed `Document`; call `yaml()` to serialize it | Checks retained intent and observations; does not back up native data |
| `plan_destroy(&cancel)` | `OperationResult` from retained state | Previews owned workload removal and retained resources |
| `destroy(&cancel)` | `OperationResult` from retained state | Deletes sandbox files/history under the [retention rules](state.md) |

Use the same state directory across CLI and SDK operations for this deployment, with compatible bundles and credentials.
Each operation holds the deployment lock; schedule callers so they do not operate concurrently on that state.
Apply computes its own checked plan; passing a previous preview is not part of the API.

## Read Apply Health

`OperationResult.health` contains `SandboxHealth` observations, labeled with the sandbox and its sole agent.
Each observation wraps `RuntimeHealth`: a `supported` flag, an optional Fabric `report`, and an optional bridge `reason_code`.
The report uses Fabric's field names and retains check timestamps and dependency results.
Other lifecycle operations leave this list empty.

`Error::Health { health }` retains the observation when supported health cannot establish readiness.
Socket failures inside the host bridge also return `Error::Health`, with `health_transport_error` or `health_transport_timeout`.
Outer OpenShell transport failures and invalid reports use the existing error variants without copying raw diagnostics.
No health failure deletes deployment resources.
The compatibility behavior for the current Fabric pin and required agent image is described in [apply health](usage.md#fabric-health-during-apply).

## Resolve Credentials in an Application

`with_secrets` supplies an application-owned `openshell::Secrets` implementation; the default resolves nonempty environment variables.
The resolver receives reference names, including gateway TLS references whose values must be file paths.
Resolved values are supplied to the SDK and, as required, its provider subprocess.
Keep them out of application logs and return typed authentication errors without attaching the secret.

This resolver adapts values already loaded by the application:

```rust
use nemoclaw_sdk::{ObservationError, openshell::Secrets};
use std::collections::BTreeMap;

struct ApplicationSecrets(BTreeMap<String, String>);

impl Secrets for ApplicationSecrets {
    fn resolve(&self, reference: &str) -> Result<String, ObservationError> {
        self.0.get(reference)
            .filter(|value| !value.is_empty())
            .cloned()
            .ok_or(ObservationError::Authentication)
    }
}
```

Attach it with `deployment.with_secrets(Arc::new(ApplicationSecrets(values)))`, where `values` is the application's map of reference names to values.
The application owns how that map is obtained, who can read it, and its lifetime in memory.
The resolver does not revoke credentials installed in OpenShell or erase generated keys in retained runtime storage; see [credential ownership](security.md#credentials-and-authentication).

## Handle Failure and Cancellation

Errors retain observation uncertainty and redact resolved values.
Cancellation leaves state available for explicit reconciliation; it does not delete resources or stop the independent DGX Spark memory supervisor.

Keep each selected bundle immutable while operations use it.
Use a separate bundle copy for a deployment operation when rebuilding development artifacts.
There is no SDK auto-retry of ambiguous mutations and no background reconciliation loop.

See [lifecycle behavior](usage.md) and [tests](testing.md).
If an unfinished apply reports different intent, retry the original document with retained state before requesting another change.
If destroy is unfinished, resume destroy; cancellation is not a rollback or a lost-state recovery mechanism.

## Docker Over SSH

On Unix clients, `docker::Engine::connect("ssh://operator@gpu-box:2222")` selects Docker through the system OpenSSH client and the remote `docker system dial-stdio` command.
Connection construction is lazy.
The remote user must be able to run Docker against the intended daemon.

Host keys must already be trusted.
Authentication is noninteractive and uses OpenSSH configuration, keys or its agent.
Passwords in URLs, remote socket paths, URL options and IPv6 literals are not supported in this slice; an SSH config alias can select the host.

Each API request has its own SSH connection, with a 10-second connection timeout and a 120-second transport bound.
There is no connection pool or automatic mutation retry.
Errors do not include SSH stderr.

SSH engines default to an unavailable remote capacity observer.
Supply a typed `HostObserver` with `with_host_observer` when remote measurements are available; local `/proc`, GPU and disk data are never substituted.
Existing engine ID and resource ownership checks apply to observations obtained over SSH.

Managed service placement now selects this transport independently of the OpenShell gateway.
For an explicit SSH service, both SDK preflight and the provider subprocess use the fixed `SshHost` collector, unless an in-process SDK caller supplies its own observer.
Plain `Engine::connect` retains the unavailable default.

The collector reads the SSH host's Linux memory, NVIDIA inventory and Docker storage filesystem, rejects a Docker context pointing to another host, and tags measurements with the daemon identity for comparison.
Python 3, Docker and `nvidia-smi` must already be available on that host.
No packages are installed.

This transport does not tunnel inference traffic.

## Package Distribution and API Reference

The public Rust API is exported from [the SDK crate](../crates/nemoclaw-sdk/src/lib.rs).
The [deployment implementation](../crates/nemoclaw-sdk/src/deployment/mod.rs) defines the lifecycle methods used above.
See [the provider guide](provider.md) for the bundled OpenTofu boundary and [CLI reference](reference/cli.md) for terminal access.

Published package installation and version-selection instructions: **TBD**.
Generate the API reference from the repository root with `cargo doc --locked -p nemoclaw-sdk --no-deps`; open `target/doc/nemoclaw_sdk/index.html` locally.
The examples above can be compiled as a local application without contacting live resources; running the preview requires the declared services and credentials.
Hosted Rust API reference and a live rehearsal of the application/secret-store integration: **TBD**.
Compatibility policy across SDK releases and migration from the earlier TypeScript lifecycle package: **TBD**.
