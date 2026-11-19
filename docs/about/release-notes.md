<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Release Notes

These notes describe the v1 development documentation and its release boundaries.
v1 has no release yet; [#12638](https://github.com/NVIDIA/NemoClaw/issues/12638) tracks the first one.
The workspace package version alone does not establish that a release has been published.

## Product Changes

The development branch provides desired-state YAML, a Rust SDK, the `onboard`/`plan`/`apply`/`export`/`destroy` CLI, and a bundled OpenTofu provider.
Refer to [the overview](overview.md) for implemented boundaries and [the CLI reference](../references/cli.md) for commands.

### Changes Since v0.1.0-rc11

These changes reached `v1` after the `v0.1.0-rc11` tag; [breaking changes](#breaking-changes-since-v010-rc11) are listed separately.

Onboarding:

- At the model question for NVIDIA Endpoints, OpenRouter, OpenAI, Anthropic, Google Gemini, and Nous Research, `nemoclaw onboard` offers the recommended models the endpoint lists and **Type another model**, instead of the endpoint's whole catalog, which can include models that cannot drive an agent.
  The review notes a typed model that the endpoint does not list.
  See [onboarding model catalogs](../agents-inference/inference.md#onboarding-model-catalogs).

Agents:

- OpenClaw works with `anthropic` providers ([#14529](https://github.com/NVIDIA/NemoClaw/issues/14529)).
- OpenClaw's `web_fetch` reaches hosts that the sandbox's network policy allows ([#14537](https://github.com/NVIDIA/NemoClaw/issues/14537)).
- OpenClaw keeps its native home in `/sandbox/artifacts`, as Hermes does; see [agent files](../build-deploy/state.md#agent-files).
- OpenClaw sessions with kept state no longer fail on turns longer than about a minute or after a few minutes idle ([#14630](https://github.com/NVIDIA/NemoClaw/issues/14630)).

Releases:

- A release's CLI reports the release's version: for `v0.1.0-rc12`, `nemoclaw --version` prints `nemoclaw 0.1.0-rc12`, and the bundle's `manifest.json` says `0.1.0-rc12`.
  Before, they said `0.1.0` and `0.1.0-dev.<hash>`.
  A bundle built from any other checkout, including one with uncommitted changes, still reports `0.1.0-dev.<hash>`, where the hash names its source files.
- A final release attests the build provenance of each CLI archive and of `SHA256SUMS`; verify them with `gh attestation verify FILE --owner NVIDIA`, as [Install the CLI](../get-started/install.md#install-on-linux-or-macos) shows.
  Release candidates have no attestations.
- A final release's macOS and Windows executables must be signed; only a release-scoped exception, which the release notes state with its reason, lets one publish unsigned.
  Release candidates may stay unsigned.
- Each release attaches `release-evidence.json`, which records the signing decision, the signed executables, and the output of the release's checksum, signature, and attestation checks.

Installation:

- [Install the CLI](../get-started/install.md) covers installing, upgrading, and uninstalling a release's CLI from its `nemoclaw-TAG-PLATFORM.tar.gz` archive, checked against `SHA256SUMS`.
- The [support matrix](#support-matrix) lists the platforms, gateway runtimes, model services, harnesses, and GPUs, and what CI runs on each.
- Each operation installs the providers of the bundle that runs it, replacing `.terraform/providers` and `.terraform.lock.hcl` in the state directory.
  Before, with a bundle whose providers had the same versions but other bytes, such as a signed build of the same commit, a deployment kept running the previous bundle's providers while that bundle existed; once it was gone, plan, apply, and destroy failed because the providers didn't match the checksums in the dependency lock file ([#14628](https://github.com/NVIDIA/NemoClaw/issues/14628)).

Images:

- Releases stage a llama.cpp runtime image, `llama-cpp`, beside the vLLM and Ollama images.
  It adds the supervisor to llama.cpp's CUDA 13.5 server image from release b12375, whose ARM64 and AMD64 builds carry kernels for GB300 (`sm_103`) and GB10 (`sm_121a`).
  CUDA 13.5 needs NVIDIA driver 580 or newer; see [build a runtime image](../build-deploy/build.md#build-a-runtime-image).

Windows clients:

- The CLI on Windows reaches a local Docker Desktop or Podman engine through its named pipe, such as `npipe:////./pipe/docker_engine`, and hides typed credentials at its prompts.
  It plans, applies, and destroys a deployment with an external gateway whose `spec.gateway.engine` is that pipe or an `ssh://` engine ([#14631](https://github.com/NVIDIA/NemoClaw/issues/14631)).
- A managed local gateway also runs from a Windows client: set `spec.gateway.engine` to Docker Desktop's or a Podman machine's named pipe, and the gateway container binds `/var/run/docker.sock` in the engine's Linux VM, where Docker Desktop serves its engine and a Podman machine links its rootful or rootless API socket.
  On Windows, `nemoclaw onboard` offers the pipe the Docker client selects, otherwise `npipe:////./pipe/docker_engine`, and the default Podman machine's `npipe:////./pipe/podman-machine-default` ([#14632](https://github.com/NVIDIA/NemoClaw/issues/14632)).
  No Windows host has run a deployment; see [current limits](../resources/limits.md#platforms-models-and-placement).
- An Ollama proxy's `engine` also takes a local named pipe, such as `npipe:////./pipe/docker_engine`, so a proxy for an external gateway runs from a Windows client.

macOS clients:

- A managed local gateway on Docker Desktop, Colima, Rancher Desktop, or a Podman machine binds `/var/run/docker.sock` in the engine's Linux VM, where each engine serves containers its socket, instead of the client's socket path, such as `~/.docker/run/docker.sock`, which the VM may not serve ([#14640](https://github.com/NVIDIA/NemoClaw/issues/14640)).
  NemoClaw recognizes each engine by its default socket; an engine at another socket, such as a Lima instance's, binds the socket's own path as before.
  See [current limits](../resources/limits.md#platforms-models-and-placement).

Gateways:

- [Current limits](../resources/limits.md#data-and-cleanup) list a managed Docker gateway that stops without a graceful shutdown, such as after a SIGKILL: it leaves its sandboxes in `Error`, and the next apply replaces them ([#13953](https://github.com/NVIDIA/NemoClaw/issues/13953)).
- While a managed Docker gateway's container is stopped, plan, apply, and destroy fail with an error that names the container and the `docker start` command that starts it, instead of `observation transport failed`; see [troubleshooting](../observability/troubleshooting.md#identify-the-failure) ([#14626](https://github.com/NVIDIA/NemoClaw/issues/14626)).

### Changes in v0.1.0-rc11

These changes reached `v1` between the `v0.1.0-rc10` and `v0.1.0-rc11` tags; [breaking changes](#breaking-changes-in-v010-rc11) are listed separately.

Agents and interfaces:

- The agent holds Fabric's `instructions`, `tools`, `skills`, `mcp`, and `workflow` sections, and the harness holds `runtime`, `environment`, `discovery`, `telemetry`, and `relay`; NemoClaw passes each to Fabric unchanged.
  Sandboxes that share a harness definition through `harnessRef` can give each agent its own instructions, tools, and skills.
  See [configure the agent and the harness](../agents-inference/agents.md#configure-the-agent-and-the-harness).
- `spec.policies` holds named sandbox policies that a network selects with `policyRef`, and `spec.grants` holds named grants that a network adds to the isolated preset with `grantRefs`.
  See [reuse policies and grants](../security/sandbox-network.md#reuse-policies-and-grants).
- A `kind: api` integration, and `openshell_api` in HCL, sends one key to every URL in its `endpoints`, so one registration covers an API spread across hosts.
  `sandboxEnv` (`sandbox_env` in HCL) names the variable the sandbox sees the key in, such as `NVIDIA_API_KEY`; without it the name stays `NEMOCLAW_API_<NAME>_KEY`.
  OpenShell reports, during apply, a sandbox whose attached registrations put keys in the same variable.
  See [key-authenticated APIs](../agents-inference/agents.md#key-authenticated-apis).
- Apply prints the command that opens Hermes's terminal UI for a Hermes agent that enables Fabric's `terminal` interface, which Fabric marks experimental.
  See [Hermes's terminal UI](../agents-inference/interfaces.md#hermess-terminal-ui).
- Apply stops an agent's failed Fabric runtime before it starts another in the sandbox.
  After provider errors, Fabric marks a runtime failed but leaves its processes running; before, every later apply failed with `state_in_use` for an agent that keeps state until someone ran `fabric-agent-ctl stop`, and without kept state, the next start failed because OpenClaw's Gateway still held its ports, after which Fabric refused every start until the sandbox was replaced.
- Agent errors keep the codes Fabric uses when it refuses to start or stop a runtime, instead of reporting `fabric_configuration_failed`.
  `start_uncertain` says to replace the sandbox and apply again, `state_in_use` means another runtime still holds the agent's kept state, and `runtime_busy` means the agent was handling a request, so its runtime is unchanged.
  See [identifying the failure](../observability/troubleshooting.md#identify-the-failure).
- A Hermes agent whose route uses an `anthropic` inference provider starts; before, apply failed with `start_failed` because the Hermes image lacked the Anthropic SDK.
  Hermes sends the requests to the provider's endpoint only when its path ends in `/anthropic` or `/anthropic/v1` or its host is Anthropic's, Claude's, or Azure's; see [pointing Hermes at an Anthropic endpoint](../agents-inference/inference.md#point-hermes-at-an-anthropic-endpoint).

Onboarding:

- The `nemoclaw onboard` review opens with a summary of the agent, model, API key, web search, where the deployment runs, image, network access, and output file; the saved YAML follows, collapsed until you press Tab.
- At the image question, `nemoclaw onboard` suggests by digest the newest image on the gateway's engine that installs the chosen harness, or else links the [agent image build instructions](../build-deploy/build.md#build-agent-images).
  When the engine holds exactly one such image and neither your template nor an earlier answer names another, onboarding uses it without asking, and the review shows it. To enter another image, go back from the next question.

Sandbox policy:

- `spec.gateway.policyAuthority.apf` lets NVIDIA Agent Policy Fabric (APF) author each sandbox's policy and serve the inference, web search, and API profiles, and `registration: managed` has NemoClaw register APF with a managed Docker gateway.
  A sandbox on such a gateway can't set `network.policy`, `network.policyRef`, `network.grants`, or `network.grantRefs`.
  See [let APF author sandbox policy](../build-deploy/usage.md#let-apf-author-sandbox-policy).

Inference and models:

- A managed vLLM or Ollama container's `container.cpuLimitMillis` reaches Docker through the Docker provider's `cpus`, without the `nemoclaw.nvidia.com/cpu-limit-millis` label.
- A managed vLLM service keeps FlashInfer's autotune results on its model volume, in `/data/vllm-cache/flashinfer-autotune`, so a replaced container doesn't tune again; vLLM 0.34.0 otherwise keeps them inside the container.
  See [retained model files](../agents-inference/models.md#retained-model-files).

Kubernetes and OpenShift:

- `gateway.kubernetes.expose.route` publishes a managed OpenShift gateway at `gateway.endpoint` through the OpenShell chart's pass-through Route, for clients such as the OpenShell CLI; its optional `annotations` reach the Route.
  The gateway certificate names the endpoint's host, and NemoClaw's own commands keep their port forward.
  Plan refuses `expose.route` unless `gateway.runtime.provider` is `openshift` and the endpoint's host is a DNS name.
  See [publishing through an OpenShift Route](../build-deploy/kubernetes.md#through-an-openshift-route).

Plan and apply:

- An apply that OpenTofu completes no longer fails with `invalid or unsupported OpenTofu UI stream` when a message in OpenTofu's UI stream is longer than 1 MiB: NemoClaw skips such a message.
  OpenTofu's final `outputs` message passed 1 MiB at about 87 OpenClaw sandboxes on a Kubernetes or OpenShift gateway.

Examples and builds:

- A staged release attaches the CLI bundles that CI built and checked at its tag, one archive each for Linux ARM64 and AMD64, macOS ARM64, and Windows AMD64, with their SHA-256 checksums in `SHA256SUMS`.
- Pinned components: OpenShell 0.1.9, OpenTofu 1.13.9, Ollama 0.40.16, Hermes Agent v0.22.7 with the Switchyard Relay plugin 0.3.2, and OpenClaw 2026.9.34.
- OpenClaw, Hermes and Pi images run Node.js 26.13.1 LTS.
- [Building from source](../build-deploy/build.md) uses Rust 1.100.0, as do the Rust stages of the agent, supervisor, and Ollama proxy images.
- The vLLM runtime image builds on vLLM 0.34.0; rebuild it to use it.
  Like 0.32.0, it uses CUDA 13.0, so GPU hosts and Kubernetes GPU nodes need NVIDIA driver 580 or newer.
  With `authentication: bearer`, the supervisor answers vLLM's new `/v1/decisions` endpoint, and the `/checkpoint/prepare`, `/checkpoint/restore`, and `/checkpoint/status` routes that `--enable-sleep-mode` adds without the key, with 404, as it does every request outside its route allowlist; see [authenticating a managed vLLM service](../agents-inference/inference.md#authenticate-a-managed-vllm-service).

OpenShell 0.1.8:

- On Kubernetes, deleting a sandbox no longer waits out its pod's 30-second termination grace period, so destroy and sandbox replacement finish sooner.
- The OpenShell CLI renews a token it got through client credentials while `OPENSHELL_OIDC_CLIENT_SECRET` is set.
  See [reaching the gateway from the OpenShell CLI](../build-deploy/kubernetes.md#reach-the-gateway-from-the-openshell-cli).
- The gateway no longer keeps memory for deleted sandboxes.

OpenShell 0.1.9:

- On a managed Kubernetes gateway, the CA in `caConfigMap` verifies only the OIDC issuer's discovery and signing keys, alongside the gateway's own trusted CAs; before, OpenShell's chart set it as the gateway's process-wide `SSL_CERT_FILE`.
  See [authenticating through an existing OIDC issuer](../build-deploy/kubernetes.md#authenticate-through-an-existing-oidc-issuer).
- Stopping a sandbox no longer ends in `SIGKILL`: its supervisor finishes shutting down within 8 seconds, and Docker waits 10.
- A long-running sandbox no longer exits when its supervisor loses its connection a second time.
- On Kubernetes, a sandbox that times out because its pod can't be scheduled reports the scheduler's reason.
- Supervisor middleware services can use OpenShell's streaming HTTP hooks, which they opt into with the `openshell.supervisor-middleware.http-hooks` capability.
  The legacy `EvaluateHttpRequest` and `HttpResponsePreReturn` hooks still work but are deprecated, and OpenShell 0.2.0 removes them; see OpenShell's [supported operations](https://github.com/NVIDIA/OpenShell/blob/ce58cf8e9b953281352d98a637e41616295b1318/docs/extensibility/supervisor-middleware/operations.mdx#http).
- The gateway's OCSF events report a denied write as Create, Update, or Delete rather than Other, so select denials by `class_uid: 6003` and `status_id: 2` rather than `type_uid: 600399`.

### Changes in v0.1.0-rc10

These changes reached `v1` between the `v0.1.0-rc9` and `v0.1.0-rc10` tags; [breaking changes](#breaking-changes-in-v010-rc10) are listed separately.

Agents and interfaces:

- `harness.settings.interfaces` turns on OpenClaw's dashboard and Hermes's API server and dashboard; plan checks each against the image's adapter, and apply prints how to reach it, including OpenClaw's terminal UI command.
  See [agent interfaces](../agents-inference/interfaces.md#reach-an-agent-interface).
- A sandbox's `serviceExposures` publishes one of its ports at a URL the gateway serves; apply prints each URL and returns it as `serviceUrls` in JSON.
  Changing the exposures updates the running sandbox's endpoints in place.
  See [service exposure](../agents-inference/interfaces.md#expose-a-service-through-the-gateway).
- Plan and apply list each agent's runtime ID and `fabric-agent-ctl invoke` command under **Agents**, and as `agents` in JSON results.
  See [invoking an agent](../agents-inference/interfaces.md#invoke-an-agent).
- Hermes keeps its native state in `/sandbox/artifacts/.fabric/state/nvidia.fabric.hermes/<agent name>`, which every runtime of the agent uses, so its interface tokens moved there.
  OpenClaw's native state stays in a temporary directory that its runtime removes at stop.
  See [agent files](../build-deploy/state.md#agent-files).
- `skills.directories` lists a folder of skills or one skill per entry for OpenClaw and Hermes, `skills.duplicates: reject` stops the agent's start when two of those skills share a name, and `skills.bundled` selects the harness's own skills.
  In hand-written HCL, `fabric_agent`'s `skills` block takes them as `directories` blocks, `duplicates`, and a `bundled` block.
  See [skills on a mounted volume](../agents-inference/agents.md#skills-on-a-mounted-volume).
- The Hermes image includes the API server, dashboard, and browser chat dependencies, and the Switchyard Relay plugin.
- Apply restarts an agent runtime that stopped in an unchanged sandbox.
- OpenClaw's startup has one 60-second deadline, instead of 30 seconds for each step.
- A failed agent start reports Fabric's cause.
- OpenClaw stops where the sandbox denies process-group signals.
- An explicit sandbox policy accepts `network_middlewares`.
  See [network middleware](../security/sandbox-network.md#attach-network-middleware).
- A network grant's `binaries`, in a document's `grants` or an HCL `managed` block, are kept as written instead of being replaced with the harness's executables.
  OpenShell matches a process by its executable's real path, so name the executable itself rather than a symlink to it, such as `/usr/local/bin/python3.14` rather than `/usr/local/bin/python3`; see OpenShell's [binary matching](https://github.com/NVIDIA/OpenShell/blob/5d25211b25a8fc887e8d5c606d57d6ab22f1d76c/docs/how-it-works/policies/network-rules.mdx#binary-matching).

Inference and models:

- `container.gpuDevices` selects the GPU for a Docker-managed vLLM or Ollama service, by UUID or index; it takes one entry.
  See [container limits](../agents-inference/inference.md#set-container-limits-and-update-policy).
- `serving.tensorParallelSize` and `serving.pipelineParallelSize` set vLLM's parallel layout; see [the parallel layout](../agents-inference/models.md#set-the-parallel-layout).
  Until `container.gpuDevices` takes more than one GPU, vLLM refuses a layout larger than one GPU; see [current limits](../resources/limits.md#platforms-models-and-placement).
- A service's GPU memory budget applies to each GPU it uses, and capacity errors name the GPU.
- On dedicated-memory GPUs, `memory.hostReserveGiB` can be as low as 6 GiB, and a vLLM recipe's GPU budget is checked against the GPU's memory.
  See [hardware profiles](../agents-inference/models.md#choose-a-hardware-profile).
- In hand-written HCL, the vLLM and Ollama capacity data sources take `gpu_devices`, and `vllm_runtime` and `ollama_runtime` take `gpu_count`, which must be 1 for now, and report it in `requirements`.
  See [service capacity](../references/provider.md#service-capacity).
- When vLLM exits during startup, the apply error includes the last 4 KiB of its output, with the service key redacted; an Ollama runtime's stop detail, such as a memory protection stop, also appears in its apply error.
- Plan refuses a sandbox that attaches more than 32 providers, OpenShell's limit: its inference providers, its web search and each `api` integration count one each.
  A deployment is no longer limited to 32 selected inference providers.
  See [inference](../agents-inference/inference.md).

Gateways and Kubernetes:

- A document holds up to 256 sandboxes with a `kubernetes` or `openshift` gateway; Docker and Podman keep 32.
  See [sandbox count and cluster size](../build-deploy/kubernetes.md#sandbox-count-and-cluster-size).
- A managed `kubernetes` or `openshift` gateway's memory limit is 2Gi, up from 1Gi, which ran out of memory before a document reached 256 sandboxes.
- An external gateway's `gateway.tls` can name a CA alone; a client certificate and key must appear together.
- `gateway.kubernetes.kubeconfig` and `context` can be omitted together; without them, NemoClaw uses the service account of the pod it runs in.
  See [running NemoClaw in a pod](../build-deploy/kubernetes.md#run-nemoclaw-in-a-pod).
- `gateway.kubernetes.namespace` can name an existing namespace: NemoClaw binds it by UID and never labels, changes, or deletes it, and refuses a namespace that another deployment created or that is being deleted.
- NemoClaw no longer reads cluster-wide objects: it doesn't check for a default StorageClass, the Agent Sandbox CRD, or `kube-system`.
  Without a default StorageClass, the gateway install times out in Helm's wait.
- A managed OpenShift gateway lets OpenShift assign its UID and `fsGroup`.
- `gateway.kubernetes.expose` publishes a managed Kubernetes or OpenShift gateway at `gateway.endpoint` through the OpenShell chart's own `NodePort` Service, for clients such as the OpenShell CLI; NemoClaw's own commands keep their port forward.
  See [publishing the gateway](../build-deploy/kubernetes.md#publish-the-gateway-outside-the-cluster).
- A managed Kubernetes or OpenShift gateway's Helm install is atomic; a release left by an unfinished install fails apply with the `helm uninstall` command to run.
  See [recovering an unfinished Helm install](../build-deploy/usage.md#recover-from-an-unfinished-helm-install).
- Plan fails when a managed Docker or Podman gateway's subnet or port is already in use.

Plan, apply, and diagnostics:

- The first interrupt lets the resource operations in progress finish; a second stops at once.
  See [recovering an interrupted operation](../build-deploy/usage.md#recover-an-interrupted-operation).
- Refusals name the object or setting: an ownership conflict, retained gateway storage from another state directory, a missing kubeconfig context, an image metadata bundle for another digest, and gateway TLS failures.
- The sandbox deletion warning ends with "except on mounted volumes".
- Adding a sandbox whose name sorts first leaves the other sandboxes unchanged.
- `metadata.uid` accepts uppercase hexadecimal digits.
- When a command's OpenTofu diagnostics together exceed 16 KiB, its error lists the whole diagnostics that fit, the next one's summary, and how many it left out, instead of replacing them all with `child output exceeds the supported limit`.

Onboarding:

- `nemoclaw onboard` offers OpenClaw and Hermes, saves only the values you chose, and leaves the rest for plan to fill.
- It doesn't ask for settings it can decide, such as a named vendor's API, the only engine that answered, or the network tier; the review shows why a value can't be saved and whether each credential is set.
- Saving prints the `nemoclaw plan` and `nemoclaw apply` commands with the saved path.
- The review explains how to set an unset credential and, for a hosted provider, names the page that issues its key.
- The Nous Research preset names `NOUS_API_KEY`.

Examples and builds:

- New examples: [an application container beside an agent](../../examples/application-container.yaml) and [GPU autoscaling on Kubernetes](../../examples/kubernetes/gpu-autoscaling/README.md).
- The [GTC DC](../../examples/gtc-dc/README.md) Kubernetes profile runs one OpenClaw and one Hermes agent on a managed gateway, in YAML or HCL, and keeps their files on PVCs; the local templates allow 8,192 output tokens.
- Linux bundles are built on Ubuntu 22.04 and need glibc 2.35 or newer; Ubuntu 22.04 is the oldest supported Linux.
  See [prerequisites](../get-started/prerequisites.md).
- Run `cargo images fetch` before a direct `docker buildx bake` build of an agent or Ollama image.
  See [building images](../build-deploy/build.md).
- Dependency pins take security fixes, including rustls, webpki, tokio, and zip.
- Pinned components: OpenShell 0.1.7, OpenTofu 1.12.12, Ollama 0.40.14, Hermes Agent v0.22.5, and OpenClaw 2026.9.34.

## Breaking Changes and Migration

Earlier CLI commands, schemas, and state formats have no compatibility guarantees.
See [migration](../get-started/migration.md) for where each earlier task lives now, and [state](../build-deploy/state.md) for data preservation.

### Breaking Changes Since v0.1.0-rc11

These changes since the `v0.1.0-rc11` tag affect existing deployments or documents:

- The intent record is now version 26, so this release refuses any deployment that `v0.1.0-rc11` or an earlier build of this branch created, without changing its state.
  Destroy each one with the bundle that created it, then create it again with this release; see [compatibility](../references/compatibility.md#deployment-state).

### Breaking Changes in v0.1.0-rc11

These changes between the `v0.1.0-rc10` and `v0.1.0-rc11` tags affect existing deployments or documents:

- A `kind: api` integration takes `endpoints`, a list of URLs, instead of `endpoint`, and `openshell_api` takes `endpoints` instead of `endpoint`; the parser rejects `endpoint`.
  Write `endpoint: https://bookings.example.com/mcp` as `endpoints: [https://bookings.example.com/mcp]`.
  An `openshell_api` with an `mcp` block takes exactly one URL.
- The intent record is now version 25, so this release refuses any deployment that `v0.1.0-rc10` or an earlier build of this branch created, without changing its state.
  Destroy each one with the bundle that created it, then create it again with this release; see [compatibility](../references/compatibility.md#deployment-state).
- `harness.config` is removed. Move each Fabric section to the agent or the harness, unchanged; the parser rejects `config` as an unknown field.
  `instructions`, `tools`, `skills`, `mcp`, and `workflow` move to the sandbox's `agent`; `runtime`, `environment`, `discovery`, `telemetry`, and `relay` stay on the harness, one level up.
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
- `agent.tools` is Fabric's tools section, and its `allow` list is removed. Rename `allow` to Fabric's `enabled`, so `tools: {allow: [read, write]}` becomes `tools: {enabled: [read, write]}`; `blocked` and `definitions` are now available too.
- In the Rust SDK, `AgentExecution` and `AgentTools` are removed: `Harness` and `Agent` hold each Fabric section as a JSON object, and `Network` has `grant_refs` and a `NetworkPolicy::Reference` variant.
  Use `Document::sandbox_network` to read a sandbox's resolved policy and grants.
- Every sandbox must set `image.ref` to an agent image pinned by digest, on Docker and Podman as on Kubernetes.
  The SDK no longer supplies a default agent image, and the parser rejects an omitted `image`, `image: {}`, and an empty `ref`; see [build agent images](../build-deploy/build.md#build-agent-images).
  In the Rust SDK, `config::DEFAULT_AGENT_IMAGE` is removed.
- With OpenShell 0.1.8, an explicit policy endpoint that sets `websocket_credential_rewrite: true` needs `protocol: websocket`; on `protocol: rest`, plan fails with `explicit sandbox policy failed OpenShell validation`.
  A `rest` endpoint answers WebSocket upgrade requests with `403`, so WebSocket traffic needs its own `websocket` endpoint.
- With OpenShell 0.1.8, a sandbox doesn't start when a filesystem policy path goes through a symlink in a writable workspace; name the symlink's target instead.
  An endpoint host written as an IPv4-mapped IPv6 address, such as `::ffff:203.0.113.7`, no longer matches; write the IPv4 address.
- With OpenShell 0.1.9, a `network_middlewares` endpoint selector that names a port, such as `api.example.com:443`, fails plan with `explicit sandbox policy failed OpenShell validation`; remove the port.
  Such a selector never matched any traffic.
- With OpenShell 0.1.9, a policy endpoint whose host is a DNS glob no longer admits a request to a private IP address written as a literal, such as `10.0.0.5`; add an endpoint for that address or list it in the endpoint's `allowed_ips`.
- With Fabric at NVIDIA/NeMo-Fabric `main` `135147a0`, an OpenClaw agent's `skills.bundled` also selects the skills that OpenClaw's own extensions ship, such as `canvas`; an extension skill that the selection leaves out no longer loads.
  An agent doesn't start when `nvidia.fabric.nooa` has no `workflow.target_id`, or when the Deep Agents `local_shell` backend has neither `tools.enabled` nor `execute` in `tools.blocked`.
- The bundle carries Docker provider 4.7.0, so hand-written HCL must require `registry.opentofu.org/kreuzwerker/docker` version `4.7.0`, as the [HCL examples](../../examples/hcl/travel/main.tf) do.

### Breaking Changes in v0.1.0-rc10

These changes between the `v0.1.0-rc9` and `v0.1.0-rc10` tags affect existing deployments or documents:

- The intent record is now version 21.
  `v0.1.0-rc9` wrote version 15, and the record moved to 16, 17, 18, 19, 20, and 21 as later changes altered it.
  This release refuses any deployment whose intent record is an earlier version, including every one that `v0.1.0-rc9` created, without changing its state.
  Destroy each one with the bundle that created it, then create it again with this release; see [compatibility](../references/compatibility.md#deployment-state).
- `spec.sandboxes`, `spec.inferenceProviders`, and a sandbox's `inferenceProviders` are maps keyed by name; the parser rejects the earlier lists.
  A provider declared inline on a route still takes `name`.
  In the Rust SDK, these fields are `BTreeMap`s, and `InferenceProvider` has no `name`.
- A vLLM recipe whose `compatibility.gpu` belongs to no hardware profile's GPU family no longer parses.
- Plan rejects `maxTokens`, `temperature`, and `topP` when the image's adapter doesn't accept them; see [OpenClaw route tuning](../agents-inference/inference.md#tune-openclaws-primary-route).
- Hermes's `max_tokens` setting no longer defaults to 512, so Hermes uses its own response-token limit.
- `skills.paths` works as in `v0.1.0-rc9`: OpenClaw requires each path to hold `SKILL.md`, and Hermes passes each path to its `skills.external_dirs` unchecked.
  Earlier v1 development builds also read an OpenClaw or Hermes path as a folder of skills and refused duplicate names; list such a folder as a `folder` entry in `skills.directories`, with `duplicates: reject` to keep refusing duplicate names.
  OpenClaw agents in those builds also kept their native state in `/sandbox/artifacts/.fabric/state/nvidia.fabric.openclaw/<agent name>`; that folder is no longer used, and the dashboard token is again under the runtime's own folder.
  See [skills on a mounted volume](../agents-inference/agents.md#skills-on-a-mounted-volume).
- An endpoint must begin with its scheme and `://`.
  Endpoints and service addresses can't name a cloud metadata host, such as `metadata` or `fd00:ec2::254`, or an IPv6 address that embeds an IPv4 address.
  A `networkCIDR` must be in canonical form, without leading zeros.
- In hand-written HCL, `openshell_kubernetes_auth` has no `gateway_values` attribute.
- In hand-written HCL on Kubernetes or OpenShift, the gateway ownership receipts that `v0.1.0-rc9` wrote no longer load, and the intent record refusal above doesn't cover them.
  Destroy such a deployment with the bundle that created it, then create it again with this release.

### Earlier Breaking Changes

These changes before the `v0.1.0-rc9` tag affect existing deployments:

- Docker-managed vLLM and Ollama services default to [`updatePolicy: Preserve`](../agents-inference/inference.md#set-container-limits-and-update-policy), which refuses an image, model, serving, or container-limit change that would replace a running container; set `spec.services.<name>.updatePolicy: Recreate` to permit the replacement and its downtime.
- `spec.gateway.image` is removed: the SDK pins the managed gateway image, and defaulted and exported documents no longer name it.
  - Remove the field from documents; the parser rejects it as an unknown field.
  - In the Rust SDK, `ManagedGateway` has no `image` field; `managed::Spec.image` carries the managed gateway's pin.

## Support Matrix

These tables describe `v1` as of these notes: what it accepts, and what CI runs it on; a configuration without an automated run is accepted but untested.
They aren't a support statement: v1 has [no support policy yet](../resources/limits.md#installation-and-releases).
[Current limits](../resources/limits.md) lists what v1 doesn't do or hasn't tested, and [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) tracks a tested matrix of harness, model, provider, and platform combinations.

### Client Platforms

Each release attaches the CLI for these platforms; [install the CLI](../get-started/install.md) lists each archive's requirements, and [current limits](../resources/limits.md#installation-and-releases) what the executables lack.
[CI / Bundle](../../.github/workflows/rust.yml) runs the unit, contract, and integration tests on each one.

| Platform | Archive | Deploys | Live tests in CI |
|---|---|---|---|
| Linux ARM64 | `linux_arm64` | Yes | Docker and kind suites |
| Linux AMD64 | `linux_amd64` | Yes | Docker and kind suites, the cases on NVIDIA hosted inference, and the GPU cases |
| macOS ARM64 | `darwin_arm64` | Yes | None |
| Windows AMD64 | `windows_amd64` | Yes, through a local engine's named pipe or SSH; no Windows host has run a deployment | None |

The builder also accepts `darwin_amd64`, but no release attaches it and CI doesn't build it.

### Gateway Runtimes

Sandboxes and model services run on Linux engines or clusters; the agent and runtime images are built for `linux/arm64` and `linux/amd64`.

| `spec.gateway.runtime.provider` | Accepted | Live tests in CI |
|---|---|---|
| `docker` | Managed or external gateway; managed vLLM, Ollama, and container services | Docker suite, the cases on NVIDIA hosted inference, and the GPU cases |
| `podman` | Managed rootless gateway on a local Linux engine or, from a Windows or macOS client, a Podman machine, or external gateway; model services only on a Docker host through [SSH placement](../agents-inference/remote-service.md) | None |
| `kubernetes` | Managed or external gateway, with external inference endpoints | kind suite |
| `openshift` | Managed or external gateway, with external inference endpoints | None; [run by hand](../../internal-docs/contributing/live-tests.md#openshift-gateway) on OpenShift Local |

### Model Services

| Service | Live tests in CI |
|---|---|
| External endpoint, such as NVIDIA hosted inference | OpenClaw and Hermes on NVIDIA hosted inference, on Linux AMD64; stub endpoints in the Docker and kind suites |
| Managed vLLM | OpenClaw on the GPU runner, and Nemotron on DGX Station by manual dispatch |
| Managed Ollama | Hermes on the GPU runner |
| External Ollama through a managed proxy | None; contract and integration tests run it against fixtures |

### Harnesses

The image workflow builds and checks an image for each harness in the [Fabric harness table](../references/fabric-harnesses.md): OpenClaw, Hermes, Deep Agents, Claude, Codex, Mini SWE Agent, Nooa, Nooa Bench, Remote Agent, Pi, and OpenCode.
The live tests deploy OpenClaw and Hermes; no live test deploys the others.
Onboarding offers OpenClaw and Hermes.

### GPUs

Managed vLLM and Ollama check the GPU against the deployment's [hardware profile](../agents-inference/models.md#choose-a-hardware-profile), such as `dgx-spark`, `dgx-station`, `h100`, or `rtx-pro-6000-blackwell`.
Accepting a profile doesn't qualify that GPU.

| GPU host | Live tests |
|---|---|
| NVIDIA RTX PRO 6000 Blackwell, Linux AMD64 | The GPU cases, on CI's GPU runner, on `v1` pushes and manual runs |
| DGX Station (GB300), Linux ARM64 | One case, by manual dispatch of Live / HCL |
| DGX Spark (GB10), Linux ARM64 | None |
| Other GPUs, Windows/WSL, and macOS | None |

Serving one model on several GPUs isn't supported ([#14384](https://github.com/NVIDIA/NemoClaw/issues/14384)).

## Qualification and Known Issues

Refer to [current limits](../resources/limits.md) for what v1 does not do yet or has not tested, with the issue tracking each.

## Previous Releases

The combined staging site's **Latest (main)** version retains the imported main guides and changelog.
Use [earlier documentation](../get-started/migration.md#find-earlier-documentation) to select that version; its release entries are not v1 release notes.
