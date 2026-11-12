<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Release Notes

These notes describe the v1 development documentation and its release boundaries.
v1 has no release yet; [#12638](https://github.com/NVIDIA/NemoClaw/issues/12638) tracks the first one.
The workspace package version alone does not establish that a release has been published.

## Product Changes

The development branch provides desired-state YAML, a Rust SDK, the `onboard`/`plan`/`apply`/`export`/`destroy` CLI, and a bundled OpenTofu provider.
Refer to [the overview](overview.md) for implemented boundaries and [the CLI reference](../references/cli.md) for commands.

### Changes Since v0.1.0-rc9

These changes reached `v1` after the `v0.1.0-rc9` tag; [breaking changes](#breaking-changes-and-migration) are listed separately.

Agents and interfaces:

- `harness.settings.interfaces` turns on OpenClaw's dashboard and Hermes's API server and dashboard; plan checks each against the image's adapter, and apply prints how to reach it, including OpenClaw's terminal UI command.
  See [agent interfaces](../agents-inference/interfaces.md#reach-an-agent-interface).
- A sandbox's `serviceExposures` publishes one of its ports at a URL the gateway serves; apply prints each URL and returns it as `serviceUrls` in JSON.
  Changing the exposures updates the running sandbox's endpoints in place.
  See [service exposure](../agents-inference/interfaces.md#expose-a-service-through-the-gateway).
- Plan and apply list each agent's runtime ID and `fabric-agent-ctl invoke` command under **Agents**, and as `agents` in JSON results.
  See [invoking an agent](../agents-inference/interfaces.md#invoke-an-agent).
- OpenClaw and Hermes keep their native state in `/sandbox/artifacts/.fabric/state/<adapter id>/<agent name>`, which every runtime of the agent uses, so their interface tokens moved there.
  See [agent files](../build-deploy/state.md#agent-files).
- The Hermes image includes the API server, dashboard, and browser chat dependencies, and the Switchyard Relay plugin.
- Apply restarts an agent runtime that stopped in an unchanged sandbox.
- OpenClaw's startup has one 60-second deadline, instead of 30 seconds for each step.
- A failed agent start reports Fabric's cause.
- OpenClaw stops where the sandbox denies process-group signals.
- An explicit sandbox policy accepts `network_middlewares`.
  See [network middleware](../security/sandbox-network.md#attach-network-middleware).

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
Changes since the `v0.1.0-rc9` tag that affect existing deployments or documents:

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
- In `skills.paths` for OpenClaw and Hermes, a folder with a `SKILL.md` is one skill, and otherwise each direct subfolder with one is a skill.
  A folder without skills adds none, and a missing path or a duplicate skill name fails the agent's start.
  Hermes no longer loads skills more than one folder deep, and no longer skips a missing path.
  See [skills on a mounted volume](../agents-inference/agents.md#skills-on-a-mounted-volume).
- An endpoint must begin with its scheme and `://`.
  Endpoints and service addresses can't name a cloud metadata host, such as `metadata` or `fd00:ec2::254`, or an IPv6 address that embeds an IPv4 address.
  A `networkCIDR` must be in canonical form, without leading zeros.
- In hand-written HCL, `openshell_kubernetes_auth` has no `gateway_values` attribute.
- In hand-written HCL on Kubernetes or OpenShift, the gateway ownership receipts that `v0.1.0-rc9` wrote no longer load, and the intent record refusal above doesn't cover them.
  Destroy such a deployment with the bundle that created it, then create it again with this release.

Earlier changes that affect existing deployments:

- Docker-managed vLLM and Ollama services default to [`updatePolicy: Preserve`](../agents-inference/inference.md#set-container-limits-and-update-policy), which refuses an image, model, serving, or container-limit change that would replace a running container; set `spec.services.<name>.updatePolicy: Recreate` to permit the replacement and its downtime.
- `spec.gateway.image` is removed: the SDK pins the managed gateway image, and defaulted and exported documents no longer name it.
  - Remove the field from documents; the parser rejects it as an unknown field.
  - In the Rust SDK, `ManagedGateway` has no `image` field; `managed::Spec.image` carries the managed gateway's pin.

## Qualification and Known Issues

Refer to [current limits](../resources/limits.md) for what v1 does not do yet or has not tested, with the issue tracking each.

## Previous Releases

The combined staging site's **Latest (main)** version retains the imported main guides and changelog.
Use [earlier documentation](../get-started/migration.md#find-earlier-documentation) to select that version; its release entries are not v1 release notes.
