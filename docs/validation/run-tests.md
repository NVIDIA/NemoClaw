# Run tests

Run checks that exercise the changed boundary and state what they prove.
Rebuild the native bundle before any integration test that executes its provider.
Run commands from the repository root.

## Check Go changes

Follow the [Go guidance in AGENTS.md](../../AGENTS.md#go-coding-guidance).
The following complete workflow targets Linux ARM64 and requires Docker, OpenSSL, and the [Fabric build prerequisites](../reference/dependencies.md#fabric-builds).
On other platforms, omit the Fabric image build; the native messaging test reports a platform skip.
Run:

```sh
go test ./...
go vet ./...
go run ./tools/bundle
python3 image/fabric/build.py --harness openclaw
go test -tags=integration ./internal/engine -count=1
```

Format changed Go files with `gofmt`.
For race and tagged-source checks, run:

```sh
go test -race ./...
go vet -tags=integration,live ./...
```

On Linux ARM64, the integration suite also runs `TestFabricOpenClawNativeMessaging` against real Fabric and OpenClaw processes in isolated Docker containers.
Build the OpenClaw Fabric image before running that suite; Docker, OpenSSL, and the [Fabric build prerequisites](../reference/dependencies.md#fabric-builds) are required.
Missing prerequisites fail the test; it skips only on platforms the image does not run on.
The fixture uses local Telegram and model responses and sends no external messages or paid inference requests.
Plain `go test ./...` excludes these integration tests.

The provider integration tests execute actual OpenTofu and provider processes against a gRPC fixture.
They cover no-op apply, model updates, export/recreate, lost responses, cancellation, ownership, policy drift, and secret exclusion.
Refresh tests verify confirmed absence, retained state on failed observations, and recovery without recreation.
The gRPC fixture does not implement a sandbox or establish working inference.
The race detector covers Go test processes; bundled subprocesses use ordinary builds.

## Check documentation changes

Check relative links, anchors, navigation, and the [ownership map](../contributing/documentation-map.md).
Verify documented commands and defaults against source, and preserve evidence files byte-for-byte when moving them.
Run `git diff --check` and obtain an independent documentation review as described in the [writing guide](../contributing/writing.md#review-and-validation).
Documentation-only changes do not require creating live deployments.

## Run the direct OpenClaw live test

This opt-in test creates two deployments with fresh UUIDs and sends actual agent requests.
The selected endpoint supplies credentials and model usage costs.
Complete [external service setup](../get-started/external-services.md) and [deployment configuration](../get-started/deploy.md) first.
Both the selected model and alternate model must be available at the external endpoint.

Use an absolute YAML path:

```sh
NEMOCLAW_LIVE_CONFIG="$PWD/deployment.yaml" NEMOCLAW_LIVE_ALTERNATE_MODEL=qwen3:0.6b   go test -tags=live ./internal/engine -run '^TestLivePlanApplyModelExportRecreate$' -count=1 -v
```

A passing test checks real replies, model changes, export/recreation, and cleanup of its deployments.
A failure retains resources and recovery state under `.local/live-UUID`.
Inspect that evidence and follow [recovery guidance](../reference/troubleshooting.md).
The [managed Ollama variant](../guides/managed-ollama.md) downloads models and has separate container/volume cleanup.

## Test other boundaries

- [Fabric adapters](fabric.md): isolated protocol fixtures and real OpenShell provisioning.
- [Native messaging](native-messaging.md): native enrollment, pairing, tools, and recreation with local fixtures.
- [DGX Spark](spark.md): retained state, watchdog recovery, and artifact replacement.
- [Validation results](index.md): recorded evidence and remaining gaps.
