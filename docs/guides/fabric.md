# Deploy a Fabric runtime

Select a Fabric image recipe to provision its agent runtime inside OpenShell.
The [runtime reference](../reference/fabric-harnesses.md) lists all ten recipes, their protocols, and their limits.
OpenClaw uses a local adapter; the other nine adapters come from the pinned Fabric source.

## Before you begin

Use native Linux ARM64, Python 3.13, Docker, uv, and the host build toolchain.
Maturin can provision Rust in its cache.
Provide an [external gateway and inference service](../get-started/external-services.md); Fabric with managed gateway or inference is outside this slice.
Claude requires Anthropic Messages; Codex and Pi require OpenAI Responses.
A Chat Completions response alone does not establish compatibility with those protocols.

Changing the harness of an established deployment requires [teardown](lifecycle.md#destroy-a-deployment), which deletes its sandbox files.
Do not rebuild a local tag while a pending deployment still needs its old digest for creation.

## Build and apply

1. Build the chosen recipe and the native bundle, replacing `codex` with your choice:

   ```sh
   python3 image/fabric/build.py --harness codex
   go run ./tools/bundle
   ```

2. Copy the matching [example](../reference/fabric-harnesses.md#choose-an-example) to `deployment.yaml`.
   Set a fresh deployment UUID, the printed immutable image digest, your gateway, and your inference endpoint and model.
   Replace fixture endpoints and `fixture-model` before using a real service.
   The examples use ports 17681 and 11446; adjust them to your topology.

3. Preview and apply with the same state directory:

   ```sh
   dist/linux_arm64/bin/nemoclaw plan --state-dir .local/fabric --file deployment.yaml
   dist/linux_arm64/bin/nemoclaw apply --state-dir .local/fabric --file deployment.yaml
   ```

## Verify and access the runtime

Apply the same YAML again and confirm an empty change list.
The hosted runtime and resource identities remain stable through unchanged apply and export/reapply.
NemoClaw checks readiness and sends a bounded inference probe without adding a conversation turn.

Use [native interfaces](native-access.md) for agent operations.
Fabric's `Fabric.run` creates a new runtime; it does not attach to the runtime hosted by NemoClaw.
The private socket exposes readiness only.
For stronger evidence, [run the Fabric tests](../validation/fabric.md).
If apply fails, preserve state and follow [troubleshooting](../reference/troubleshooting.md).
