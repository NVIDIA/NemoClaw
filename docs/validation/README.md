# Rust parity evidence

The comparison is the Go `v1-poc` implementation at
`b549ccd43e6102b72aa9c65ee17abfe3c429fc0b`. This is an experimental implementation,
not a claim that every backend works on every host or that the Go limitations
have been removed. Commit bodies retain the test-first implementation decisions.

| Contract | Evidence |
|---|---|
| SDK and CLI plan/apply/export/destroy; ownership, identity, drift, partial creation, failed observations, interrupted destroy | Workspace behavioral tests and real OpenTofu protocol/lifecycle tests in [native platform qualification](rust-native-platforms.json) |
| Strict schema, defaults, resource addresses, digests and agent launch contracts | Fixtures derived from the pinned reference in `crates/nemoclaw-sdk/tests/fixtures`; all thirteen reference examples parse |
| Managed gateway and retained signing/encryption identity | [Gateway lifecycle](rust-managed-gateway-linux-arm64.json), [gateway storage](rust-gateway-storage-linux-arm64.json) |
| Fresh Spark download/preparation, real OpenClaw response, no-op, export/reapply, capacity rejection, watchdog stop/recovery, image-only replacement | [Spark lifecycle](rust-spark-linux-arm64.json) |
| Model-specific runtime sources, licenses, and repeatable local artifact build | [Final runtime reproduction](rust-runtime-memory-fix-linux-arm64.json) |
| Fabric native harness protocols and native OpenClaw settings | [Ten-harness SDK fixtures](rust-native-platforms.json), [seven native harness fixtures](rust-fabric-adapters-linux-arm64.json), [native OpenClaw](rust-native-openclaw-linux-arm64.json) |
| Managed Ollama initial apply, no-op, export/reapply | [Real Docker/Ollama lifecycle](rust-ollama-linux-arm64.json) |
| Deep Agents, Hermes and Fabric OpenClaw native responses, stable hosted runtime, no-op, export/reapply and teardown | [Live Fabric qualification](rust-fabric-live-linux-arm64.json) |
| Runtime/recipe/backend/hardware separation, renamed executable, image upgrade and offline reproduction | [Runtime boundaries](rust-runtime-boundaries-linux-arm64.json) |
| Config-selected public model, generic runtime, no-op/export, failed startup recovery and watchdog lifecycle | [Selected-model qualification](rust-selected-model-linux-arm64.json) |
| Engine connection isolation, target identity, typed capacity and inference failure recovery | [Preparatory fixtures and read-only Docker checks](rust-engine-preparation-linux-arm64.json); [rootless Podman proof](rust-podman-rootless-linux-arm64.json) qualifies the external gateway/sandbox path |
| Linux ARM64/x64, macOS ARM64/Intel, Windows x64 bundles | [Five native jobs](rust-native-platforms.json); real OpenTofu and production provider execution on each target |

The parity baseline workspace check passed 99 deterministic tests, with 17 explicit
integration/live tests excluded from the ordinary run. Formatting and strict
workspace Clippy passed. The retained platform and live records identify the
separate execution gates; ignored tests are not counted as passes.

Limits inherited from the reference remain explicit: Ollama's combined process
and storage resource does not support destroy; native channel credentials and
persistent sandbox mounts are not
provisioned by this schema; invocation replay and conversation recovery are not
provided. Native bundle tests do not establish Podman or GPU compatibility across
all operating systems. Reading retained Go storage is not a full state-migration
qualification. No comparative maintenance-cost reduction has been measured.

The selected-model experiment additionally qualifies Fabric OpenClaw with a
managed gateway and managed vLLM inference. It does not extend that live result
to every Fabric harness or model.

[SSH engine transport evidence](rust-ssh-linux-arm64.json) covers real loopback
SSH identity, failure classification and artifact transfers. It does not qualify
remote managed deployment.
