<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Release Candidate Notes

These notes track changes between release candidates for NemoClaw 0.1.0. For the v1 release history, refer to the [release notes](../../docs/changelog/overview.md).
As of this documentation revision, v1 has no published release.
The release records list draft release candidates, not a published final release.
Issue [#12638](https://github.com/NVIDIA/NemoClaw/issues/12638) tracks the first one.
The workspace package version alone doesn't establish that a release has been published.
Release candidates are tagged `v0.1.0-rc.<N>`, starting with `v0.1.0-rc.1`, so that their versions sort in release order.
The earlier `v0.1.0-rc1` through `v0.1.0-rc12` tags and their draft releases were removed; the sections below that name them record what each contained.

## Product Changes

The development branch provides desired-state YAML, a Rust SDK, the `onboard`/`plan`/`apply`/`export`/`destroy` CLI, and a bundled OpenTofu provider.
Refer to [the overview](../../docs/about/overview.md) for implemented boundaries and [the CLI reference](../../docs/references/cli.md) for commands.

### Changes Since v0.1.0-rc12

These changes reached `v1` after `1636069b91`, the commit that `v0.1.0-rc12` tagged.

Bundles:

- No two bundles that CI builds report the same version, and versions sort in release order ([#14738](https://github.com/NVIDIA/NemoClaw/issues/14738)): CI / Bundle's run for a tag's push reports the tag, its other runs report `0.1.0-<run>` or `0.1.0-rc.<N>.<run>`, with `.<attempt>` from a second attempt, and a local or fork build reports `0.1.0-dev.<hash>`.
  See [CLI bundles](releases.md#cli-bundles).
  Only release candidate tags of the form `v0.1.0-rc.<N>` count, and only the tag push's run reports the tag: a clean local checkout of the tag now reports `0.1.0-dev.<hash>`.
  Before, every bundle but a clean checkout of a tag reported `0.1.0-dev.<hash>` of its source files, so CI builds of the same sources shared a version.

Releases:

- Each release attaches `version-pins.json`, which lists the version and digest or checksum of each component that a deployment of it uses, including the release's images ([#14722](https://github.com/NVIDIA/NemoClaw/issues/14722)).
  See [compatibility](../../docs/references/compatibility.md#using-one-release-together).
  A final release is published only when the file matches its tag's `versions.json` and the images it staged.
  Before, hand-written HCL copied `versions.json` from the release's tag.
- Each release attaches `nemoclaw-<tag>-darwin_arm64.pkg`, a macOS installer for Macs with Apple silicon on macOS 15 or later ([#12638](https://github.com/NVIDIA/NemoClaw/issues/12638)).
  It installs the `darwin_arm64` archive's bundle in `/usr/local/nemoclaw` and puts its `bin` directory on `PATH` through `/etc/paths.d/nemoclaw`; installing a newer release replaces the bundle.
  See [installing with the macOS installer](../../docs/get-started/install.md#installing-with-the-macos-installer).
  Until a Developer ID Installer certificate signs it, release candidates attach it unsigned and final releases leave it out; see [the macOS installer](releases.md#macos-installer).
  Before, macOS clients installed the CLI only from the archive.
- Each release whose Windows executables are signed attaches `nemoclaw-<tag>-windows_amd64.msi`, a per-user Windows installer that needs no administrator rights ([#12638](https://github.com/NVIDIA/NemoClaw/issues/12638)).
  It installs the `windows_amd64` archive's bundle in `%LOCALAPPDATA%\Programs\NemoClaw` and adds its `bin` directory to the user `Path`; installing a newer release replaces the bundle, and an older release's installer refuses to replace a newer one.
  See [installing with the Windows installer](../../docs/get-started/install.md#installing-with-the-windows-installer).
  Staging signs it with the Windows executables and builds none without Windows signing; see [the Windows installer](releases.md#windows-installer).
  Before, Windows clients installed the CLI only from the archive.

Agents:

- Agent images build Fabric from its [`v0.7.0`](https://github.com/NVIDIA/NeMo-Fabric/tree/v0.7.0) release tag instead of a commit on its `release/0.7` branch, without patches ([#13318](https://github.com/NVIDIA/NemoClaw/issues/13318)).

Plan and apply:

- Apply pulls every agent image and reads its catalog label before it creates the gateway, its storage and network, or any agent configuration, so a pull that fails or an image that doesn't fit its sandbox leaves nothing to destroy ([#14596](https://github.com/NVIDIA/NemoClaw/issues/14596)).
  Before, apply failed after creating the gateway, which remained until destroy.
- Plan and the `nemoclaw onboard` review report an agent image that the engine doesn't hold as not present, and link the [agent image build instructions](../../docs/build-deploy/build.md#building-agent-images).
  See [pulling from private registries](../../docs/build-deploy/usage.md#pulling-from-private-registries).
- Apply detects a new value behind an unchanged inference, web search, or API credential reference, and registers it ([#14803](https://github.com/NVIDIA/NemoClaw/issues/14803)).
  The OpenShell provider records an Argon2id digest of each value it registers as the registration's `credential_digest`; a plan that reads another value updates the registration in place, and the deployment replaces each sandbox that attaches the registration, so its agent starts with the new value.
  See [rotating credentials](../../docs/security/credential-rotation.md).
  `nemoclaw plan` doesn't read these credentials, so it shows no change for a new value, and a recreated registration now also replaces the sandboxes that attach it.
  Before, apply reported no resource changes, and running agents kept the old value until their sandboxes were replaced for another reason.
- An agent image whose adapter doesn't accept `runtime.keep_state`, such as one built from another Fabric revision than the CLI's, plans and runs without it ([#14798](https://github.com/NVIDIA/NemoClaw/issues/14798)).
  Each of its runtimes gets its own state folder.
  Before, plan and the `nemoclaw onboard` review rejected it over `harness.runtime.keep_state`, a field the configuration doesn't need to set.
- When the only image on the engine for the chosen harness can't run the configuration, `nemoclaw onboard` asks for the image again and says why, instead of choosing that image without asking.
- Plan and apply no longer fail with `managed runtime environment drifted` when `NEMOCLAW_DISABLE_TELEMETRY` differs from the value a Podman gateway was created with.
  NemoClaw records the gateway's OpenShell telemetry setting when it plans the deployment, so the next plan with the other value replaces the gateway and keeps its storage, as it does for a Docker gateway.
- A gateway NemoClaw manages sends no OpenShell telemetry when a CI variable such as `CI=true` is set, as NemoClaw's own record already didn't.
  Before, only `NEMOCLAW_DISABLE_TELEMETRY` turned it off, so CI runs reported gateway telemetry.

Gateways:

- A managed `kubernetes` or `openshift` gateway takes `dataStorageClass`, the StorageClass of its data volume, and `resources`, its container's CPU and memory requests and limits, which the chart takes as written ([#14588](https://github.com/NVIDIA/NemoClaw/issues/14588)).
  See [Choosing the Gateway's StorageClass and Resources](../../docs/build-deploy/kubernetes.md#choosing-the-gateways-storageclass-and-resources).
  Plan refuses a changed `dataStorageClass` on an existing deployment, memory in units other than whole `Mi` or `Gi`, and a request above its limit.
  Before, the volume took the cluster's default StorageClass, and the gateway always requested 250m CPU and 256Mi and was limited to 1 CPU and 2Gi.
- On the `openshift` target, the shared supervisor that `supervisor_topology = "gateway"` selects also leaves its UID, group, and `fsGroup` to OpenShift, as the gateway does.
  Before, the chart ran it as UID and group 65534, which `restricted-v2` refuses.

OpenShell 0.1.10:

- OpenShell moved to [`ai-openshell/openshell`](https://github.com/ai-openshell/openshell): the pinned CLI downloads from that repository's releases, and the gateway, supervisor, and sandbox images and the gateway chart come from `quay.io/ai-openshell` instead of `ghcr.io/nvidia/openshell`.
  A cluster that mirrors or allowlists OpenShell's images needs the new names.
- A client that reconnects to an address that policy DNS answered after the answer's TTL has passed, as OpenClaw's Node.js does, connects again: OpenShell refreshes and checks the destination first.
  Before, OpenShell refused the connection, so an OpenClaw agent's model request failed and its runtime stopped.
- Restarting a sandbox no longer sometimes reports it as `Error` with `ContainerExited` while it's still starting.
- On Kubernetes, deleting a sandbox and then creating one with the same name works reliably.
- Sandboxed workloads can set their own CPU affinity, nice value, and resource limits, and signal themselves.
- A proxy failure before a response starts returns `502 Bad Gateway` with a request ID, and HTTP clients learn promptly when an upstream closes an idle connection.

OpenTofu 1.13.10:

- The bundle's OpenTofu is 1.13.10, built with Go 1.27.4 for GO-2026-6859, an HTTP/1 server crash.
  `tofu test` overrides resources in indexed modules correctly.

### Changes in v0.1.0-rc12

These changes reached `v1` between the `v0.1.0-rc11` and `v0.1.0-rc12` tags.
[Breaking changes](#breaking-changes-in-v010-rc12) are listed separately.

Onboarding:

- At the model question for NVIDIA Endpoints, OpenRouter, OpenAI, Anthropic, Google Gemini, and Nous Research, `nemoclaw onboard` offers the recommended models the endpoint lists and **Type another model**, instead of the endpoint's whole catalog, which can include models that can't drive an agent.
  The review notes a typed model that the endpoint doesn't list.
  See [onboarding model catalogs](../../docs/agents-inference/inference.md#onboarding-model-catalogs).
- When the gateway's engine holds exactly one image that installs the chosen harness, and neither your template nor an earlier answer names another, `nemoclaw onboard` uses it without asking the image question, and the review shows it.
  To enter another image, go back from the next question.

Agents:

- OpenClaw works with `anthropic` providers ([#14529](https://github.com/NVIDIA/NemoClaw/issues/14529)).
- OpenClaw's `web_fetch` reaches hosts that the sandbox's network policy allows ([#14537](https://github.com/NVIDIA/NemoClaw/issues/14537)).
- OpenClaw keeps its native home in `/sandbox/artifacts`, as Hermes does.
  See [agent files](../../docs/build-deploy/state.md#agent-files).
- OpenClaw sessions with kept state no longer fail on turns longer than about a minute or after a few minutes idle ([#14630](https://github.com/NVIDIA/NemoClaw/issues/14630)).
- A Hermes route to an `anthropic` provider reaches the provider's endpoint whatever its path ([#14538](https://github.com/NVIDIA/NemoClaw/issues/14538)).
- `spec.sandboxes.<name>.gpus` asks OpenShell for that many GPUs for the programs an agent runs in its sandbox, so its tools can run GPU workloads apart from its inference route.
  OpenShell picks the devices, or Docker and Podman take specific ones from `driverConfig`'s `cdi_devices`, and it refuses a request that the gateway's driver can't serve.
  Changing the count replaces the sandbox.
  See [GPU access for agent tools](../../docs/agents-inference/agents.md#gpu-access-for-agent-tools).

Inference and models:

- A `kind: llamaCpp` service serves one pinned GGUF file from Hugging Face with llama.cpp on one CUDA GPU, for an inference provider that selects it with `serviceRef`.
  The runtime downloads only that file and checks its size and SHA-256 before serving it.
  With `authentication: bearer`, llama-server reads a generated key from a private file.
  See [serving a pinned GGUF with llama.cpp](../../docs/agents-inference/models.md#serving-a-pinned-gguf-with-llamacpp).
- A `kind: nim` service runs native NVIDIA NIM with its vLLM backend behind a private Docker network and a route filter, with the operator's NGC key mounted read-only.
  It remains a candidate: [#14556](https://github.com/NVIDIA/NemoClaw/issues/14556) records what was qualified, and general task reliability remains unqualified.
  See [the native NIM candidate](../../docs/agents-inference/models.md#native-nim-candidate).

Releases:

- A release's CLI reports the release's version: for `v0.1.0-rc12`, `nemoclaw --version` prints `nemoclaw 0.1.0-rc12`, and the bundle's `manifest.json` says `0.1.0-rc12`.
  Before, they said `0.1.0` and `0.1.0-dev.<hash>`.
  A bundle built from any other checkout, including one with uncommitted changes, still reports `0.1.0-dev.<hash>`, where the hash names its source files.
- A final release attests the build provenance of each CLI archive and of `SHA256SUMS`.
  Verify them with `gh attestation verify FILE --owner NVIDIA`, as [Installing the CLI](../../docs/get-started/install.md#installing-on-linux-or-macos) shows.
  Release candidates have no attestations.
- A final release's macOS and Windows executables must be signed.
  Only a release-scoped exception, which the release notes state with its reason, lets one publish unsigned.
  Release candidates may stay unsigned.
- Each release attaches `release-evidence.json`, which records the signing decision, the signed executables, and the output of the release's checksum, signature, and attestation checks.

Installation:

- [Installing the CLI](../../docs/get-started/install.md) covers installing, upgrading, and uninstalling a release's CLI from its `nemoclaw-TAG-PLATFORM.tar.gz` archive, checked against `SHA256SUMS`.
- The [support matrix](#support-matrix) lists the platforms, gateway runtimes, model services, harnesses, and GPUs, and what CI runs on each.
- Each operation installs the providers of the bundle that runs it, replacing `.terraform/providers` and `.terraform.lock.hcl` in the state directory.
  Before, with a bundle whose providers had the same versions but other bytes, such as a signed build of the same commit, a deployment kept running the previous bundle's providers while that bundle existed.
  Once it was gone, plan, apply, and destroy failed because the providers didn't match the checksums in the dependency lock file ([#14628](https://github.com/NVIDIA/NemoClaw/issues/14628)).

Images:

- Releases no longer stage the `claude` agent image, because it bundles Anthropic's proprietary Claude Code CLI, which NVIDIA can't redistribute ([#13524](https://github.com/NVIDIA/NemoClaw/issues/13524)).
  Build it locally as [Building Agent Images](../../docs/build-deploy/build.md#building-agent-images) describes.
- Releases stage a llama.cpp runtime image, `llama-cpp`, beside the vLLM and Ollama images.
  It adds the supervisor to llama.cpp's CUDA 13.5 server image from release b12375, whose ARM64 and AMD64 builds carry kernels for GB300 (`sm_103`) and GB10 (`sm_121a`).
  CUDA 13.5 needs NVIDIA driver 580 or newer.
  See [build a runtime image](../../docs/build-deploy/build.md#building-a-runtime-image).
- Images keep license notices that their components require and earlier images dropped: Node.js's license in the `hermes`, `openclaw`, and `pi` images, OpenClaw's in `openclaw`, Bun's in `opencode`, and the notices of the Rust crates and standard library that the Ollama proxy and the runtime images' supervisor link.

Windows clients:

- The CLI on Windows reaches a local Docker Desktop or Podman engine through its named pipe, such as `npipe:////./pipe/docker_engine`, and hides typed credentials at its prompts.
  It plans, applies, and destroys a deployment with an external gateway whose `spec.gateway.target.docker.engine` or `spec.gateway.target.podman.engine` is that pipe or an `ssh://` engine ([#14631](https://github.com/NVIDIA/NemoClaw/issues/14631)).
- A managed local gateway also runs from a Windows client: set `spec.gateway.target.docker.engine` to Docker Desktop's named pipe or `spec.gateway.target.podman.engine` to a Podman machine's, and the gateway container binds `/var/run/docker.sock` in the engine's Linux VM, where Docker Desktop serves its engine and a Podman machine links its rootful or rootless API socket.
  On Windows, `nemoclaw onboard` offers the pipe the Docker client selects, otherwise `npipe:////./pipe/docker_engine`, and the default Podman machine's `npipe:////./pipe/podman-machine-default` ([#14632](https://github.com/NVIDIA/NemoClaw/issues/14632)).
  No Windows host has run a deployment.
  See [current limits](../../docs/resources/limits.md#platforms-models-and-placement).
- An Ollama proxy's `engine` also takes a local named pipe, such as `npipe:////./pipe/docker_engine`, so a proxy for an external gateway runs from a Windows client.

macOS clients:

- A managed local gateway on Docker Desktop, Colima, Rancher Desktop, or a Podman machine binds `/var/run/docker.sock` in the engine's Linux VM, where each engine serves containers its socket, instead of the client's socket path, such as `~/.docker/run/docker.sock`, which the VM might not serve ([#14640](https://github.com/NVIDIA/NemoClaw/issues/14640)).
  NemoClaw recognizes each engine by its default socket.
  An engine at another socket, such as a Lima instance's, binds the socket's own path as before.
  See [current limits](../../docs/resources/limits.md#platforms-models-and-placement).

Gateways:

- [Current limits](../../docs/resources/limits.md#data-and-cleanup) list a managed Docker gateway that stops without a graceful shutdown, such as after a SIGKILL: it leaves its sandboxes in `Error`, and the next apply replaces them ([#13953](https://github.com/NVIDIA/NemoClaw/issues/13953)).
- While a managed Docker or Podman gateway's container is stopped, plan, apply, and destroy fail with an error that names the container and the `docker start` or `podman start` command that starts it, instead of `observation transport failed`.
  See [troubleshooting](../../docs/observability/troubleshooting.md#identifying-the-failure) ([#14626](https://github.com/NVIDIA/NemoClaw/issues/14626), [#14691](https://github.com/NVIDIA/NemoClaw/issues/14691)).
- `spec.gateway.target` selects where a gateway runs, with exactly one of `docker`, `podman`, `kubernetes`, and `openshift`, each holding only the settings NemoClaw uses there.
  Omitting it selects Docker with its defaults.
  Editors offer only the selected target's fields, and an invalid field reports that target's rule.
  A managed `kubernetes` or `openshift` gateway without `expose` names no address or port: each command forwards a free local port to the gateway pod, and plan and apply report the gateway as `not published`.
  The `openshift` target takes the fields of `kubernetes`, and only it takes [`expose.route`](../../docs/build-deploy/kubernetes.md#through-an-openshift-route), which publishes the gateway at `expose.endpoint`.
  See [adapting a document to another target](../../docs/build-deploy/usage.md#adapting-a-document-to-another-target) and the [breaking change](#breaking-changes-in-v010-rc12).

Recovery:

- After OpenShell rejects a sandbox create as an invalid argument, such as a network policy key with the reserved `_provider_` prefix, a corrected apply or destroy proceeds, instead of failing on an unfinished creation.
  See [recovering an interrupted operation](../../docs/build-deploy/usage.md#recovering-an-interrupted-operation) ([#14654](https://github.com/NVIDIA/NemoClaw/issues/14654)).

### Changes in v0.1.0-rc11

These changes reached `v1` between the `v0.1.0-rc10` and `v0.1.0-rc11` tags.
[Breaking changes](#breaking-changes-in-v010-rc11) are listed separately.

Agents and interfaces:

- The agent holds NVIDIA NeMo Fabric's `instructions`, `tools`, `skills`, `mcp`, and `workflow` sections, and the harness holds `runtime`, `environment`, `discovery`, `telemetry`, and `relay`.
  NemoClaw passes each to Fabric unchanged.
  Sandboxes that share a harness definition through `harnessRef` can give each agent its own instructions, tools, and skills.
  See [configure the agent and the harness](../../docs/agents-inference/agents.md#configuring-the-agent-and-the-harness).
- `spec.policies` holds named sandbox policies that a network selects with `policyRef`, and `spec.grants` holds named grants that a network adds to the isolated preset with `grantRefs`.
  See [reuse policies and grants](../../docs/security/sandbox-network.md#reusing-policies-and-grants).
- A `kind: api` integration, and `openshell_api` in HCL, sends one key to every URL in its `endpoints`, so one registration covers an API spread across hosts.
  `sandboxEnv` (`sandbox_env` in HCL) names the variable the sandbox sees the key in, such as `NVIDIA_API_KEY`.
  Without it, the name stays `NEMOCLAW_API_<NAME>_KEY`.
  NVIDIA OpenShell reports, during apply, a sandbox whose attached registrations put keys in the same variable.
  See [key-authenticated APIs](../../docs/agents-inference/agents.md#key-authenticated-apis).
- Apply prints the command that opens Hermes's terminal UI for a Hermes agent that enables Fabric's `terminal` interface, which Fabric marks experimental.
  See [Hermes's terminal UI](../../docs/agents-inference/interfaces.md#hermess-terminal-ui).
- Apply stops an agent's failed Fabric runtime before it starts another in the sandbox.
  After provider errors, Fabric marks a runtime failed but leaves its processes running.
  Before, every later apply failed with `state_in_use` for an agent that keeps state until someone ran `fabric-agent-ctl stop`, and without kept state, the next start failed because OpenClaw's Gateway still held its ports, after which Fabric refused every start until the sandbox was replaced.
- Agent errors keep the codes Fabric uses when it refuses to start or stop a runtime, instead of reporting `fabric_configuration_failed`.
  `start_uncertain` says to replace the sandbox and apply again, `state_in_use` means another runtime still holds the agent's kept state, and `runtime_busy` means the agent was handling a request, so its runtime is unchanged.
  See [identifying the failure](../../docs/observability/troubleshooting.md#identifying-the-failure).
- A Hermes agent whose route uses an `anthropic` inference provider starts.
  Before, apply failed with `start_failed` because the Hermes image lacked the Anthropic SDK.
  Hermes sends the requests to the provider's endpoint only when its path ends in `/anthropic` or `/anthropic/v1` or its host is Anthropic's, Claude's, or Azure's.

Onboarding:

- The `nemoclaw onboard` review opens with a summary of the agent, model, API key, web search, where the deployment runs, image, network access, and output file.
  The saved YAML follows, collapsed until you press Tab.
- At the image question, `nemoclaw onboard` suggests by digest the newest image on the gateway's engine that installs the chosen harness, or else links the [agent image build instructions](../../docs/build-deploy/build.md#building-agent-images).

Sandbox policy:

- `spec.gateway.policyAuthority.apf` lets NVIDIA Agent Policy Fabric (APF) author each sandbox's policy and serve the inference, web search, and API profiles, and `registration: managed` has NemoClaw register APF with a managed Docker gateway.
  A sandbox on such a gateway can't set `network.policy`, `network.policyRef`, `network.grants`, or `network.grantRefs`.
  See [let APF author sandbox policy](../../docs/build-deploy/usage.md#letting-apf-author-sandbox-policy).

Inference and models:

- A managed vLLM or Ollama container's `container.cpuLimitMillis` reaches Docker through the Docker provider's `cpus`, without the `nemoclaw.nvidia.com/cpu-limit-millis` label.
- A managed vLLM service keeps FlashInfer's autotune results on its model volume, in `/data/vllm-cache/flashinfer-autotune`, so a replaced container doesn't tune again.
  vLLM 0.34.0 otherwise keeps them inside the container.
  See [retained model files](../../docs/agents-inference/models.md#retained-model-files).

Kubernetes and OpenShift:

- `gateway.target.openshift.expose.route` publishes a managed OpenShift gateway at `expose.endpoint` through the OpenShell chart's pass-through Route, for clients such as the OpenShell CLI.
  `expose.route`'s optional `annotations` reach the Route.
  The gateway certificate names the endpoint's host, and NemoClaw's own commands keep their port forward.
  See [publishing through an OpenShift Route](../../docs/build-deploy/kubernetes.md#through-an-openshift-route).

Plan and apply:

- An apply that OpenTofu completes no longer fails with `invalid or unsupported OpenTofu UI stream` when a message in OpenTofu's UI stream is longer than 1 MiB: NemoClaw skips such a message.
  OpenTofu's final `outputs` message passed 1 MiB at about 87 OpenClaw sandboxes on a Kubernetes or OpenShift gateway.

Examples and builds:

- A staged release attaches the CLI bundles that CI built and checked at its tag, one archive each for Linux ARM64 and AMD64, macOS ARM64, and Windows AMD64, with their SHA-256 checksums in `SHA256SUMS`.
- Pinned components: OpenShell 0.1.9, OpenTofu 1.13.9, Ollama 0.40.16, Hermes Agent v0.22.7 with the Switchyard Relay plugin 0.3.2, and OpenClaw 2026.9.34.
- OpenClaw, Hermes, and Pi images run Node.js 26.13.1 LTS.
- [Building from source](../../docs/build-deploy/build.md) uses Rust 1.100.0, as do the Rust stages of the agent, supervisor, and Ollama proxy images.
- The vLLM runtime image builds on vLLM 0.34.0.
  Rebuild it to use it.
  Like 0.32.0, it uses CUDA 13.0, so GPU hosts and Kubernetes GPU nodes need NVIDIA driver 580 or newer.
  With `authentication: bearer`, the supervisor answers vLLM's new `/v1/decisions` endpoint, and the `/checkpoint/prepare`, `/checkpoint/restore`, and `/checkpoint/status` routes that `--enable-sleep-mode` adds without the key, with 404, as it does every request outside its route allowlist.
  See [authenticating a managed vLLM service](../../docs/agents-inference/inference.md#authenticating-a-managed-vllm-service).

OpenShell 0.1.8:

- On Kubernetes, deleting a sandbox no longer waits out its pod's 30-second termination grace period, so destroy and sandbox replacement finish sooner.
- The OpenShell CLI renews a token it got through client credentials while `OPENSHELL_OIDC_CLIENT_SECRET` is set.
  See [reaching the gateway from the OpenShell CLI](../../docs/build-deploy/kubernetes.md#reaching-the-gateway-from-the-openshell-cli).
- The gateway no longer keeps memory for deleted sandboxes.

OpenShell 0.1.9:

- On a managed Kubernetes gateway, the CA in `caConfigMap` verifies only the OIDC issuer's discovery and signing keys, alongside the gateway's own trusted CAs.
  Before, OpenShell's chart set it as the gateway's process-wide `SSL_CERT_FILE`.
  See [authenticating through an existing OIDC issuer](../../docs/build-deploy/kubernetes.md#authenticating-through-an-existing-oidc-issuer).
- Stopping a sandbox no longer ends in `SIGKILL`: its supervisor finishes shutting down within 8 seconds, and Docker waits 10.
- A long-running sandbox no longer exits when its supervisor loses its connection a second time.
- On Kubernetes, a sandbox that times out because its pod can't be scheduled reports the scheduler's reason.
- Supervisor middleware services can use OpenShell's streaming HTTP hooks, which they opt into with the `openshell.supervisor-middleware.http-hooks` capability.
  The legacy `EvaluateHttpRequest` and `HttpResponsePreReturn` hooks still work but are deprecated, and OpenShell 0.2.0 removes them.
  See OpenShell's [supported operations](https://github.com/NVIDIA/OpenShell/blob/ce58cf8e9b953281352d98a637e41616295b1318/docs/extensibility/supervisor-middleware/operations.mdx#http).
- The gateway's OCSF events report a denied write as Create, Update, or Delete rather than Other, so select denials by `class_uid: 6003` and `status_id: 2` rather than `type_uid: 600399`.

### Changes in v0.1.0-rc10

These changes reached `v1` between the `v0.1.0-rc9` and `v0.1.0-rc10` tags.
[Breaking changes](#breaking-changes-in-v010-rc10) are listed separately.

Agents and interfaces:

- `harness.settings.interfaces` turns on OpenClaw's dashboard and Hermes's API server and dashboard.
  Plan checks each against the image's adapter, and apply prints how to reach it, including OpenClaw's terminal UI command.
  See [agent interfaces](../../docs/agents-inference/interfaces.md#reaching-an-agent-interface).
- A sandbox's `serviceExposures` publishes one of its ports at a URL the gateway serves.
  Apply prints each URL and returns it as `serviceUrls` in JSON.
  Changing the exposures updates the running sandbox's endpoints in place.
  See [service exposure](../../docs/agents-inference/interfaces.md#exposing-a-service-through-the-gateway).
- Plan and apply list each agent's runtime ID and `fabric-agent-ctl invoke` command under **Agents**, and as `agents` in JSON results.
  See [invoking an agent](../../docs/agents-inference/interfaces.md#invoking-an-agent).
- Hermes keeps its native state in `/sandbox/artifacts/.fabric/state/nvidia.fabric.hermes/<agent name>`, which every runtime of the agent uses, so its interface tokens moved there.
  OpenClaw's native state stays in a temporary directory that its runtime removes at stop.
  See [agent files](../../docs/build-deploy/state.md#agent-files).
- `skills.directories` lists a folder of skills or one skill per entry for OpenClaw and Hermes, `skills.duplicates: reject` stops the agent's start when two of those skills share a name, and `skills.bundled` selects the harness's own skills.
  In hand-written HCL, `fabric_agent`'s `skills` block takes them as `directories` blocks, `duplicates`, and a `bundled` block.
  See [skills on a mounted volume](../../docs/agents-inference/agents.md#skills-on-a-mounted-volume).
- The Hermes image includes the API server, dashboard, and browser chat dependencies, and the Switchyard Relay plugin.
- Apply restarts an agent runtime that stopped in an unchanged sandbox.
- OpenClaw's startup has one 60-second deadline, instead of 30 seconds for each step.
- A failed agent start reports Fabric's cause.
- OpenClaw stops where the sandbox denies process-group signals.
- An explicit sandbox policy accepts `network_middlewares`.
  See [network middleware](../../docs/security/sandbox-network.md#attaching-network-middleware).
- A network grant's `binaries`, in a document's `grants` or an HCL `managed` block, are kept as written instead of being replaced with the harness's executables.
  OpenShell matches a process by its executable's real path, so name the executable itself rather than a symlink to it, such as `/usr/local/bin/python3.14` rather than `/usr/local/bin/python3`.
  See OpenShell's [binary matching](https://github.com/NVIDIA/OpenShell/blob/5d25211b25a8fc887e8d5c606d57d6ab22f1d76c/docs/how-it-works/policies/network-rules.mdx#binary-matching).

Inference and models:

- `container.gpuDevices` selects the GPU for a Docker-managed vLLM or Ollama service, by UUID or index.
  It takes one entry.
  See [container limits](../../docs/agents-inference/inference.md#setting-container-limits-and-update-policy).
- `serving.tensorParallelSize` and `serving.pipelineParallelSize` set vLLM's parallel layout.
  See [the parallel layout](../../docs/agents-inference/models.md#setting-the-parallel-layout).
  Until `container.gpuDevices` takes more than one GPU, vLLM refuses a layout larger than one GPU.
  See [current limits](../../docs/resources/limits.md#platforms-models-and-placement).
- A service's GPU memory budget applies to each GPU it uses, and capacity errors name the GPU.
- On dedicated-memory GPUs, `memory.hostReserveGiB` can be as low as 6 GiB, and a vLLM recipe's GPU budget is checked against the GPU's memory.
  See [hardware profiles](../../docs/agents-inference/models.md#choosing-a-hardware-profile).
- In hand-written HCL, the vLLM and Ollama capacity data sources take `gpu_devices`, and `vllm_runtime` and `ollama_runtime` take `gpu_count`, which must be 1 for now, and report it in `requirements`.
  See [service capacity](../../docs/references/provider.md#service-capacity).
- When vLLM exits during startup, the apply error includes the last 4 KiB of its output, with the service key redacted.
  An Ollama runtime's stop detail, such as a memory protection stop, also appears in its apply error.
- Plan refuses a sandbox that attaches more than 32 providers, OpenShell's limit: its inference providers, its web search, and each `api` integration count one each.
  A deployment is no longer limited to 32 selected inference providers.
  See [inference](../../docs/agents-inference/inference.md).

Gateways and Kubernetes:

- A document holds up to 256 sandboxes with a `kubernetes` or `openshift` gateway.
  Docker and Podman keep 32.
  See [sandbox count and cluster size](../../docs/build-deploy/kubernetes.md#sandbox-count-and-cluster-size).
- A managed `kubernetes` or `openshift` gateway's memory limit is 2Gi, up from 1Gi, which ran out of memory before a document reached 256 sandboxes.
- An external gateway's `gateway.tls` can name a CA alone.
  A client certificate and key must appear together.
- `gateway.kubernetes.kubeconfig` and `context` can be omitted together.
  Without them, NemoClaw uses the service account of the pod it runs in.
  See [running NemoClaw in a pod](../../docs/build-deploy/kubernetes.md#running-nemoclaw-in-a-pod).
- `gateway.kubernetes.namespace` can name an existing namespace: NemoClaw binds it by UID and never labels, changes, or deletes it, and refuses a namespace that another deployment created or that's being deleted.
- NemoClaw no longer reads cluster-wide objects: it doesn't check for a default StorageClass, the Agent Sandbox CRD, or `kube-system`.
  Without a default StorageClass, the gateway install times out in Helm's wait.
- A managed OpenShift gateway lets OpenShift assign its UID and `fsGroup`.
- `gateway.kubernetes.expose` publishes a managed Kubernetes or OpenShift gateway at `gateway.endpoint` through the OpenShell chart's own `NodePort` Service, for clients such as the OpenShell CLI.
  NemoClaw's own commands keep their port forward.
  See [publishing the gateway](../../docs/build-deploy/kubernetes.md#publishing-the-gateway-outside-the-cluster).
- A managed Kubernetes or OpenShift gateway's Helm install is atomic.
  A release left by an unfinished install fails apply with the `helm uninstall` command to run.
  See [recovering an unfinished Helm install](../../docs/build-deploy/usage.md#recovering-from-an-unfinished-helm-install).
- Plan fails when a managed Docker or Podman gateway's subnet or port is already in use.

Plan, apply, and diagnostics:

- The first interrupt lets the resource operations in progress finish.
  A second stops at once.
  See [recovering an interrupted operation](../../docs/build-deploy/usage.md#recovering-an-interrupted-operation).
- Refusals name the object or setting: an ownership conflict, retained gateway storage from another state directory, a missing kubeconfig context, an image metadata bundle for another digest, and gateway TLS failures.
- The sandbox deletion warning ends with "except on mounted volumes".
- Adding a sandbox whose name sorts first leaves the other sandboxes unchanged.
- `metadata.uid` accepts uppercase hexadecimal digits.
- When a command's OpenTofu diagnostics together exceed 16 KiB, its error lists the whole diagnostics that fit, the next one's summary, and how many it left out, instead of replacing them all with `child output exceeds the supported limit`.

Onboarding:

- `nemoclaw onboard` offers OpenClaw and Hermes, saves only the values you chose, and leaves the rest for plan to fill.
- It doesn't ask for settings it can decide, such as a named vendor's API, the only engine that answered, or the network tier.
  The review shows why a value can't be saved and whether each credential is set.
- Saving prints the `nemoclaw plan` and `nemoclaw apply` commands with the saved path.
- The review explains how to set an unset credential and, for a hosted provider, names the page that issues its key.
- The Nous Research preset names `NOUS_API_KEY`.

Examples and builds:

- New examples: [an application container beside an agent](../../examples/features/application-container.yaml) and [GPU autoscaling on Kubernetes](../../examples/platforms/kubernetes/gpu-autoscaling/README.md).
- The [GTC DC](../../examples/guides/nemotron-super.md) Kubernetes profile runs one OpenClaw and one Hermes agent on a managed gateway, in YAML or HCL, and keeps their files on PVCs.
  The local templates allow 8,192 output tokens.
- Linux bundles are built on Ubuntu 22.04 and need glibc 2.35 or newer.
  Ubuntu 22.04 is the oldest supported Linux.
  See [prerequisites](../../docs/get-started/prerequisites.md).
- Run `cargo images fetch` before a direct `docker buildx bake` build of an agent or Ollama image.
  See [building images](../../docs/build-deploy/build.md).
- Dependency pins take security fixes, including rustls, webpki, tokio, and zip.
- Pinned components: OpenShell 0.1.7, OpenTofu 1.12.12, Ollama 0.40.14, Hermes Agent v0.22.5, and OpenClaw 2026.9.34.

## Breaking Changes and Migration

Earlier CLI commands, schemas, and state formats have no compatibility guarantees.
See [migration](../../docs/get-started/migration.md) for where each earlier task lives now, and [state](../../docs/build-deploy/state.md) for data preservation.

### Breaking Changes Since v0.1.0-rc12

These changes since `1636069b91`, the commit that `v0.1.0-rc12` tagged, affect existing deployments or documents:

- The intent record is now version 33, so this release refuses any deployment that `v0.1.0-rc12` or an earlier build of this branch created, without changing its state.
  Destroy each one with the bundle that created it, then create it again with this release.
  See [compatibility](../../docs/references/compatibility.md#deployment-state).
- Agent images register the Fabric workflow targets they install, so plan checks a sandbox with a `workflow` against Fabric's compatibility check too ([#14600](https://github.com/NVIDIA/NemoClaw/issues/14600)).
  A document that sets a field the workflow's adapter doesn't accept, such as a route's `maxTokens` for NOOA, or a `workflow.target_id` the image doesn't register, now fails plan naming that field.
  Before, plan passed it and the agent failed to start after apply created resources.
  With an image built before this change, whose catalog lists no workflow targets, plan reports the image's Fabric capabilities as unverified and Fabric checks the configuration when the agent starts.
- Plan rejects a sandbox's `driverConfig` on a managed gateway whose `spec.gateway.config` doesn't set `allow_driver_config: true` in the compute driver's table, such as `openshell.drivers.docker`, naming the sandbox's `driverConfig` ([#14781](https://github.com/NVIDIA/NemoClaw/issues/14781)); editors that use the configuration schema show it too.
  An empty `driverConfig` is still accepted.
  Before, plan passed it and OpenShell refused the sandbox during apply, after other resources were created.
- In HCL, `openshell_sandbox` requires `owner`, its workspace's owner, such as `owner = openshell_workspace.example.owner`, and plan rejects a sandbox without it.
  Before, the provider generated an owner that never matched the workspace's, so apply failed.
  Plan also rejects a sandbox policy that OpenShell's validator refuses, a sandbox that attaches more than 32 registrations, and an `openshell_inference` without a supported `api`, `server`, or `binaries`, while the workspace's owner or generation is still to be generated. Each error names the attribute and the reason.
  Before, these passed plan and failed during apply.
- A managed `kubernetes` or `openshift` gateway reports no sandbox service URLs, so apply lists none: OpenShell 0.1.10's chart turns off gateway service routing.
  To route services through the gateway, set `enable_gateway_service_routing: true` in the `openshell.gateway` table of `spec.gateway.config`, as [deploying with a managed gateway](../../docs/build-deploy/kubernetes.md#deploying-with-a-managed-gateway) describes, or reach them with `openshell forward service`.
  Before, apply listed URLs that didn't open as printed ([#14316](https://github.com/NVIDIA/NemoClaw/issues/14316)).

### Breaking Changes in v0.1.0-rc12

These changes between the `v0.1.0-rc11` and `v0.1.0-rc12` tags affect existing deployments or documents:

- The intent record is now version 31, so this release refuses any deployment that `v0.1.0-rc11` or an earlier build of this branch created, without changing its state.
  Destroy each one with the bundle that created it, then create it again with this release.
  See [compatibility](../../docs/references/compatibility.md#deployment-state).
- OpenClaw's `harness.settings.plugins.entries` is now `plugins.bundled.entries`, for plugins that ship with OpenClaw, and `plugins.external.entries`, for plugins you provide; Fabric's OpenClaw adapter no longer accepts `plugins.entries`.
- `spec.gateway.target` replaces `spec.gateway.runtime` and the gateway's flat settings.
  The parser rejects the old fields, and plan refuses a changed target on an existing deployment.
  A managed Docker or Podman gateway takes an integer `port`, 17681 by default, instead of `endpoint`, with `engine`, `networkCIDR`, and `imagePullPolicy` beside it.
  Before:

  ```yaml
  gateway:
    management: managed
    runtime: {provider: docker}
    endpoint: http://127.0.0.1:17671
    engine: unix:///var/run/docker.sock
    networkCIDR: 172.20.0.0/24
  ```

  After:

  ```yaml
  gateway:
    management: managed
    target:
      docker:
        port: 17671
        engine: unix:///var/run/docker.sock
        networkCIDR: 172.20.0.0/24
  ```

  A managed Kubernetes gateway's `kubernetes` settings move under `target.kubernetes`, and a published gateway's `endpoint` moves into `expose`.
  Without `expose`, remove `endpoint`: each command forwards its own free local port.
  Before:

  ```yaml
  gateway:
    management: managed
    runtime: {provider: kubernetes}
    endpoint: https://gateway.agents.example.com:30080
    kubernetes:
      kubeconfig: {env: NEMOCLAW_CLUSTER_KUBECONFIG}
      context: my-cluster
      namespace: agents
      authentication: {profile: development}
      expose:
        service: {type: NodePort}
  ```

  After:

  ```yaml
  gateway:
    management: managed
    target:
      kubernetes:
        kubeconfig: {env: NEMOCLAW_CLUSTER_KUBECONFIG}
        context: my-cluster
        namespace: agents
        authentication: {profile: development}
        expose:
          endpoint: https://gateway.agents.example.com:30080
          service: {type: NodePort}
  ```

  - With `runtime: {provider: openshift}`, write the same settings under `target: {openshift: {...}}` instead of `target: {kubernetes: {...}}`.
  - Move `kubernetes: {imagePullSecrets: [registry-credentials]}` to `config: {openshell.drivers.kubernetes: {image_pull_secrets: [registry-credentials]}}`.
    The gateway and its helper pods no longer get pull Secrets.
    See [current limits](../../docs/resources/limits.md#platforms-models-and-placement).
  - On an external gateway, `runtime` and `engine` become the target: `runtime: {provider: podman}` with `engine: unix:///run/user/1000/podman/podman.sock` becomes `target: {podman: {engine: unix:///run/user/1000/podman/podman.sock}}`, and `runtime: {provider: kubernetes}` becomes `target: {kubernetes: {}}`.
  - JSON results omit `connection.gatewayEndpoint` for a managed Kubernetes or OpenShift gateway without `expose`.
  - In hand-written HCL, `openshell_kubernetes_storage`, `openshell_kubernetes_auth`, and `openshell_kubernetes_gateway` take no `endpoint`, and `openshell_gateway` takes `kubernetes` without `endpoint`, with `target` in the specification's `settings`, as in [the Kubernetes HCL example](../../examples/platforms/kubernetes/hosted-inference/hosted-nvidia.tf).
  - In the Rust SDK, `ManagedGateway` and `ExternalGateway` hold `target`, a `ManagedTarget` or an `ExternalTarget`, `Runtime` is removed, and `ManagedKubernetes` has no `image_pull_secrets`.

### Breaking Changes in v0.1.0-rc11

These changes between the `v0.1.0-rc10` and `v0.1.0-rc11` tags affect existing deployments or documents:

- A `kind: api` integration takes `endpoints`, a list of URLs, instead of `endpoint`, and `openshell_api` takes `endpoints` instead of `endpoint`.
  The parser rejects `endpoint`.
  Write `endpoint: https://bookings.example.com/mcp` as `endpoints: [https://bookings.example.com/mcp]`.
  An `openshell_api` with an `mcp` block takes exactly one URL.
- The intent record is now version 25, so this release refuses any deployment that `v0.1.0-rc10` or an earlier build of this branch created, without changing its state.
  Destroy each one with the bundle that created it, then create it again with this release.
  See [compatibility](../../docs/references/compatibility.md#deployment-state).
- `harness.config` is removed. Move each Fabric section to the agent or the harness, unchanged.
  The parser rejects `config` as an unknown field.
  `instructions`, `tools`, `skills`, `mcp`, and `workflow` move to the sandbox's `agent`.
  `runtime`, `environment`, `discovery`, `telemetry`, and `relay` stay on the harness, one level up.
  Before:
  ```yaml
  harness:
    kind: nvidia.fabric.hermes
    config:
      runtime: {max_turns: 16}
      instructions: {system: {mode: replace, content: "Research flights."}}
      skills: {directories: [{folder: /sandbox/skills}], duplicates: reject}
  agent:
    name: flights
  ```
  After:
  ```yaml
  harness:
    kind: nvidia.fabric.hermes
    runtime: {max_turns: 16}
  agent:
    name: flights
    instructions: {system: {mode: replace, content: "Research flights."}}
    skills: {directories: [{folder: /sandbox/skills}], duplicates: reject}
  ```
- `harness.execution` is removed. Set Fabric's `runtime.timeout_seconds` on the harness instead: replace `harness: {kind: nvidia.fabric.openclaw, execution: {timeoutSeconds: 600}}` with `harness: {kind: nvidia.fabric.openclaw, runtime: {timeout_seconds: 600}}`.
- `agent.tools` is Fabric's tools section, and its `allow` list is removed. Rename `allow` to Fabric's `enabled`, so `tools: {allow: [read, write]}` becomes `tools: {enabled: [read, write]}`.
  `blocked` and `definitions` are now available too.
- In the Rust SDK, `AgentExecution` and `AgentTools` are removed: `Harness` and `Agent` hold each Fabric section as a JSON object, and `Network` has `grant_refs` and a `NetworkPolicy::Reference` variant.
  Use `Document::sandbox_network` to read a sandbox's resolved policy and grants.
- Every sandbox must set `image.ref` to an agent image pinned by digest, on Docker and Podman as on Kubernetes.
  The SDK no longer supplies a default agent image, and the parser rejects an omitted `image`, `image: {}`, and an empty `ref`.
  See [build agent images](../../docs/build-deploy/build.md#building-agent-images).
  In the Rust SDK, `config::DEFAULT_AGENT_IMAGE` is removed.
- With OpenShell 0.1.8, an explicit policy endpoint that sets `websocket_credential_rewrite: true` needs `protocol: websocket`.
  On `protocol: rest`, plan fails with `explicit sandbox policy failed OpenShell validation`.
  A `rest` endpoint answers WebSocket upgrade requests with `403`, so WebSocket traffic needs its own `websocket` endpoint.
- With OpenShell 0.1.8, a sandbox doesn't start when a filesystem policy path goes through a symlink in a writable workspace.
  Name the symlink's target instead.
  An endpoint host written as an IPv4-mapped IPv6 address, such as `::ffff:203.0.113.7`, no longer matches.
  Write the IPv4 address.
- With OpenShell 0.1.9, a `network_middlewares` endpoint selector that names a port, such as `api.example.com:443`, fails plan with `explicit sandbox policy failed OpenShell validation`.
  Remove the port.
  Such a selector never matched any traffic.
- With OpenShell 0.1.9, a policy endpoint whose host is a DNS glob no longer admits a request to a private IP address written as a literal, such as `10.0.0.5`.
  Add an endpoint for that address or list it in the endpoint's `allowed_ips`.
- Plan asks Fabric, at NVIDIA/NeMo-Fabric `c6d1093d`, whether the image's adapter accepts each sandbox's configuration, and fails before any resource changes when it doesn't.
  This covers harness settings, model fields, tool settings, and extensions that NemoClaw didn't check before, such as a setting the adapter's schema doesn't declare.
  Each error names the field you wrote.
  A workflow is checked at plan only when the image's catalog describes its target.
- With Fabric at NVIDIA/NeMo-Fabric `main` `135147a0`, an OpenClaw agent's `skills.bundled` also selects the skills that OpenClaw's own extensions ship, such as `canvas`.
  An extension skill that the selection leaves out no longer loads.
  An agent doesn't start when `nvidia.fabric.nooa` has no `workflow.target_id`, or when the Deep Agents `local_shell` backend has neither `tools.enabled` nor `execute` in `tools.blocked`.
- The bundle carries Docker provider 4.7.0, so hand-written HCL must require `registry.opentofu.org/kreuzwerker/docker` version `4.7.0`, as the [HCL examples](../../examples/features/travel/hcl/main.tf) do.

### Breaking Changes in v0.1.0-rc10

These changes between the `v0.1.0-rc9` and `v0.1.0-rc10` tags affect existing deployments or documents:

- The intent record is now version 21.
  `v0.1.0-rc9` wrote version 15, and the record moved to 16, 17, 18, 19, 20, and 21 as later changes altered it.
  This release refuses any deployment whose intent record is an earlier version, including every one that `v0.1.0-rc9` created, without changing its state.
  Destroy each one with the bundle that created it, then create it again with this release.
  See [compatibility](../../docs/references/compatibility.md#deployment-state).
- `spec.sandboxes`, `spec.inferenceProviders`, and a sandbox's `inferenceProviders` are maps keyed by name.
  The parser rejects the earlier lists.
  A provider declared inline on a route still takes `name`.
  In the Rust SDK, these fields are `BTreeMap`s, and `InferenceProvider` has no `name`.
- A vLLM recipe whose `compatibility.gpu` belongs to no hardware profile's GPU family no longer parses.
- Plan rejects `maxTokens`, `temperature`, and `topP` when the image's adapter doesn't accept them.
  See [OpenClaw route tuning](../../docs/agents-inference/inference.md#tuning-openclaws-primary-route).
- Hermes's `max_tokens` setting no longer defaults to 512, so Hermes uses its own response-token limit.
- `skills.paths` works as in `v0.1.0-rc9`: OpenClaw requires each path to hold `SKILL.md`, and Hermes passes each path to its `skills.external_dirs` unchecked.
  Earlier v1 development builds also read an OpenClaw or Hermes path as a folder of skills and refused duplicate names.
  List such a folder as a `folder` entry in `skills.directories`, with `duplicates: reject` to keep refusing duplicate names.
  OpenClaw agents in those builds also kept their native state in `/sandbox/artifacts/.fabric/state/nvidia.fabric.openclaw/<agent name>`.
  That folder is no longer used, and the dashboard token is again under the runtime's own folder.
  See [skills on a mounted volume](../../docs/agents-inference/agents.md#skills-on-a-mounted-volume).
- An endpoint must begin with its scheme and `://`.
  Endpoints and service addresses can't name a cloud metadata host, such as `metadata` or `fd00:ec2::254`, or an IPv6 address that embeds an IPv4 address.
  A `networkCIDR` must be in canonical form, without leading zeros.
- In hand-written HCL, `openshell_kubernetes_auth` has no `gateway_values` attribute.
- In hand-written HCL on Kubernetes or OpenShift, the gateway ownership receipts that `v0.1.0-rc9` wrote no longer load, and the intent record refusal above doesn't cover them.
  Destroy such a deployment with the bundle that created it, then create it again with this release.

### Earlier Breaking Changes

These changes before the `v0.1.0-rc9` tag affect existing deployments:

- Docker-managed vLLM and Ollama services default to [`updatePolicy: Preserve`](../../docs/agents-inference/inference.md#setting-container-limits-and-update-policy), which refuses an image, model, serving, or container-limit change that would replace a running container.
  Set `spec.services.<name>.updatePolicy: Recreate` to permit the replacement and its downtime.
- `spec.gateway.image` is removed: the SDK pins the managed gateway image, and defaulted and exported documents no longer name it.
  - Remove the field from documents.
    The parser rejects it as an unknown field.
  - In the Rust SDK, `ManagedGateway` has no `image` field.
    `managed::Spec.image` carries the managed gateway's pin.

## Support Matrix

These tables describe `v1` as of these notes: what it accepts, and what CI runs it on.
A configuration without an automated run is accepted but untested.
They aren't a support statement: v1 has [no support policy yet](../../docs/resources/limits.md#installation-and-releases).
[Current limits](../../docs/resources/limits.md) lists what v1 doesn't do or hasn't tested, and [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) tracks a tested matrix of harness, model, provider, and platform combinations.

### Client Platforms

Each release attaches the CLI for these platforms.
[Installing the CLI](../../docs/get-started/install.md) lists each archive's requirements, and [current limits](../../docs/resources/limits.md#installation-and-releases) what the executables lack.
[CI / Bundle](../../.github/workflows/rust.yml) runs the unit, contract, and integration tests on each one.

| Platform | Archive | Deploys | Live tests in CI |
|---|---|---|---|
| Linux ARM64 | `linux_arm64` | Yes | Docker and kind suites |
| Linux AMD64 | `linux_amd64` | Yes | Docker and kind suites, the cases on NVIDIA hosted inference, and the GPU cases |
| macOS ARM64 | `darwin_arm64` | Yes | None |
| Windows AMD64 | `windows_amd64` | Yes, through a local engine's named pipe or SSH; no Windows host has run a deployment | None |

The builder also accepts `darwin_amd64`, but no release attaches it and CI doesn't build it.

### Gateway Runtimes

Sandboxes and model services run on Linux engines or clusters.
The agent and runtime images are built for `linux/arm64` and `linux/amd64`.

| `spec.gateway.target` | Accepted | Live tests in CI |
|---|---|---|
| `docker` | Managed or external gateway; managed vLLM, Ollama, llama.cpp, and container services, and the native NIM candidate | Docker suite, the cases on NVIDIA hosted inference, and the GPU cases |
| `podman` | Managed rootless gateway on a local Linux engine or, from a Windows or macOS client, a Podman machine, or external gateway; model services only on a Docker host through [SSH placement](../../docs/agents-inference/remote-service.md) | None |
| `kubernetes` | Managed or external gateway, with external inference endpoints | kind suite |
| `openshift` | Managed or external gateway, with external inference endpoints | None; [run by hand](live-tests.md#openshift-gateway) on OpenShift Local |

### Model Services

| Service | Live tests in CI |
|---|---|
| External endpoint, such as NVIDIA hosted inference | OpenClaw and Hermes on NVIDIA hosted inference, on Linux AMD64; stub endpoints in the Docker and kind suites |
| Managed vLLM | OpenClaw on the GPU runner, and NVIDIA Nemotron on NVIDIA DGX Station by manual dispatch |
| Managed Ollama | Hermes on the GPU runner |
| Managed llama.cpp | OpenClaw on the GPU runner, in the [`docker-openclaw-llama-cpp`](../../crates/nemoclaw-e2e/cases/docker-openclaw-llama-cpp.yaml) case |
| Native NIM, a candidate | None; [qualified by hand](https://github.com/NVIDIA/NemoClaw/issues/14556#issuecomment-7016789006) on DGX Spark and L40S |
| External Ollama through a managed proxy | None; contract and integration tests run it against fixtures |

### Harnesses

The image workflow builds and checks an image for each harness in the [Fabric harness table](../../docs/references/fabric-harnesses.md): OpenClaw, Hermes, Deep Agents, Claude, Codex, Mini SWE Agent, Nooa, Nooa Bench, Remote Agent, Pi, and OpenCode.
The live tests deploy OpenClaw and Hermes.
No live test deploys the others.
Onboarding offers OpenClaw and Hermes.

### GPUs

Managed vLLM, Ollama, llama.cpp, and NIM services check the GPU against the service's [hardware profile](../../docs/agents-inference/models.md#choosing-a-hardware-profile), such as `dgx-spark`, `dgx-station`, `h100`, or `rtx-pro-6000-blackwell`, or, for vLLM, llama.cpp, and NIM, its dedicated GPU requirements.
Accepting a profile doesn't qualify that GPU.
A sandbox's [`gpus`](../../docs/agents-inference/agents.md#gpu-access-for-agent-tools) asks OpenShell for GPUs for the agent's tools; no live test requests them.

| GPU host | Live tests |
|---|---|
| NVIDIA RTX PRO 6000 Blackwell, Linux AMD64 | The GPU cases, on CI's GPU runner, on `v1` pushes and manual runs |
| DGX Station (GB300), Linux ARM64 | One case, by manual dispatch of Live / HCL |
| DGX Spark (GB10), Linux ARM64 | None |
| Other GPUs, Windows/WSL, and macOS | None |

Serving one model on several GPUs isn't supported ([#14384](https://github.com/NVIDIA/NemoClaw/issues/14384)).

## Qualification and Known Issues

Refer to [current limits](../../docs/resources/limits.md) for what v1 doesn't do yet or hasn't tested, with the issue tracking each.

## Previous Releases

The separate NemoClaw v0 product contains the earlier main guides and changelog.
Use [earlier documentation](../../docs/get-started/migration.md#finding-earlier-documentation) to find that product's release notes.
