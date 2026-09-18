<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Use Desired State

Build a [verified native bundle](build.md) and put its `bin` directory on `PATH`.
Choose a checked-in [example](../examples/), set a fresh deployment UUID and available endpoints, and retain the same state directory for every operation.
Each document contains one to 32 named sandboxes, each with exactly one harness configuration.
Use the [multiple-sandbox example](../examples/multiple-sandboxes.yaml) to share inference across different harnesses in one state directory.
[OpenClaw and Pi agents](agents.md) can select multiple model choices.
Each sandbox declares one `agent` and hosts one Fabric runtime; each Deep Agents instance selects one model.
Use separate sandboxes for additional agents, with shared inference definitions when they use the same providers.
Multiple selected providers can own independent managed vLLM services.
Managed Ollama and its proxy still share a singleton lifecycle; see [managed inference dependencies](inference.md#combine-local-and-hosted-providers).

Examples contain deployment identities and local image pins; replace them before provisioning your own deployment.
Apply creates or changes runtime resources and can download container images and model data.
It checks configuration and readiness without sending generation requests.
If you omit `--state-dir`, the CLI uses `.nemoclaw` in the working directory.

```sh
nemoclaw plan --state-dir .local/deployment deployment.yaml
nemoclaw apply --state-dir .local/deployment deployment.yaml
nemoclaw export --state-dir .local/deployment --output exported-new.yaml
nemoclaw apply --state-dir .local/deployment exported-new.yaml
```

Plan and apply require a YAML path.
Pass `-` explicitly to read standard input, for example `cat deployment.yaml | nemoclaw apply -`.
Export writes YAML to standard output, or to a file with `--output exported.yaml`.
`--bundle DIR` selects an explicit private bundle; otherwise the CLI uses the parent of its executable's `bin` directory.

Keep the selected bundle unchanged while an operation runs.
`--bundle-dir` is an alias for `--bundle`.
Export and destroy accept no YAML.
Errors go to stderr with a nonzero exit code.

Plan prints a text preview; use `nemoclaw plan -o json deployment.yaml` for scripts.
Apply and destroy emit JSON; export emits YAML.
See [CLI output](reference/cli.md#output-and-failure) for formats and exit codes.

Plan observes resources without creating containers, pulling images, downloading models, preparing data, or invoking inference.
A fresh managed gateway defers the OpenShell graph until apply makes it reachable.
Apply always creates its own checked plan; a previous public plan is not an approval artifact.

Verify inference and a native agent reply separately; see [verification levels](inference.md#verify-the-result).

For model-specific preparation supplied by a pinned image, see [inline recipes](recipes.md).
Ordinary models can omit `service.recipe`.

## Use a Managed Podman Gateway

Use a local rootless Linux Podman engine through its Unix API socket.
[Linux ARM64 qualification](validation/rust-managed-podman-linux-arm64.md) covers Podman 5.8.7, Deep Agents, and an existing Qwen3-4B inference service.
Rootful operation, remote Podman engines, and other operating systems remain unqualified.

Select `runtime.provider: podman` for every sandbox and set `gateway.engine` to the local Podman API service's Unix socket.
See [the Podman example](../examples/managed-podman.yaml).
The API service is an operator prerequisite; NemoClaw manages its gateway, network, and credential storage through that service.
Load the harness image into the selected Podman image store and use the digest reported there.

Rootless operation requires an API that reports `pasta` networking, as required by the pinned OpenShell callback listener.
Older APIs that omit this information fail during plan.
The host must have a private IPv4 address on its default-route interface.
OpenShell uses that address for sandbox-only callbacks while keeping its user API on loopback.
Every managed gateway uses one compute driver; use separate deployments to select different drivers.
Managed vLLM with Podman sandboxes still requires explicit SSH Docker placement and publication.

Podman's changing compatibility `/info.ID` is not a durable identity.
Gateway bindings use the retained owned network UUID, volume creation identity, container ID, and persisted signing keys.
A missing or replaced bound network is a conflict, not permission to recreate it.
Destroy retains that network and gateway storage.

## Fabric Health During Apply

Apply requests health from the existing hosted Fabric runtime after configuration and infrastructure readiness checks, including on unchanged applies.
It does not start a second runtime, invoke the agent, send generation requests, repair health failures, or replay work.
Plan, export, and destroy do not request Fabric health.

The JSON result includes one `health` entry per sandbox, identifying its sole agent and hosted Fabric runtime.
These observations do not separately test every inference route or integration.
When available, `report` retains Fabric's liveness, activity, readiness, reason codes, timestamps, and dependency observations.
A busy runtime can complete apply if Fabric reports it responsive and ready to accept work.
A dependency marked unsupported is not a successful check; Fabric owns its effect on overall readiness.

The pinned Fabric does not yet provide `runtime.check_health()`.
New agent images include the bridge but report `supported: false`, `report: null`, and `reason_code: fabric_health_unsupported`.
Apply retains its existing configuration and readiness checks in this case; success does not establish fresh Fabric health or working inference.
The proposed upstream contract is [Fabric #305](https://github.com/NVIDIA/NeMo-Fabric/pull/305); real adapter health qualification remains **TBD** until an accepted implementation is pinned and tested.

Use an [agent image built from this revision](build.md#build-agent-images).
An older image without the health bridge fails apply with an image-rebuild diagnostic; a missing bridge is not treated as unsupported Fabric.
Sandbox image changes require the [separate-deployment path](#choose-the-change-path).
Keep the original bundle and state for existing deployments.

Supported health with not-ready or unknown readiness fails apply and retains resources.
The SDK returns structured health observations; the CLI writes them as JSON to stderr with exit status 1.
Transport failures and malformed reports also fail rather than becoming healthy or unsupported.
Keep the state directory, inspect the failure, and explicitly reapply the same configuration after recovery.
The report is an observation at its recorded time, not a promise of future availability or successful tasks.

## Configuration and Credentials

Use [definitions and references](configuration-references.md) to choose shared or inline configuration.
Use the [YAML field reference](reference/configuration.md) to check field names, defaults, conditional requirements, and validation limits.

Unknown fields, duplicate keys, inline secrets, and unsupported combinations are rejected.
Images must use immutable SHA-256 references.
Managed DGX Spark declares `inferenceProviders[].service` instead of `endpoint`, with a pinned model, backend, serving settings, and memory policy.

The checked-in [DGX Spark example](../examples/spark/spark-inline.yaml) declares preparation tools in an inline recipe and uses the resident memory supervisor.
Follow [managed Ollama](inference.md#run-managed-ollama) for its endpoint, local engine, network, model, and recovery requirements.
Use [`ollamaProxy`](inference.md#use-external-ollama-through-a-managed-proxy) to keep the daemon and installed model external while managing an authenticated proxy.
Gateway and inference ownership are independent of the harness; the selected service must still support its request API.

Use `credential: {env: INFERENCE_API_KEY}` for an inference provider or gateway.
The caller supplies the referenced environment value.
For gateway mTLS, `tls.ca.env`, `tls.certificate.env`, and `tls.key.env` reference environment variables whose values are local file paths.

Credential values stay out of configuration, plans, state, and export.
OpenShell stores installed provider credentials for routing; removing the local variable does not revoke them.
Rotation under an unchanged reference is not detected automatically.

The SDK and provider child process need access to referenced credentials during operations.
Remove caller-owned environment values and TLS files when no longer needed.
Destroy removes the owned provider registration, but retained gateway storage remains; revoke upstream credentials separately when retiring them.

Caller-supplied inference credentials require HTTPS.
The managed Ollama proxy uses its private HTTP endpoint and a deployment-generated bearer key.
Uncredentialed inference HTTP endpoints must be literal private or loopback addresses; plaintext gateway addresses must be loopback.
The isolated policy permits inference routing without general network egress.

The isolated preset uses OpenShell's `best_effort` Landlock mode and depends on the host kernel.
Unavailable Landlock restrictions are not enforced.
The [recorded test results](validation/README.md) cover policy tests, not a security qualification.

Use [sandbox policy and proxy configuration](sandbox-network.md) to replace the isolated preset or select an agent HTTP proxy.

## Control Container Image Downloads

Set `imagePullPolicy` beside `image` on a managed `gateway`, `service`, `ollama`, or `ollamaProxy` configuration.
The setting controls image acquisition on that container's engine, including an SSH Docker engine selected by service placement.
Images still require immutable SHA-256 references.

| Policy | Before container creation or restart |
|---|---|
| `Always` | Contact the registry even when the image is cached; a failed pull fails apply |
| `IfNotPresent` | Use the cached image, or pull it when absent |
| `Never` | Use the cached image; fail when it is absent |

Omission preserves existing behavior: `IfNotPresent` for the gateway, Ollama, and Ollama proxy; `Never` for a vLLM service.
Locally built images can use `Never` without requiring a registry copy.
For a published vLLM runtime, add this field under `inferenceProviders[].service`, alongside its existing image, model, and backend settings:

```yaml
imagePullPolicy: IfNotPresent
```

Use the same field on inline or referenced service configurations.
The gateway policy also applies to its credential initializer container.
Changing the policy does not replace or restart a running container; apply records the policy for its next creation or restart.
Export preserves the setting.
Downloaded images stay in the selected engine's image store and survive destroy.

Plan never pulls images and does not establish registry availability.
Image compatibility checks still run during apply.
If pulling fails, retain the state directory, restore registry access, and reapply the same configuration.
With `Never`, load the pinned image into the selected engine before reapplying.

This setting does not control model downloads or sandbox images acquired by OpenShell.
The pinned OpenShell API has no per-sandbox pull-policy field; external gateways and sandboxes reject this YAML field.
Registry credential configuration is unchanged: NemoClaw does not supply credentials to the image-pull request.

## Resource Ownership

Ownership declarations are optional except for the existing `gateway.management` field.
Existing YAML keeps its current behavior when the new fields are omitted.
Adding an equivalent declaration leaves the compiled resources and runtime specifications unchanged; export preserves the declaration after a successful apply.

`managed` means NemoClaw manages the resource's lifecycle under its existing retention policy.
`external` means NemoClaw uses the resource without managing its lifecycle or administrative configuration.
Using an external service still sends requests to it; attaching a container to an external network does not transfer ownership of that network.
An external inference server still has a deployment-owned OpenShell provider registration, which destroy removes.

Paths below are relative to `spec`:

| Object | Ownership when omitted | Accepted declaration |
|---|---|---|
| `inferenceProviders[]` | Managed with `service` or `ollama`; external with `endpoint`, including `ollamaProxy` | `management: managed` or `external`, matching that form |
| `inferenceProviders[].service` and `.ollama` | Managed server | `management: managed` |
| `gateway.storage`, `inferenceProviders[].service.storage`, `.ollama.storage` | Managed storage | `{management: managed}` |
| `gateway.network`, `inferenceProviders[].service.placement.network` | Managed network, configured by the existing sibling `networkCIDR` | `{management: managed}` |
| `inferenceProviders[].service.model` | Managed model download and preparation | `management: managed` alongside repository and revision |
| `inferenceProviders[].ollama.model` | Managed installation of the route's model | `{management: managed}` |
| `inferenceProviders[].ollamaProxy` | Managed authenticated proxy | `management: managed` |
| `inferenceProviders[].ollamaProxy.model` | Existing external model installation | `management: external` alongside its digest |
| `inferenceProviders[].ollama.network` | Existing external network | Network name, or `{management: external, name: NETWORK}` |
| `sandboxes[].network.proxy` | Existing external HTTP proxy | `management: external` alongside host and port |

External gateways cannot declare managed storage or networks.
In the Ollama network object, `management` can also be omitted; `name` is required.
The declarations do not grant permissions, change retention, adopt existing resources, or enable new lifecycle modes.
External model installations are supported through `ollamaProxy.model`.
External volumes, managed Ollama networks, and managed general-purpose HTTP egress proxies are rejected.

For example, under `inferenceProviders[].ollama`, either network form selects the same existing network:

```yaml
network: nc-prototype-slice
```

```yaml
network:
  management: external
  name: nc-prototype-slice
storage:
  management: managed
model:
  management: managed
```

Use an existing network on the configured Ollama engine and keep the other Ollama settings and route model from your deployment.
Run `nemoclaw plan` with the same state directory to verify that adding declarations proposes no resource changes, then apply and export using the commands above.
Finish any interrupted apply with its original YAML before changing declarations.
Ownership checks and failure handling still apply, and managed model storage still survives destroy.

## Editor Schema Assistance

The maintained examples select their schema with a comment:

```yaml
# yaml-language-server: $schema=../schemas/nemoclaw-v1alpha1.schema.json
```

An editor using [YAML Language Server](https://github.com/redhat-developer/yaml-language-server) can provide field completion, hover descriptions, and schema diagnostics.
The path is relative to the YAML file.
When copying an example elsewhere, update the path to the matching schema file.
Use the schema from the same source revision as your CLI; the API version alone does not identify that revision.
For an installed bundle, select its `schemas/nemoclaw-v1alpha1.schema.json` file.

Keep `$schema` in the comment; a YAML field named `$schema` is an unknown configuration field and is rejected.
Exported YAML omits comments, so add the association again if you want editor assistance for an export.

Editor validation does not replace SDK parsing or deployment checks.
See [validation beyond the schema](reference/configuration.md#validation-beyond-the-schema) for those limits.

## Updates and Recovery

Keep the original YAML and bundle before editing a deployment.
Plan the proposed YAML against the existing state directory, review the changes and any `deferred` checks, then apply that same YAML.
Apply recomputes its plan; a successful earlier plan does not reserve resources or authorize a later unchecked change.

### Multiple Sandboxes

Sandbox names must be unique within a deployment; each sandbox declares one named agent.
Agent names may repeat across sandboxes.
Adding a named sandbox preserves existing sandbox and provider identities.
Reordering declarations is not an update.
Each sandbox receives only its selected inference provider policies, while shared definitions reuse one provider registration.
Sandbox-local definitions are visible only to their enclosing sandbox.
Sandboxes can select distinct Brave credential references; shared references reuse one registration.
Ordinary apply still refuses removal or replacement; destroy operates on the whole deployment.
Use separate deployments when you need independent teardown.
Existing state needs the [named-resource transition](state.md#named-sandbox-resources).

### Choose the Change Path

| Proposed change | Current behavior and next step |
|---|---|
| OpenClaw model choices or a Pi catalog with multiple choices or a tool policy | Change the sandbox launch specification; use a separate deployment and verify the selected models through the native agent |
| Pi model or native model metadata with one declared choice and no tool policy | Restarts the Pi runtime inside the existing sandbox; its in-memory conversation is lost; see [Pi model selection](agents.md#pi-model-selection) |
| External inference endpoint, provider implementation, or authenticated/anonymous mode | Changes the immutable native provider profile binding; use a separate deployment |
| Sandbox image, harness, API, OpenClaw tuning, agent/tools, execution settings, interfaces, or attached integration settings | Changes the sandbox launch specification; ordinary apply refuses replacement; use a separate deployment with a fresh UID and state |
| Sandbox network policy or proxy | Changes the sandbox specification; follow [policy change constraints](sandbox-network.md) and use a separate deployment when replacement is required |
| Managed vLLM process image or serving specification | May replace the process only after checking retained storage and the established engine/resource identities; review the plan and [model constraints](models.md) |
| Deployment UID, established gateway endpoint, or bound runtime engine | Cannot retarget the existing state; create a separate deployment |
| Remove a resource or change management mode so its binding disappears | Ordinary apply refuses removal; assess a separate deployment and explicit retirement of the original |
| Change a credential value behind the same environment reference | Unchanged apply does not detect rotation; see [credential lifecycle](security.md#credentials-and-authentication) |

The [plan checks](../crates/nemoclaw-sdk/src/deployment/plan.rs) reject ordinary removal/replacement.
The [runtime stage](../crates/nemoclaw-sdk/src/deployment/runtime.rs) enforces the narrower managed-process replacement path.
A model change does not migrate conversations or guarantee that the new model supports the old model's tools, context, or reasoning settings.

### Verify an Unchanged Reapply

From the directory containing your deployment YAML, with the matching bundle and credential references available:

```sh
nemoclaw export --state-dir .local/deployment --output exported-new.yaml
```

After export succeeds, inspect its configuration and reapply it using the same state:

```sh
nemoclaw plan --state-dir .local/deployment exported-new.yaml
nemoclaw apply --state-dir .local/deployment exported-new.yaml
```

For a fully observed unchanged deployment, expect `No resource changes planned.` with no deferred work.
With `-o json`, this is an empty `changes` list and no `deferred` field.
Deferred work means the plan is incomplete, even if the current changes list is empty.
Unchanged apply still performs configuration and readiness checks; it can fail if a required service is unavailable.
It does not send generation requests.
Keep the original YAML until verification succeeds.

### Recover an Interrupted Operation

Changing an established gateway endpoint is rejected.
There is no lost-state adoption, migration, pruning, or purge command.

After an interrupted apply, keep the original YAML and entire state directory, including `runtime/`, and explicitly reapply.
If the error says an unfinished apply has different intent, use the exact configuration from that unfinished operation before attempting a new change.
If readiness fails after resource creation, established identities remain recorded.
Authentication, transport, incomplete observations, ownership drift, or changed durable identity stop planning; they never authorize recreation.

Export requires complete observations and agent configuration checks, but does not invoke inference.
It preserves references and desired settings, not model weights, histories, native settings, or agent files.
Shell redirection can leave an empty file on failure; check the exit status before using a new export.

When Ollama is stopped, plan previews only service recovery and explicitly defers model inventory and the complete deployment plan.
Apply repairs the verified service, waits for its API, and then obtains a fresh full plan.
Failed inventory still stops normal planning and export; it never becomes confirmed model absence.

Destroy verifies the container and storage without requiring model inventory, because it retains all model data.

## Destroy

Destroy removes all bound sandboxes, provider registrations and profiles, and managed process containers.
**Sandbox files and conversation history are deleted.** Back up native agent data separately when needed.
The workspace, model downloads, prepared data, gateway database and keys, bridge, stopped initializer, images, and local deployment state remain.
Retained resources stay tracked.

Preview deletion, then destroy only the deployment bound to this state directory:

```sh
nemoclaw plan --destroy --state-dir .local/deployment
nemoclaw destroy --state-dir .local/deployment
```

Review the preview before running destroy.
Destroy does not prompt for confirmation.

Destroy validates both saved resource graphs before deletion and removes OpenShell workloads before its gateway.
Repeating completed destroy has no changes.
An interrupted destroy resumes from its recorded graph boundary; other operations refuse unfinished teardown.

Reapply the original configuration to recreate workloads using retained storage.
Managed Ollama retains an independent model-volume binding while deleting its container and releasing the model installation binding.
Model files are not deleted.

For an older deployment, apply its original YAML once to establish the storage binding before destroy.

The local lock excludes other NemoClaw operations on the same state directory, not other gateway clients.
OpenShell deletes by name without an ID/version condition, so a concurrent replacement between the final identity check and delete cannot be eliminated by this client.

## Remote Model Service

Use [the SSH model service guide](remote-service.md) for placement, publication, host prerequisites, and qualification limits.
