<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Understand the OpenTofu Provider

The native bundle includes the NemoClaw, OpenShell, Fabric, Docker, and Helm OpenTofu providers.
The SDK compiles desired-state YAML into resource graphs and runs bundled OpenTofu.
OpenShell manages workspaces, provider registrations and profiles, and sandboxes through a gateway's API.
Fabric configures the Fabric host in each agent sandbox and waits for its runtime, through the same gateway.
Docker manages disposable service compute and Docker gateway processes; Helm installs the managed Kubernetes gateway chart; NemoClaw manages Podman gateway processes, Kubernetes gateway prerequisites and model services, initialization, retained gateway bridges, and durable data bindings.
Use [the SDK](sdk.md) or [CLI](reference/cli.md) for the documented deployment workflow.

## Resource and State Ownership

OpenTofu owns graph execution and resource state.
The SDK retains desired intent, validates plans, coordinates runtime stages, and reports provider observations.
The NemoClaw, OpenShell, and Fabric providers verify durable data and credential identity; the Docker and Helm providers reconcile their native resource state.
The SDK refuses state that an earlier release wrote with the NemoClaw provider's OpenShell or Fabric types, before reading or changing it; keep that state directory and use the release that wrote it.

Before planning, the SDK checks configuration, locks state, and validates retained intent and local bindings.
OpenTofu refresh and provider planning perform environmental checks; the SDK does not run a separate environmental preflight.
The SDK then checks the saved plan against its deployment scope, retained bindings, and recovery rules before authorizing changes.
Docker gateway, inference, and proxy containers may be recreated or replaced while their independent storage bindings remain unchanged.
Podman gateways retain their stronger process identity checks.
OpenTofu selects their replacement without an SDK requirement that the desired process specification changed.
The compiled graph orders the gateway after protected storage; the SDK requires its independent storage binding, and the provider rechecks storage and process identity before replacement.
Docker gateway storage independently binds signing and encryption keys; its verified mountpoint supplies the process mount through OpenTofu.
The refreshed gateway running state determines whether the OpenShell stage can be planned or must wait for gateway creation or recovery.

The generated graphs manage these objects and observations:

| Owner | Managed objects and observations |
|---|---|
| OpenShell provider | Workspace, provider registration, provider profile, and sandbox |
| OpenShell provider data source | Gateway version and compute drivers |
| Fabric provider | Fabric runtime configuration |
| Fabric provider data source | Fabric image capabilities and sandbox completion |
| NemoClaw provider | Podman gateway process (`nemoclaw_managed_gateway`); gateway storage, initialization, and retained bridge (`nemoclaw_gateway_storage`) |
| NemoClaw provider | Retained inference credentials and proxy storage; external Ollama model observation |
| NemoClaw provider | Kubernetes namespace and encryption key (`nemoclaw_kubernetes_storage`), development issuer (`nemoclaw_kubernetes_auth`), and gateway readiness (`nemoclaw_kubernetes_gateway`) |
| NemoClaw provider | Kubernetes vLLM/Ollama workloads and readiness (`nemoclaw_kubernetes_service`), with retained model and optional separate credential PVCs (`nemoclaw_kubernetes_service_storage`) |
| NemoClaw provider data source | Engine capabilities, managed runtime-image compatibility, managed gateway readiness, and vLLM/Ollama service or proxy readiness |
| Docker provider | Docker gateway, inference, and proxy containers; model-cache volumes, service-owned networks and acquired images |
| Docker provider data source | Local images selected with `imagePullPolicy: Never` |
| Helm provider | The managed Kubernetes gateway's OpenShell chart release (`helm_release.gateway`) |

The [standalone HCL fixture](contributing/integration-tests.md#standalone-cache-and-credential-resources) verifies cache and credential resource composition without SDK orchestration.
It does not qualify a complete standalone OpenShell deployment workflow.
Do not edit SDK-generated graphs or share a deployment state directory between independently managed workflows.

## Provider Catalog

The bundle pins these providers:

| Provider | Source address | Version |
|---|---|---|
| NemoClaw | `registry.opentofu.org/nvidia/nemoclaw` | Source-derived |
| OpenShell | `registry.opentofu.org/nvidia/openshell` | Source-derived, matching NemoClaw |
| Fabric | `registry.opentofu.org/nvidia/fabric` | Source-derived, matching NemoClaw |
| Docker | `registry.opentofu.org/kreuzwerker/docker` | 4.6.0 |
| Helm | `registry.opentofu.org/hashicorp/helm` | 3.3.0 |

None of them exposes ephemeral resources or provider functions.

### OpenShell Resources and Data Source

| Type | Manages or observes |
|---|---|
| `openshell_workspace` | Workspace |
| `openshell_provider_registration` | Provider registration |
| `openshell_provider_profile` | Provider profile |
| `openshell_sandbox` | Sandbox |
| `openshell_gateway` data source | [Gateway version and compute drivers](#gateway-capabilities) |

The `openshell` provider takes the gateway `endpoint`, the `credential_env` variable holding its bearer credential, the `tls_ca_env`, `tls_certificate_env`, and `tls_key_env` variables naming mutual TLS files, and `destroy`, which permits deleting sandboxes during explicit teardown.
The bundled OpenShell provider includes NemoClaw's managed-service identity and credential checks.
During apply, it reads Docker vLLM and Ollama proxy keys from their owning containers, and authenticated cluster vLLM keys through the verified model Pod from its separate credential PVC.
The key never enters OpenTofu state.

Inputs are typed:

- `openshell_sandbox` takes a `policy` block and a `provider_names` list.
  The block's attributes and blocks follow the sandbox policy model with snake_case names: optional `explicit` policy and `managed` deployment grants, whose named network rules are labeled blocks.
  A matcher that is either a glob or alternatives sets `value` for the glob, or `any` for the alternatives.
- `openshell_provider_profile` takes a `binaries` list.
- `runtime_json` stays the JSON string that `fabric_capabilities` returns.
- `owner` and `generation` are optional; when omitted, the provider generates them during apply and keeps them in state, with the lost-reply limit described for [service storage](#nemoclaw-resources).

```hcl
resource "openshell_sandbox" "assistant" {
  workspace      = openshell_workspace.example.name
  name           = "assistant"
  image          = var.image
  agent_name     = "assistant"
  runtime_json   = data.fabric_capabilities.assistant.runtime_json
  provider_names = [openshell_provider_registration.local.name]
  policy {
    explicit {
      version = 1
      network_policies "docs" {
        name = "docs"
        endpoints {
          host = "docs.example.com"
          port = 443
        }
        binaries {
          path = "/usr/bin/curl"
        }
      }
    }
  }
}
```

### Fabric Resource and Data Source

| Type | Manages or observes |
|---|---|
| `fabric_agent_configuration` | Fabric runtime configuration in a sandbox |
| `fabric_sandbox_readiness` data source | [Sandbox completion](#sandbox-completion) |
| `fabric_capabilities` data source | [Fabric image catalog and compatibility](#engine-and-fabric-discovery) |

The `fabric` provider takes the same gateway settings as the `openshell` provider, and `destroy`, which permits removing agent configurations during explicit teardown.
It reaches each sandbox's Fabric host by running commands in the sandbox through the gateway; `fabric_capabilities` instead reads the container engine named on it.
The bundled Fabric provider includes NemoClaw's managed-service checks when it verifies a configuration's parent sandbox.

### NemoClaw Resources

The `nemoclaw` provider's only setting is `destroy`, which permits deleting gateways, cluster model workloads, and proxies during explicit teardown.
Each resource names the engine or cluster it uses.

| Resource | Manages |
|---|---|
| `nemoclaw_managed_gateway` | Podman gateway process |
| `nemoclaw_gateway_storage` | Gateway storage, initialization, and retained bridge |
| `nemoclaw_kubernetes_storage` | Kubernetes namespace and encryption key |
| `nemoclaw_kubernetes_auth` | Kubernetes development token issuer and OpenShift chart overrides |
| `nemoclaw_kubernetes_gateway` | Kubernetes gateway StatefulSet identity and readiness |
| `nemoclaw_kubernetes_service` | Managed vLLM/Ollama Pod, ConfigMap, Service, NetworkPolicy, and runtime readiness |
| `nemoclaw_kubernetes_service_storage` | Retained model PVC and, for authenticated vLLM, a separate credential PVC |
| `nemoclaw_inference_storage` | vLLM credential storage |
| `nemoclaw_ollama_service_storage` | Managed Ollama model storage |
| `nemoclaw_ollama_proxy_storage` | Ollama proxy credential storage |
| `nemoclaw_ollama_external_model` | Upstream Ollama model digest |

Generated Docker graphs place vLLM and Ollama model caches in `docker_volume` resources and do not declare `nemoclaw_ollama_service_storage`.
Managed Kubernetes and OpenShift services use the two cluster resources above, each with an SDK-compiled `spec` and computed `running` status.
Their resource postconditions enforce runtime readiness; they do not use the Docker container-based `nemoclaw_service_readiness` data source.
See [managed cluster inference](kubernetes.md#run-a-managed-model-service) for namespace ownership, credential isolation, and retention.

`nemoclaw_inference_storage` and `nemoclaw_ollama_service_storage` take `name` and `engine`, and optionally `owner` and `generation`.
The provider creates a local volume with that name on that engine and labels it with the owner and generation.
It rejects a same-named volume with other labels, and never recreates a bound volume that disappears.
Validation reports an invalid value at its attribute:

- `name` is 2 to 255 letters, digits, underscores, periods, or hyphens, starting with a letter or digit.
- `owner` is a lowercase UUID.
- `generation` is 32 lowercase hexadecimal characters.
- `engine` is a supported engine endpoint.

When `owner` or `generation` is omitted, the provider generates it during apply and keeps it in state.
Generated graphs supply both values, which the SDK records before apply.
If a create succeeds but its reply is lost, OpenTofu state has no record of a generated identity.
The next apply generates another, finds the volume labelled with the lost one, and stops.
To keep the volume, set `owner` and `generation` to its `nemoclaw.nvidia.com/uid` and `nemoclaw.nvidia.com/generation` labels and apply again.

`nemoclaw_ollama_proxy_storage` takes `name` and `engine`, and keeps the proxy credential in a volume named `<name>-auth`.
`nemoclaw_ollama_external_model` takes `name`, `engine`, `upstream`, `model`, and `digest`.
Both take optional `owner` and `generation`, generated the same way; generated graphs give the external model its proxy storage's values.

`nemoclaw_gateway_storage` and `nemoclaw_managed_gateway` take the gateway's `name`, `compute_driver` (`docker` or `podman`), `engine`, `image`, and `network_cidr`, optional `owner` and `generation`, generated the same way, and optional `image_pull_policy`:

- `name` is `nc-`, 16 lowercase hexadecimal characters, a hyphen, and a lowercase name.
- `engine` is a local Unix engine socket; Podman requires its API service socket.
- `network_cidr` is a private IPv4 `/24`.

`nemoclaw_managed_gateway` also requires the gateway `endpoint`, an HTTP origin with an unprivileged loopback port.
`nemoclaw_gateway_storage` requires `endpoint` for Podman and rejects it for Docker, whose gateway data does not depend on the listen port; it returns the volume's `data_path`.
The storage volume, bridge network, and initialization labels derive from `name`, `owner`, and the other settings, so changing any of them requires new storage.

### NemoClaw Data Sources

| Data source | Observes |
|---|---|
| `nemoclaw_engine_capabilities` | [Engine prerequisites](#engine-and-fabric-discovery) |
| `nemoclaw_target_hardware` | [Engine-advertised hardware](#target-hardware) |
| `nemoclaw_inference_capabilities` | [Inference model catalog](#inference-endpoint-metadata) |
| `nemoclaw_gateway_readiness` | [Managed Docker gateway process and health](#gateway-capabilities) |
| `nemoclaw_runtime_image` | [Managed runtime image labels](#runtime-image-compatibility) |
| `nemoclaw_service_readiness` | [vLLM, Ollama, and proxy readiness](#runtime-capacity-and-readiness) |
| `nemoclaw_service_capacity` | [Combined service capacity](#combined-service-capacity) |
| `nemoclaw_vllm_runtime` | Nothing; [computes the vLLM runtime contract](#vllm-runtime-contract) |
| `nemoclaw_ollama_runtime` | Nothing; [computes the Ollama runtime contract](#ollama-runtime-contracts) |
| `nemoclaw_ollama_proxy_runtime` | Nothing; [computes the Ollama proxy contract](#ollama-runtime-contracts) |
| `nemoclaw_gateway_runtime` | Nothing; [computes a Docker gateway's launch](#docker-gateway-launch) |

### Docker and Helm Types

The bundled upstream binaries expose every type below.
Generated graphs declare only the types marked as used; NemoClaw does not qualify the others.

| Provider | Kind | Type | Generated graphs use it for |
|---|---|---|---|
| Docker | Resource | `docker_container` | Docker gateway, inference, and proxy containers |
| Docker | Resource | `docker_image` | Acquired gateway and service images |
| Docker | Resource | `docker_network` | Service-owned networks |
| Docker | Resource | `docker_volume` | Model caches |
| Docker | Data source | `docker_image` | Local images selected with `imagePullPolicy: Never` |
| Helm | Resource | `helm_release` | The managed Kubernetes gateway chart |
| Docker | Resource | `docker_buildx_builder`, `docker_compose`, `docker_config`, `docker_plugin`, `docker_registry_image`, `docker_secret`, `docker_service`, `docker_tag` | Unused |
| Docker | Data source | `docker_containers`, `docker_logs`, `docker_network`, `docker_plugin`, `docker_registry_image`, `docker_registry_image_manifests`, `docker_registry_image_tags` | Unused |
| Helm | Data source | `helm_template` | Unused |


## OpenShell Resource Lifecycles

The shared [resource lifecycle contract](../crates/nemoclaw-openshell/src/lifecycle.rs) distinguishes reconstructible configuration from protected identity and sandbox data.
The provider owns observation and update/replacement behavior; OpenTofu owns action ordering and resource state.
The SDK checks deployment scope and recovery constraints without imposing a second blanket ban on OpenShell changes.
For reconstructible resources, OpenTofu and the provider own confirmed absence, physical identity, and replacement cleanup; the SDK does not require a second drift history to report those actions during apply or teardown.

| Resource | Reconciliation | Protection |
|---|---|---|
| Provider profile and registration | Update supported fields, replace immutable configuration, remove unused declarations, and recreate after confirmed absence | Verify ownership and established identity before mutation; preserve bindings on failed observation |
| Fabric runtime configuration | Apply the public Fabric document and reconcile its resource lifecycle | Verify the parent sandbox identity; a changed configuration can restart its runtime and lose native session state |
| Sandbox | Create and observe the declared sandbox | During apply, refuse deletion, replacement, or recreation of a missing binding because deletion loses agent files and history |
| Workspace | Create, observe, and retain | Refuse replacement, deletion, or automatic recreation of a missing binding |

OpenShell refuses deletion of profiles referenced by registrations and registrations attached to sandboxes.
The registration's endpoint, provider type, and authentication mode require replacement, matching its profile's configuration contract.
The graph orders registration deletion before profile deletion when both change.
Standalone HCL must declare the matching configuration and dependency on its profile.
Recreating an absent profile with unchanged configuration does not itself replace its registration.
The SDK creates registrations only for definitions selected by sandboxes; unused YAML definitions have no resource lifecycle.
The standalone provider supports registration removal and replacement, while removing a last selection in SDK YAML also changes the protected sandbox specification.
Replacing a registration still attached to a protected sandbox is not a supported shortcut around sandbox lifecycle rules.
Endpoint and policy changes that also change a sandbox's launch specification remain protected; see [change paths](usage.md#choose-the-change-path).

The provider's `destroy` setting authorizes explicit sandbox teardown; reconstructible registrations and configuration do not require it.
It never authorizes deleting the workspace or bypassing identity checks.
Removing Fabric configuration releases its resource binding without deleting or stopping the sandbox-owned runtime.
The SDK's destroy operation still retains durable storage and the workspace.
See [deletion and retention](state.md#deletion-and-retention) before removing workloads.

An observation error is not absence.
Authentication, transport, and incomplete observations preserve prior state and stop planning.
The backend verifies ownership again immediately before mutation because objects can change after planning.
Creation readback must match the physical ID, owner, and generation established by the creation response.
If readback fails or identifies a substituted object, the provider returns the original established binding together with the error.
OpenTofu retains that failed creation as tainted state; automatic untainting is not a recovery guarantee.
OpenShell deletion is name-addressed without a conditional ID/version check; an immediate identity check does not make the API operation atomic.

## Discovery Ownership

Onboarding and planning consume observations from the owners below.
Each observation keeps its source and distinguishes a successful read, confirmed unavailability, and unknown results.
An observation describes the selected target at the time of its read; it is not a reservation or a promise of successful inference.

| Question | Owner and source | When it runs |
|---|---|---|
| Engine prerequisites | `nemoclaw_engine_capabilities`; selected Docker/Podman API | Onboarding target changes and managed deployment planning |
| Engine features, CPU, memory, and advertised GPU inventory | `nemoclaw_target_hardware`; selected engine API | Onboarding and planning for selected gateway/service engines |
| GPU memory, driver, compute capability, and disk measurements | Provider `observe_host_hardware` with a selected `HostObserver` | Explicit direct calls or existing configured service-capacity checks; the new passive hardware source does not run collectors |
| Packaged adapters, APIs, settings, and runtime requirements | `fabric_capabilities`; selected image metadata containing Fabric discovery results | Onboarding image changes and deployment planning |
| Managed runtime specification, required labels, and platform | `nemoclaw_runtime_image`; selected engine image inspection | Plan for present images; after image acquisition before runtime mutations |
| Advertised models and catalog authentication | `nemoclaw_inference_capabilities`; HTTP model-list endpoint from the control host | Onboarding endpoint changes and planning for selected inference routes |
| Credential-reference availability | Direct SDK `observe_credentials`; application's secret resolver | Onboarding, SDK calls, and plan-result discovery; values and local availability do not enter provider state |
| Gateway version and compute drivers | Existing `openshell_gateway`; authenticated OpenShell API | Onboarding review and required deployment lifecycle checks |
| Existing resources, ownership, drift, and retained storage | Existing OpenTofu resource refresh and SDK retained bindings | Deployment planning; no separate scan adopts unowned resources |

## Engine and Fabric Discovery

`nemoclaw_engine_capabilities` (NemoClaw provider) and `fabric_capabilities` (Fabric provider) require `engine`, the selected container-engine endpoint, without requiring an OpenShell connection.
The engine source also requires `compute_driver` (`docker` or `podman`); the Fabric source requires `image`.
For a cluster image that no local engine can inspect, the Fabric source instead reads the metadata bundle whose path is in the environment variable named by `metadata_env`; `engine` must then be empty.
Both return `status`, `available`, and structured JSON in `observation_json`.

The engine observation checks gateway prerequisites and reports available server version, architecture, operating system, CPU count, and memory fields.
These describe the selected engine, which may differ from the CLI host.
The image observation retains its configuration ID, repository manifest digests, platform, and size even when it lacks Fabric metadata.
Neither source pulls images or starts containers.
Each backend observation is bounded to five seconds; OpenTofu initialization and execution add overhead.

`available` means the requested metadata was observed successfully.
`unavailable` records a confirmed engine prerequisite mismatch or an image absent from the selected engine.
`unknown` records an unreachable target, missing image labels, invalid metadata, or a timed-out observation.
A missing image does not establish that the harness is unsupported.

Fabric observations retain the original `catalog`: Fabric adapter and workflow target descriptors and their discovery provenance.
Native schemas and declared requirements are consumed directly, without a second capability projection.
Missing declarations remain unknown; an advertised setting does not prove that the selected inference model supports it.

Optional `requirements_json` supplies an SDK `FabricRequirements` containing the canonical public Fabric `configuration` and deployment filesystem grants.
Optional `architecture` and `operating_system` supply the execution engine's platform.
The computed `compatibility_status` is `supported`, `unsupported`, or `unknown`, with details in `observation_json.compatibility`.
The SDK checks image identity, source revision and platform, then calls Fabric's pure planner with the selected image's descriptors.
Fabric owns settings, model, extension and workflow validation.
Missing native capability contracts and mismatched Fabric revisions remain unknown; explicit schema violations are unsupported.
The `fabric_plan` check retains a bounded canonical field path and a fixed explanation for classified planner failures.
Raw schema messages and rejected values are omitted; unsafe or overlong field identifiers fall back to `configuration`.
For a rejected model token limit, the reason also names `overrides.maxTokens` and up to 16 model routes carrying that setting, including Fabric's generated `default` role.
Deployment postconditions name the sandbox and adapter and preserve unsupported check reasons in text and JSON errors.
Onboarding uses the same assessment; unknown error variants retain a generic rejection.
Omitting requirements preserves metadata-only discovery.

The [agent image builder](build.md#build-agent-images) reads `Fabric.discover()` inside each assembled image and stores the result in `io.nemoclaw.fabric.catalog`.
It selects installed-package records using Fabric's provenance, without editing their descriptors.
Harness image stages declare the directories where their layout installs each adapter; the builder records them as `runtime_files`, keyed by adapter ID, beside the descriptors.
With deployment filesystem grants, every path in the adapter descriptor's `requirements.files`, its `runtime_files` entry, and the image runtime's `required_paths` must fall under a grant.
The bundled snapshot supports offline authoring and carries the same pinned Fabric revision and source checksum.
See the [image metadata contract](design/fabric-management.md#image-metadata) and [catalog regeneration](build.md#regenerate-the-bundled-catalog).
Direct Bake builds without labels remain unverified.
Catalog identifiers are not restricted to a compiled SDK list.
The runtime consumes the same canonical public configuration through Fabric; see [discovered harness configuration](sdk.md#configure-a-discovered-fabric-harness).

Generated graphs observe each sandbox image independently of resource creation or image acquisition.
Managed gateways use their configured engine; external gateways require `spec.gateway.engine` for image inspection and do not run managed-gateway prerequisite checks.
With `requirements_json`, image discovery also returns `runtime_json`, the selected adapter and advertised runtime layout, and `binaries_json`, its resolved executable list.
The sandbox consumes `runtime_json`; its `policy` block retains authored policy and managed endpoint inputs, resolved against that layout before creation.
Provider profiles require a nonempty `binaries` list, which graphs decode from `binaries_json`; search registrations retain their scoped `profile_name`.
Refresh verifies the actual launch and policy against retained metadata, and export and teardown do not need another image inspection.

Inference registrations are scoped by authored provider identity, image digest, and adapter ID; search registrations also include the credential reference.
Sandboxes using the same image and adapter can share registrations, while different image or adapter executable lists remain separate.
Adding a sandbox preserves existing bindings.
Export preserves authored definitions and refuses conflicting credential references among registrations for one inference definition.

Lifecycle postconditions reject known engine incompatibility, conflicting image/adapter metadata, and missing image runtime metadata.
Other unknown evidence does not relax required resource-refresh or gateway checks.
An image observation is scoped to the selected engine, not every possible execution host.

## Target Hardware

`nemoclaw_target_hardware` requires `engine` and returns `status` and `observation_json`.
The passive read reports the daemon identity, architecture, CPU/memory fields, and available engine features such as rootless mode, runtimes, networking, cgroups, and memory-limit support.
GPU IDs advertised as engine generic resources are retained without inventing names, VRAM, driver versions, or compute capability.
No GPU advertisement means unknown inventory, not zero GPUs.

For complete host measurements, the provider library exposes `hardware_observation::observe_host_hardware` with the selected engine and a `HostObserver`.
The operation checks the collector's daemon identity before accepting measurements and has a 30-second bound.
It reports unsupported GPU memory counters separately from unobserved counters.
Collector failure never falls back to the client's hardware.
The new `nemoclaw_target_hardware` source uses passive engine information and does not execute a collector or launch a probe container.
Existing configured service-capacity checks retain their daemon-bound `HostObserver` collectors; this passive source neither replaces nor disables those checks.

## Inference Endpoint Metadata

`nemoclaw_inference_capabilities` requires `endpoint` and `api`; optional `credential_env` names a credential reference.
The provider resolves that reference in memory for the selected endpoint and returns `status` and `observation_json`, never the credential value.
It issues bounded GET requests to the OpenAI-compatible or Anthropic model-list API, with no generation request and no redirects.
Reads have a five-second total bound and limits on response size, models, and pagination.

The observation identifies control-host reachability, catalog authentication, and advertised model identifiers.
It does not establish sandbox reachability or generation, streaming, tool-calling, or model-loading behavior; `api_verified` remains false.
Authentication denial is distinguished from a missing or unsupported model-list endpoint.
Shared endpoint/API/credential-reference requests are deduplicated.
The SDK reports unavailable or unverified catalogs under the plan result's `unverified` list, preserving their typed status without treating catalog availability as a resource-planning prerequisite.
Onboarding adds observed identifiers to model suggestions while preserving manual model entry and accepted choices.

Credentials remain a direct SDK concern: `observe_credentials` reports whether each selected reference resolves, separately from remote authentication.
Gateway and resource discovery reuse their existing strict lifecycle reads below, preserving bindings when refresh fails.
See [SDK discovery](sdk.md#discover-before-authoring-or-planning) and [onboarding target checks](../examples/onboarding-tui/README.md#target-checks).

## Gateway Capabilities

The deployment graph reads `data.openshell_gateway.current` during planning through the `openshell` provider's configured connection.
The data source reports the observed `gateway_version`, driver names and aliases in `compute_drivers`, the driver-entry count in `compute_driver_count`, `compatible` for the `required_compute_drivers`, and an `incompatibility` description that is empty when compatible.
Compatibility requires the pinned OpenShell version and exactly one initialized driver matching every required name.
OpenTofu lifecycle conditions name each failed requirement with its required and observed values.
SDK discovery observations use the same description as their `reason`.
Missing metadata, authentication failures, and transport failures stop planning without changing runtime resources.
Each API read is bounded to 30 seconds.

The optional `wait_timeout_seconds` accepts zero to 300 seconds; omission or zero means one bounded API read.
A positive timeout retries only transport failures, not authentication failures, incomplete metadata, or incompatibility.
For a managed gateway, the runtime stage sets this timeout to 90 seconds and reads capabilities after gateway reconciliation.
The capability postcondition must succeed before OpenShell resource refresh proceeds.

For managed Docker gateways, the runtime graph first reads `data.nemoclaw_gateway_readiness.current` and orders the capability read after it.
`nemoclaw_gateway_readiness` takes the container's `engine`, `container_id`, `name`, and `owner`, the gateway `endpoint`, and optional `wait_timeout_seconds` and `read_trigger`.
The runtime graph waits 90 seconds and takes `container_id` from the Docker provider's process resource, so the read waits until apply.
The data source checks the exact container ID, name, and owner through read-only engine inspection while waiting for the gateway to answer its OpenShell health call without credentials, then returns `ready`.
Two matching stopped or absent observations, separated by 200 milliseconds, stop a positive readiness wait; a restarting process can recover within the existing timeout.
A zero timeout reports a stopped process on its first observation and continues inspecting a running process while the single API request is pending.
A running but unreachable gateway remains a transport failure; failed or incomplete engine observations are not treated as process absence.
The error names the container, includes its observed exit code when available, and points to its logs without copying raw engine errors or log text.
The observation neither restarts nor deletes the process; follow [gateway startup recovery](troubleshooting.md#recover-a-managed-gateway-startup-failure).
Podman and external gateways have no process readiness read; their capability read retains its API wait.

A known data-source result can be retained in a saved plan.
The deployment graph also declares `data.openshell_gateway.apply`, with a `read_trigger` that is unknown during planning.
OpenTofu defers that read until apply and checks its compatibility postcondition before dependent resources can change, including on an otherwise unchanged apply.
The compiler uses `timestamp() != ""`: it is unknown during planning but resolves to a stable `true`, so the trigger does not create perpetual state differences.
The optional trigger is a scheduling input, not another compatibility check; a literal `true` alone would not defer the read.
The SDK does not make a separate pre-apply gateway request.
This observation is not a lock against concurrent gateway administrators.

Observed data never becomes a durable resource binding.
A failed apply may record new observations and condition results while retaining managed-resource state.
After correcting compatibility or access, reapply the same configuration with its retained state.
Teardown omits the capability gates so a version or driver mismatch alone does not prevent cleanup.

[Gateway protocol tests](../crates/nemoclaw-e2e/tests/opentofu_openshell.rs) exercise the production provider and pinned OpenTofu without SDK orchestration: early planning errors, saved-plan drift, unchanged apply, failed observation, recovery, and teardown.
[Deployment fixtures](../crates/nemoclaw-e2e/tests/deployment.rs) and [Fabric lifecycle fixtures](../crates/nemoclaw-e2e/tests/fabric_deployment.rs) verify that the SDK uses the same apply-time protection.
Fabric configuration writes are owned by `fabric_agent_configuration`; unchanged apply preserves the active runtime handle.
Its `config_json` is the canonical public Fabric configuration, separate from immutable sandbox identity.

## vLLM Runtime Contract

`nemoclaw_vllm_runtime` computes the settings that a vLLM container's runtime supervisor reads, without contacting any host.
Its blocks and attributes follow the runtime contract with snake_case names: `model`, `serving`, `memory`, `hardware`, `authentication`, and `recipe`.
`model` is required, and the contract requires either `hardware` or `recipe`.
Omitted or zero settings select the same defaults as service YAML.
Validation reports a rejected setting at its attribute, and the `spec` output is the validated specification.

```hcl
data "nemoclaw_vllm_runtime" "qwen" {
  hardware {
    profile = "dgx-spark"
  }
  model {
    repository = "Qwen/Qwen3-4B"
    revision   = "1cfa9a7208912126459214e8b04321603b3df60c"
  }
  serving {
    port = 18898
  }
}
```

A vLLM `docker_container` passes `spec` as `NEMOCLAW_RUNTIME_SPEC` and declares the rest of its configuration directly.
Generated graphs declare:

- `entrypoint = ["/usr/local/bin/nemoclaw-runtime"]` and `env = ["NEMOCLAW_RUNTIME_SPEC=${data.nemoclaw_vllm_runtime.NAME.spec}"]`.
- The model cache volume at `/data` and, with bearer authentication, the `nemoclaw_inference_storage` credential volume at `/credentials`.
- The serving port, published on the service's bind address.
- `gpus = "all"`, `memory` and `memory_swap` of 106496 MiB, and `shm_size` of 8192 MiB unless the service sets another size.
- Private IPC unless the service selects host IPC, an unlimited `memlock` ulimit, and a `stack` ulimit of 67108864.
- All capabilities dropped, `no-new-privileges`, restart policy `no`, and JSON-file logs rotated at 32 MB across three files.

OpenTofu shows a changed setting as a replacement of the whole `NEMOCLAW_RUNTIME_SPEC` environment entry.

## Ollama Runtime Contracts

`nemoclaw_ollama_runtime` computes the managed Ollama runtime's `NEMOCLAW_RUNTIME_SPEC` the same way.
Its blocks follow the Ollama runtime contract with snake_case names: `hardware`, `model` with `name` and `digest`, `serving`, and `memory`.

`nemoclaw_ollama_proxy_runtime` computes the external Ollama proxy's `NEMOCLAW_OLLAMA_PROXY` value from `bind_address`, `upstream`, `model`, and `digest`.
`bind_address` is a loopback or private address with a port, and `upstream` a loopback HTTP endpoint ending in `/v1`; the output `spec` names the endpoint the proxy serves on `bind_address`.
Generated graphs pass each `spec` to its container's environment variable.

## Docker Gateway Launch

`nemoclaw_gateway_runtime` computes a Docker gateway container's `entrypoint`, `command`, and `env` without contacting any host.
It takes the gateway's `name` and `endpoint`, validated as for `nemoclaw_managed_gateway`, and the `data_path` returned by its `nemoclaw_gateway_storage`, an absolute path:

```hcl
data "nemoclaw_gateway_runtime" "gateway" {
  name      = nemoclaw_gateway_storage.gateway.name
  endpoint  = "http://127.0.0.1:17670"
  data_path = nemoclaw_gateway_storage.gateway.data_path
}

resource "docker_container" "gateway" {
  # name, image, network, ports, and mounts as described below
  entrypoint = data.nemoclaw_gateway_runtime.gateway.entrypoint
  command    = data.nemoclaw_gateway_runtime.gateway.command
  env        = data.nemoclaw_gateway_runtime.gateway.env
}
```

The gateway reads its configuration and database under `data_path` and listens on all container addresses at the endpoint's port.
Generated graphs also run the container as `0:0` and give it:

- the storage's volume mounted at `data_path`;
- the engine socket mounted at `/var/run/docker.sock`;
- the endpoint's port published on the endpoint's address;
- the storage's bridge network, at the second host address of `network_cidr`.

## Runtime Image Compatibility

`nemoclaw_runtime_image` requires the service's `engine`, its `image` pinned by SHA-256 digest, and its `architecture` (`amd64` or `arm64`), and returns `observation_json` with `status`, `source`, and `required_version`.
Optional `labels` maps each label the image must carry to its value; generated graphs require the service's backend, recipe, and authentication labels.
The source checks the vLLM or Ollama image's `org.nemoclaw.runtime.spec` label against the shared runtime contract, plus the Linux platform, the architecture, and `labels`.
It performs one engine image inspection with a 20-second bound and never pulls an image or starts a process.
Missing or mismatched runtime-spec labels fail with [rebuild guidance](build.md#retained-sources-and-compatibility); authentication, transport, and incomplete inspection failures also stop the operation.
Diagnostics do not echo image label values.

Optional `allow_missing: true` permits a confirmed absent image to return `status: unknown` before acquisition; omission or false rejects absence.
Optional `image_id` requires the inspected image to match the Docker provider's acquired image ID.
The SDK emits a read for the currently selected image and another dependent on acquisition, then orders all other runtime resource mutations after compatibility succeeds.
An absent image may therefore be pulled before a compatibility failure, but storage, network, and container creation remain blocked.
SDK plan reports preserve unresolved runtime-image checks in `deferred`, separate from supplemental catalog and service-readiness advisories.
Teardown removes both image observations and their dependency gates.

## Runtime Capacity and Readiness

Configuration validation checks hardware profiles, architecture selections, and memory settings without contacting an execution host.
The default service graph does not invoke the SSH host-capacity collector, resolve model registries, or inspect model-file inventories during planning.
A successful plan therefore does not establish that a model will fit or load.

The hosted runtime checks its hardware, startup headroom, model artifacts, and available memory before serving.
Its resident supervisor continues protecting host memory after the CLI exits and does not automatically restart a stopped workload.
The runtime graph uses `nemoclaw_service_readiness` to wait for current application status from the Docker provider's container ID.
The data source validates the runtime contract and container identity, reads the service's status contract, and checks generated vLLM credential permissions when the contract enables authentication.
It does not repeat model-file verification, collect hardware inventory, or request model responses.
Startup phases may be polled; stopped services, failed observations, and malformed status fail the read.

The data source requires the container's `engine`, `name`, and `container_id`, and its `contract`: the `spec` of the `nemoclaw_vllm_runtime`, `nemoclaw_ollama_runtime`, or `nemoclaw_ollama_proxy_runtime` data source the container runs with.
Its optional `wait_timeout_seconds` accepts zero to 32400 seconds; omission means 32400 seconds, and zero requests one bounded observation.
Successful reads return `ready: true`; unsuccessful reads report an error.
The optional `read_trigger` has the same scheduling semantics as the gateway trigger above.
The compiler references the container's `id` and uses `timestamp() != ""` to defer readiness until apply, including unchanged apply.
This apply-time read appears as `unverified` in SDK plan results; it does not make an otherwise resolved resource plan incomplete or relax the apply gate.
The runtime graph must succeed before the SDK proceeds to the OpenShell graph.
The OpenShell graph uses the same data source for Ollama proxies, with a 30-second wait and dependencies from their selected provider registrations.
For a proxy contract, the observation verifies the recorded container ID and name, running state, credential file permissions, and the upstream model digest through read-only metadata.
It waits for an initially missing key only while the container runs and the volume has no initialization marker; initialized missing keys and invalid permissions fail immediately.
The SDK runs no readiness loop of its own.

The [standalone readiness fixture](contributing/integration-tests.md#standalone-service-readiness) exercises this contract without SDK deployment orchestration.
A failed read retains managed bindings, and SDK teardown omits readiness gates.
See [runtime ownership](design/runtime.md) and [recovery](models.md#diagnose-and-recover-a-stopped-runtime).

## Sandbox Completion

The OpenShell graph uses `fabric_sandbox_readiness` after sandbox creation and any runtime configuration resource.
Its required `sandbox` map carries the sandbox resource's binding and configuration; the provider checks startup and configuration before requesting the packaged bridge's health response.
It does not invoke an agent or model.
The optional string `read_trigger` uses `uuid()` in generated graphs, making the read unknown during planning and recording a fresh token on every apply.

Agent configuration and sandbox completion inspect the bound sandbox's OpenShell configuration admission before executing runtime commands.
An explicit `Rejected` admission stops the startup wait even while the sandbox is `Starting`.
The diagnostic names the sandbox and includes only recognized gateway reasons; unknown backend text becomes a fixed repair message.
Passive refresh retains a rejected nonterminal sandbox so apply can repair attached providers, and teardown does not require admission.
See [runtime policy rejection recovery](sandbox-network.md#recover-from-runtime-policy-rejection).

The data source returns `ready`, nullable `health_json`, and nullable `error_message`.
Runtime observation failures return `ready: false` with an error message.
The pinned bridge's explicit unsupported response is retained in `health_json`; unrecognized reports are errors.
The graph must enforce `ready` with a lifecycle postcondition: a data-source observation alone does not reject an unsuccessful result.
Failed postconditions retain observations and resource bindings for recovery.
The SDK reads these values through OpenTofu JSON and includes the unsupported bridge response in successful apply results.
Failures preserve execution or observation errors without an unverified health payload.
SDK-generated graphs defer health until apply; export and teardown omit the observation.
Standalone configurations with known inputs may read during planning unless the trigger defers them.
Existing sandbox resource refresh still verifies configuration.

The [standalone sandbox fixture](contributing/integration-tests.md#standalone-sandbox-completion) checks this contract through the production provider without SDK deployment orchestration.
The shared backend compares public Fabric configuration and runtime handle state; fresh native configuration and health remain subject to [Fabric observation limits](design/fabric-management.md#observation-limits).

## Combined Service Capacity

The optional `nemoclaw_service_capacity` data source remains available for explicit capacity observation.
It takes an `engine` and `contracts`, the `spec` of each `nemoclaw_vllm_runtime` or `nemoclaw_ollama_runtime` data source on that engine, and rejects a contract listed twice.
It reports required and observed bytes and compatibility using the selected execution host's measurements.
The SDK's default service graph does not use it as an admission gate.
Per-service runtime protection does not reserve capacity across deployments or schedule shared GPUs.
Operators must choose budgets appropriate for the shared host.

## Network and Image Reconciliation

The Docker provider creates, refreshes, replaces, and removes Docker gateway and service containers, and service-owned private networks.
These resources use native provider IDs; labels are diagnostic metadata rather than a second compute-ownership mechanism.
A missing service container may be recreated during explicit apply.
Missing or substituted bound credentials and gateway storage remain errors.
A missing model-cache volume may be recreated; its original creation time and daemon ID are not application identity.
The generated graph retains caches with `prevent_destroy`; SDK teardown keeps those volume resources declared.
OpenTofu cannot enforce `prevent_destroy` after its resource declaration is removed, so apply still rejects removing a retained cache declaration.
The gateway bridge serves OpenShell sandboxes and remains part of the retained storage namespace; the Docker gateway process uses host networking.
Gateway initialization consumes the provider-acquired image before the process is created.
Podman initialization retains its existing image acquisition path.

The Docker provider acquires pinned Docker gateway and service images and keeps downloaded images on destroy.
The `Never` policy uses its local image data source; a missing local image fails that observation.
This does not lock the image against concurrent removal before container creation; see the [policy limits](usage.md#control-container-image-downloads).
See [image acquisition policies](usage.md#control-container-image-downloads) for supported modes.
Plan does not pull images, and container creation does not establish application health or model compatibility.

Provider reconciliation checks the attributes refreshed by that provider; it does not guarantee detection of every out-of-band Docker configuration change.
The deployment lock excludes other NemoClaw operations using the same state directory, not concurrent Docker administrators.

## Managed Kubernetes Gateway

The runtime graph for a managed Kubernetes or OpenShift gateway declares four resources in this order:

1. `nemoclaw_kubernetes_storage.runtime` creates and retains the namespace and encryption key, with `prevent_destroy`.
2. `nemoclaw_kubernetes_auth.runtime` prepares the development token issuer.
   For OpenShift, its computed `gateway_values` carries the namespace's UID and group ranges as chart overrides.
3. `helm_release.gateway` installs the pinned OpenShell chart into the prepared namespace without creating the namespace or taking ownership of existing objects.
4. `nemoclaw_kubernetes_gateway.runtime` records the chart's StatefulSet identity and reports readiness in `running`.

The three NemoClaw resources take the same cluster target and identity:

- `name`: `nc-`, 16 lowercase hexadecimal characters, and `-gateway`.
- `compute_driver`: `kubernetes` or `openshift`.
- `endpoint`: the gateway's `https://127.0.0.1:PORT` loopback endpoint.
- `kubeconfig_env`: the environment variable whose value is the kubeconfig file path.
- `context` and `namespace`: the exact kubeconfig context and the namespace for the gateway.
- `authentication_profile`: `development`.
- Optional `environment`: the names of the environment variables the kubeconfig's exec credential plugin needs.
- Optional `owner` and `generation`, generated on create when omitted.

The three resources share one private receipt, keyed by `owner` and `name`, so give `nemoclaw_kubernetes_auth` and `nemoclaw_kubernetes_gateway` the storage's `owner`, for example `owner = nemoclaw_kubernetes_storage.platform.owner`.
Generated graphs also give the authentication resource the gateway's `generation`.
Changing any of these settings after creation fails planning and leaves the resources unchanged.

Each NemoClaw resource has a postcondition requiring `running`, so an incomplete step stops apply until a later apply with the same state completes it.
The SDK requires each earlier binding before it accepts a later one.
The Helm provider receives only the authored kubeconfig path and context; ambient Helm and Kubernetes settings are excluded.

Teardown removes the release before the issuer.
The authentication resource must confirm through `release_present` that the Helm release records are absent before it deletes the issuer.
The namespace, encryption key, and persistent volumes remain.
[Managed Kubernetes ownership](design/architecture.md#managed-kubernetes-ownership) explains recovery when Helm loses its release binding, and [Deploy to Kubernetes or OpenShift](kubernetes.md) gives the procedure.

## Packaging and Qualification

Follow [bundle building](build.md) for matched CLI, SDK contract, provider, schema, and OpenTofu versions.
The NemoClaw, OpenShell, and Fabric providers use the same source-derived version to prevent stale reuse.
The Docker and Helm providers have fixed release versions and checksum-pinned native archives, with their upstream licenses retained in the bundle.

[Schema tests](../crates/nemoclaw-provider/tests/schema.rs), [OpenShell provider schema tests](../crates/openshell-provider/tests/schema.rs), [Fabric provider schema tests](../crates/fabric-provider/tests/schema.rs), [planning tests](../crates/nemoclaw-provider/tests/planning.rs), and [refresh tests](../crates/nemoclaw-provider/tests/refresh.rs) cover provider contracts.
[Fixture qualification](contributing/integration-tests.md) covers real OpenTofu protocol/lifecycle execution with explicit bundle inputs.

## Direct OpenTofu Usage

The providers are not published yet ([#12638](https://github.com/NVIDIA/NemoClaw/issues/12638)).
Supported HCL examples, import, adoption, remote-state backends and compatibility across releases are tracked in [#12645](https://github.com/NVIDIA/NemoClaw/issues/12645).

These sections need verified implementations and test results before they can recommend a direct-use workflow.
