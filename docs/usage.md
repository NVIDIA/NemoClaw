<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Use Desired State

Use a [verified native bundle](build.md) with its `bin` directory on `PATH`.
For a first deployment, follow [get started](get-started.md).
When copying an [example](../examples/), assign a fresh UUID and replace endpoints and image pins with values for your resources.
Keep the matching bundle and the same state directory throughout the deployment.
Deployment planning currently requires a Unix client; see [engine connection limits](design/execution-targets.md#connections-and-identity).

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
Plan, apply, and destroy print text by default; scripts should select `-o json`.
See [CLI options and output](reference/cli.md) for bundle selection, formats, and exit codes.

## Configure Sandboxes and Inference

A document contains one to 32 named sandboxes, each with one harness and one agent.
Use the [multiple-sandbox example](../examples/multiple-sandboxes.yaml) to share inference across different harnesses.
[OpenClaw and Pi](agents.md) can select multiple models; each Deep Agents instance selects one.

Declare managed services under `spec.services` and select their connections with `inferenceProviders[].serviceRef`.
Every declared service is installed and checked, even without an inference consumer.
Services run on the gateway's Docker engine by default, or on another host through [SSH placement](remote-service.md).
See [service constraints](inference.md#combine-local-and-hosted-providers) for multiple Ollama/vLLM services and [models](models.md) for hardware contracts and optional [recipes](recipes.md).

## Use a Managed Podman Gateway

Use a local rootless Linux Podman engine through its Unix API socket.
Rootful operation, remote Podman engines, and other operating systems are untested ([#12641](https://github.com/NVIDIA/NemoClaw/issues/12641)).

Set `gateway.runtime.provider: podman` and set `gateway.engine` to the local Podman API service's Unix socket.
See [the Podman example](../examples/managed-podman.yaml).
The API service is an operator prerequisite; NemoClaw manages its gateway, network, and credential storage through that service.
Load the harness image into the selected Podman image store and use the digest reported there.

Rootless operation requires an API that reports `pasta` networking, as required by the pinned OpenShell callback listener.
Older APIs that omit this information fail during plan.
The host must have a private IPv4 address on its default-route interface.
OpenShell uses that address for sandbox-only callbacks while keeping its user API on loopback.
Every managed gateway uses one compute driver; use separate deployments to select different drivers.
Native managed inference on Podman remains unsupported.
A Podman gateway can consume managed vLLM or Ollama through explicit SSH Docker placement and publication; see [remote services](remote-service.md).

Podman's changing compatibility `/info.ID` is not a durable identity.
Gateway bindings use the retained owned network UUID, volume creation identity, container ID, and persisted signing keys.
A missing or replaced bound network is a conflict, not permission to recreate it.
Destroy retains that network and gateway storage.
Removing them from Podman is not covered yet ([#12640](https://github.com/NVIDIA/NemoClaw/issues/12640)).

## Agent Runtimes During Apply

Apply starts each new agent through Fabric's `fabric-agent-ctl` in its sandbox, and completes once the runtime has started.
It does not invoke agents, send generation requests, or replay work.
Fabric reports no runtime status or health, so neither a plan nor an unchanged apply checks that a started runtime is still running; a runtime that stops is found at its next invocation ([NVIDIA/NeMo-Fabric#420](https://github.com/NVIDIA/NeMo-Fabric/issues/420)).

Use an [agent image built from this revision](build.md#build-agent-images).
Image changes require the [separate-deployment path](#choose-the-change-path); keep existing deployments' original bundles and state.

A failed start, transport failure, or malformed response fails apply and retains resources.
The CLI exits with status 1 and reports the failure in the selected [output format](reference/cli.md#output-and-failure).
Keep state, diagnose the failure, and reapply after recovery; see [recovering an interrupted operation](#recover-an-interrupted-operation).

## Configuration and Credentials

### Run an Application Container

Declare a `kind: container` service with an immutable image and literal environment settings.
The image owns its entrypoint; optional `command` overrides its arguments, and `files` supplies nonsecret configuration with mode 0444.
Environment values enter configuration, plans/state, exports, and Docker inspection; they are not protected credential references.
Generic credential-file delivery is deferred.
If an application needs a key through `environment`, follow the [temporary plaintext environment approach](design/container-contract.md#application-environment) and protect every resulting artifact.
NemoClaw does not expand host environment variables in this map.
`container` sets GPU access, CPU/memory limits, shared memory, IPC, and ulimits; omission does not expose GPUs.
The default user is 65532:65532; images that require root must explicitly request `user: "0:0"`.
The container runs on the managed local Docker gateway's engine and network.
Optional `publication` binds an unprivileged TCP port to loopback or a private IPv4 address; `port` must agree with the application's listener.
`readiness.path` selects an HTTP GET expecting 200; `readiness.runtimeStatus` selects a managed-runtime status file such as `/data/status.json`.
Choose at most one; omission uses Docker HEALTHCHECK, and all modes check on unchanged applies.
The default readiness timeout is 300 seconds.
HTTP probes must reach the published or container address from the provider process; virtualized engine networking may require explicit publication.
A private publication allows an OpenAI-compatible container to be selected by `serviceRef`; registration waits for its readiness and uses /v1.
Application data defaults to /data, or `data.mountPath` selects a directory below /var/lib.
This data is disposable: destroy removes the owned volume.
See the [container contract](design/container-contract.md) for the explicit managed-model form and the manual VoiceClaw interface.
The typed `ollama` and `vllm` kinds retain their current policies and use this same assembly base.

### Supply Credential References

Use [definitions and references](configuration-references.md) to choose shared or inline configuration.
Use the [field reference](reference/configuration.md) for names, defaults, and validation rules.

Unknown fields, duplicate keys, and unsupported combinations are rejected; images require immutable SHA-256 references.
Container `environment` values are literal settings retained in configuration and state, not the credential references described below.
Validation cannot identify a secret pasted into a literal value.
Gateway and inference ownership are independent of the harness, but inference must support the harness's request API.
See [managed models](models.md), [Ollama](inference.md#run-managed-ollama), or [external Ollama with a managed proxy](inference.md#use-external-ollama-through-a-managed-proxy) for service configuration.

Use `credential: {env: INFERENCE_API_KEY}` for an inference provider or gateway.
The caller supplies the referenced environment value.
For gateway mTLS, `tls.ca.env`, `tls.certificate.env`, and `tls.key.env` reference environment variables whose values are local file paths.

Values resolved through credential references stay out of configuration, plans, state, and export.
This guarantee does not apply to literal container environment settings.
OpenShell stores installed provider credentials for routing; removing the local variable does not revoke them.
Rotation under an unchanged reference is not detected automatically.

The SDK and provider child process need access to referenced credentials during operations.
Remove caller-owned environment values and TLS files when no longer needed.
Destroy removes the owned provider registration, but retained gateway storage remains; revoke upstream credentials separately when retiring them.

Caller-supplied inference credentials require HTTPS.
The managed Ollama proxy uses its private HTTP endpoint and a deployment-generated bearer key.
OpenShell decides which inference destinations a sandbox can reach; plaintext gateway addresses must be loopback.
The isolated policy permits inference routing without general egress and uses `best_effort` Landlock; unavailable kernel restrictions are not enforced.
See [sandbox policy configuration](sandbox-network.md) for changes and [security](security.md) for qualification limits.

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

Every declared service is installed, even without an inference provider referring to it.
Every selected inference provider has a deployment-owned OpenShell registration; destroy removes that registration without deleting an external server.
Managed model and credential storage survive destroy.
Gateway storage and credential checks verify deployment ownership, generation, and the established storage/engine identity.
Docker gateway and disposable service compute follow Docker-provider state and may be recreated or replaced during apply.
Model caches use native Docker volume reconciliation, including its name-based reuse; they have no immutable creation-time binding.
There is no migration or lost-state adoption workflow for credentials or gateway storage.

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
Removing or replacing a sandbox deletes its files and conversation history, and the plan shows it; keep data that must survive on a [mounted volume](agents.md#skills-on-a-mounted-volume).

### Choose the Change Path

| Proposed change | Current behavior and next step |
|---|---|
| Models, settings, or public Fabric configuration within the selected adapter | Replaces the agent and its sandbox, deleting the sandbox's files and conversations; review the plan |
| External inference endpoint, provider implementation, or authenticated/anonymous mode | Changes a selected provider's profile and registration; a change to a sandbox's launch specification replaces the sandbox |
| Harness adapter, sandbox image, driver configuration, agent identity, or provider attachments | Replaces the sandbox, deleting its files and conversations |
| Sandbox network policy | Follow [policy change constraints](sandbox-network.md); a change that needs a new sandbox replaces it |
| Managed vLLM or Ollama image, container limits, or serving specification | Replaces the Docker container. Service-level `updatePolicy: Preserve` blocks replacement of a running Docker container; set `Recreate` only when accepting sequential replacement and downtime. Review the plan, [container limits and update policy](inference.md#set-container-limits-and-update-policy), and [model constraints](models.md) |
| Ollama proxy image or serving specification | Docker-provider reconciliation may replace the proxy container while retaining its independently bound credential storage |
| Deployment UID, established gateway endpoint, or bound credential/gateway engine | Cannot retarget the existing state; create a separate deployment |
| Remove an unused inference provider definition | Changes the desired document only; the SDK creates registrations for selected definitions, so unused definitions have no resources to delete |
| Remove a sandbox | Deletes it, with its files and conversations |
| Remove retained storage or a protected gateway binding | Apply refuses removal; assess a separate deployment and explicit retirement of the original |
| Change a credential value behind the same environment reference | Unchanged apply does not detect rotation; see [credential lifecycle](security.md#credentials-and-authentication) |

A runtime that stopped or became unusable recovers only in a new sandbox: changing the agent's configuration replaces it, or see [replacement after an unusable OpenClaw runtime](#replace-workloads-after-an-unusable-openclaw-runtime).

For OpenClaw model and native-setting updates, use an [agent image built from this revision](build.md#build-agent-images).
Rebuilding the CLI bundle alone does not update the adapter in an existing sandbox image; changing that image replaces the sandbox.
How the adapter applies native configuration is Fabric's; see its OpenClaw adapter documentation.

The [provider lifecycle contract](provider.md#openshell-resource-lifecycles) distinguishes reconstructible objects, sandboxes included, from durable identity.
OpenShell refuses deletion of a registration still attached to a sandbox or a profile still referenced by a registration.
Apply can recreate a missing registration after confirmed absence.
Disposable Docker compute uses provider reconciliation within the declared deployment graph.
A model change does not migrate conversations or guarantee that the new model supports the old model's tools, context, or reasoning settings.

### Verify an Unchanged Reapply

From the directory containing your deployment YAML, with the matching bundle and credential references available:

```sh
nemoclaw export --state-dir .local/deployment --output exported-new.yaml
```

For Brave and Tavily integrations, export preserves definitions, selection references, and credential references at their authored deployment, sandbox, or agent scope.
It observes installed search registrations without resolving search keys and rejects registration drift; reapply still requires the referenced credentials.

After export succeeds, inspect its configuration and reapply it using the same state:

```sh
nemoclaw plan --state-dir .local/deployment exported-new.yaml
nemoclaw apply --state-dir .local/deployment exported-new.yaml
```

For a fully resolved resource plan with no changes, expect `No resource changes planned.` with no deferred work.
With `-o json`, this is `complete: true`, an empty `changes` list, and no `deferred` field.
Deferred work means the plan is incomplete, even if the current changes list is empty.
Unavailable or unverified model catalogs and service readiness scheduled for apply appear separately under `unverified`; they do not make the resource plan incomplete.
Review those advisories and the [typed observations](sdk.md#read-plan-discovery-and-resource-inventory); a complete plan does not establish service health or working inference.
Unchanged apply still performs configuration and readiness checks; it can fail if a required service is unavailable.
It does not send generation requests.
Keep the original YAML until verification succeeds.

### Recover an Interrupted Operation

Changing an established gateway endpoint is rejected.
There is no lost-state adoption, migration, pruning, or purge command.

After an interrupted apply, keep the original YAML and entire state directory, including `runtime/`, and reapply.
For records with per-resource recovery evidence, plan, apply, and destroy compare pending creations with saved OpenTofu bindings.
A saved ID with matching name, workspace, owner, and generation removes that resource from the pending-creation guard; live provider observations and plan checks still verify its identity before mutation.
A failed agent start keeps its sandbox binding.
Start failures report a fixed stage, failure code, and agent runtime state without forwarding native error text.
A sandbox runs one agent runtime, and a failed start may have used it, so the next apply creates the agent in a new sandbox and deletes the old sandbox's files.
When Fabric rejected the configuration, correct the settings before reapplying.
An invocation failure can also leave a runtime unusable; NemoClaw cannot detect that, and an unchanged apply leaves it alone.
For the operator-reported OpenClaw failure, see [workload replacement](#replace-workloads-after-an-unusable-openclaw-runtime).
A sandbox in `Error` can still block apply, but its saved identity permits [teardown](#destroy) without a successful reapply.
Changing a rejected sandbox policy or image does not authorize replacement; follow the [change constraints](#choose-the-change-path).

If the error still reports an unfinished creation, preserve that resource's original configuration while correcting unrelated settings.
Reapply successfully before removing or changing that unresolved resource or requesting teardown; the server may have created it without returning its identity.
Older unfinished records without per-resource recovery evidence still require the exact configuration from the unfinished operation.
If managed gateway or inference runtime apply fails, revised intent or teardown can proceed using recorded bindings and the existing ownership checks.
The same applies when an OpenShell-graph apply only observes resources, updates or deletes established bindings, or changes disposable compute.
Runtime recovery does not clear pending OpenShell creations.
An OpenShell create rejection without a saved resource identity still leaves the pending-creation guard in place; automatic cleanup after a definitive rejection is not implemented.
Preserve that record and its original bundle rather than deleting state or attempting adoption from another state directory.
Export remains unavailable during pending creation recovery or unfinished teardown.
If an apply planned no non-disposable OpenShell creations, a later export can verify its established bindings without another successful apply; incomplete or inconsistent observations still fail export.
If readiness fails after resource creation, provider state and persistent data remain recorded.
A later explicit apply may replace or recreate disposable service compute.
Authentication, transport, and incomplete observations remain failures; missing or changed bound credentials and gateway storage never authorize their automatic recreation.
A missing model-cache volume may be recreated during apply, followed by model download and preparation; its separate credential volume must still match.

To retire instead of recover after an interrupted apply, first run `nemoclaw plan --destroy` with the same state directory.
A failed first apply can be destroyed when every pending creation has a matching saved binding, including agent configuration accounted for by its parent sandbox.
The preview leaves retained intent and resource state unchanged; unavailable or foreign observations still stop teardown.
Teardown uses current bindings and a fresh plan; it does not require the failed apply's plan file.
An apply tracks pending creations only for OpenShell and Fabric objects, and after a failure keeps only those OpenTofu started; an apply that planned none leaves reconciliation of its established bindings to OpenTofu.
Every recorded binding must belong to the current intent, each saved storage specification must match, and a recorded managed process also requires its independent storage binding.
Undeclared or drifted bindings, a process without its storage binding, and ambiguous unfinished creations still require recovery before destroy.
Destroy changes the operation to resumable teardown only after its plan is checked, so a planning failure leaves the unfinished-apply recovery state in place.

Export requires complete observations and agent configuration checks, but does not invoke inference.
It preserves references and desired settings, not model weights, histories, native settings, or agent files.
Shell redirection can leave an empty file on failure; check the exit status before using a new export.

When a managed service is stopped, plan observes the stopped resource without starting it.
An explicit apply reconciles the resource graph and performs bounded readiness checks, including vLLM/Ollama service and proxy data-source reads.
The installer contract has no separate recovery operation and does not create an automatic restart loop.
Export preserves retained intent and validates required resource bindings without another readiness or model-inventory check.
Destroy uses native provider compute/cache state and separately verified credential and gateway storage; it does not inspect model inventories.

### Replace Workloads After an Unusable OpenClaw Runtime

Use this path when an OpenClaw runtime is unusable after an invocation failure and you choose to replace its sandbox.
The [reported malformed-request failure](agents.md#run-one-headless-openclaw-request) required sandbox replacement; the exact inputs that trigger it and recovery inside the existing sandbox remain unqualified ([#12642](https://github.com/NVIDIA/NemoClaw/issues/12642)).
The CLI has no targeted sandbox replacement or runtime-reset command.
Its supported replacement path is whole-deployment destroy followed by reapplying the original configuration.

**Destroy deletes every bound sandbox's files and conversation history, including those of other agents in this deployment.**
Preserve any native data you need before choosing removal; configuration export does not back it up.
Managed model and credential storage remain tracked; that storage does not preserve sandbox files.
Keep the original YAML, matching bundle, credential references, and entire state directory.
Do not replace the state directory or change the deployment UID to bypass the failure.

From the directory containing the original `deployment.yaml`, with the matching bundle on `PATH`, preview the removal using the deployment's existing state path:

```sh
nemoclaw plan --destroy --state-dir .local/deployment
```

Teardown verifies the parent sandbox's identity; it does not need the agent runtime to answer.
It still requires gateway access, matching ownership, and saved bindings for pending creations; if the preview fails, retain state and resolve that error before proceeding.
After reviewing the whole-deployment removal and accepting its data loss, run:

```sh
nemoclaw destroy --state-dir .local/deployment
```

Destroy does not prompt for confirmation.
If it fails or is interrupted, resolve the cause and resume destroy with the same state; do not reapply until destroy completes.
After a successful destroy, request workload recreation with the original configuration and retained storage:

```sh
nemoclaw apply --state-dir .local/deployment deployment.yaml
```

This procedure follows the implemented CLI lifecycle; recovery from arbitrary malformed inputs remains unqualified.
Recreation starts the runtime but does not check that it answers.
Check the recreated runtime before using the [exact OpenClaw request](agents.md#run-one-headless-openclaw-request); do not replay an invocation whose effects are unknown merely to test recovery.

### Recover an Interrupted Helm Removal

This procedure applies to managed Kubernetes and OpenShift deployments.

During destroy, the pinned Helm provider can lose a release binding when its release lookup fails, even though the release remains in the cluster.
Before removing a bound release, NemoClaw saves a private checkpoint at `helm-recovery.json` in the deployment state directory.
If removal fails or is interrupted, recovery can restore only that missing binding while preserving the current authentication and storage bindings and any completed removals.
Restoring the binding does not reinstall the release or undo cluster changes.
If authentication cleanup already confirmed that the release and gateway are absent, recovery does not restore the deleted binding.

Keep the bundle that started this destroy, the deployment YAML, and the entire state directory, including the checkpoint under `runtime/` and the receipt and retained key material under `kubernetes/`.
Correct the reported Kubernetes API connectivity or permission failure before resuming destroy.
From the directory containing the deployment YAML, use the retained bundle and the same state directory:

```sh
deployment_bundle=/absolute/path/to/retained-bundle
"$deployment_bundle/bin/nemoclaw" --bundle "$deployment_bundle" \
  destroy --state-dir .local/deployment
```

Destroy validates the checkpoint against the original bundle, intent, and state before restoring a missing binding.
It then obtains a fresh plan, verifies resource identities, and continues the remaining removal; authentication cleanup still requires confirmed release and gateway absence.
Cancellation or a process interruption can leave the checkpoint for the next destroy attempt.

If `plan --destroy` reports that Helm binding recovery is pending, run the destroy command above; preview does not restore bindings.
Apply and export remain unavailable while destroy is unfinished.
If the checkpoint is missing, unreadable, or inconsistent with the current state, retain all evidence and resolve the error; recovery does not infer ownership or adopt an existing release.
Do not edit OpenTofu state, import the release, delete the checkpoint, or replace the current state with an older copy.
After destroy succeeds, the namespace, encryption key, and persistent volumes remain subject to the existing [retention rules](state.md#deletion-and-retention).

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

### Remove Retained Resources

This procedure removes what destroy retains on Docker engines when you retire a deployment.
It does not cover a Podman, Kubernetes, or OpenShift gateway, or the workspace on an external gateway; keep the state directory for those ([#12640](https://github.com/NVIDIA/NemoClaw/issues/12640)).

**Removal permanently deletes the managed gateway's database, workspace, and keys, plus model downloads, prepared data, and managed vLLM and Ollama proxy credentials.**
It does not revoke upstream keys or remove images, external gateways, or engines.

Finish destroy first: `nemoclaw plan --destroy --state-dir .local/deployment` must print `No resource changes planned.`, then the entries to remove under `Retained resources:`.
The commands select objects by UID alone, so confirm that no other deployment, including one copied from the same example, uses this `metadata.uid`.
Run the commands with Docker access to each engine the deployment selects: the managed gateway's `spec.gateway.engine`, each service's `placement.engine`, and each Ollama proxy's `engine`.
For SSH placement, connect to that host using the already configured SSH identity; do not substitute the client's local Docker daemon.
From any directory, set `deployment_engine` to one of those engines and `deployment_uid` to the UID, then list the deployment's objects:

```sh
deployment_engine=unix:///var/run/docker.sock
deployment_uid=REPLACE_WITH_METADATA_UID
owner_label="label=nemoclaw.nvidia.com/uid=$deployment_uid"
docker --host "$deployment_engine" container ls --all --filter "$owner_label" --format '{{.Names}} {{.Status}}'
docker --host "$deployment_engine" volume ls --filter "$owner_label" --format '{{.Name}}'
docker --host "$deployment_engine" network ls --filter "$owner_label" --format '{{.Name}}'
```

Continue only if each listed name matches a `Retained resources:` entry in the [retained Docker objects](state.md#find-retained-docker-objects) table and no listed container is running.
Then remove them:

```sh
docker --host "$deployment_engine" container ls --all --quiet --filter "$owner_label" | xargs -r docker --host "$deployment_engine" container rm
docker --host "$deployment_engine" volume ls --quiet --filter "$owner_label" | xargs -r docker --host "$deployment_engine" volume rm
docker --host "$deployment_engine" network ls --quiet --filter "$owner_label" | xargs -r docker --host "$deployment_engine" network rm
```

Rerun the list commands to confirm they print nothing; the removal is safe to repeat.
If a volume or network remains, Docker's error identifies the container still using it; keep the state directory until you resolve that.
Repeat on each engine.
If an entry is not in the table, this procedure does not cover it; keep the state directory.
If no engine had objects for an entry, check the engines and the UID, and keep the state directory until you find them.
When every entry's objects are gone, remove the `.local/deployment` directory.
To deploy again, use a fresh `metadata.uid` and a new state directory; apply refuses a state directory whose gateway storage or credentials were removed.

The [live Docker suite](contributing/testing.md) removes its gateways' UID-labelled objects and fails if any remain.
Removal of managed service volumes and of objects on SSH engines is not verified, and there is no purge command ([#12640](https://github.com/NVIDIA/NemoClaw/issues/12640)).
