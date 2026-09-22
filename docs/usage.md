<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Use Desired State

Use a [verified native bundle](build.md) with its `bin` directory on `PATH`.
For a first deployment, follow [get started](get-started.md) or [interactive onboarding](reference/cli.md#commands).
When copying an [example](../examples/), assign a fresh UUID and replace endpoints and image pins with values for your resources.
Keep the matching bundle and the same state directory throughout the deployment.

From the directory containing your YAML, preview the changes.
Plan observes resources without creating containers, pulling images, downloading models, preparing data, or invoking inference.
A fresh managed gateway defers the OpenShell graph until apply makes it reachable.

```sh
nemoclaw plan --state-dir .local/deployment deployment.yaml
```

Review the preview before apply.
Apply computes its own checked plan and can create or change resources and download images or models.
It checks configuration and readiness without invoking inference.

```sh
nemoclaw apply --state-dir .local/deployment deployment.yaml
```

Verify model and agent responses separately using [inference verification](inference.md#verify-the-result).
On failure, retain YAML and state and use [recovery](#recover-an-interrupted-operation).

After apply succeeds, export the observed configuration:

```sh
nemoclaw export --state-dir .local/deployment --output exported-new.yaml
```

Check the exit status before using the export, then follow [unchanged reapply](#verify-an-unchanged-reapply).
Export is not a backup of agent files or conversations.

Without `--state-dir`, state defaults to `.nemoclaw` in the working directory.
Plan and apply require a YAML path or explicit `-` for stdin; export and destroy accept no YAML.
Plan prints text by default; scripts should select `-o json`.
See [CLI options and output](reference/cli.md) for bundle selection, formats, and exit codes.

## Configure Sandboxes and Inference

A document contains one to 32 named sandboxes, each with one harness and one agent.
Use the [multiple-sandbox example](../examples/multiple-sandboxes.yaml) to share inference across different harnesses.
[OpenClaw and Pi](agents.md) can select multiple models; each Deep Agents instance selects one.

Declare managed services under `spec.services` and select their connections with `inferenceProviders[].serviceRef`.
Every declared service is installed and checked, even without an inference consumer.
See [service constraints](inference.md#combine-local-and-hosted-providers) for multiple Ollama/vLLM services and [models](models.md) for hardware contracts and optional [recipes](recipes.md).

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

Apply requests health from each existing Fabric runtime after configuration and infrastructure readiness checks, including on unchanged applies.
It does not invoke agents, send generation requests, repair failures, or replay work.
Plan, export, and destroy do not request Fabric health.

Each sandbox's `health` entry identifies its agent and runtime.
When supported, `report` contains Fabric's liveness, activity, readiness, reasons, timestamps, and dependency observations.
Fabric decides overall readiness; a busy runtime can pass if responsive and ready to accept work.
An unsupported dependency is not a successful check.
These observations do not test every inference route or integration.

**Current limit:** the pinned Fabric lacks `runtime.check_health()`.
New images report `supported: false`, `report: null`, and `reason_code: fabric_health_unsupported` while apply retains its other configuration and readiness checks.
Success therefore does not establish fresh Fabric health or working inference.
Real adapter health qualification remains **TBD** until an accepted implementation is pinned and tested.

Use an [agent image built from this revision](build.md#build-agent-images); an older image missing the bridge fails with a rebuild diagnostic.
Image changes require the [separate-deployment path](#choose-the-change-path); keep existing deployments' original bundles and state.

Not-ready or unknown supported health, transport failures, and malformed reports fail apply and retain resources.
For a supported health failure, the CLI writes structured JSON to stderr and exits with status 1.
Keep state, diagnose the failure, and explicitly reapply after recovery.
Health is an observation at its recorded time, not a guarantee of future availability.

## Configuration and Credentials

Use [definitions and references](configuration-references.md) to choose shared or inline configuration.
Use the [field reference](reference/configuration.md) for names, defaults, and validation rules.

Unknown fields, duplicate keys, inline secrets, and unsupported combinations are rejected; images require immutable SHA-256 references.
Gateway and inference ownership are independent of the harness, but inference must support the harness's request API.
See [managed models](models.md), [Ollama](inference.md#run-managed-ollama), or [external Ollama with a managed proxy](inference.md#use-external-ollama-through-a-managed-proxy) for service configuration.

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
The isolated policy permits inference routing without general egress and uses `best_effort` Landlock; unavailable kernel restrictions are not enforced.
See [policy and proxy configuration](sandbox-network.md) for changes and [security](security.md) for qualification limits.

## Control Container Image Downloads

Set `imagePullPolicy` beside `image` under `spec.gateway` or `spec.services.<name>`.
The service setting applies to `kind: vllm`, `ollama`, and `ollamaProxy`.
The setting controls image acquisition on that container's engine, including an SSH Docker engine selected by the service's `placement.engine`.
Images still require immutable SHA-256 references.

| Policy | Managed inference and proxy images |
|---|---|
| `IfNotPresent` (default) | The Docker provider ensures the pinned image is available and pulls it when absent |
| `Never` | The Docker provider reads the local image; a missing image fails that observation |
| `Always` | Rejected for services; choose pinned acquisition or local-only use |

The local image read and container creation are separate operations.
If another actor removes the image between them, the Docker provider can attempt acquisition during container creation; `Never` is not a network-isolation guarantee.

For locally built images without a registry copy, load the pinned image into the selected engine and set:

```yaml
imagePullPolicy: Never
```

Docker-managed gateways use the same `IfNotPresent` and `Never` modes as services; `Always` is rejected.
Podman gateways retain their existing image policy: omission means `IfNotPresent`, and `Always` contacts the registry before creation or restart, including its credential initializer.
Service acquisition does not promise a registry request on every restart or complete layer progress.
Export preserves the declared setting.
Downloaded service images remain on the selected engine after destroy, although their disposable provider resource bindings are removed.

Plan never pulls images and does not establish registry availability or application compatibility.
If acquisition fails, retain the state directory, restore image availability, and reapply.
Switching between managed acquisition and local-only lookup changes image resource declarations; review its plan.
This setting does not control model downloads or sandbox images acquired by OpenShell.
The pinned OpenShell API has no per-sandbox pull-policy field; external gateways and sandboxes reject this YAML field.

## Resource Ownership

Ownership follows the configuration form; do not repeat it on services, models, storage, networks, or inference providers.
Only `gateway.management` selects a lifecycle mode.

| Configuration | What NemoClaw manages |
|---|---|
| `gateway.management: managed` | The gateway, its network, and credential storage |
| `gateway.management: external` | No gateway infrastructure |
| `spec.services.<name>` with `kind: vllm` or `ollama` | The service container, model installation, and persistent storage |
| `spec.services.<name>` with `kind: ollamaProxy` | The proxy and its credential storage, not its upstream daemon or model |
| Inference provider with `serviceRef` | An OpenShell registration using the named service's connection |
| Inference provider with `endpoint` | An OpenShell registration using an externally operated server |
| `sandboxes[].network.proxy` | No proxy infrastructure; this is an existing HTTP proxy connection |

Every declared service is installed, even without an inference provider referring to it.
Every selected inference provider has a deployment-owned OpenShell registration; destroy removes that registration without deleting an external server.
Managed model and credential storage survive destroy.
Gateway storage and credential checks verify deployment ownership, generation, and the established storage/engine identity.
Docker gateway and disposable service compute follow Docker-provider state and may be recreated or replaced during apply.
Model caches use native Docker volume reconciliation, including its name-based reuse; they have no immutable creation-time binding.
There is no migration or lost-state adoption workflow for credentials or gateway storage.

The former optional `management` annotations and ownership-only `storage`/`network` objects are rejected.
For a new deployment, omit those fields and use a fresh UID and state directory.
Retained intent containing them is not migrated by editing input YAML; keep the original bundle and state for recovery or teardown of that deployment.
Do not edit or delete its state to bypass this rejection.

## Editor Schema Assistance

Add a schema comment for editor completion, descriptions, and diagnostics:

```yaml
# yaml-language-server: $schema=../schemas/nemoclaw-v1alpha1.schema.json
```

Editors using [YAML Language Server](https://github.com/redhat-developer/yaml-language-server) resolve the path relative to the YAML file; update it when copying examples.
Select `schemas/nemoclaw-v1alpha1.schema.json` from the matching bundle or CLI source revision; the API version alone is insufficient.

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
Ordinary apply still refuses sandbox removal or replacement because its files and history are not separately retained; destroy operates on the whole deployment.
Use separate deployments when you need independent teardown.
Existing state needs the [named-resource transition](state.md#named-sandbox-resources).

### Choose the Change Path

| Proposed change | Current behavior and next step |
|---|---|
| OpenClaw model choices or a Pi catalog with multiple choices or a tool policy | Change the sandbox launch specification; use a separate deployment and verify the selected models through the native agent |
| Pi model or native model metadata with one declared choice and no tool policy | Restarts the Pi runtime inside the existing sandbox; its in-memory conversation is lost; see [Pi model selection](agents.md#pi-model-selection) |
| External inference endpoint, provider implementation, or authenticated/anonymous mode | Changes a selected provider's profile and registration; changes to an existing sandbox's launch specification still require a separate deployment |
| Sandbox image, harness, API, OpenClaw tuning, agent/tools, execution settings, interfaces, or attached integration settings | Changes the sandbox launch specification; ordinary apply refuses replacement; use a separate deployment with a fresh UID and state |
| Sandbox network policy or proxy | Changes the sandbox specification; follow [policy change constraints](sandbox-network.md) and use a separate deployment when replacement is required |
| Managed inference or proxy image or serving specification | Docker-provider reconciliation may replace the container while retaining its independently bound storage; review the plan and [model constraints](models.md) |
| Deployment UID, established gateway endpoint, or bound credential/gateway engine | Cannot retarget the existing state; create a separate deployment |
| Remove an unused inference provider definition | Changes the desired document only; the SDK creates registrations for selected definitions, so unused definitions have no resources to delete |
| Remove a sandbox, retained storage, or a protected gateway binding | Ordinary apply refuses removal; assess a separate deployment and explicit retirement of the original |
| Change a credential value behind the same environment reference | Unchanged apply does not detect rotation; see [credential lifecycle](security.md#credentials-and-authentication) |

The [provider lifecycle contract](provider.md#openshell-resource-lifecycles) distinguishes reconstructible registrations and configuration from protected sandbox data and durable identity.
OpenShell refuses deletion of a registration still attached to a sandbox or a profile still referenced by a registration.
Ordinary apply can recreate a missing registration after confirmed absence, while preserving the sandbox's identity and files.
Disposable Docker compute uses ordinary provider reconciliation within the declared deployment graph.
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
If the error reports an unfinished creation, preserve that resource's original configuration while correcting unrelated settings.
Reapply successfully before removing or changing that pending resource or requesting teardown; the server may have created it without returning its identity.
Older unfinished records without per-resource recovery evidence still require the exact configuration from the unfinished operation.
If managed gateway or inference runtime apply fails, revised intent or teardown can proceed using recorded bindings and the existing ownership checks.
The same applies when an OpenShell-graph apply only observes resources, updates or deletes established bindings, or changes disposable compute.
Runtime recovery does not clear pending OpenShell creations.
Export remains unavailable while either operation is unfinished.
If readiness fails after resource creation, provider state and persistent data remain recorded.
A later explicit apply may replace or recreate disposable service compute.
Authentication, transport, and incomplete observations remain failures; missing or changed bound credentials and gateway storage never authorize their automatic recreation.
A missing model-cache volume may be recreated during apply, followed by model download and preparation; its separate credential volume must still match.

Export requires complete observations and agent configuration checks, but does not invoke inference.
It preserves references and desired settings, not model weights, histories, native settings, or agent files.
Shell redirection can leave an empty file on failure; check the exit status before using a new export.

When a managed service is stopped, plan observes the stopped resource without starting it.
An explicit apply reconciles the resource graph and performs bounded readiness checks, including vLLM/Ollama service and proxy data-source reads.
The installer contract has no separate recovery operation and does not create an automatic restart loop.
Export preserves retained intent and validates required resource bindings without another readiness or model-inventory check.
Destroy uses native provider compute/cache state and separately verified credential and gateway storage; it does not inspect model inventories.

## Destroy

Destroy removes all bound sandboxes, provider registrations and profiles, and managed process containers.
**Sandbox files and conversation history are deleted.** Back up native agent data separately when needed.
The workspace, model downloads, prepared data, gateway database and keys, gateway bridge, stopped initializer, images, and local deployment state remain.
Service-owned networks are removed with disposable compute.
Persistent resources stay tracked; retained image bytes do not require retained image-resource bindings.

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
See [retention details](state.md#deletion-and-retention) for surviving resources and files.

The local lock excludes other NemoClaw operations on the same state directory, not other gateway clients.
OpenShell deletes by name without an ID/version condition, so a concurrent replacement between the final identity check and delete cannot be eliminated by this client.

## Remote Model Service

Use [the SSH model service guide](remote-service.md) for placement, publication, host prerequisites, and qualification limits.
