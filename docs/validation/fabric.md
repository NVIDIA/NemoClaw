# Test Fabric adapters

Test adapter lifecycle with isolated protocol fixtures, then test the OpenShell deployment boundary.
Use a real model separately to establish actual agent responses.
A passing fixture does not qualify hosted authentication or model task quality.

Build the selected image and native bundle with the [Fabric guide](../guides/fabric.md) before testing.
Use native Linux ARM64, Docker, the OpenSSL CLI, and the [Python and native build prerequisites](../reference/dependencies.md#fabric-builds).
The tests create disposable containers; the OpenShell test also creates a fresh deployment.

## Test without external inference

The offline runner accepts `claude`, `codex`, `mini-swe-agent`, `nooa`, `nooa-bench`, `remote-agent`, and `pi`.
Use the [native messaging fixture](native-messaging.md) for OpenClaw.
Deep Agents and Hermes have [retained live evidence](index.md) and can use the real-model test later on this page.

The offline test uses real Fabric and harness processes in a disposable Docker container with `--network none`.
A local TLS server supplies protocol responses.
It checks startup, readiness without inference, rejection of mismatched readiness configuration, two ordered invocations in one runtime, and stop.
mini-SWE-agent and both NOOA modes execute real file-writing tools and verify the file separately.
No external messages or paid model requests are sent.

```sh
python3 tools/fabric-adapter-experiment.py --harness codex
python3 -m unittest discover -s image/fabric -p test_build.py -v
```

The inventory test compares the recipes with both the Python and TypeScript adapter trees in the verified source populated by the default image build.
Evidence and diagnostics are retained under the printed `.local/fabric-*` path.

## Test through OpenShell with fixture inference

The fixture server covers the same seven recipes as the offline runner.
For the real OpenShell boundary, [start the external gateway](../get-started/external-services.md#start-the-gateway).
Run a fixture server on that test network's bridge address, then point the corresponding YAML at `http://BRIDGE_ADDRESS:11446/v1`:

```sh
mkdir -p .local/fabric-model-fixture
FABRIC_FIXTURE_EVIDENCE="$PWD/.local/fabric-model-fixture" \
FABRIC_FIXTURE_MARKER=FOUR \
  python3 test/fabric_adapters.py codex --serve-fixture BRIDGE_ADDRESS 11446
```

In another terminal, after rebuilding the native bundle:

```sh
NEMOCLAW_LIVE_FABRIC_CONFIG="$PWD/deployment.yaml" \
  go test -tags=live ./internal/engine -run '^TestLiveFabric$' -count=1 -timeout=12m -v
```

Use the same harness in the server and YAML.
This exercises real OpenShell provisioning, inference routing, unchanged apply, export/reapply, stable hosted runtime and resource identities, an independent SDK invocation, and teardown.
The SDK invocation starts its own runtime; it does not attach to the hosted one.
Stop the fixture and test gateway and remove the empty test network afterward.
This is native runtime evidence with fixture inference, not live-model quality or authentication qualification.
Refer to [validation results](index.md) for retained evidence.

If a fixture test fails, inspect its printed evidence path before retrying.
For an OpenShell failure, the test retains deployment state; use the same state directory for [recovery or teardown](../guides/lifecycle.md).

## Test with a real model

The retained Linux ARM64 test used the pinned Ollama image in [external service setup](../get-started/external-services.md), Qwen3 1.7B, and GPU access (`--gpus all`) on DGX Spark.
Wait for the model download and a successful inference response before applying; route registration validates the endpoint.
CPU cold-start latency can exceed the gateway validation deadline.
For a local gateway binary, check `openshell-gateway --version` before starting it: a different globally installed version may have incompatible CLI flags.

```sh
NEMOCLAW_LIVE_FABRIC_CONFIG="$(pwd)/deployment.yaml" \
  go test -tags=live ./internal/engine -run '^TestLiveFabric$' -count=1 -timeout=20m -v
```

This creates a fresh deployment UUID and retains YAML, native OpenTofu state and results under `.local/fabric-live-UUID`.
It checks unchanged apply, export/reapply, and stable hosted runtime/resource identities.
OpenClaw is accessed through its native CLI over OpenShell exec; native settings are changed before reconciliation and verified afterward, followed by a real agent reply.
The other harnesses receive an independent one-shot smoke request through the upstream Fabric SDK, not an attachment to the hosted runtime.
The private probe has no invocation interface.
The previous `NEMOCLAW_LIVE_FABRIC_TOOLS` mode is retired with the NemoClaw invocation API; its historical tool evidence remains recorded in the [historical validation log](../archive/validation-log.md).

On success the test removes its sandbox, route and provider.
Failure retains the deployment for inspection.
`TestFabricDeploymentBoundary` runs through native OpenTofu/provider processes with gateway fixtures, checks immutable harness choice and configuration observations, and rejects the retired runtime commands.
