# Agent runtimes and native access

OpenClaw runs through Fabric, using `harness: openclaw`.
The default sandbox image is the pinned Fabric OpenClaw image. Fabric owns the
agent process inside the sandbox, while OpenShell
owns isolation and inference routing. Native channel enrollment, pairing,
plugins, histories, and workspace data belong to the agent. NemoClaw checks its
reserved gateway and inference settings without replacing unrelated settings.

An agent selects a `harness` from `deepagents`, `hermes`,
`openclaw`, `claude`, `codex`, `mini-swe-agent`, `nooa`, `nooa-bench`, `remote-agent`,
or `pi`. OpenClaw supports external services, managed OpenShell gateways, and
managed Spark or Ollama inference. Other harnesses currently require external
gateway and inference services. The strict schema rejects unsupported combinations.

The pinned Pi recipe requires the route model `gpt-4o` and an OpenAI Responses
endpoint serving that model. Its Fabric adapter resolves models from Pi's catalog
and does not expose custom-model metadata. NemoClaw rejects other route model IDs,
including model changes on existing Pi deployments, before applying them. This
keeps Pi's context limits and capabilities consistent with the configured model.
Earlier configurations could route a different model behind Pi's GPT-4o profile;
that substitution is no longer accepted. Retained fixture evidence establishes
protocol behavior, not compatibility with those substituted models.

Fabric is the only runtime integration, so agents have no `type` field. Remove
`type: fabric` from older YAML. The strict schema rejects the obsolete field.
Previously retained intent files still contain that field and are not migrated
by this schema change; use their previous bundle for export or teardown.

The former `type: openclaw` standalone launcher is no longer supported. Existing
standalone deployments are not automatically converted or replaced; use their
previous bundle to export or tear them down before provisioning a Fabric deployment.
Changing YAML alone does not migrate agent files or conversations.

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

[Fabric-only OpenClaw validation](validation/rust-fabric-only-openclaw-linux-arm64.json)
covers the shared managed-apply agent probe, a real response through OpenShell,
unchanged apply, export/reapply, and stable Fabric runtime identity. The test
creates and removes an owned sandbox against an existing inference service.
