# Desired-state prototype validation

Evidence date: 2026-09-11. This is local experiment evidence, not
supported-platform or release qualification.

The architecture now uses shared direct readers for provider refresh and export.
The historical live runs below tested implementation `706f228877` with bundle
`0.1.0-dev.g17f54bad65eb`, before removal of the SQL observation layer. Their
recorded manifests, timings, and sizes are retained unchanged; they do not
qualify the current bundle.

## Current direct-reader validation

The direct-reader implementation was validated locally with Go 1.27.1 and bundle
`0.1.0-dev.g59160961efb3` on Linux ARM64.

| Check | Result |
| --- | --- |
| `go test ./...` | Pass |
| `go vet -tags=integration,live ./...` | Pass |
| `go test -race -tags=integration ./internal/engine -count=1 -v` | Pass; 23.643 seconds |
| Native bundle rebuild | Pass; exactly CLI, OpenTofu, and provider |
| Rebuild with a retired helper in `libexec` | Helper removed; absent from bundle and manifest |
| All five platform bundles | Build and all artifact checksums pass; three executables each |
| `gofmt`, `git diff --check` | Pass |

The integration suite executes the native OpenTofu and provider against a gRPC
fixture. It covers no-op apply, drift, export/recreate, lost responses, cancellation,
secret exclusion, identity and policy guards, confirmed absence, and retained state
on authentication, permission, transport, deadline, and incomplete-response errors.
The shared-reader unit tests also cover incomplete sandbox phase, missing identity,
wrong response names, bounded calls, and rejection of invalid observation keys.

The race detector covers the Go engine and fixture; bundled subprocesses use
ordinary builds. Live gateways, containers, and inference were not rerun for this
change. Linux AMD64, macOS, and Windows results are cross-build evidence only.
Historical timings and bundle sizes below are not a controlled before/after
performance comparison.

### Integration with the newer Spark work

After transferring the direct-reader change onto the Spark prototype at
`074eebe7d0`, bundle `0.1.0-dev.g4f9700e760da` passed `go test ./...`,
`go vet -tags=integration,live ./...`, and the native Linux ARM64 integration suite
with the race detector (`24.480` seconds). The merge retains managed runtime and
storage observations during export and Spark resource schema behavior. All five
platform bundles were rebuilt and their complete three-executable manifests
verified. Other platform results remain cross-build evidence; live inference was
not rerun during this transfer.

## Managed DGX Spark experiment

The recipe slice runs on this Linux ARM64 GB10 Spark with 121.7 GiB RAM,
Docker 29.2.1, NVIDIA driver 580.142, OpenShell 0.0.116, and OpenClaw 2026.9.4.
[examples/spark.yaml](examples/spark.yaml) contains the resolved runtime and model
pins. Structured results and pseudonymized identities are in
[evidence/spark-linux-arm64.json](evidence/spark-linux-arm64.json). Its manifest
identifies the complete local logs by path and SHA-256; database backups and secret
material are not committed. [LOCAL_TEST.md](LOCAL_TEST.md) has the build, apply,
and retained-state test commands. Runtime images and weights remain local.
The final bundle is `0.1.0-dev.g3ab242b52957`; all five platform manifests
and their three executables were rebuilt and checksum-verified.

The model snapshot contains 51 pinned files totaling 105,935,744,618 bytes.
The packed PLE table has 320,001,536 rows of 90 bytes. Its full-row verification
passed, and the live worker attached the 26.82 GiB mmap artifact. The first full
inference load took about 11 minutes; the configured loading budget is 30 minutes,
starting after download and preparation. No host tuning was performed.

| Scenario | Retained result |
| --- | --- |
| Initial runtime plan | Gateway-dependent OpenShell graph deferred; no Docker resources created |
| Exact snapshot and packed preparation | All file hashes/sizes verified; preparation published after full-row verification |
| Interrupted real download | A 3.09 GB partial shard resumed in the same container; model volume retained |
| CLI interruption | Runtime continued downloading and supervising memory after the CLI exited |
| Initial complete path | Actual OpenClaw reply `FOUR` through OpenShell after correcting the early gateway layout |
| Fresh gateway and sandbox | Six resources created with the corrected layout; actual reply `FOUR`; no repairs |
| Unchanged apply | No resource changes, downloads, or preparation; actual reply `FOUR` |
| Export/reapply | Same configuration pins, eight identities, and artifact receipts; actual reply `FOUR` |
| Safe capacity rejection | A 64 GiB requested reserve rejected arithmetically; no allocation stress or resource changes |
| Watchdog shutdown | `SIGUSR1` stopped the inference process group; no Docker automatic restart |
| Explicit watchdog recovery | Read-only plan proposed one update; apply restarted the same container and returned `FOUR` |
| Failed sandbox startup fixture | Normal binding retained; no taint or recreation; declared policy still checked |
| Final runtime artifact change | Only inference container replaced; other seven identities and both receipts retained; actual reply, no-op, and export/reapply passed |

The full Spark lifecycle harness passed in 653.012 seconds, preserving all eight
bindings and both artifact receipt hashes and modification times through no-op,
export/reapply, and watchdog recovery. It used the earlier runtime manifest
`232af38c6451e1430e7dbcdea2ee23c284545a258318863ded5c4ac1069f2864`.
The artifact-change harness passed in 663.004 seconds. The final manifest is
`c76fd5c3a78f65fcc2dff2aba30f68ab27a880aec3b8a5f2647cd4d19736f8fb`;
its updated source archive reflects the direct-reader branch, and its supervisor
binary is byte-for-byte identical. Both manifests were independently reproduced
with the build cache disabled. No image or model artifact was published.

Deterministic Go fixtures cover interrupted and corrupt downloads, failed
observations, capacity, supervised shutdown, ownership/generation/identity drift,
retained storage, encryption-key handoff, and sandbox readiness failure. Five
packaged Python tests execute the actual preparation tool and verifier against
tiny safetensors with networking and GPU access disabled. Race tests, vet, and the
native OpenTofu integration suite pass (26.496 seconds for the final integration
run). Five-second host samples over 90 minutes observed at least 23.7 GiB of
available memory; the resident watchdog samples independently every second.
Cross-platform bundle builds establish
compilation and artifact checksums only; this GPU backend is qualified here only
on Linux ARM64 Docker on GB10.

The first gateway layout had two concrete defects. Its sandbox tokens were written
inside the gateway rootfs, while Docker mounted the corresponding host paths.
It also kept the database encryption key outside persistent storage. Fixing only
the signing-key and database paths did not preserve usable credentials. The final
layout persists XDG state, and gateway identity includes both key fingerprints.
The deletion guard copies and verifies a legacy encryption key before removing
its container, since OpenTofu can destroy an old resource before creating a newly
introduced storage dependency. The handoff stores the original key instead of generating a replacement.

The early failed sandbox exposed an upstream lifecycle limitation: OpenShell
0.0.116 latches `Error`, and start/stop cannot recover that phase. The experiment
retained its failed filesystem, corrected the token mount, and performed an
offline, version-checked status repair with a database backup. Its OpenShell ID
survived; its failed physical container was replaced. The non-secret inference
credential placeholder was reinstalled without changing provider identity after
the early encryption-key loss. These were controlled repairs of the experimental
layout, not successful automatic recovery or product behavior. The corrected
fresh gateway/sandbox run needed no repair. Ordinary apply preserves terminal
sandbox errors and reports them without editing OpenShell's database.

Provider refresh and export use the shared direct readers introduced by the
concurrent branch change. OpenShell configuration and policy use its SDK;
managed containers, bridges, volumes, and offline file receipts use Docker.
Hardware/capacity and the resident watchdog read `/proc/meminfo`, NVIDIA inventory,
and filesystem capacity directly. Mutations, conditional-write version checks,
active health/inference/agent probes, and local state/secret-reference access are
direct. There is no osquery component in the current bundle.

The complete model volume and prepared artifact are preserved. The primary
experiment remains available; qualification-only gateways are stopped with their
state/data retained. The existing `nemoradio-vllm` and `nemoradio-tts` containers
and data were retained. Only the explicitly authorized radio stop was performed;
no unrelated resources, host drivers, kernel settings, or system packages were
changed. This evidence does not qualify Podman, Docker Desktop, other GPUs, or
recovery of terminal OpenShell sandbox errors.

## Historical native runtime evidence

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

## Historical automated checks

| Check | Result |
| --- | --- |
| `go test -race ./...` | Pass |
| `go test -race -tags=integration ./... -count=1 -v` | Pass; engine package 191.811 seconds |
| `go vet -tags=integration,live ./...` | Pass |
| `go fix -diff -tags=integration,live ./...` | No changes |
| Live managed plan/apply/model/export/recreate test | Pass, 236.358 seconds |
| Formatting, `git diff --check`, commit hooks | Pass |
| Bundle artifact checksum verification | All five platforms pass |

Fourteen engine integration scenarios executed real OpenTofu, provider, and osquery
processes against a gRPC fixture. They cover lost create responses, cancellation
after an effect, recovery without duplicate creates, ownership/generation/identity
conflicts, missing resources, endpoint/model drift, policy and launch drift,
credential exclusion, destructive-plan rejection, and inference failure.

At that revision, refresh tests invoked OpenTofu directly, without the CLI's
preflight. Confirmed absence removed state in refresh-only operations; failed or
incomplete observations retained bindings. The retired SQL adapter also had
protocol-specific tests for missing helpers, empty results, and invalid rows.

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

## Reader decision

Provider refresh and export now call shared resource readers directly. The
OpenShell reader uses the SDK and preserves complete configuration, explicit
NotFound, identity, launch, and active-policy checks. Docker and model inventory
continue to use their owning APIs. Failed or partial observations retain state and
block export. There is no observation subprocess, SQL adapter, or extension in
the current bundle.

The earlier Docker collector comparison is retained in
[evidence/ollama-observation-linux-arm64.json](evidence/ollama-observation-linux-arm64.json).
It showed that built-in SQL inventory could not distinguish an unavailable socket
from no matching containers. It explains the earlier direct-reader decision; it
is not a benchmark of the current implementation. A net maintenance or latency
improvement has not been measured.

## Historical build availability and remaining limits

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
Each historical manifest covers five executables; the current bundle contains
three (CLI, OpenTofu, and provider). Cross-compilation does not qualify a
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
