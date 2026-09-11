# Desired-state prototype validation

Evidence date: 2026-09-11. Tested implementation and live harness:
`706f228877`, with bundle `0.1.0-dev.g17f54bad65eb`.
This is local experiment evidence, not supported-platform or release qualification.

## Native runtime evidence

The managed inference scenario passed on Linux ARM64 with Docker 29.2.1,
OpenShell 0.0.116, OpenClaw 2026.9.4, and Ollama 0.34.0. It used an existing
local gateway, Docker engine, and network. NemoClaw created six resources:
workspace, inference registration, route, sandbox, Ollama service with a named
volume, and model installation.

| Scenario | Observed result |
| --- | --- |
| Create from YAML | Container, model, and working OpenClaw agent created |
| Apply unchanged YAML | Zero resource changes; inference checked |
| Stop the Ollama container and plan | Model inventory unknown; plan failed; persisted bindings unchanged |
| Export while Ollama is stopped | Failed without YAML because model configuration was unobservable |
| Explicit harness restart, then apply | Zero resource changes; same container and volume binding |
| Change `qwen3:0.6b` to `qwen3.5:0.8b` | Model and route updated; sandbox ID and previous model retained |
| Export and recreate | Six resources created under a fresh UID and port on the same gateway |
| Real agent requests | Three successful, nonempty replies |

The final run passed in 236.358 seconds. Redacted identities and the exact bundle
manifest are in [evidence/managed-ollama-linux-arm64.json](evidence/managed-ollama-linux-arm64.json).
The test removed both deployments, Ollama containers, and model volumes after
success. The dedicated gateway and network were then removed. Downloaded tools,
images, and local evidence remain. Unrelated containers were not changed.

This result exposes a design failure: separate service/model resources do not
repair a stopped server through ordinary apply. OpenTofu needs model refresh to
succeed before it can plan the parent's restart. The harness restart is explicit;
the product has no hidden write during refresh or targeted-apply workaround.

The image references were:

```text
ollama/ollama@sha256:684d8674b4315fa18f4f0e973a118ec2652ed96f67563277839985175858e0ba
nc-prototype-openclaw@sha256:f73285851f5cc9d1862da7aaa603249f2c97fdf431bc4b03a5a435af897405f3
```

Earlier external-inference runs are retained in
[evidence/linux-arm64.json](evidence/linux-arm64.json) and
[evidence/osquery-refresh-linux-arm64.json](evidence/osquery-refresh-linux-arm64.json).
Live recreation uses a fresh UID on the same gateway. Same-UID recreation on a
different gateway is covered only by the protocol fixture.

## Automated checks

| Check | Result |
| --- | --- |
| `go test -race ./...` | Pass |
| `go test -race -tags=integration ./... -count=1 -v` | Pass; engine package 191.811 seconds |
| `go vet -tags=integration,live ./...` | Pass |
| `go fix -diff -tags=integration,live ./...` | No changes |
| Live managed plan/apply/model/export/recreate test | Pass, 236.358 seconds |
| Formatting, `git diff --check`, commit hooks | Pass |
| Bundle artifact checksum verification | All five platforms pass |

Fourteen engine integration scenarios execute real OpenTofu, provider, and osquery
processes against a gRPC fixture. They cover lost create responses, cancellation
after an effect, recovery without duplicate creates, ownership/generation/identity
conflicts, missing resources, endpoint/model drift, policy and launch drift,
credential exclusion, destructive-plan rejection, and inference failure.

Refresh tests invoke OpenTofu directly, without the CLI's preflight. Confirmed
absence can remove state in a refresh-only operation. Authentication, permission,
transport, deadline, malformed/partial responses, missing policy, missing helpers,
and empty SQL results stop planning and preserve bindings. Recovery does not
recreate resources accidentally. Adapter tests reject duplicate rows or columns,
unexpected keys, missing fields, and inconsistent status.

A failed inference probe now leaves completed writes acknowledged. The integration
fixture proves configuration can be exported while inference is unhealthy and a
subsequent apply adds no resources. Required missing configuration still blocks export.

Docker API fixtures cover partial initial allocation, retained operation identity,
stop/start without replacement, ownership conflicts, missing storage, and failed
observations without effects. Ollama HTTP fixtures cover incomplete inventories,
rejected requests, partial pull streams, cancellation during a pull, explicit
reapply, and subsequent no-op installation. These do not prove recovery from a
real download interrupted through the OpenTofu process boundary.

The race detector covers Go tests and fixtures. Bundled subprocesses use ordinary
builds. Fixtures do not establish runtime isolation or working inference.

## Collector decision

With osquery 5.23.1, `docker_containers` returned an empty JSON array, exit code 0,
and no diagnostic for both a successful query with no match and a nonexistent
Docker socket. The shared SDK collector returned confirmed absence for the first
and unknown observation for the second. The bounded comparison is recorded in
[evidence/ollama-observation-linux-arm64.json](evidence/ollama-observation-linux-arm64.json).

Managed Ollama refresh and export therefore share direct typed readers. Built-in
Docker inventory alone cannot authorize state removal. Existing OpenShell refresh
and export retain the custom tables with explicit observation statuses. This does
not establish a net maintenance benefit for either route: equivalent-collector
latency, memory, useful joins, and total owned-code comparisons remain open.

Reads still direct:

- Managed Ollama container/volume/model refresh and export; engine and image
  inventory; ownership checks; bounded activation waits after connection refusal.
- Gateway capability/version discovery and CLI ownership preflight.
- Mutation reconciliation, immediate conditional-write revision checks, sandbox
  readiness waits, and agent configuration/health/inference probes.
- Local intent, OpenTofu state, manifests, environment credentials, and TLS files.

The OpenShell extension uses the SDK to populate its tables. That is the source
of its observations, not a fallback for failed osquery queries.

## Build availability and remaining limits

Go 1.27.1, OpenTofu 1.12.6, and osquery 5.23.1 were executed locally. The Docker
client is Moby v0.6.0 with API v1.56.0. The gateway SDK remains pinned to the
OpenShell 0.0.116 release commit; a newer unreleased SDK removed APIs this slice uses.

| Bundle | Build and checksums | Runtime evidence | Uncompressed size |
| --- | --- | --- | --- |
| Linux ARM64 | Pass | Managed Docker slice | 460.7 MiB |
| Linux AMD64 | Pass | Not run | 470.2 MiB |
| macOS ARM64 | Pass | Not run | 284.2 MiB |
| macOS AMD64 | Pass | Not run | 296.7 MiB |
| Windows AMD64 | Pass | Not run | 215.5 MiB |

Sizes include upstream executables and unstripped Go development binaries.
Each manifest covers five executables. Cross-compilation does not qualify a
container VM, compute driver, inference topology, or process cleanup behavior.
Managed Ollama currently requires a local Unix socket. Podman, native macOS,
Windows, remote-engine authentication, and GPU inference remain unqualified.

The pinned OpenClaw image adds supervisor network tools and disables an inherited
health probe that runs outside the agent's network namespace. Active checks use
OpenShell exec. Landlock uses upstream best-effort enforcement. These changes do
not establish a security qualification.

The model volume is a cache, not qualified general application storage. Identity
checks use engine/container IDs plus a volume creation timestamp and operation
labels; Docker provides no native volume UUID here. Desired model tags are mutable,
and an observed digest is not a desired content pin. Ordinary apply refuses lost
bound service/storage and does not prune old weights.

Other open RFC gates include provider-error taint recovery, documented state
inspection instead of private state parsing, a complete plan-action allowlist,
credential installation versions, platform qualification, migration, adoption,
and measured maintenance reduction. No automatic rollback or lost-state adoption
is implemented. The implementation remains a local experiment.
