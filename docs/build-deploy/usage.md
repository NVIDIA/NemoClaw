<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Using Desired State

Use a [verified native bundle](build.md) with its `bin` directory on `PATH`.
For a first deployment, follow [get started](../get-started/first-deployment.md).
When copying an [example](../../examples), assign a fresh UUID and replace endpoints and image pins with values for your resources.
Keep the matching bundle and the same state directory throughout the deployment.
On a Windows client, set the gateway target's `engine`, such as `spec.gateway.target.docker.engine`, to a local engine's named pipe, such as Docker Desktop's `npipe:////./pipe/docker_engine` or a Podman machine's `npipe:////./pipe/podman-machine-default`, or to an `ssh://` engine for an external gateway.
A managed gateway on a pipe binds `/var/run/docker.sock` in the engine's Linux VM.
On macOS, a managed gateway on Docker Desktop's, Colima's, Rancher Desktop's, or a Podman machine's default socket also binds `/var/run/docker.sock` in the engine's VM.
On another socket, it binds the socket's own path.
See [engine connection limits](../../internal-docs/design/execution-targets.md#connections-and-identity).

From the directory containing your YAML, preview the changes.
Plan observes resources without creating containers, pulling images, downloading models, preparing data, or invoking inference.
A fresh managed gateway defers the NVIDIA OpenShell graph until apply makes it reachable.

```sh
nemoclaw plan --state-dir .local/deployment deployment.yaml
```

Review the preview before apply.
Apply computes its own checked plan and can create or change resources and download images or models.
It checks configuration and readiness without invoking inference.

```sh
nemoclaw apply --state-dir .local/deployment deployment.yaml
```

Verify model and agent responses separately using [inference verification](../agents-inference/inference.md#verifying-the-result).
On failure, retain YAML and state and use [recovery](#recovering-an-interrupted-operation).

After apply succeeds, export the observed configuration:

```sh
nemoclaw export --state-dir .local/deployment --output exported-new.yaml
```

Check the exit status before using the export, then follow [unchanged reapply](#verifying-an-unchanged-reapply).
Export isn't a backup of agent files or conversations.

Without `--state-dir`, state defaults to `.nemoclaw` in the working directory.
Plan and apply require a YAML path or explicit `-` for stdin.
Export and destroy accept no YAML.
Plan, apply, and destroy print text by default.
Scripts should select `-o json`.
See [CLI options and output](../references/cli.md) for bundle selection, formats, and exit codes.

## Configuring Sandboxes and Inference

A document contains sandboxes keyed by name, each with one harness and one agent: up to 256 with a Kubernetes or OpenShift gateway, and up to 32 with Docker or Podman, which run every sandbox on one host.
See [sandbox count and cluster size](kubernetes.md#sandbox-count-and-cluster-size) for the reasons.
Use the [multiple-sandbox example](../../examples/multiple-sandboxes.yaml) to share inference across different harnesses.
[OpenClaw and Pi](../agents-inference/agents.md) can select multiple models.
Each Deep Agents instance selects one.

Declare managed services under `spec.services` and select their connections with `inferenceProviders.<name>.serviceRef`.
Every declared service is installed and checked, even without an inference consumer.
Services run on the gateway's Docker engine by default, or on another host through [SSH placement](../agents-inference/remote-service.md).
See [service constraints](../agents-inference/inference.md#combining-local-and-hosted-providers) for multiple Ollama and vLLM services and [models](../agents-inference/models.md) for hardware contracts and optional [recipes](../agents-inference/recipes.md).

## Using a Managed Podman Gateway

Use a local rootless Linux Podman engine through its Unix API socket.
Rootful operation, remote Podman engines, and other operating systems are untested ([#12641](https://github.com/NVIDIA/NemoClaw/issues/12641)).

Set `gateway.target` to `podman`, with `engine` naming the local Podman API service's Unix socket, as [the Podman example](../../examples/managed-podman.yaml) does:

```yaml
gateway:
  management: managed
  target:
    podman:
      engine: unix:///run/user/1000/podman/podman.sock
```

The API service is an operator prerequisite.
NemoClaw manages its gateway, network, and credential storage through that service.
Load the harness image into the selected Podman image store and use the digest reported there.

Rootless operation requires an API that reports `pasta` networking, as required by the pinned OpenShell callback listener.
Podman 5 and later report it.
Older APIs omit it and fail during plan, including Ubuntu 24.04's Podman 4.9.3, even with `pasta` installed.
The host must have a private IPv4 address on its default-route interface.
OpenShell uses that address for sandbox-only callbacks while keeping its user API on loopback.
Every managed gateway uses one compute driver.
To use another, [adapt the document](#adapting-a-document-to-another-target) for a separate deployment.
Native managed inference on Podman remains unsupported.
A Podman gateway can consume managed vLLM or Ollama through explicit SSH Docker placement and publication.
See [remote services](../agents-inference/remote-service.md).

Podman's changing compatibility `/info.ID` isn't a durable identity.
Gateway bindings use the retained owned network UUID, volume creation identity, container ID, and persisted signing keys.
A missing or replaced bound network is a conflict, not permission to recreate it.
Destroy retains that network and gateway storage.
To remove them, follow [Removing Retained Resources](#removing-retained-resources) for Podman.

## Agent Runtimes During Apply

Apply starts each new agent through NVIDIA NeMo Fabric's `fabric-agent-ctl` in its sandbox, and completes once the runtime has started.
It doesn't invoke agents, send generation requests, or replay work.
Plan and apply ask Fabric whether each agent's runtime still runs, with `fabric-agent-ctl check`, which sends no prompt and makes no model request.
When Fabric reports the runtime stopped, the plan updates the agent and says `agent runtime is not running`.
Apply stops that runtime in Fabric and starts another in the same sandbox, which keeps its files and conversation history.
Fabric reports a confirmed process exit as `failed/agent_exited`, which lets plan replace the runtime.
If the health connection fails without confirming an exit, the result remains `unknown` and counts as running.

Use an [agent image built from this revision](build.md#building-agent-images).
Image changes require the [separate-deployment path](#choosing-the-change-path).
Keep existing deployments' original bundles and state.

A failed start, transport failure, or malformed response fails apply and retains resources.
The CLI exits with status 1 and reports the failure in the selected [output format](../references/cli.md#output-and-failure).
Keep state, diagnose the failure, and reapply after recovery.
See [recovering an interrupted operation](#recovering-an-interrupted-operation).

## Configuration and Credentials

Choose the configuration owner for each setting and keep credential values out of shared YAML.
The procedures below distinguish gateway settings, application inputs, and credential references.

### Running an Application Container

Declare a `kind: container` service with an immutable image on a managed local Docker gateway.
The [application container example](../../examples/application-container.yaml) runs an application beside one agent and passes it the workspace, sandbox, agent, and gateway address as literal environment values.
NemoClaw doesn't interpret them.
Follow [Configuring a Container Service](container-services.md) for inputs, readiness, credential exposure, disposable data, and the distinction between application readiness and successful inference.
VoiceClaw still needs separate qualification.
The typed `ollama` and `vllm` kinds use the same assembly base but retain their own policies.

### Configuring a Managed Gateway

`spec.gateway.config` passes OpenShell gateway settings to a managed gateway in the format of the OpenShell Helm chart's `gatewayConfig` value.
Each key names a table of OpenShell's [gateway configuration](https://github.com/NVIDIA/OpenShell/blob/ce58cf8e9b953281352d98a637e41616295b1318/docs/how-it-works/gateways/configuration.mdx) and holds that table's fields.
Nested maps become inline tables, and a list of maps becomes an array of tables.

```yaml
gateway:
  management: managed
  config:
    openshell.gateway:
      log_level: debug
    openshell.gateway.otlp:
      endpoint: http://otel-collector.example.internal:4317
    openshell.drivers.docker:
      allow_driver_config: true
```

Docker and Podman gateways write these tables into their configuration file beside the keys NemoClaw sets.
Kubernetes and OpenShift gateways pass them to the chart's `gatewayConfig`, where they can override NemoClaw's `workspace_mode` and `workspace_default_storage_size` defaults, and the chart keeps the settings it derives from Kubernetes resources.
See OpenShell's [chart configuration guide](https://github.com/NVIDIA/OpenShell/blob/ce58cf8e9b953281352d98a637e41616295b1318/docs/kubernetes/migrate-gateway-config.mdx).
Plan rejects a setting that replaces a key NemoClaw manages, such as the gateway's authentication, signing paths, or the driver's images.
OpenShell validates the rest when the gateway starts: an unknown or misplaced field in the selected driver's table stops the gateway, and tables for other drivers are ignored.
A change replaces a Docker or Podman gateway's container, which receives the new file and keeps the gateway's data, and upgrades a Kubernetes gateway's chart release.
The restarted gateway restarts its sandboxes but not their Fabric agents.
The next plan finds each agent's runtime stopped, and apply starts it again in its sandbox, which keeps its files.
A sandbox that exits instead of restarting is replaced, which deletes its files and conversation history.
Don't put secrets in it.
Plans and state show it.
An external gateway takes no `config`.
Its operator configures it.

### Letting APF Author Sandbox Policy

NVIDIA Agent Policy Fabric (APF) is an OpenShell interceptor that issues signed sandbox policies and serves provider profiles.
When APF does both on a gateway, set `spec.gateway.policyAuthority.apf`:

```yaml
gateway:
  management: managed
  policyAuthority:
    apf:
      registration: managed
      endpoint: https://host.docker.internal:18202
      tls:
        ca: {env: APF_CA_FILE}
```

- With `registration: managed`, NemoClaw writes APF's interceptor and provider-profile source into a managed Docker gateway's configuration file and copies the CA certificate that `tls.ca` names into the gateway's storage.
  `spec.gateway.config` must not register interceptors or profile sources.
- With `registration: external`, the gateway's operator registers APF, such as in `spec.gateway.config` on a managed Podman, Kubernetes, or OpenShift gateway.
  An external gateway requires it.

With either registration:

- Each sandbox runs APF's policy, so plan rejects a sandbox that sets `network.policy`, `network.policyRef`, `network.grants`, or `network.grantRefs`.
  Apply refuses a sandbox that APF admitted without its provenance annotations.
- Apply records each sandbox's loaded policy hash and APF's provenance token.
  The next apply records a policy that arrives with a new token.
  A policy that changes under the same token, or a sandbox that loses APF's provenance, plans an in-place update that asks OpenShell for the sandbox's configuration without a policy, so that APF issues its policy again.
- Inference, web search, and API integrations use the profile that APF serves under the name NemoClaw would give it, once NemoClaw has checked that the profile delivers the credential in the variable the agent reads.
  NemoClaw creates the provider registrations but never imports or deletes these profiles.
  An API integration can't set `mcp`, because APF's profile sets the endpoint's rules.
- NemoClaw doesn't verify the provenance token's signature.
  APF and OpenShell decide which policies a sandbox loads.

Limits:

- APF's bundle must serve each profile under the name NemoClaw gives it, which includes a hash of the sandbox image.
  No field chooses the names.
- A deployment created without the field can't change to APF, because APF refuses to delete the profiles NemoClaw imported.
- You give APF the gateway's signing key yourself, and with `registration: external` also install APF's CA in the gateway.
- APF's bundle refresher updates running sandboxes only in OpenShell's `default` workspace, and NemoClaw creates its own workspace, so the refresher doesn't bring a new bundle's policy to a running NemoClaw sandbox.

### Supplying Credential References

Use [definitions and references](configuration-references.md) to choose shared or inline configuration.
Use the [field reference](../reference/configuration.md) for names, defaults, and validation rules.

Validation rejects unknown fields, duplicate keys, and unsupported combinations.
Images require immutable SHA-256 references.
Container `environment` values are literal settings retained in configuration and state, not the credential references described below.
Validation can't identify a secret pasted into a literal value.
Gateway and inference ownership are independent of the harness, but inference must support the harness's request API.
See [managed models](../agents-inference/models.md), [Ollama](../agents-inference/inference.md#running-managed-ollama), or [external Ollama with a managed proxy](../agents-inference/inference.md#using-external-ollama-through-a-managed-proxy) for service configuration.

Use `credential: {env: INFERENCE_API_KEY}` for an inference provider or gateway.
The caller supplies the referenced environment value.
For an external HTTPS gateway, `tls.ca.env` references an environment variable whose value is the path of a local CA certificate file.
NemoClaw then verifies the gateway with that CA instead of the system roots.
When the gateway also requires a client certificate, add `tls.certificate.env` and `tls.key.env` together, referencing the certificate and key files the same way.

Values resolved through credential references stay out of configuration, plans, state, and export.
This guarantee doesn't apply to literal container environment settings.
OpenShell stores installed provider credentials for routing.
Removing the local variable doesn't revoke them.
Rotation under an unchanged reference isn't detected automatically.

The SDK and provider child process need access to referenced credentials during operations.
Remove caller-owned environment values and TLS files when you no longer need them.
Destroy removes the owned provider registration, but retained gateway storage remains.
Revoke upstream credentials separately when retiring them.

Prefer HTTPS for a caller-supplied inference credential: over plain HTTP, the key crosses the network unencrypted.
The managed Ollama proxy uses its private HTTP endpoint and a deployment-generated bearer key.
OpenShell decides which inference destinations a sandbox can reach.
Plaintext gateway addresses must be loopback.
The isolated policy permits inference routing without general egress and uses `best_effort` Landlock.
Unavailable kernel restrictions aren't enforced.
See [sandbox policy configuration](../security/sandbox-network.md) for changes and [security](../security/security.md) for qualification limits.

## Control Container Image Downloads

Set `imagePullPolicy` in a managed gateway's `docker` or `podman` target, or beside `image` under `spec.services.<name>`.
The service setting applies to `kind: vllm`, `ollama`, and `ollamaProxy`.
The setting controls image acquisition on that container's engine, including an SSH Docker engine selected by the service's `placement.engine`.
Images still require immutable SHA-256 references.

| Policy | Managed inference and proxy images |
|---|---|
| `IfNotPresent` (default) | The Docker provider ensures the pinned image is available and pulls it when absent |
| `Never` | The Docker provider reads the local image; a missing image fails that observation |
| `Always` | Rejected for services; choose pinned acquisition or local-only use |

The local image read and container creation are separate operations.
If another actor removes the image between them, the Docker provider can attempt acquisition during container creation.
`Never` isn't a network-isolation guarantee.

For locally built images without a registry copy, load the pinned image into the selected engine and set:

```yaml
imagePullPolicy: Never
```

Docker-managed gateways use the same `IfNotPresent` and `Never` modes as services.
`Always` is rejected.
Podman gateways retain their existing image policy: omission means `IfNotPresent`, and `Always` contacts the registry before creation or restart, including its credential initializer.
The SDK pins the gateway image, so documents and exports don't name it.
A Docker or Podman deployment keeps the gateway image pin of the bundle that created it.
See the [change path](#choosing-the-change-path).
Service acquisition doesn't promise a registry request on every restart or complete layer progress.
Export preserves the declared setting.
Downloaded service images remain on the selected engine after destroy, although their disposable provider resource bindings are removed.

Plan never pulls images and doesn't establish registry availability or application compatibility.
If acquisition fails, retain the state directory, restore image availability, and reapply.
Switching between managed acquisition and local-only lookup changes image resource declarations.
Review its plan.
This setting doesn't control model downloads or sandbox images acquired by OpenShell.
The pinned OpenShell API has no per-sandbox pull-policy field.
External gateways and sandboxes reject this YAML field.

### Pulling From Private Registries

Each image authenticates through whatever pulls it, and the configuration names registries, never credentials:

| Image | Pulled by | Authenticates with |
|---|---|---|
| Managed gateway and service images on Docker | NemoClaw, through the Docker provider | Logins in the Docker configuration file on the machine running OpenTofu, for each registry listed in `spec.registries` |
| Agent images on a Docker or Podman gateway's engine | NemoClaw, through the Docker provider, before reading their catalog label | The same logins, for each registry listed in `spec.registries` |
| Podman gateway image | Podman | Podman's own login on the engine's host |
| Images on Kubernetes or OpenShift | The cluster | Image-pull Secrets; see [Kubernetes and OpenShift](kubernetes.md) |

When the engine doesn't hold an agent image yet, plan reports the image as not on the engine and that sandbox's compatibility as deferred.
Apply pulls every agent image and reads its catalog label before it creates the gateway, its storage and network, or any agent configuration, so a pull that fails or an image that doesn't fit its sandbox creates nothing that must be destroyed.
An external gateway that names no `engine` pulls no agent images.

To have NemoClaw's pulls authenticate, log in on the machine running OpenTofu, for example with `docker login nvcr.io`, and list the registry:

```yaml
spec:
  registries:
    - address: nvcr.io
```

For each listed address, the Docker provider reads `.docker/config.json` in the home directory of the user running OpenTofu, including a `credsStore` credential store, even when the engine is reached over SSH.
It doesn't read `DOCKER_CONFIG`.
To use another file, set its absolute path as `configFile`:

```yaml
spec:
  registries:
    - address: nvcr.io
      configFile: /srv/ci/docker/config.json
```

The address must match the file's entry for that registry, such as `registry.example.com:5000`.
The provider documents `auths` entries and `credsStore`.
If your file uses per-registry `credHelpers`, check that a pull succeeds before relying on it.
The configuration, the compiled graph, and OpenTofu state hold only the addresses.

## Resource Ownership

Ownership follows the configuration form.
Don't repeat it on services, models, storage, networks, or inference providers.
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
Every selected inference provider has a deployment-owned OpenShell registration.
Destroy removes that registration without deleting an external server.
Managed model and credential storage survive destroy.
Gateway storage and credential checks verify deployment ownership, generation, and the established storage and engine identity.
Docker gateway and disposable service compute follow Docker-provider state and can be recreated or replaced during apply.
Model caches use native Docker volume reconciliation, including its name-based reuse.
They have no immutable creation-time binding.
There is no migration or lost-state adoption workflow for credentials or gateway storage.

## Editor Schema Assistance

Add a schema comment for editor completion, descriptions, and diagnostics:

```yaml
# yaml-language-server: $schema=../schemas/nemoclaw-v1alpha1.schema.json
```

Editors using [YAML Language Server](https://github.com/redhat-developer/yaml-language-server) resolve the path relative to the YAML file.
Update it when copying examples.
Select `schemas/nemoclaw-v1alpha1.schema.json` from the matching bundle or CLI source revision.
The API version alone is insufficient.

Keep `$schema` in the comment.
A YAML field named `$schema` is an unknown configuration field and is rejected.
Exported YAML omits comments, so add the association again if you want editor assistance for an export.

Editor validation doesn't replace SDK parsing or deployment checks.
See [validation beyond the schema](../reference/configuration.md#validation-beyond-the-schema) for those limits.

## Updates and Recovery

Keep the original YAML and bundle before editing a deployment.
Plan the proposed YAML against the existing state directory, review the changes and any `deferred` checks, then apply that same YAML.
Apply recomputes its plan.
A successful earlier plan doesn't reserve resources or authorize a later unchecked change.

### Multiple Sandboxes

Sandbox names, the keys of `spec.sandboxes`, are unique within a deployment.
Each sandbox declares one named agent.
Agent names may repeat across sandboxes.
Adding a named sandbox preserves existing sandbox and provider identities.
Reordering declarations isn't an update.
Each sandbox receives only its selected inference provider policies, while shared definitions reuse one provider registration.
Sandbox-local definitions are visible only to their enclosing sandbox.
Sandboxes can select distinct Brave credential references.
Shared references reuse one registration.
Removing or replacing a sandbox deletes its writable layer and in-memory conversation, and the plan shows it.
Keep files that must survive on [mounted agent-data volumes](state.md#keeping-agent-files-on-mounted-volumes).

### Choosing the Change Path

Check whether the desired edit updates a running resource, replaces it, or requires a separate deployment before applying.

| Proposed change | Current behavior and next step |
|---|---|
| Models, settings, or public Fabric configuration within the selected adapter | Replaces the agent and its sandbox, deleting the sandbox's files and conversations; review the plan |
| External inference endpoint, provider implementation, or authenticated or anonymous mode | Changes a selected provider's profile and registration; a change to a sandbox's launch specification replaces the sandbox |
| Harness adapter, sandbox image, driver configuration, agent identity, or provider attachments | Replaces the sandbox, deleting its files and conversations |
| Service exposures | Updates the sandbox's endpoints in place; the sandbox keeps its files and conversations |
| Sandbox network rules, middleware bindings, or grants | Updates the running sandbox's policy in place; the sandbox keeps its files and conversations, and connections it opened under the previous rules close; see [policy changes](../security/sandbox-network.md#verifying-and-changing-the-configuration) |
| Sandbox policy's filesystem, Landlock, or process settings, or a policy APF governs | Replaces the sandbox, deleting its files and conversations (except on mounted volumes); see [policy changes](../security/sandbox-network.md#verifying-and-changing-the-configuration) |
| Managed vLLM or Ollama image, container limits, or serving specification | Replaces the Docker container. Service-level `updatePolicy: Preserve` blocks replacement of a running Docker container; set `Recreate` only when accepting sequential replacement and downtime. Review the plan, [container limits and update policy](../agents-inference/inference.md#setting-container-limits-and-update-policy), and [model constraints](../agents-inference/models.md) |
| Ollama proxy image or serving specification | Docker-provider reconciliation can replace the proxy container while retaining its independently bound credential storage |
| Deployment UID, gateway management or target, established gateway port or endpoint, or bound credential or gateway engine | Can't retarget the existing state; create a separate deployment, and for another target, see [Adapting a Document to Another Target](#adapting-a-document-to-another-target) |
| A bundle with a different gateway image pin than the bundle that created a Docker or Podman deployment | Plan, apply, export, and destroy refuse, because deployment state binds the gateway to its original image pin. Keep operating the deployment with its original bundle, or create a separate deployment |
| Remove an unused inference provider definition | Changes the desired document only; the SDK creates registrations for selected definitions, so unused definitions have no resources to delete |
| Remove a sandbox | Deletes it, with its files and conversations |
| Remove retained storage or a protected gateway binding | Apply refuses removal; assess a separate deployment and explicit retirement of the original |
| Change a credential value behind the same environment reference | Unchanged apply doesn't detect rotation; see [credential lifecycle](../security/security.md#credentials-and-authentication) |

Apply starts a stopped runtime again in its sandbox.
See [agent runtimes during apply](#agent-runtimes-during-apply).
A runtime that Fabric reports running but that doesn't answer recovers only in a new sandbox: changing the agent's configuration replaces it, or see [replacement after an unusable runtime](#replacing-workloads-after-an-unusable-runtime).

For OpenClaw model and native-setting updates, use an [agent image built from this revision](build.md#building-agent-images).
Rebuilding the CLI bundle alone doesn't update the adapter in an existing sandbox image.
Changing that image replaces the sandbox.
How the adapter applies native configuration is Fabric's.
See its OpenClaw adapter documentation.

The [provider lifecycle contract](../references/provider.md#openshell-resource-lifecycles) distinguishes reconstructible objects, sandboxes included, from durable identity.
OpenShell refuses deletion of a registration still attached to a sandbox or a profile still referenced by a registration.
Apply can recreate a missing registration after confirmed absence.
Disposable Docker compute uses provider reconciliation within the declared deployment graph.
A model change doesn't migrate conversations or guarantee that the new model supports the old model's tools, context, or reasoning settings.

### Adapting a Document to Another Target

The gateway target is fixed after the first plan: plan refuses another with `state is bound to a different gateway target`, and NemoClaw moves no resources or data between targets.
To run the same sandboxes on another target, create a new deployment: copy the document, give it a fresh `metadata.uid`, and make these edits before planning it with a new state directory:

- Replace `spec.gateway.target` with the new target and its settings:
  - A managed `podman` target requires `engine`, the Podman API service's socket.
  - A managed `kubernetes` or `openshift` target requires `namespace` and `authentication`, and `kubeconfig` with `context` unless NemoClaw runs in a pod.
    See [Deploying With a Managed Gateway](kubernetes.md#deploying-with-a-managed-gateway).
  - An external `docker` or `podman` target takes `engine`, the engine holding the sandbox images, which plan inspects.
  - Between a managed and an external gateway, also set `management`.
    An external gateway takes `endpoint`, and `credential` and `tls` when it needs them.
- For `kubernetes` or `openshift`:
  - Give each sandbox an `image.ref` the cluster can pull, and its `image.metadata`.
    See [Preparing Agent Images](kubernetes.md#preparing-agent-images).
  - Remove `spec.services`, which these targets don't run, and replace each inference provider's `serviceRef` with the `endpoint` of a server the sandboxes reach, such as [a model server in the cluster](kubernetes.md#using-a-model-server-in-the-cluster).
  - A document holds at most 256 sandboxes.
  - Only `openshift` takes `expose.route`.
    On `kubernetes`, publish through `expose.service` or remove `expose`.
- For `docker` or `podman`:
  - Remove each sandbox's `image.metadata`, and list private registries in [`spec.registries`](#pulling-from-private-registries).
  - A document holds at most 32 sandboxes.
    Split a larger one.
- With a managed `podman` target or an external `docker` or `podman` target, a managed vLLM or Ollama service needs an explicit `placement` and `publication` on an [SSH Docker engine](../agents-inference/remote-service.md), an `ollamaProxy` service needs its own `engine`, and a `kind: container` service needs the managed `docker` target.
  Otherwise, replace the service with an inference endpoint as for `kubernetes`.
- Move OpenShell's driver settings, in `config` and each sandbox's `driverConfig`, to the new driver's table and key, such as `openshell.drivers.kubernetes` in `config` and `kubernetes` in `driverConfig`.
  OpenShell validates the new driver's settings and ignores other drivers'.
  An external gateway takes no `config`: its operator configures it.
- `policyAuthority.apf.registration: managed` requires the managed `docker` target.
  Elsewhere, set `registration: external` and [register APF](#letting-apf-author-sandbox-policy) yourself, in `config` on a managed gateway, or through the operator of an external one.

Destroy the original deployment with its own bundle and state directory when you no longer need it.

### Verifying an Unchanged Reapply

From the directory containing your deployment YAML, with the matching bundle and credential references available:

```sh
nemoclaw export --state-dir .local/deployment --output exported-new.yaml
```

For Brave and Tavily integrations, export preserves definitions, selection references, and credential references at their authored deployment, sandbox, or agent scope.
It observes installed search registrations without resolving search keys and rejects registration drift.
Reapply still requires the referenced credentials.

After export succeeds, inspect its configuration and reapply it using the same state:

```sh
nemoclaw plan --state-dir .local/deployment exported-new.yaml
nemoclaw apply --state-dir .local/deployment exported-new.yaml
```

For a fully resolved resource plan with no changes, expect `No resource changes planned.` with no deferred work.
With `-o json`, this is `complete: true`, an empty `changes` list, and no `deferred` field.
Deferred work means the plan is incomplete, even if the current changes list is empty.
Unavailable or unverified model catalogs and service readiness scheduled for apply appear separately under `unverified`.
They don't make the resource plan incomplete.
Review those advisories and the [typed observations](../references/sdk.md#reading-plan-discovery-and-resource-inventory).
A complete plan doesn't establish service health or working inference.
Unchanged apply still performs configuration and readiness checks.
It can fail if a required service is unavailable.
It doesn't send generation requests.
Keep the original YAML until verification succeeds.

### Recovering an Interrupted Operation

Changing an established gateway's target, port, or endpoint is rejected.
Two deployments on one engine need different ports and non-overlapping subnets.
A plan that fails binds nothing, so when a deployment's first plan reports that its target's `port` or `networkCIDR` is taken, change that field and plan again.
Once a plan has succeeded, the port is bound: free it instead.
There is no lost-state adoption, migration, pruning, or purge command.

After an interrupted apply, keep the original YAML and entire state directory, including `runtime/`, and reapply.
Interrupt once and let the resource operations in progress finish: an interrupt stops OpenTofu from starting new ones, and the state then records what it created.
A second interrupt stops OpenTofu at once and can leave a resource that the state doesn't record.
For records with per-resource recovery evidence, plan, apply, and destroy compare pending creations with saved OpenTofu bindings.
A saved ID with matching name, workspace, owner, and generation removes that resource from the pending-creation guard.
Live provider observations and plan checks still verify its identity before mutation.
A failed agent start keeps its sandbox binding.
Start failures report a fixed stage, failure code, and agent runtime state without forwarding native error text.
A failed start might have left a runtime running, so the next apply creates the agent in a new sandbox and deletes the old sandbox's files.
When Fabric rejected the configuration, correct the settings before reapplying.
An invocation failure can also leave a runtime unusable.
Unless Fabric's check reports it stopped, an unchanged apply leaves it alone.
To recover from that, or from a sandbox that exited, see [workload replacement](#replacing-workloads-after-an-unusable-runtime).
A sandbox in `Error` can still block apply, but its saved identity permits [teardown](#destroying) without a successful reapply.
Changing a rejected sandbox policy or image doesn't authorize replacement.
Follow the [change constraints](#choosing-the-change-path).

If the error still reports an unfinished creation, preserve that resource's original configuration while correcting unrelated settings.
Reapply successfully before removing or changing that unresolved resource or requesting teardown.
The server might have created it without returning its identity.
Older unfinished records without per-resource recovery evidence still require the exact configuration from the unfinished operation.
If managed gateway or inference runtime apply fails, revised intent or teardown can proceed using recorded bindings and the existing ownership checks.
The same applies when an OpenShell-graph apply only observes resources, updates or deletes established bindings, or changes disposable compute.
Runtime recovery doesn't clear pending OpenShell creations.
When OpenShell rejects a new sandbox's create as an invalid argument, it has stored nothing, so the apply drops that sandbox's pending creation: correct the configuration and apply again, or run destroy.
This applies only when every error in that apply was such a rejection.
Any other create failure, including a lost reply, keeps the pending-creation guard in place.
Preserve that record and its original bundle rather than deleting state or attempting adoption from another state directory.
Export remains unavailable during pending creation recovery or unfinished teardown.
If an apply planned no non-disposable OpenShell creations, a later export can verify its established bindings without another successful apply.
Incomplete or inconsistent observations still fail export.
If readiness fails after resource creation, provider state and persistent data remain recorded.
A later explicit apply can replace or recreate disposable service compute.
Authentication, transport, and incomplete observations remain failures.
Missing or changed bound credentials and gateway storage never authorize their automatic recreation.
A missing model-cache volume can be recreated during apply, followed by model download and preparation.
Its separate credential volume must still match.

To retire instead of recover after an interrupted apply, first run `nemoclaw plan --destroy` with the same state directory.
A failed first apply can be destroyed when every pending creation has a matching saved binding, including agent configuration accounted for by its parent sandbox.
The preview leaves retained intent and resource state unchanged.
Unavailable or foreign observations still stop teardown.
Teardown uses current bindings and a fresh plan.
It doesn't require the failed apply's plan file.
An apply tracks pending creations only for OpenShell and Fabric objects, and after a failure keeps only those OpenTofu started.
An apply that planned none leaves reconciliation of its established bindings to OpenTofu.
Every recorded binding must belong to the current intent, each saved storage specification must match, and a recorded managed process also requires its independent storage binding.
Undeclared or drifted bindings, a process without its storage binding, and ambiguous unfinished creations still require recovery before destroy.
Destroy changes the operation to resumable teardown only after its plan is checked, so a planning failure leaves the unfinished-apply recovery state in place.

Export requires complete observations and agent configuration checks, but doesn't invoke inference.
It preserves references and desired settings, not model weights, histories, native settings, or agent files.
Shell redirection can leave an empty file on failure.
Check the exit status before using a new export.

When a managed service is stopped, plan observes the stopped resource without starting it.
An explicit apply reconciles the resource graph and performs bounded readiness checks, including vLLM and Ollama service and proxy data-source reads.
The installer contract has no separate recovery operation and doesn't create an automatic restart loop.
Export preserves retained intent and validates required resource bindings without another readiness or model-inventory check.
Destroy uses native provider compute and cache state and separately verified credential and gateway storage.
It doesn't inspect model inventories.

### Recovering After a Host Reboot

After the host restarts, the engine starts a managed Docker gateway again, because its restart policy is `unless-stopped`, but not a managed vLLM or Ollama container, whose restart policy is `no`.
See the [provider reference](../references/provider.md#docker-gateway-launch).
From the directory containing the original `deployment.yaml`, with the matching bundle on `PATH`, plan and then apply with the deployment's state directory:

```sh
nemoclaw plan --state-dir .local/deployment deployment.yaml
nemoclaw apply --state-dir .local/deployment deployment.yaml
```

The plan shows each stopped model container replaced.
The default `updatePolicy: Preserve` permits this because the container no longer runs.
Apply creates the new container on the retained model-cache volume and waits for the service's readiness.
As after a [gateway restart](#configuring-a-managed-gateway), the same apply starts each agent's runtime again in its sandbox.
If a model container had stopped before the reboot, find out why before applying.
See [Diagnosing and Recovering a Stopped Runtime](../agents-inference/models.md#diagnosing-and-recovering-a-stopped-runtime).

### Replacing Workloads After an Unusable Runtime

When OpenShell reports that a sandbox exited, `nemoclaw plan` replaces that sandbox and says why, such as `sandbox exited: SANDBOX_PHASE_ERROR, reason ContainerExited, exit code 1`.
Read why it exited with `openshell logs SANDBOX --source sandbox` before applying.
See [native logs](../observability/troubleshooting.md#reading-native-service-logs).
**The replacement deletes that sandbox's files and conversation history.**

Use the rest of this path when an agent runtime is unusable after an invocation failure while its sandbox still runs, as after a gateway restart, and you choose to replace it.
The CLI has no targeted sandbox replacement or runtime-reset command.
Its supported replacement path is whole-deployment destroy followed by reapplying the original configuration.

**Destroy deletes every bound sandbox's writable layer and in-memory conversation, including those of other agents in this deployment.**
Files on caller-supplied mounted volumes remain under the platform's control.
See [agent-data retention](state.md#keeping-agent-files-on-mounted-volumes).
Preserve any native data you need before choosing removal.
Configuration export doesn't back it up.
Managed model and credential storage remain tracked.
That storage doesn't preserve sandbox files.
Keep the original YAML, matching bundle, credential references, and entire state directory.
Don't replace the state directory or change the deployment UID to bypass the failure.

From the directory containing the original `deployment.yaml`, with the matching bundle on `PATH`, preview the removal using the deployment's existing state path:

```sh
nemoclaw plan --destroy --state-dir .local/deployment
```

Teardown verifies the parent sandbox's identity.
It doesn't need the agent runtime to answer.
It still requires gateway access, matching ownership, and saved bindings for pending creations.
If the preview fails, retain state and resolve that error before proceeding.
After reviewing the whole-deployment removal and accepting its data loss, run:

```sh
nemoclaw destroy --state-dir .local/deployment
```

Destroy doesn't prompt for confirmation.
If it fails or is interrupted, resolve the cause and resume destroy with the same state.
Don't reapply until destroy completes.
After a successful destroy, request workload recreation with the original configuration and retained storage:

```sh
nemoclaw apply --state-dir .local/deployment deployment.yaml
```

This procedure follows the implemented CLI lifecycle.
Recovery from arbitrary malformed inputs remains unqualified.
Recreation starts the runtime but doesn't check that it answers.
Check the recreated runtime with one [request](../agents-inference/agents.md#running-one-agent-request) before relying on it.
Don't replay an invocation whose effects are unknown merely to test recovery.

### Recovering From an Unfinished Helm Install

This procedure applies to managed Kubernetes and OpenShift deployments.

NemoClaw installs the gateway release atomically: when the install fails or Helm's 600-second wait times out, Helm uninstalls the release before the apply returns, and the apply's error carries Helm's reason.
The namespace, credential key, and the gateway's volume claims stay.
Helm removes the gateway's pods with the release, so to see why the gateway didn't become ready, read its pods' events and logs while the apply waits.
Correct the cause, such as a missing StorageClass or an unreachable OIDC issuer, then apply again.

After a first interrupt, the apply waits for the install to finish or for Helm to uninstall it.
A second interrupt, a crash, or a killed process can stop the install before then, which leaves the release `pending-install` in the cluster without a binding in the state.
Helm refuses to install that name again, and NemoClaw can't tell the release from another owner's, so plan, apply, and destroy stop before changing anything, name the release, and leave it.
If the release is this deployment's, remove it with Helm and rerun the operation:

```sh
helm uninstall RELEASE --namespace NAMESPACE
```

### Recovering an Interrupted Helm Removal

This procedure applies to managed Kubernetes and OpenShift deployments.

During destroy, the pinned Helm provider can lose a release binding when its release lookup fails, even though the release remains in the cluster.
Before removing a bound release, NemoClaw saves a private checkpoint at `helm-recovery.json` in the deployment state directory.
If removal fails or is interrupted, recovery can restore only that missing binding while preserving the current authentication and storage bindings and any completed removals.
Restoring the binding doesn't reinstall the release or undo cluster changes.
If authentication cleanup already confirmed that the release and gateway are absent, recovery doesn't restore the deleted binding.

Keep the bundle that started this destroy, the deployment YAML, and the entire state directory, including the checkpoint under `runtime/` and the receipt and retained key material under `kubernetes/`.
Correct the reported Kubernetes API connectivity or permission failure before resuming destroy.
From the directory containing the deployment YAML, use the retained bundle and the same state directory:

```sh
deployment_bundle=/absolute/path/to/retained-bundle
"$deployment_bundle/bin/nemoclaw" --bundle "$deployment_bundle" \
  destroy --state-dir .local/deployment
```

Destroy validates the checkpoint against the original bundle, intent, and state before restoring a missing binding.
It then obtains a fresh plan, verifies resource identities, and continues the remaining removal.
Authentication cleanup still requires confirmed release and gateway absence.
Cancellation or a process interruption can leave the checkpoint for the next destroy attempt.

If `plan --destroy` reports that Helm binding recovery is pending, run the destroy command above.
Preview doesn't restore bindings.
Apply and export remain unavailable while destroy is unfinished.
If the checkpoint is missing, unreadable, or inconsistent with the current state, retain all evidence and resolve the error.
Recovery doesn't infer ownership or adopt an existing release.
Don't edit OpenTofu state, import the release, delete the checkpoint, or replace the current state with an older copy.
After destroy succeeds, the namespace, encryption key, and persistent volumes remain subject to the existing [retention rules](state.md#deletion-and-retention).

## Destroying

Destroy removes all bound sandboxes, provider registrations and profiles, the OpenShell workspace, and managed process containers.
**Sandbox writable layers and in-memory conversations are deleted.**
Files on caller-supplied mounted volumes remain under the platform's control.
The platform owns their backup and transfer.
Model downloads, prepared data, the gateway database and keys, the gateway bridge, the stopped initializer, images, and local deployment state remain.
Reapplying the same configuration reinstalls a managed gateway on its retained storage and recreates the workspace.
Service-owned networks are removed with disposable compute.
Persistent resources stay tracked.
Retained image bytes don't require retained image-resource bindings.

Preview deletion, then destroy only the deployment bound to this state directory:

```sh
nemoclaw plan --destroy --state-dir .local/deployment
nemoclaw destroy --state-dir .local/deployment
```

Review the preview before running destroy.
Destroy doesn't prompt for confirmation.

Destroy validates both saved resource graphs before deletion and removes OpenShell workloads before its gateway.
Repeating completed destroy has no changes.
An interrupted destroy resumes from its recorded graph boundary.
Other operations refuse unfinished teardown.

Reapply the original configuration to recreate workloads using retained storage.
See [retention details](state.md#deletion-and-retention) for surviving resources and files.

The local lock excludes other NemoClaw operations on the same state directory, not other gateway clients.
OpenShell deletes by name without an ID or version condition, so this client can't eliminate a concurrent replacement between the final identity check and delete.

### Removing Retained Resources

NemoClaw has no purge command: you remove what destroy retains with each platform's own commands, below.
Finish destroy first: `nemoclaw plan --destroy --state-dir .local/deployment` must print `No resource changes planned.`, then the entries to remove under `Retained resources:`.

**Removal permanently deletes the managed gateway's database, workspace, and keys, plus model downloads, prepared data, and managed vLLM and Ollama proxy credentials.**
It doesn't revoke upstream keys or remove images, external gateways, engines, or clusters.

#### On Docker

The commands select objects by UID alone, so confirm that no other deployment, including one copied from the same example, uses this `metadata.uid`.
Run the commands with Docker access to each engine the deployment selects: the managed gateway's `engine` in `spec.gateway.target.docker`, `unix:///var/run/docker.sock` by default, each service's `placement.engine`, and each Ollama proxy's `engine`.
For SSH placement, connect to that host using the already configured SSH identity.
Don't substitute the client's local Docker daemon.
From any directory, set `deployment_engine` to one of those engines and `deployment_uid` to the UID, then list the deployment's objects:

```sh
deployment_engine=unix:///var/run/docker.sock
deployment_uid=REPLACE_WITH_METADATA_UID
owner_label="label=nemoclaw.nvidia.com/uid=$deployment_uid"
docker --host "$deployment_engine" container ls --all --filter "$owner_label" --format '{{.Names}} {{.Status}}'
docker --host "$deployment_engine" volume ls --filter "$owner_label" --format '{{.Name}}'
docker --host "$deployment_engine" network ls --filter "$owner_label" --format '{{.Name}}'
```

Continue only if each listed name matches a `Retained resources:` entry in the [retained Docker objects](state.md#finding-retained-docker-objects) table and no listed container is running.
Then remove them:

```sh
docker --host "$deployment_engine" container ls --all --quiet --filter "$owner_label" | xargs -r docker --host "$deployment_engine" container rm
docker --host "$deployment_engine" volume ls --quiet --filter "$owner_label" | xargs -r docker --host "$deployment_engine" volume rm
docker --host "$deployment_engine" network ls --quiet --filter "$owner_label" | xargs -r docker --host "$deployment_engine" network rm
```

Rerun the list commands to confirm they print nothing.
The removal is safe to repeat.
If a volume or network remains, Docker's error identifies the container still using it.
Keep the state directory until you resolve that.
Repeat on each engine.
If an entry isn't in the table, this procedure doesn't cover it.
Keep the state directory.
If no engine had objects for an entry, check the engines and the UID, and keep the state directory until you find them.
When every entry's objects are gone, remove the `.local/deployment` directory.
To deploy again, use a fresh `metadata.uid` and a new state directory.
Apply refuses a state directory whose gateway storage or credentials were removed.

The [live Docker suite](../../internal-docs/contributing/testing.md) removes its gateways' UID-labeled objects and fails if any remain.

#### On Podman

A managed Podman gateway keeps the same objects, with the same names and label, as on Docker ([retained Docker objects](state.md#finding-retained-docker-objects)).
Follow the Docker steps with `podman --url "$deployment_engine"` in place of `docker --host "$deployment_engine"`, where `deployment_engine` is the gateway's `engine` in `spec.gateway.target.podman`, such as `unix:///run/user/1000/podman/podman.sock`.
It has been run against a managed rootless Podman 5.8.8 gateway.

#### On Kubernetes or OpenShift

Destroy keeps the deployment's namespace, the gateway's key Secret, and its persistent volume claims ([retained Kubernetes objects](state.md#finding-retained-kubernetes-objects)).
It deletes each sandbox's workspace claim, but under the `Retain` reclaim policy the claim's volume stays `Released` with the workspace files on it.
Deleting the namespace removes the objects in it.
Volumes are cluster-wide, so you check them separately.
Use the kubeconfig and context the deployment uses, and set `deployment_namespace` to the `namespace` of its `kubernetes` or `openshift` target:

```sh
deployment_context=my-cluster
deployment_namespace=nemoclaw-development
kubectl --context "$deployment_context" --namespace "$deployment_namespace" \
  get pods,secrets,persistentvolumeclaims
kubectl --context "$deployment_context" get persistentvolumes \
  -o custom-columns=NAME:.metadata.name,NAMESPACE:.spec.claimRef.namespace,STATUS:.status.phase,RECLAIM:.spec.persistentVolumeReclaimPolicy \
  | awk -v ns="$deployment_namespace" 'NR == 1 || $2 == ns'
```

Continue only if no pods remain, and nothing other than this deployment uses the namespace.
The second command lists the volumes whose claims are or were in the namespace: the gateway's, `Bound`, and any `Released` workspace volumes of destroyed sandboxes.
Listing volumes needs read access to PersistentVolumes across the cluster.
Without it, ask the cluster operator to run that command.
An earlier deployment that used the same namespace name can have left `Released` volumes that match too.
Remove only the ones you mean to.

A volume with the `Delete` reclaim policy goes with its claim, and the cluster deletes its data.
For each listed volume with `Retain` that a provisioner created, set its reclaim policy to `Delete`, so the provisioner deletes the volume and its storage:

```sh
deployment_volume=REPLACE_WITH_VOLUME_NAME
kubectl --context "$deployment_context" patch persistentvolume "$deployment_volume" \
  --patch '{"spec":{"persistentVolumeReclaimPolicy":"Delete"}}'
```

Remove a volume that no provisioner manages, and its storage, with your platform's tools.
If the namespace existed before the first apply, keep it: it lacks the `nemoclaw.nvidia.com/uid` label that a namespace NemoClaw created carries.
Delete what the deployment left in it instead: the key Secret, the chart's certificate and signing-key Secrets, the chart's certificate hook account and role, which Helm doesn't remove, and the gateway's volume claim.
Set `deployment_release` to the gateway's release name, the prefix of the Secret ending in `-kek`, then skip to the volume list below:

```sh
deployment_release=REPLACE_WITH_RELEASE_NAME
kubectl --context "$deployment_context" --namespace "$deployment_namespace" delete secret \
  "$deployment_release-kek" "$deployment_release-server-tls" \
  "$deployment_release-client-tls" "$deployment_release-jwt-keys"
kubectl --context "$deployment_context" --namespace "$deployment_namespace" \
  delete serviceaccount,role,rolebinding "$deployment_release-certgen"
kubectl --context "$deployment_context" --namespace "$deployment_namespace" \
  delete persistentvolumeclaim "openshell-data-$deployment_release-0"
```

Otherwise, delete the namespace and wait for it to go:

```sh
kubectl --context "$deployment_context" delete namespace "$deployment_namespace" --wait=true
```

On OpenShift, `oc delete project` does the same as deleting the namespace.
If `kubectl get namespace "$deployment_namespace"` reports it not found, the namespace and its objects are gone.
Run the volume list again.
Once the volumes are gone, it prints only its header.
When the namespace, or in a kept namespace those objects, and the volumes are gone, remove the state directory, which holds the cluster receipt and any development issuer keys.

The [live Kubernetes gateway test](../../internal-docs/contributing/live-tests.md#kubernetes-gateway-without-the-helm-cli) deletes its namespace this way, after switching any volume whose reclaim policy isn't `Delete` to `Delete`, and checks that the namespace and its volumes are gone.
