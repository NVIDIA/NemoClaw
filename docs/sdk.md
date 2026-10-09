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
The separate `unverified` list reports supplemental model-catalog or apply-time service-readiness checks; it does not make resource planning incomplete.
The progress callback reports phase changes, `Progress::MutationStarted`, `Progress::Resource`, `Progress::Waiting`, `Progress::Download`, and `Progress::Completed` events.
`MutationStarted` is emitted synchronously after each mutating OpenTofu subprocess launches, before child output is read.
It does not prove that a resource changed or that a change completed.
Track it across all stages of one operation if the application needs to distinguish preflight failure from possible partial mutation.
Resource events adapt OpenTofu's machine-readable UI into fixed resource-kind, action, and status labels with an `elapsed` duration.
They include a bounded, redacted native address when available; raw messages, runtime IDs, and output values are omitted.
Resources of the same kind share a kind label; the optional address distinguishes them.
Waiting events report a fixed operation label when a timed step starts and every 10 seconds while it remains pending.
Completed events contain a fixed `operation` label, an `elapsed` duration, and a `StepOutcome` of `Succeeded`, `Failed`, or `Cancelled`.
They cover bundle verification and OpenTofu commands, including provider readiness checks within apply, and contain no diagnostic payloads.
Download events contain the backend resource kind and name, requested image or model, optional layer ID, phase, and optional completed/total byte counts.
Each event replaces the previous counts for that resource, artifact, and layer; counts are not increments.
Provider downloads reach the callback through a local channel; updates can be dropped and never determine the operation result.
Callbacks run synchronously; keep them short.
A timed step reports when it returns, including cooperative cancellation; dropping its future does not emit a completed event.

## Choose the Lifecycle Operation

| Method | Input and result | Effect |
|---|---|---|
| `plan(&document, &cancel)` | `OperationResult` with changes, deferred prerequisites, and unverified checks | Observes and previews the desired deployment |
| `apply(&document, &cancel)` | `OperationResult` after checked planning/readiness | Can create/change resources, download models, and check readiness without generation |
| `export(&cancel)` | Observed `Document`; call `yaml()` to serialize it | Checks retained intent and observations; does not back up agent data |
| `plan_destroy(&cancel)` | `OperationResult` from retained state | Previews owned workload removal and retained resources |
| `destroy(&cancel)` | `OperationResult` from retained state | Deletes sandbox files/history under the [retention rules](state.md) |

Use the same state directory across CLI and SDK operations for this deployment, with compatible bundles and credentials.
Each operation holds the deployment lock; schedule callers so they do not operate concurrently on that state.
Apply computes its own checked plan; passing a previous preview is not part of the API.

## Discover Before Authoring or Planning

`discovery::plan_queries(&document)` returns the target reads a plan makes for a document, each a `DiscoveryQuery` that names everything that determines its answer.
The [`nemoclaw-discovery`](../crates/nemoclaw-discovery/src/lib.rs) crate answers queries directly with `observe`, without OpenTofu, a bundle, or deployment state; the provider's data sources call the same read functions during a plan.
`observe` reads independent facts concurrently, answers each distinct query once, and records a read that fails as an unknown observation; only cancellation is an error.
An image read for a managed gateway takes its platform from the engine read, as a plan does.
Reads never pull an image or launch a probe container.
Engine, image, hardware, and catalog reads each have a five-second bound; a gateway capability call has thirty seconds.

Use `fabric_catalog::FabricCatalog::bundled()` when target inspection is unavailable.
This snapshot is generated by the pinned Fabric discovery API; it is not evidence that any adapter is installed on the target.
`FabricRequirements::for_sandbox` projects deployment references into the public Fabric configuration.
`assess_image` checks platform, source revision and manifest identity, then asks Fabric's pure planner to validate that configuration against the image's unchanged descriptors.
`nemoclaw_discovery::judge_image` runs this assessment for an image read, in `observe` and in the provider's image data source, preserving missing capability contracts as unknown.

Credential availability stays direct through `inference_discovery::observe_credentials(&document, secrets)`.
Only reference names, availability, and safe reasons are returned.
Plan results include these direct observations in `OperationResult.discovery`, outside OpenTofu provider state.
`observe` and `observe_endpoint` take the caller's secret resolver; the provider's data sources resolve references from their process environment.
These operations do not infer runtime feasibility from an available model name or advertised GPU.

Deployment planning already refreshes selected resources and gateway metadata through their owners.
Reuse those observations and retained bindings for ownership, drift, and storage decisions; a separate unowned-resource scan cannot authorize adoption.
The [provider reference](provider.md#discovery-ownership) defines data-source inputs, sources, limitations, and unknown results for each category.

## Configure a Discovered Fabric Harness

`HarnessKind` is an opaque canonical Fabric adapter identifier, with no named Rust variants or aliases.
Set `harness.kind` to the descriptor's exact `adapter_id`, such as `nvidia.fabric.openclaw`.
A new identifier needs no SDK release or frontend allowlist.
Parser acceptance does not establish installation, compatibility or readiness.

Supply an explicit immutable sandbox image containing the generic launcher and selected Fabric adapter.
The omitted-image default is a generic image pin, not a per-adapter image lookup.
Optional `harness.settings` carries a JSON object, including nested values, to Fabric's `harness.settings` unchanged.
Optional `harness.config` adds public Fabric fields such as workflow, MCP and telemetry.
It cannot replace deployment-owned identities, models, workspace paths or artifact paths.
Model `overrides.settings` likewise passes native settings through without interpretation.
These fields contain configuration and credential references, not inline secrets.
Fabric owns their schemas, validation and native mapping.

The runtime passes the canonical public configuration directly to Fabric's public planner and startup API.
Fabric discovers and dispatches installed adapters; NemoClaw does not resolve descriptor filenames or translate identifiers.
Image labels support passive planning, and installed Fabric discovery governs execution.
The bundled snapshot supplies offline candidates only.

## Read Plan Discovery and Resource Inventory

`plan(&document, &cancel)` returns `OperationResult.discovery` when observations or inventory are available.
The report reuses the checked OpenTofu plan and retained bindings; it does not scan for unowned resources or authorize adoption.
Apply and destroy results omit this field when empty.

| Report field | Meaning |
|---|---|
| `targets` | Safe query inputs, such as engine, image, endpoint, API, compute driver, and credential reference |
| `observations` | Typed engine, hardware, Fabric, inference, gateway, and existing service-readiness results, or an explicit unresolved category |
| `credentials` | Direct reference-availability checks through the application's `Secrets` resolver; values and local credential file paths are excluded |
| `resources` | Resource addresses and validated plan facts, labeled with their `runtime` or `deployment` state scope |

Join `targets` and `observations` by their keys within the same result.
Completed observations retain their source; an endpoint catalog read from the control host does not establish sandbox reachability or working generation APIs.
A later observation replaces an earlier observation of the same query, including its unresolved status.
Known data reads remain visible when another provider read is deferred.

For each resource, `existed` means it appeared in retained state or the refreshed plan's prior value; it is not a health assertion.
`plannedActions` describes the checked action list.
`drifted` records OpenTofu refresh differences, including computed metadata; it can be true with `plannedActions: ["no-op"]` and does not mean the caller requested a configuration change.
`agentRunning`, when present, is the pre-apply Fabric runtime status observed for an agent-configuration resource.
`retained` identifies an established resource retained by the owning teardown compiler, and `reusePlanned` means its plan is unchanged with no reported drift.
These entries contain no resource IDs, specifications, or credential values.
Retaining a workspace does not preserve sandbox files; see [retention](state.md#deletion-and-retention).
Always inspect the operation's `deferred` list before treating the resource preview as complete.
If a missing managed gateway prevents planning the deployment stage, `OperationResult.deferred_resources` lists its compiled resource addresses without assigning actions or adding them to `changes`.
`OperationResult.resource_sources` maps opaque scoped provider registrations to their authored `name` and definition `path`, including route-inline providers.
These source entries describe intent and can precede resource creation; they contain no credential references or values.
`DiscoveryReport::deferred()` reports unresolved engine, hardware, image, and gateway prerequisites; missing credential references are added to `OperationResult.deferred`.
`DiscoveryReport::unverified()` reports unavailable or unverified model catalogs and service readiness not confirmed by plan.
The SDK copies those advisories into `OperationResult.unverified`, retaining full statuses and reasons in `discovery.observations`.
A complete resource plan does not establish healthy services, successful catalog authentication, or working inference.
Apply still enforces its readiness gates, including on unchanged deployments.

## Read Apply Health

`OperationResult.health` contains `SandboxHealth` observations, labeled with the sandbox and its sole agent.
Each observation wraps `RuntimeHealth`: a `supported` flag, an optional `report`, and an optional bridge `reason_code`.
The pinned bridge reports unsupported health with a null report; the SDK rejects unrecognized or proposed health reports.
Other lifecycle operations leave this list empty.
OpenTofu schedules the provider's sandbox completion observation; the SDK reads its recorded result without a second health request.

OpenShell transport failures and invalid reports use the existing error variants without copying raw diagnostics.
A failed apply preserves its original execution error and uses fresh readiness observations to establish whether mutations completed.
No health failure deletes deployment resources.
The compatibility behavior for the current Fabric pin and required agent image is described in [apply health](usage.md#fabric-health-during-apply).

## Resolve Credentials in an Application

`with_secrets` supplies an application-owned `Secrets` implementation; the default resolves nonempty environment variables.
The resolver receives reference names, including gateway TLS references whose values must be file paths.
Resolved values are supplied to the SDK and, as required, its provider subprocess.
OpenTofu initialization and JSON inspection do not resolve deployment credentials.
Export resolves gateway authentication references for provider refresh, without requiring inference or search credentials.
Keep them out of application logs and return typed authentication errors without attaching the secret.

This resolver adapts values already loaded by the application:

```rust
use nemoclaw_sdk::{ObservationError, Secrets};
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

See [lifecycle behavior](usage.md) and [tests](contributing/testing.md).
If an unfinished apply reports different intent, retry the original document with retained state before requesting another change.
If destroy is unfinished, resume destroy; cancellation is not a rollback or a lost-state recovery mechanism.

## Docker Over SSH

Set a managed service's `placement.engine` to an explicit SSH URL, such as `ssh://operator@gpu-box:2222`.
On Unix clients, the provider uses the system OpenSSH client and the remote `docker system dial-stdio` command.
The remote user must be able to run Docker against the intended daemon.

Host keys must already be trusted.
Authentication is noninteractive and uses OpenSSH configuration, keys or its agent.
Passwords in URLs, remote socket paths, URL options and IPv6 literals are not supported; an SSH config alias can select the host.

Each API request has its own SSH connection, with a 10-second connection timeout and a 120-second transport bound.
There is no connection pool or automatic mutation retry.
Errors do not include SSH stderr.

Service placement selects this transport independently of the OpenShell gateway.
Explicit capacity observation uses the provider's host collector to read the SSH host's Linux memory, NVIDIA inventory and Docker storage filesystem.
The collector rejects a Docker context pointing to another host and checks the daemon identity before accepting measurements.
Collector failure never substitutes the client's hardware.
For that observation, a POSIX shell, Docker and `nvidia-smi` must already be available on that host.
No packages are installed.

This transport does not tunnel inference traffic.

## Package Distribution and API Reference

The public Rust API is exported from [the SDK crate](../crates/nemoclaw-sdk/src/lib.rs).
The [deployment implementation](../crates/nemoclaw-sdk/src/deployment/mod.rs) defines the lifecycle methods used above.
See [the provider guide](provider.md) for the bundled OpenTofu boundary and [CLI reference](reference/cli.md) for terminal access.

The SDK crate is not published yet ([#12638](https://github.com/NVIDIA/NemoClaw/issues/12638)).
Generate the API reference from the repository root with `cargo doc --locked -p nemoclaw-sdk --no-deps`; open `target/doc/nemoclaw_sdk/index.html` locally.
The examples above can be compiled as a local application without contacting live resources; running the preview requires the declared services and credentials.
A hosted API reference, a live rehearsal of the application and secret-store integration, and a compatibility policy across releases are tracked in [#12645](https://github.com/NVIDIA/NemoClaw/issues/12645).
