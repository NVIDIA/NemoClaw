# NemoClaw desired-state prototype

This local experiment creates an OpenClaw agent from YAML using Go, OpenTofu,
and OpenShell. It has an independent Git root and contains no source
from the previous NemoClaw implementation. See [DESIGN.md](DESIGN.md) for scope.

The supported prototype commands are:

```sh
nemoclaw plan < deployment.yaml
nemoclaw apply < deployment.yaml
nemoclaw export > exported.yaml
nemoclaw plan --destroy
nemoclaw destroy
```

Each command accepts `--state-dir DIR`, which defaults to `.nemoclaw` in the
current directory. Keep this directory: it contains deployment identity,
unfinished intent, the OpenTofu state, and the provider lock file.
On PowerShell, use `--file deployment.yaml` for plan/apply input. Export and
destroy select the recorded deployment through `--state-dir`; they accept no YAML.

## Build

Install Go 1.27.1, then run:

```sh
go run ./tools/bundle
```

The builder downloads a checksum-pinned OpenTofu artifact and builds
two Go executables. It does not install global tools or contact a provider
registry during deployment. Runtime artifacts are under `dist/OS_ARCH`:

```text
bin/nemoclaw
libexec/tofu
providers/registry.opentofu.org/nvidia/nemoclaw/VERSION/OS_ARCH/
  terraform-provider-nemoclaw_vVERSION
manifest.json
```

Windows executables have `.exe` suffixes. The provider version includes a source
digest so rebuilt development binaries cannot silently reuse an old checksum.
The manifest verifies bundle contents before each operation. It is an integrity
check against the local manifest, not a signed distribution mechanism.

Cross-build with `go run ./tools/bundle --platform windows_amd64`.
The other targets are `linux_amd64`, `linux_arm64`, `darwin_amd64`, and
`darwin_arm64`. Native execution qualification is recorded in
[VALIDATION.md](VALIDATION.md).

## Run the slice

For a complete Linux Docker test setup, follow [LOCAL_TEST.md](LOCAL_TEST.md).

Provide an OpenShell 0.0.116 gateway with one Docker or Podman compute driver.
Use an existing OpenAI-compatible inference endpoint, or the managed Ollama
experiment below. Gateway provisioning and engine installation remain prerequisites.

The OpenClaw image needs the network tools used by OpenShell's supervisor.
Its inherited Docker health check is disabled because it runs outside the
agent's network namespace. NemoClaw checks health through OpenShell execution.
Build the small image layer and obtain its immutable reference:

```sh
docker build -t nc-prototype-openclaw:2026.9.4 image
docker image inspect nc-prototype-openclaw:2026.9.4 --format '{{index .RepoDigests 0}}'
```

For a remote gateway, publish your image to a registry it can reach. The local
image in the example is available only on the Docker engine where it was built.
The base image is pinned; rebuilding the apt layer can produce a different digest.
Always use the resulting digest in your YAML.

Copy [examples/local.yaml](examples/local.yaml), choose a new deployment UUID,
and set the gateway, inference endpoint, image reference, runtime, and model.
The inference endpoint must be reachable from OpenShell's inference execution
environment, which can differ from the CLI's host.

```sh
dist/linux_arm64/bin/nemoclaw plan --file deployment.yaml
dist/linux_arm64/bin/nemoclaw apply --file deployment.yaml
dist/linux_arm64/bin/nemoclaw export > exported.yaml
```

Change `overrides.model` and apply again to update the inference route. The
OpenClaw configuration uses a stable `primary` model alias, so this does not
replace the sandbox.

[examples/managed-ollama.yaml](examples/managed-ollama.yaml) adds an `ollama`
block to the inference provider. It selects a local Unix engine socket, an
existing Docker network, and a pinned Ollama image. The endpoint selects an
explicit private address and port reachable by the CLI, gateway, and sandbox
supervisor. Apply creates an owned container and named model volume, downloads
the selected model, and then configures the OpenShell route. Changing the model
retains previous weights and the sandbox. Follow the managed variant in
[LOCAL_TEST.md](LOCAL_TEST.md) to exercise this Linux Docker topology.

This experiment exposes a repair limitation: if Ollama stops, the separate model
resource cannot refresh its inventory, so OpenTofu cannot plan the service's
restart. Plan and apply stop with a diagnostic and retain state. The live harness
explicitly starts the owned container to continue testing. Automatic repair needs
a different resource boundary or a qualified engine strategy; it is not implemented.

Every apply also sends a one-token inference probe through the sandbox. This
can load a local model or incur inference usage even when the plan is empty.
It does not add to the OpenClaw conversation history.

For credentials, use `credential: {env: INFERENCE_API_KEY}` on the inference
provider, or `credential: {env: GATEWAY_TOKEN}` on the gateway. Values are resolved
at runtime. They do not enter YAML, plans, or OpenTofu state. HTTPS is required
when credentials are configured. Gateway mTLS uses `tls.ca.env`,
`tls.certificate.env`, and `tls.key.env`; those environment values are file paths.
Without credentials, inference HTTP endpoints may use literal private or
loopback addresses. Plaintext gateways must use literal loopback addresses.

## Responsibility boundaries

| Component | Owns |
| --- | --- |
| Go CLI | Strict YAML, compilation, deployment lock, ownership, unfinished intent |
| OpenTofu | Dependency graph, refresh, diff, saved plan, resource state |
| Go provider | OpenShell resources and optional Ollama service/model resources |
| OpenShell SDK and shared resource reader | Configuration observations, mutation reconciliation, conditional writes, sandbox execution |
| Shared Docker/model API readers | Managed runtime configuration, storage identity, and complete model inventory |

Provider refresh and export call the same OpenShell resource reader directly for
workspaces, inference providers, routes, and sandboxes. The provider reuses its
gateway client for observations and mutations; export opens one gateway client
for its configuration reads and agent checks. Reads have bounded deadlines and
contain only non-secret resource attributes.

A complete successful read returns the resource's observed configuration. Only
an explicit OpenShell NotFound for the object, or its parent workspace for a
route, establishes absence. A policy-status NotFound is an observation failure,
not evidence that the sandbox disappeared. Incomplete responses, missing required
attributes, mismatched names, authentication, permission, and transport failures
stop planning with a diagnostic and preserve the last known state. Only confirmed
absence permits the provider's `Resource.Read` to remove an object from OpenTofu
state.

Export uses observed values, verifies ownership, generation, durable identities,
launch configuration, and the active policy, and checks the agent's configuration.
It writes YAML only after all required observations and checks succeed. Export
rejects absence as well as failure; it does not require a healthy inference result.

Managed Ollama uses Docker's API for identity/configuration and Ollama's `/api/tags`
for complete model inventory. Refresh and export share those readers too. The same
owning APIs support gateway capability discovery, ownership preflight, mutation
reconciliation, readiness waits, and active agent/inference probes. Local intent,
OpenTofu state, bundle manifests, and credential references use local sources.
Host observations describe that host; guest and remote resources are read through
the owning API or inside the environment being observed.

## Recovery and limits

`nemoclaw plan --destroy --state-dir DIR` previews teardown without changing runtime
resources. `nemoclaw destroy --state-dir DIR` makes a fresh checked plan and removes
the bound sandbox, route, provider registration, and managed process containers.
Sandbox files and conversation history are deleted with the sandbox. Model weights,
prepared artifacts, gateway data and keys, the bridge, the stopped initializer,
images, local state, and the workspace remain. The result lists retained OpenTofu
resources. There is no data-purge option in this slice.

The workspace stays tracked because upstream workspace deletion can cascade into
untracked routes and memberships. Retained storage also stays tracked; it is never
forgotten merely to make a destroy plan succeed. A later apply of the original YAML
recreates workloads using the retained workspace and data.

Destroy checks both graphs before effects and removes OpenShell workloads before
the managed gateway. It requires observable ownership, generation, configuration,
and durable identities, but does not require healthy inference or its API credential.
A failed delete or observation retains state. Rerun destroy to reconcile; other
operations refuse an unfinished teardown. Repeating completed destroy returns no
changes without trying to contact the removed gateway.

This first destroy slice supports external inference endpoints and managed Spark.
The older combined Ollama container/storage resource is rejected before effects.
An unfinished apply with potentially unbound effects must first be reconciled using
its original YAML. The gateway must be reachable until its workloads are removed.
OpenShell 0.0.116 has no conditional delete ID/version parameter: we verify identity
immediately before its name-addressed delete, but cannot eliminate concurrent
replacement between that read and the request. The local deployment lock does not
lock other gateway clients.

An apply records intent before external effects. If interrupted, retain the state
directory and apply the same YAML. Reads reconcile resources using deployment
UIDs, random generation labels, and recorded resource IDs. Mutations have no
automatic retry loop. A lost response requires another explicit apply.

Ordinary apply rejects resource removal. The managed Spark variant permits replacing
its inference container after an explicit service-specification change, or its
gateway container after a versioned launch-layout correction. Both require
verification of the separately retained storage binding. Unknown fields, inline
credentials, foreign ownership, missing bound services/storage or OpenShell resources, and unsupported
combinations stop the operation. There is no adoption, pruning, migration,
automatic rollback, or lost-state recovery command.

This schema permits one provider, one sandbox, one OpenClaw agent, and one route.
It is a `v1alpha1` subset of the #10904 analysis. The isolated policy allows no
ordinary network egress; OpenShell handles inference routing separately.
Landlock uses upstream `best_effort` mode, so filesystem enforcement depends on
the host kernel. This is not a platform or security qualification release.

Credential rotation under an unchanged environment reference is not detected.
The gateway endpoint is bound to local state; moving a deployment requires a
fresh target and state directory. Export preserves secret references and
portable desired settings, not conversation history, model weights, or agent files.
Windows process cleanup and native macOS/Windows runtime behavior still require
live qualification. Podman support is accepted in the schema but requires its
own live runtime test.

## Managed Spark recipe

[examples/spark.yaml](examples/spark.yaml) declares a managed OpenShell gateway,
the pinned Qwen3.8 Flash Next service, and an OpenClaw agent routed through it.
This backend requires the local Linux ARM64 Docker engine on a GB10 DGX Spark.
Build the local runtime artifact and bundle using [LOCAL_TEST.md](LOCAL_TEST.md),
then apply the YAML. The service downloads and verifies the pinned snapshot,
prepares packed PLE storage, and loads inference with a 30-minute startup budget.
The CLI reports success only after an actual OpenClaw reply through OpenShell.

Model and prepared data survive CLI interruption, stopped inference, and explicit
runtime-image changes. Gateway storage retains its database, signing key,
credential-encryption key, and bridge independently of the gateway container.
A resident supervisor protects host memory after the CLI exits. Its shutdown is latched: Docker does not automatically restart it. Reapply
checks capacity and restarts the same container. An unchanged running apply checks
readiness without replacing resources or repeating completed artifact work.

Planning performs observations only. Before the managed gateway exists, it reports
the OpenShell graph as deferred. Apply first establishes runtime infrastructure,
then plans OpenShell resources using that live gateway. Retain the entire selected
state directory, including its `runtime/` child, for subsequent operations.

## Verify

Go changes follow the JetBrains Modern Go Guidelines through the locally
vendored skill. See [AGENTS.md](AGENTS.md) for the version-aware workflow.

```sh
go test ./...
go vet ./...
go run ./tools/bundle
go test -tags=integration ./internal/engine -count=1
```

Integration tests execute the real OpenTofu and provider binaries
against a gRPC fixture. They cover no-op apply, model changes, export/recreate,
lost responses, cancellation, ownership, policy/configuration drift, and secrets.
Refresh tests invoke OpenTofu directly to verify state removal on confirmed
absence, retained state on observation failures, and recovery without recreation.
The fixture does not implement a sandbox or prove inference works.

To run the opt-in live test, set `NEMOCLAW_LIVE_CONFIG` to an absolute YAML path
and `NEMOCLAW_LIVE_ALTERNATE_MODEL` to another model already available at that
endpoint. Then run `go test -tags=live ./internal/engine -run TestLive -count=1 -v`.
It creates two deployments with fresh UUIDs, exercises real agent replies, and
removes only those deployments after success. A failure retains resources and
recovery state under `.local/live-UUID`. With managed Ollama, the test also exercises
the stopped-service limitation, checks retained cached models, and removes its
owned containers and volumes after success. It downloads the selected models;
the external-endpoint variant requires both models already available.
Test credentials and model costs are
those of the explicitly selected gateway and inference endpoint.

Versions were checked on 2026-09-11: Go 1.27.1, OpenTofu 1.12.6,
OpenShell 0.0.116, OpenClaw 2026.9.4, and Ollama 0.34.0. Binary hashes and URLs
are in [versions.json](versions.json); Go dependencies are pinned in `go.mod`
and `go.sum`. The OpenShell SDK is pinned to the stable gateway's release commit:
the newer unreleased SDK has already removed the inference API used here.
