# Agent runtimes and native access

OpenClaw is the default agent. A sandbox owns its native process, while OpenShell
owns isolation and inference routing. Native channel enrollment, pairing,
plugins, histories, and workspace data belong to the agent. NemoClaw checks its
reserved gateway and inference settings without replacing unrelated settings.

A Fabric agent selects `type: fabric` and a `harness` from `deepagents`, `hermes`,
`openclaw`, `claude`, `codex`, `mini-swe-agent`, `nooa`, `nooa-bench`, `remote-agent`,
or `pi`. This prototype requires an external OpenShell gateway and external
inference for Fabric. The strict schema rejects unsupported combinations.

Build a local Linux ARM64 image with:

```sh
python3 image/fabric/build.py --harness openclaw
```

The builder needs Docker, uv, and a native C/Rust toolchain. It verifies upstream
source archives and dependency hashes, then prints the resulting image digest.
Put that immutable digest in the sandbox's `image.ref`. It does not publish an
image. See [the source notice](../image/NOTICE.md).

Fabric's local OpenClaw adapter owns one native gateway and session. An uncertain
invocation result stops that runtime and is never replayed automatically.
Provisioning readiness does not invoke the model. Native settings survive
configuration checks and recreation when their state volume is retained.

Qualification commands:

```sh
python3 -m unittest discover -s image/fabric -p test_build.py
python3 tools/openclaw-native-test.py --image nc-prototype-fabric:openclaw
python3 tools/fabric-adapter-experiment.py --harness codex
```

The recipe coverage test needs the checksum-verified Fabric source populated by
the builder. The native messaging and harness tests use disposable containers
and retained evidence under `.local`. They do not send external messages.
[Native messaging evidence](validation/rust-native-openclaw-linux-arm64.json)
and [harness evidence](validation/rust-fabric-adapters-linux-arm64.json) distinguish
protocol fixtures from complete live inference qualification.

Real messaging deployment still needs generic egress, mounted secrets, and
retained sandbox storage that this desired-state schema does not provision.
The Docker fixture supplies those prerequisites locally. Use native OpenClaw
commands through OpenShell sandbox access; there is no NemoClaw invocation or
channel-management API. A Fabric SDK `run` starts a new runtime rather than
attaching to the one hosted by NemoClaw.

[Live Fabric qualification](validation/rust-fabric-live-linux-arm64.json) covers
Deep Agents, Hermes, and Fabric OpenClaw. Hermes rejects the example Spark
service's 32K context; its successful short-response run used Ollama/Qwen3. This
does not qualify long-context accuracy or general tool-use reliability.
