An explicit `Rejected` OpenShell configuration admission stops the wait even while the sandbox is `Starting`.
The diagnostic names the sandbox and includes only recognized gateway reasons; unknown backend text becomes a fixed repair message.
See [runtime policy rejection recovery](../security/sandbox-network.md#recover-from-runtime-policy-rejection).

Refresh runs `fabric-agent-ctl check` for the recorded runtime and records the result in the computed `running`.
A runtime Fabric no longer has, one that fails its check, and one whose sandbox isn't ready or doesn't serve its bridge count as stopped; an adapter without health checks, or a probe that can't finish, counts as running.
A check whose reply is cut off fails refresh as an incomplete observation.
A stopped runtime plans an update: apply stops it in Fabric and starts another in the same sandbox, with a new `runtime_id`.
An update that keeps a running runtime, such as for a newer image catalog, leaves it alone.
Fabric doesn't report the configuration a runtime applied, so a configuration changed inside the sandbox outside OpenTofu is not reported as drift.
Removing the resource stops the agent through `fabric-agent-ctl stop`, as removing an attachment does, and the sandbox stays.
A runtime that already stopped, or a sandbox already gone, counts as removed; if stopping fails, the binding is kept so the next apply or destroy retries.

`fabric_agent` exports `runtime_id`, the ID Fabric gave the runtime, for invoking it with `fabric-agent-ctl invoke --runtime-id`, and `running`, whether refresh found it running.
It also exports a `ref` with its sandbox's `workspace`, `sandbox` name, `sandbox_id`, `owner`, and `generation`, its own `name`, and `config_sha256`.
`config_sha256` is `sha256:<hex>` over the composed document's JSON with object keys sorted; it is known while planning once the agent's inputs are.

### vLLM and Ollama Types

The `vllm` and `ollama` providers serve one runtime each: its credential storage, the runtime contract its container runs with, and its readiness and capacity reads.
The `ollama` provider also checks the model behind an Ollama proxy.
Each provider's only setting is `destroy`, which permits deleting its credential storage during explicit teardown.
Each type except `ollama_model` names the engine it uses.

| Type | Manages or observes |
|---|---|
| `vllm_credential_storage` | vLLM credential storage |
| `vllm_runtime` data source | Nothing; [computes the vLLM runtime contract](#vllm-runtime-contract) |
| `vllm_readiness` data source | [vLLM service readiness](#runtime-capacity-and-readiness) |
| `vllm_capacity` data source | [vLLM service capacity](#service-capacity) |
| `ollama_proxy_credential_storage` | Ollama proxy credential storage |
| `ollama_runtime` data source | Nothing; [computes the Ollama runtime contract](#ollama-runtime-contracts) |
| `ollama_proxy_runtime` data source | Nothing; [computes the Ollama proxy contract](#ollama-runtime-contracts) |
| `ollama_readiness` data source | [Managed Ollama readiness](#runtime-capacity-and-readiness) |
| `ollama_proxy_readiness` data source | [Ollama proxy readiness](#runtime-capacity-and-readiness) |
| `ollama_model` data source | An upstream Ollama model's digest |
| `ollama_capacity` data source | [Managed Ollama capacity](#service-capacity) |

Generated graphs place vLLM and Ollama model caches in `docker_volume` resources.

`vllm_credential_storage` takes `name` and `engine`, and optionally `owner` and `generation`.
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

`ollama_proxy_credential_storage` takes `name` and `engine`, and keeps the proxy credential in a volume named `<name>-auth`.
It takes optional `owner` and `generation`, generated the same way.

`ollama_model` takes `upstream`, `name`, and `digest`, and exports `ref` with those values.
`upstream` is an `http` URL with a loopback IP address, an explicit port, and path `/v1`; `name` is an Ollama model name; `digest` is 64 lowercase hexadecimal characters.
Each read lists the upstream's models with `GET /api/tags` and fails when the model is absent or its digest differs; it never pulls or changes a model.
OpenTofu reads it while planning once its inputs are known, so a changed digest stops the plan.
Generated graphs read it for each Ollama proxy and start the proxy container after it.

### Host Data Sources

The `host` provider observes container engines and changes nothing; it has no settings.

| Data source | Observes |
|---|---|
| `host_engine` | [Engine version, platform, CPUs, memory](#engine-and-fabric-discovery), and [advertised hardware](#target-hardware) |
| `host_image` | [An image's platform and labels](#runtime-image-compatibility) |
| `host_container_health` | [Owned container readiness](#application-container-health): Docker HEALTHCHECK, HTTP, or managed-runtime status |

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

The shared [resource lifecycle contract](../../crates/nemoclaw-openshell/src/lifecycle.rs) distinguishes reconstructible objects, sandboxes included, from retained workspace identity.
The provider owns observation and update/replacement behavior; OpenTofu owns action ordering and resource state.
The SDK checks deployment scope and recovery constraints without imposing a second blanket ban on OpenShell changes.
For reconstructible resources, OpenTofu and the provider own confirmed absence, physical identity, and replacement cleanup; the SDK does not require a second drift history to report those actions during apply or teardown.

| Resource | Reconciliation | Protection |
|---|---|---|
| Inference and web search | Create the profile and then the registration; recreate a missing profile and rotate an inference credential reference in place; replace on any other input change or a missing registration | The same checks for both objects; a failure between them records the identity, so the next apply replaces the resource |
| Fabric agent | Apply the public Fabric document; replace the agent on any input change | Verify the parent sandbox identity; refuse a replacement unless the sandbox is replaced too |
| Sandbox | Create and observe the declared sandbox; replace it on any change to its specification | Replacement and deletion delete its files and conversation history; data that must survive belongs on a mounted volume |
| Workspace | Create and observe; delete only during explicit teardown | Refuse replacement and automatic recreation of a missing binding; `lifecycle { prevent_destroy = true }` retains it, as generated graphs do during apply |

OpenShell refuses deletion of profiles referenced by registrations and registrations attached to sandboxes.
Inference and web search resources therefore recreate a missing profile in place, and remove the registration before its profile.
Generated graphs create an `openshell_inference` only for definitions selected by sandboxes; unused YAML definitions have no resource lifecycle.
Standalone HCL can remove or replace an inference resource, while removing a last selection in SDK YAML also changes the sandbox's specification, which replaces the sandbox.
Endpoint and policy changes that also change a sandbox's launch specification replace the sandbox; see [change paths](../build-deploy/usage.md#choose-the-change-path).

The provider's `destroy` setting authorizes explicit teardown of workspaces; reconstructible objects, sandboxes included, do not require it.
It never authorizes deleting the workspace or bypassing identity checks.
Removing Fabric configuration stops the agent and leaves the sandbox-owned runtime host and its sandbox in place.
The SDK's destroy operation retains durable storage and deletes the workspace with the rest of the deployment's objects.
See [deletion and retention](../build-deploy/state.md#deletion-and-retention) before removing workloads.

An observation error is not absence.
Authentication, transport, and incomplete observations preserve prior state and stop planning.
Planning a new object reaches no gateway, so the same apply can install the gateway it uses.
The backend checks who owns an existing name immediately before each mutation, which also covers objects that changed after planning.
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
| Engine version, platform, CPUs, and memory | `host_engine` (`engine_json`); selected Docker/Podman API | Onboarding target changes and managed deployment planning |
| Managed gateway prerequisites for its compute driver | `openshell_gateway_prerequisites`; selected Docker/Podman API | Onboarding target changes and managed deployment planning |
| Engine features, CPU, memory, and advertised GPU inventory | `host_engine` (`hardware_json`); selected engine API | Onboarding and planning for selected gateway/service engines |
| GPU memory, driver, compute capability, and disk measurements | Provider `observe_host_hardware` with a selected `HostObserver` | Explicit direct calls or existing configured service-capacity checks; the new passive hardware source does not run collectors |
| Packaged adapters, APIs, settings, and runtime requirements | `fabric_harnesses`; selected image metadata containing Fabric discovery results | Onboarding image changes and deployment planning |
| Required labels and platform of managed images | `host_image`; selected engine image inspection | Plan for present images; after image acquisition before runtime mutations |
| Advertised models and catalog authentication | Direct SDK `observe_endpoint`; HTTP model-list endpoint from the control host | Onboarding endpoint changes |
| Credential-reference availability | Direct SDK `observe_credentials`; application's secret resolver | Onboarding, SDK calls, and plan-result discovery; values and local availability do not enter provider state |
| Gateway version and compute drivers | Existing `openshell_gateway`; authenticated OpenShell API | Onboarding review and required deployment lifecycle checks |
| Existing resources, ownership, drift, and retained storage | Existing OpenTofu resource refresh and SDK retained bindings | Deployment planning; no separate scan adopts unowned resources |

## Engine and Fabric Discovery

`host_engine` (host provider), `openshell_gateway_prerequisites` (OpenShell provider), and `fabric_harnesses` (Fabric provider) require `engine`, the selected container-engine endpoint, without requiring an OpenShell connection.
The prerequisite source also requires `compute_driver` (`docker` or `podman`); the Fabric source requires `image`.
For a cluster image that no local engine can inspect, the Fabric source instead reads the metadata bundle whose path is in the environment variable named by `metadata_env`; `engine` must then be empty.
Each returns `status`, `available`, and structured JSON: `host_engine` in `engine_json` and `hardware_json`, the others in `observation_json`.
One read of the engine's `/info` answers both of `host_engine`'s observations; its `status` and `available` describe the engine facts, and `hardware_json` carries its own status.

The engine observation reports available server version, architecture, operating system, CPU count, and memory fields.
The prerequisite observation is `unavailable`, with its reason, when the engine cannot host a managed gateway with that driver: the Podman driver needs a Podman engine socket, and rootless Podman needs pasta networking.
The gateway installation types check the same prerequisites when they plan and apply.
The prerequisite source also takes the gateway's optional `endpoint`, `name`, and `owner`. With them, it is also `unavailable` when anything other than that gateway holds the endpoint's port: another running container that publishes it, or, for Podman, whose gateway listens on the host's loopback, any listener on the CLI host. A host process that holds a Docker engine's port is reported when the gateway starts.
Plans for a managed gateway read both and report them as one engine observation, whose status is the less available of the two.
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

Optional `config_json` supplies the canonical public Fabric configuration, the same document a `fabric_agent`'s inputs compose.
Optional `filesystem_read` lists the paths the sandbox policy grants for reading; omitting it skips the filesystem check.
A configuration without `harness.adapter_id` is rejected.
Optional `architecture` and `operating_system` supply the execution engine's platform.
The computed `compatibility_status` is `supported`, `unsupported`, or `unknown`, with details in `observation_json.compatibility`.
The SDK checks image identity, source revision and platform, and that the image provides the selected adapter (the `fabric_adapter` check).
An image without the adapter is unsupported. NemoClaw doesn't compare Fabric revisions: the image's own Fabric runtime reports an incompatibility when the agent starts.
Fabric owns settings, model, extension and workflow validation, which it performs inside the sandbox when the agent is configured.
Deployment postconditions name the sandbox and adapter and preserve unsupported check reasons in text and JSON errors.
Onboarding uses the same assessment; unknown error variants retain a generic rejection.
Omitting `config_json` preserves metadata-only discovery.

The [agent image builder](../build-deploy/build.md#build-agent-images) reads `Fabric.discover()` inside each assembled image and stores the result in `io.nemoclaw.fabric.catalog`.
It selects installed-package records using Fabric's provenance, without editing their descriptors.
Harness image stages declare the directories where their layout installs each adapter; the builder records them as `runtime_files`, keyed by adapter ID, beside the descriptors.
With deployment filesystem grants, every path in the adapter descriptor's `requirements.files`, its `runtime_files` entry, and the image runtime's `required_paths` must fall under a grant.
The bundled snapshot supports offline authoring and carries the same pinned Fabric revision and source checksum.
For image metadata internals, refer to the [image metadata contract](../../internal-docs/design/fabric-management.md#image-metadata).
Direct Bake builds without labels remain unverified.
Catalog identifiers are not restricted to a compiled SDK list.
The runtime consumes the same canonical public configuration through Fabric; see [discovered harness configuration](sdk.md#configure-a-discovered-fabric-harness).

Generated graphs observe each sandbox image independently of resource creation or image acquisition.
Managed gateways use their configured engine; external gateways require `spec.gateway.engine` for image inspection and do not run managed-gateway prerequisite checks.
With `config_json`, image discovery also returns `runtime_json`, the selected adapter and advertised runtime layout, and `binaries_json`, its resolved executable list.
The sandbox consumes `runtime_json`; its `policy` block retains authored policy and managed endpoint inputs, resolved against that layout before creation.
Provider profiles require a nonempty `binaries` list, which graphs decode from `binaries_json`; search registrations take their scoped profile's `ref` as `profile`.
Refresh verifies the actual launch and policy against retained metadata, and export and teardown do not need another image inspection.

Inference registrations are scoped by authored provider identity, image digest, and adapter ID; search registrations also include the credential reference.
Sandboxes using the same image and adapter can share registrations, while different image or adapter executable lists remain separate.
Adding a sandbox preserves existing bindings.
Export preserves authored definitions and refuses conflicting credential references among registrations for one inference definition.

Lifecycle postconditions reject known engine incompatibility, conflicting image/adapter metadata, and missing image runtime metadata.
Other unknown evidence does not relax required resource-refresh or gateway checks.
An image observation is scoped to the selected engine, not every possible execution host.

## Target Hardware

`host_engine`'s `hardware_json` is the passive hardware read.
It reports the daemon identity, architecture, CPU/memory fields, and available engine features such as rootless mode, runtimes, networking, cgroups, and memory-limit support.
GPU IDs advertised as engine generic resources are retained without inventing names, VRAM, driver versions, or compute capability.
No GPU advertisement means unknown inventory, not zero GPUs.

For complete host measurements, the provider library exposes `hardware_observation::observe_host_hardware` with the selected engine and a `HostObserver`.
The operation checks the collector's daemon identity before accepting measurements and has a 30-second bound.
It reports unsupported GPU memory counters separately from unobserved counters.
Collector failure never falls back to the client's hardware.
`host_engine` uses passive engine information and does not execute a collector or launch a probe container.
Existing configured service-capacity checks retain their daemon-bound `HostObserver` collectors; this passive source neither replaces nor disables those checks.

## Inference Endpoint Metadata

Onboarding reads an external endpoint's model catalog to suggest models, with `inference_discovery::observe_endpoint`; plans and providers don't read catalogs, because OpenShell carries inference traffic from its own network.
Each read takes the endpoint, its `api`, and an optional `credential_env` credential reference, which the SDK resolves in memory and never reports.
It issues bounded GET requests to the OpenAI-compatible or Anthropic model-list API, with no generation request and no redirects.
Reads have a five-second total bound and limits on response size, models, and pagination.

The observation identifies control-host reachability, catalog authentication, and advertised model identifiers.
It does not establish sandbox reachability or generation, streaming, tool-calling, or model-loading behavior; `api_verified` remains false.
Authentication denial is distinguished from a missing or unsupported model-list endpoint.
Onboarding adds observed identifiers to model suggestions while preserving manual model entry and accepted choices.

Credentials remain a direct SDK concern: `observe_credentials` reports whether each selected reference resolves, separately from remote authentication.
Gateway and resource discovery reuse their existing strict lifecycle reads below, preserving bindings when refresh fails.
See [SDK discovery](sdk.md#discover-before-authoring-or-planning) and [onboarding target checks](../../crates/nemoclaw-onboarding/README.md#target-checks).

## Gateway Capabilities

The deployment graph reads `data.openshell_gateway.current` during planning through the connection it takes, and every OpenShell object and Fabric configuration takes its `ref`.
The data source reports the observed `gateway_version`, driver names and aliases in `compute_drivers`, the driver-entry count in `compute_driver_count`, `compatible` for the `required_compute_drivers`, and an `incompatibility` description that is empty when compatible.
Compatibility requires the pinned OpenShell version and exactly one initialized driver matching every required name.
OpenTofu lifecycle conditions name each failed requirement with its required and observed values.
SDK discovery observations use the same description as their `reason`.
Missing metadata, authentication failures, and transport failures stop planning without changing runtime resources.
Each API read is bounded to 30 seconds.

The optional `wait_timeout_seconds` accepts zero to 300 seconds; omission or zero means one bounded API read.
A positive timeout retries only transport failures, not authentication failures, incomplete metadata, or incompatibility.
For a managed gateway, the generated graph sets this timeout to 90 seconds and reads capabilities after gateway reconciliation.
The capability postcondition must succeed before OpenShell resource refresh proceeds.

For managed Docker gateways, the runtime graph first reads `data.openshell_docker_gateway_readiness.current` and orders the capability read after it.
`openshell_docker_gateway_readiness` takes the container's `engine`, `container_id`, `name`, and `owner`, the gateway `endpoint`, and optional `wait_timeout_seconds` and `read_trigger`.
The runtime graph waits 90 seconds and takes `container_id` from the Docker provider's process resource, so the read waits until apply.
The data source checks the exact container ID, name, and owner through read-only engine inspection while waiting for the gateway to answer its OpenShell health call without credentials, then returns `ready`.
Two matching stopped or absent observations, separated by 200 milliseconds, stop a positive readiness wait; a restarting process can recover within the existing timeout.
A zero timeout reports a stopped process on its first observation and continues inspecting a running process while the single API request is pending.
A running but unreachable gateway remains a transport failure; failed or incomplete engine observations are not treated as process absence.
The error names the container, includes its observed exit code when available, and points to its logs without copying raw engine errors or log text.
The observation neither restarts nor deletes the process; follow [gateway startup recovery](../observability/troubleshooting.md#recover-a-managed-gateway-startup-failure).
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

[OpenShell contract tests](../../crates/openshell-provider/tests/contract) exercise the production provider and pinned OpenTofu without SDK orchestration: early planning errors, saved-plan drift, unchanged apply, failed observation, recovery, and teardown.
[Deployment fixtures](https://github.com/NVIDIA/NemoClaw/blob/86b8d94273a76a696e06b300dc29f7035b163667/crates/nemoclaw-e2e/tests/integration/deployment.rs) and [Fabric lifecycle fixtures](https://github.com/NVIDIA/NemoClaw/blob/86b8d94273a76a696e06b300dc29f7035b163667/crates/nemoclaw-e2e/tests/integration/fabric_deployment.rs) verify that the SDK uses the same apply-time protection.
Starting and stopping agent runtimes is owned by `fabric_agent`; an unchanged apply leaves the running runtime alone.
Its inputs compose the canonical public Fabric configuration, separate from immutable sandbox identity.

## vLLM Runtime Contract

`vllm_runtime` computes the settings that a vLLM container's runtime supervisor reads, without contacting any host.
Its blocks and attributes follow the runtime contract with snake_case names: `model`, `serving`, `memory`, `hardware`, `authentication`, and `recipe`.
`model` is required, and the contract requires either `hardware` or `recipe`.
Omitted or zero settings select the same defaults as service YAML.
Validation reports a rejected setting at its attribute, and the `spec` output is the validated specification.

```hcl
data "vllm_runtime" "qwen" {
  hardware {
    profile = "dgx-spark"
  }
  model {
    repository = "Qwen/Qwen3-4B"
    revision   = "1cfa9a7208912126459214e8b04321603b3df60c"
  }
  # The weights, about 7.5 GiB, the KV cache and 2 GiB must fit in the budget.
  memory {
    gpu_memory_gib = 20
    kv_cache_gib   = 6
  }
  serving {
    port = 18898
  }
}
```

`launch` and `requirements` describe the server for any platform, so a Docker container, a Kubernetes pod, or any other placement can run it without the SDK:

- `launch` has `entrypoint`, `command`, `environment` (only `NEMOCLAW_RUNTIME_SPEC`, holding `spec`), the `port` the server listens on, the `data_path` for its model cache, and `key_env`: with `authentication`, the variable a platform sets to [supply the server's API key](../agents-inference/inference.md#supply-the-key-on-other-platforms), otherwise empty.
- `requirements` has `gpu`, a recommended minimum `shared_memory_bytes` (8 GiB), and `ulimits` by name, where `-1` is unlimited: `memlock` and `stack`. Platforms that cannot set process limits leave them to the node.
- Memory and CPU limits, IPC, publication, and credentials are the placement's choice.

```hcl
resource "docker_container" "qwen" {
  name       = "qwen"
  image      = var.vllm_image # pinned by digest
  entrypoint = data.vllm_runtime.qwen.launch.entrypoint
  command    = data.vllm_runtime.qwen.launch.command
  env        = [for name, value in data.vllm_runtime.qwen.launch.environment : "${name}=${value}"]
  shm_size   = data.vllm_runtime.qwen.requirements.shared_memory_bytes / 1048576
  gpus       = "all"
  ports {
    internal = data.vllm_runtime.qwen.launch.port
    external = data.vllm_runtime.qwen.launch.port
    ip       = "127.0.0.1"
  }
}
```

Generated graphs place managed vLLM with Docker and declare:

- `entrypoint = ["/usr/local/bin/nemoclaw-runtime"]` and `env = ["NEMOCLAW_RUNTIME_SPEC=${data.vllm_runtime.NAME.spec}"]`.
- The model cache volume at `/data` and, with bearer authentication, the `vllm_credential_storage` credential volume at `/credentials`.
- The serving port, published on the service's bind address.
- `gpus = "all"`; `memory` and `memory_swap` follow `container.memoryLimitGiB`, defaulting to 106496 MiB (104 GiB); `shm_size` defaults to 8192 MiB unless the service sets another size.
- No CPU cap unless `container.cpuLimitMillis` is supplied; Docker then enforces `cpu_quota = cpuLimitMillis × 100` microseconds per `cpu_period = 100000` (100 ms, as on Kubernetes), with a minimum quota of 1000 microseconds.
- A `nemoclaw.nvidia.com/cpu-limit-millis` label when a CPU limit is set and a `nemoclaw.nvidia.com/memory-limit-gib` label when the memory limit differs from 104 GiB; because label changes replace the container, changing either limit is a replacement rather than an in-place `docker update`.
- Private IPC unless the service selects host IPC, an unlimited `memlock` ulimit, and a `stack` ulimit of 67108864.
- All capabilities dropped, `no-new-privileges`, restart policy `no`, and JSON-file logs rotated at 32 MB across three files.

OpenTofu shows a changed setting as a replacement of the whole `NEMOCLAW_RUNTIME_SPEC` environment entry.
Container limits and service-level `updatePolicy` belong to the SDK deployment contract and do not enter that runtime specification.
For managed vLLM and Ollama, the SDK's default `Preserve` policy refuses replacement of a running Docker container; `Recreate` permits the replacement and its possible downtime.
See [container limits and update policy](../agents-inference/inference.md#set-container-limits-and-update-policy) for common fields and platform constraints.

## Ollama Runtime Contracts

`ollama_runtime` computes the managed Ollama runtime's `NEMOCLAW_RUNTIME_SPEC` the same way, with the same `launch` and `requirements` outputs.
Its blocks follow the Ollama runtime contract with snake_case names: `hardware`, `model` with `name` and `digest`, `serving`, and `memory`.

`ollama_proxy_runtime` computes the external Ollama proxy's `NEMOCLAW_OLLAMA_PROXY` value from `bind_address`, `upstream`, `model`, and `digest`.
`bind_address` is a loopback or private address with a port, and `upstream` a loopback HTTP endpoint ending in `/v1`; the output `spec` names the endpoint the proxy serves on `bind_address`.
Generated graphs pass each `spec` to its container's environment variable.

## Docker Gateway Launch

`openshell_docker_gateway_runtime` computes a Docker gateway container's `entrypoint`, `command`, and `env` without contacting any host.
It takes the gateway's `name` and `endpoint`, validated as for `openshell_podman_gateway`, and the `data_path` returned by its `openshell_gateway_storage`, an absolute path:

```hcl
data "openshell_docker_gateway_runtime" "gateway" {
  name      = openshell_gateway_storage.gateway.name
  endpoint  = "http://127.0.0.1:17670"
  data_path = openshell_gateway_storage.gateway.data_path
}

resource "docker_container" "gateway" {
  # name, image, network, ports, and mounts as described below
  entrypoint = data.openshell_docker_gateway_runtime.gateway.entrypoint
  command    = data.openshell_docker_gateway_runtime.gateway.command
  env        = data.openshell_docker_gateway_runtime.gateway.env
}
```

The gateway reads its configuration and database under `data_path` and listens on all container addresses at the endpoint's port.
Generated graphs also run the container as `0:0` and give it:

- the storage's volume mounted at `data_path`;
- the engine socket mounted at `/var/run/docker.sock`;
- the endpoint's port published on the endpoint's address;
- the storage's bridge network, at the second host address of `network_cidr`;
- the restart policy `unless-stopped`, so the engine starts the gateway again after the gateway or the host restarts, while a gateway stopped with `docker stop` stays stopped.

## Runtime Image Compatibility

`host_image` requires an `engine`, an `image` pinned by SHA-256 digest, and an `architecture` (`amd64` or `arm64`), and returns `observation_json` with `status` and `source`.
Optional `labels` maps each label the image must carry to its value; generated graphs require each vLLM or Ollama service's backend, recipe, and authentication labels.
The source checks the Linux platform, the architecture, and `labels`, and knows nothing about NemoClaw runtimes.
It performs one engine image inspection with a 20-second bound and never pulls an image or starts a process.
A platform mismatch or a missing or mismatched label fails the read and names the label, not the image's value; authentication, transport, and incomplete inspection failures also stop the operation.
See [retained sources and compatibility](../build-deploy/build.md#retained-sources-and-compatibility) for rebuilding a mismatched image.

Optional `allow_missing: true` permits a confirmed absent image to return `status: unknown` before acquisition; omission or false rejects absence.
Optional `image_id` requires the inspected image to match the Docker provider's acquired image ID.
The SDK emits a read for the currently selected image and another dependent on acquisition, then orders all other runtime resource mutations after compatibility succeeds.
An absent image may therefore be pulled before a compatibility failure, but storage, network, and container creation remain blocked.
SDK plan reports preserve unresolved runtime-image checks in `deferred`, separate from supplemental catalog and service-readiness advisories.
Teardown removes both image observations and their dependency gates.

## Application Container Health

`host_container_health` requires an `engine`, a container `name`, and a `container_id`.
Optional `labels` maps each label the container must carry to its value; generated graphs require the deployment owner, generation, and compiled launch digest.
The source verifies that the selected container is running and matches its identity and labels; it never runs a command in it.
By default it requires Docker HEALTHCHECK to report `healthy`.
Optional `http_url` selects an HTTP GET that must return 200, without credentials in the URL or redirects.
Optional `runtime_status` instead selects a managed-runtime status file: `phase`, `updated`, `detail`, and `pid`, with a ready report no older than the container's start time.
These modes are mutually exclusive; neither interprets application configuration or invokes a model.
A successful read sets `healthy`.
It waits for startup within `wait_timeout_seconds` (capped at 3600, default 0); zero performs one bounded observation.
Missing or stopped containers, mismatched labels, malformed or stopped runtime reports, rejected HTTP reads, and unhealthy Docker reports fail the read.
A stale runtime report or loading phase is not readiness; it can be polled within the deadline.
Failed engine observations are not absence.
Generated graphs set `read_trigger` so every apply, including an unchanged apply, observes current health before dependent services start.

## Runtime Capacity and Readiness

Configuration validation checks hardware profiles, architecture selections, and memory settings without contacting an execution host.
The default service graph does not invoke the SSH host-capacity collector, resolve model registries, or inspect model-file inventories during planning.
A successful plan therefore does not establish that a model will fit or load.

The hosted runtime checks its hardware, startup headroom, model artifacts, and available memory before serving.
Its resident supervisor continues protecting host memory after the CLI exits and does not automatically restart a stopped workload.
The runtime graph uses `vllm_readiness` and `ollama_readiness` to wait for current application status from the Docker provider's container ID.
Each validates the runtime contract and container identity, reads the service's status contract, and checks generated vLLM credential permissions when the contract enables authentication.
It does not repeat model-file verification, collect hardware inventory, or request model responses.
Startup phases may be polled; stopped services, failed observations, and malformed status fail the read.

Each readiness data source requires its `contract`, the `spec` of the runtime contract data source the server runs with: `vllm_runtime` for `vllm_readiness`, `ollama_runtime` for `ollama_readiness`, and `ollama_proxy_runtime` for `ollama_proxy_readiness`.
It reads readiness in one of two modes:

- **Container mode:** `engine`, `name`, and `container_id` name a Docker container; the read follows the container's status as described above. Given `sandbox_endpoint`, the base URL gateways and sandboxes use, a successful read also exports the server's `ref`. For a server that requires its generated key (vLLM with `authentication`, and every Ollama proxy), the ref's `credential_source` names where that key lives: the container, the credential volume it mounts, and that volume's NemoClaw identity, read from the engine and checked as registrations check it. Without `sandbox_endpoint`, container mode exports no `ref`.
- **Endpoint mode:** `endpoint` is the server's OpenAI-compatible base URL, ending in `/v1`, that the provider can reach. The read polls `<endpoint>/models`, without following redirects, until the response lists the contract's served model; it needs no engine and works for a server on any platform. It serves unauthenticated contracts only and reports neither startup phase nor failure reason. Optional `sandbox_endpoint` is the base URL gateways and sandboxes use, defaulting to `endpoint`, and a successful read exports the server's `ref`. `ollama_proxy_readiness` supports container mode only.

The `ref` is `{ type = "inference_server", endpoint, model, credential_env, credential_source }`: `endpoint` is the sandbox endpoint, `model` the contract's served model, `credential_env` empty, and `credential_source` set only for a server that requires its generated key. It names the key's location and never holds the key.

Setting both modes' inputs fails validation, as does endpoint mode with an authenticated contract.
Until inference registrations take the `ref`, pass its endpoint: `endpoint = data.vllm_readiness.NAME.ref.endpoint`.

```hcl
data "vllm_readiness" "qwen" {
  contract         = data.vllm_runtime.qwen.spec
  endpoint         = "http://127.0.0.1:18898/v1"
  sandbox_endpoint = "http://10.0.0.8:18898/v1"
  read_trigger     = docker_container.qwen.id != ""
}
```
A contract for another runtime fails validation, naming the provider that reads it.
Its optional `wait_timeout_seconds` accepts zero to 32400 seconds; omission means 32400 seconds, and zero requests one bounded observation.
Successful reads return `ready: true`; unsuccessful reads report an error.
The optional `read_trigger` has the same scheduling semantics as the gateway trigger above.
The compiler references the container's `id` and uses `timestamp() != ""` to defer readiness until apply, including unchanged apply.
This apply-time read appears as `unverified` in SDK plan results; it does not make an otherwise resolved resource plan incomplete or relax the apply gate.
The runtime graph must succeed before the SDK proceeds to the OpenShell graph.
The OpenShell graph uses `ollama_proxy_readiness` for Ollama proxies, with a 30-second wait and dependencies from their selected provider registrations.
For a proxy contract, the observation verifies the recorded container ID and name, running state, credential file permissions, and the upstream model digest through read-only metadata.
It waits for an initially missing key only while the container runs and the volume has no initialization marker; initialized missing keys and invalid permissions fail immediately.
The SDK runs no readiness loop of its own.

The [standalone readiness fixture](../../internal-docs/contributing/integration-tests.md#standalone-service-readiness) exercises this contract without SDK deployment orchestration.
A failed read retains managed bindings, and SDK teardown omits readiness gates.
See [runtime ownership](../../internal-docs/design/runtime.md) and [recovery](../agents-inference/models.md#diagnose-and-recover-a-stopped-runtime).

## Service Capacity

The optional `vllm_capacity` and `ollama_capacity` data sources observe capacity for one runtime's services on an engine.
Each takes an `engine` and `contracts`, the `spec` of each of that runtime's contract data sources on the engine, and rejects a contract listed twice or one for another runtime.
No data source combines services of different runtimes on one host.
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
This does not lock the image against concurrent removal before container creation; see the [policy limits](../build-deploy/usage.md#control-container-image-downloads).
See [image acquisition policies](../build-deploy/usage.md#control-container-image-downloads) for supported modes.
Plan does not pull images, and container creation does not establish application health or model compatibility.

Provider reconciliation checks the attributes refreshed by that provider; it does not guarantee detection of every out-of-band Docker configuration change.
The deployment lock excludes other NemoClaw operations using the same state directory, not concurrent Docker administrators.

## Managed Kubernetes Gateway

The runtime graph for a managed Kubernetes or OpenShift gateway declares four resources in this order:

1. `openshell_kubernetes_storage.runtime` binds the namespace by UID, creating it if it doesn't exist, and creates the encryption key; it retains both, with `prevent_destroy`.
2. `openshell_kubernetes_auth.runtime` prepares the development token issuer.
   For OpenShift, its computed `gateway_values` carries the namespace's UID and group ranges as chart overrides.
3. `helm_release.gateway` installs the pinned OpenShell chart into the prepared namespace without creating the namespace or taking ownership of existing objects.
4. `openshell_kubernetes_gateway.runtime` records the chart's StatefulSet identity and reports readiness in `running`.

The three NemoClaw resources take the same cluster target and identity:

- `name`: `nc-`, 16 lowercase hexadecimal characters, and `-gateway`.
- `compute_driver`: `kubernetes` or `openshift`.
- `endpoint`: the gateway's `https://127.0.0.1:PORT` loopback endpoint.
- Optional `kubeconfig_env`: the environment variable whose value is the kubeconfig file path. Omit it to use the service account of the pod that runs OpenTofu; the provider then finds the API server through `KUBERNETES_SERVICE_HOST` and `KUBERNETES_SERVICE_PORT`.
- Optional `context`: the exact kubeconfig context, set exactly when `kubeconfig_env` is.
- `namespace`: the namespace for the gateway.
- `authentication_profile`: `development`.
- Optional `environment`: the names of the environment variables the kubeconfig's exec credential plugin needs; it requires `kubeconfig_env`.
- Optional `owner` and `generation`, generated on create when omitted.

The three resources share one private receipt, keyed by `owner` and `name`, so give `openshell_kubernetes_auth` and `openshell_kubernetes_gateway` the storage's `owner`, for example `owner = openshell_kubernetes_storage.platform.owner`.
Generated graphs also give the authentication resource the gateway's `generation`.
Changing any of these settings after creation fails planning and leaves the resources unchanged.

Each NemoClaw resource has a postcondition requiring `running`, so an incomplete step stops apply until a later apply with the same state completes it.
The SDK requires each earlier binding before it accepts a later one.
The Helm provider receives only the authored kubeconfig path and context; without them, it receives neither, and its client uses the pod's service account.
Ambient Helm and Kubernetes settings are excluded.

Teardown removes the release before the issuer.
The authentication resource must confirm through `release_present` that the Helm release records are absent before it deletes the issuer.
The namespace, encryption key, and persistent volumes remain.
[Managed Kubernetes ownership](../../internal-docs/design/architecture.md#managed-kubernetes-ownership) explains recovery when Helm loses its release binding, and [Deploy to Kubernetes or OpenShift](../build-deploy/kubernetes.md) gives the procedure.

## Packaging and Qualification

Follow [bundle building](../build-deploy/build.md) for matched CLI, SDK contract, provider, schema, and OpenTofu versions.
The NemoClaw, OpenShell, and Fabric providers use the same source-derived version to prevent stale reuse.
The Docker and Helm providers have fixed release versions and checksum-pinned native archives, with their upstream licenses retained in the bundle.

[Schema snapshots](../../internal-docs/contributing/testing.md#provider-schema-snapshots) of the NemoClaw, OpenShell, and Fabric providers, [planning tests](../../crates/nemoclaw-provider/tests/planning.rs), and [refresh tests](../../crates/nemoclaw-provider/tests/refresh.rs) cover provider contracts.
[Fixture qualification](../../internal-docs/contributing/integration-tests.md) covers real OpenTofu protocol/lifecycle execution with explicit bundle inputs.

## Direct OpenTofu Usage

The providers are not published yet ([#12638](https://github.com/NVIDIA/NemoClaw/issues/12638)).
See [compatibility](compatibility.md) for the supported examples, import, adoption, state backends, and what each release guarantees.

Every resource and data source takes inputs that can be written in HCL.
[`examples/hcl/travel`](../../examples/hcl/travel/main.tf) is a complete hand-written configuration: a Pi agent in an OpenShell sandbox, answering with a local Ollama server placed with Docker, and allowed only HTTPS `GET` requests to one site.
An integration test applies it unchanged against the bundle's providers.
[`examples/hcl/travel-team`](../../examples/hcl/travel-team/README.md) scales the same pattern to a team of six agents with their own sandboxes, models, and grants.
Writing one by hand:

- Install the providers from a bundle: name its `providers` directory as a filesystem mirror, and pin each NVIDIA provider to the bundle's version. Development bundles carry pre-release versions, which OpenTofu selects only when pinned exactly.
- Place model servers with any platform from `vllm_runtime` or `ollama_runtime`'s [`launch` and `requirements`](#vllm-runtime-contract), confirm them with [endpoint readiness](#runtime-capacity-and-readiness), and register them with [`openshell_inference`](#inference-providers), passing the readiness read's `ref` as `server`.
- Inference registrations take any well-formed HTTP or HTTPS endpoint. OpenShell decides which destinations sandboxes may reach, including its gateway-host alias `host.openshell.internal`.
- Register web search with [`openshell_web_search`](#web-search), which owns its profile.
- Tear the configuration down with `tofu destroy` and the provider's `destroy = true`. To keep a workspace instead, add `lifecycle { prevent_destroy = true }` to it; OpenTofu then refuses to destroy it.
