# Local validation: 2026-09-11

The first slice passed on Linux ARM64 with Docker 29.2.1, OpenShell 0.0.116,
OpenClaw 2026.9.4, and Ollama 0.34.0. This is local experiment evidence, not a
supported-platform or release qualification.

## Observed behavior

The live test created four resources from YAML: a workspace, inference provider,
inference route, and OpenClaw sandbox. An unchanged apply produced zero resource
changes. Switching from `qwen3.5:0.8b` to `qwen3:0.6b` updated only the route and
preserved the sandbox ID.

OpenClaw returned successful, nonempty replies before and after the model change.
Export ran the actual osquery executable and custom extension, reconstructed the
applied YAML, and recreated the deployment in another workspace with a new UID.
The recreated OpenClaw agent also returned a reply. This checks integration;
it does not assess the small models' response quality.

The final image live run passed in 56.855 seconds. Resource IDs and results are
recorded in [evidence/linux-arm64.json](evidence/linux-arm64.json). The image was:

```text
nc-prototype-openclaw@sha256:f73285851f5cc9d1862da7aaa603249f2c97fdf431bc4b03a5a435af897405f3
```

The test deleted its two deployments after success. Earlier prototype deployments,
both test Ollama containers, the dedicated gateway process, and its Docker network
were also removed. Model caches, downloaded tools, images, and local evidence
remain available for another run. Existing unrelated containers were unchanged.

## Automated checks

| Check | Result |
| --- | --- |
| `go test ./...` | Pass |
| `go vet ./...` | Pass |
| `go vet -tags=integration,live ./...` | Pass |
| Real-process integration tests | All nine pass |
| `go test -race -tags=integration ./internal/engine -count=1` | Pass, 24.438 seconds |
| Live plan/apply/model/export/recreate test | Pass with final image |
| Bundle artifact checksum verification | All five platforms pass |

The integration suite executes real OpenTofu, provider, and osquery processes
against a gRPC fixture. It covers lost create responses, cancellation after an
external effect, recovery without duplicate creates, foreign ownership, replaced
resource IDs, missing observations, mutable-route export, credential exclusion,
policy/configuration drift, destructive-plan rejection, and failed inference.
The race detector covers the Go test process and fixture; bundled subprocesses
are ordinary builds.

The same-UID recreation on a different gateway is covered by the protocol fixture.
The live recreation used a fresh workspace and explicit new UID on the same gateway.

## Build availability

Go 1.27.1, OpenTofu 1.12.6, and osquery 5.23.1 were executed locally. Each generated
bundle contains five executables and a verified manifest. The final source-derived
provider version is `0.1.0-dev.g72caa84deee8`.

| Bundle | Build and checksums | Runtime evidence | Uncompressed size |
| --- | --- | --- | --- |
| Linux ARM64 | Pass | Full Docker slice | 455.2 MiB |
| Linux AMD64 | Pass | Not run | 464.4 MiB |
| macOS ARM64 | Pass | Not run | 278.4 MiB |
| macOS AMD64 | Pass | Not run | 290.6 MiB |
| Windows AMD64 | Pass | Not run | 209.4 MiB |

Sizes include upstream executables and unstripped Go development binaries.
Native Windows ARM64 is not bundled because this OpenTofu release does not
provide that target. Native control binaries do not establish availability of
an OpenShell compute driver, container VM, inference engine, or GPU backend.

## Constraints exposed by the experiment

OpenShell requires workspace names of at most 19 characters. The prototype derives
a short workspace name from the deployment UID and retains the full UID in labels.
The OpenShell SDK must match the stable gateway's release commit; the newest
unreleased SDK has removed the inference API used by this slice.

OpenClaw's stock image needs `iproute2` and `nftables` for this supervisor setup.
Its process uses numeric UID/GID 1000, a writable sandbox directory, and an
explicit temporary directory. The inherited Docker health probe runs outside
the agent's network namespace, so the image disables it and NemoClaw probes
through the OpenShell execution API.

Gateway-side route validation does not prove that the supervisor can reach the
endpoint. Apply therefore sends a one-token inference probe through the sandbox.
A failed probe retains unfinished intent and blocks export until recovery.

Remaining work includes managed gateway/inference provisioning, the rest of the
#10904 schema, credential rotation, adoption/pruning, state recovery without the
local directory, native macOS/Windows and Podman qualification, and distribution
packaging. Windows child-process cleanup needs live verification. There is no
automatic rollback or migration from an existing NemoClaw deployment.
