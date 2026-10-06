<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Manual protected-input integration check

Use this check to qualify the fixed setup helper before attempting VoiceClaw.
It creates one randomly named owned initializer and disposable volume, delivers a
source-defined test token, verifies completed delivery and unchanged re-apply, and
removes those resources. It creates no agent, gateway, speech request, or application
container and uses no real credentials. It does not qualify the full installer.

## Prerequisites

- Use this candidate worktree, its pinned Rust toolchain and Protocol Buffers compiler,
  and a Docker engine running Linux containers with a local volume driver and POSIX
  ACL support. Do not use an engine with unrelated resources you cannot inspect.
- Review the [helper's accepted scope and custody](../../crates/nemoclaw-container-inputs/README.md).
- Build the helper from this source and make a genuine repository manifest digest
  resolve in the selected engine. No automatic image pull or publication occurs.
  The caller, not the installer, owns image acquisition and publication authority.

Run these commands from the worktree root for the selected engine architecture:

```sh
AGENT_PLATFORM=linux/arm64 docker buildx bake container-input-tests
AGENT_PLATFORM=linux/arm64 docker buildx bake container-inputs --load
```

Use `linux/amd64` instead for an amd64 engine. The first target runs the helper's
Linux filesystem tests, including real access/default ACL rejection. The second
builds the scratch runtime image, locally tagged `nc-fabric:container-inputs` with
the default `IMAGE_PREFIX`. These commands download build dependencies; review
that network access in your environment. They do not push an image.

`--load` may leave `RepoDigests` empty. A local `sha256:` configuration ID or a
made-up digest is not an accepted manifest reference. If needed, arrange an
authorized private artifact transfer through your image owner before this test.
Do not publish an image or weaken the immutable-reference check to proceed.

## Run the real Docker check

Set only the explicit engine endpoint and the genuine preloaded helper manifest
reference. These values are nonsecret. Replace the examples; never use the zero
digest literally.

```sh
export NEMOCLAW_INPUT_TEST_ENGINE=unix:///var/run/docker.sock
export NEMOCLAW_INPUT_TEST_IMAGE=your-approved-repository/container-inputs@sha256:0000000000000000000000000000000000000000000000000000000000000000
cargo test --locked -p nemoclaw-provider --lib \
  live_container_inputs_deliver_without_restarting_on_unchanged_apply \
  -- --ignored --nocapture
```

On a macOS client, use the selected Linux engine's explicit Unix socket rather
than assuming `/var/run/docker.sock`. The test uses Docker's real attach stream,
the scratch binary, capability set and mounted filesystem. It checks delivery,
read-only refresh, unchanged binding, and owned cleanup. Protocol/recovery edge
cases belong to `services/inputs_tests.rs`; no extra live retries are added.

Record the source revision (including the local diff if uncommitted), image manifest
digest, platform, Docker version, command and result. This check is opt-in and
excluded from the ordinary and isolated-lifecycle CI runs. It fails, rather than
skips, if its prerequisites are missing.

The test prints only the owned helper and volume names. It attempts helper removal
before deleting the volume without force. If transport or ownership is uncertain,
it leaves the named resources for investigation; do not delete by prefix or run a
global prune. A process killed externally can also leave these resources.

## Connect the VoiceClaw candidate later

In the accepted `kind: container` declaration, add the nonsecret setup-image input
alongside the existing protected references:

```yaml
inputSetup:
  image: your-approved-repository/container-inputs@sha256:REPLACE_WITH_MANIFEST_DIGEST
secrets:
  speech:
    credential: {env: NVIDIA_API_KEY}
    targetPath: /var/lib/voiceclaw/credentials/speech
```

`inputSetup` is required exactly when `secrets` or `agentConnections` are declared.
It is a NemoClaw authoring field; it changes neither VoiceClaw's environment names
nor the `nemoclaw.agent-connection.v1` descriptor. Do not place secret values in
YAML, command arguments, Docker environment variables or saved test artifacts.

Build a matching native bundle using `cargo ci`, or follow [the native build
instructions](../../docs/build.md). With an approved complete deployment file,
review the plan before apply, retain the same state directory, and export to a
new file. Replace the bundle path with the generated native bundle directory:

```sh
/absolute/path/to/native-bundle/bin/nemoclaw --bundle /absolute/path/to/native-bundle --state-dir .nemoclaw-voice-test plan voice.yaml
/absolute/path/to/native-bundle/bin/nemoclaw --bundle /absolute/path/to/native-bundle --state-dir .nemoclaw-voice-test apply voice.yaml
/absolute/path/to/native-bundle/bin/nemoclaw --bundle /absolute/path/to/native-bundle --state-dir .nemoclaw-voice-test export --output voice-observed.yaml
```

These commands operate on real declared resources; the helper-only test above
does not authorize them. Use the CLI's protected credential prompts or your
approved credential source. Re-applying unchanged references is not token rotation.
Changing input references replaces disposable application data. Deployment-wide
`destroy` removes owned workloads, including the sandbox agent and application
data; it is not selective VoiceClaw uninstall. Never delete state to retry.

As of October 6, 2026, the pinned Fabric revision has no supported native readiness
check. [NemoClaw #12443](https://github.com/NVIDIA/NemoClaw/issues/12443) and
[Fabric #298](https://github.com/NVIDIA/NeMo-Fabric/issues/298) track that missing
capability. The declaration fixture explicitly sets sandbox `allowUnsupportedHealth: true`
to allow installation after infrastructure and configuration checks when native
health reports exactly unsupported. It does not report native health as passing;
omission or false retains the strict default. Failed or unknown observations still fail.
VoiceClaw's own readiness must check local inputs and frontend readiness independently.
A reviewed VoiceClaw profile/image and approved container-reachable HTTPS
endpoint/service identity remain joint prerequisites. Full apply and voice
turns are not qualified by this helper check. Do not substitute liveness, generation,
operator login, or insecure TLS for those requirements.
