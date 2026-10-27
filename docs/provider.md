<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Understand the OpenTofu Provider

The native bundle includes the NemoClaw, OpenShell, Fabric, Docker, and Helm OpenTofu providers.
The SDK compiles desired-state YAML into resource graphs and runs bundled OpenTofu.
OpenShell manages workspaces, provider registrations and profiles, and sandboxes through a gateway's API.
Fabric starts and stops the one agent runtime in each sandbox through Fabric's `fabric-agent-ctl`, through the same gateway.
Docker manages disposable service compute and Docker gateway processes; Helm installs the managed Kubernetes gateway chart; OpenShell installs Podman gateway processes, Kubernetes gateway prerequisites, initialization, and retained gateway bridges; NemoClaw manages durable data bindings for inference services.
Use [the SDK](sdk.md) or [CLI](reference/cli.md) for the documented deployment workflow.

## Resource and State Ownership

OpenTofu owns graph execution and resource state.
The SDK retains desired intent, validates plans, and reports provider observations.
The OpenShell, Fabric, vLLM, and Ollama providers verify durable data and credential identity; the Docker and Helm providers reconcile their native resource state.
The SDK refuses state that an earlier release wrote with the NemoClaw provider's OpenShell or Fabric types, before reading or changing it; keep that state directory and use the release that wrote it.

Before planning, the SDK checks configuration, locks state, and validates retained intent and local bindings.
OpenTofu refresh and provider planning perform environmental checks; the SDK does not run a separate environmental preflight.
The SDK then checks the saved plan against its deployment scope, retained bindings, and recovery rules before authorizing changes.
Docker gateway, inference, and proxy containers may be recreated or replaced while their independent storage bindings remain unchanged.
Podman gateways retain their stronger process identity checks.
OpenTofu selects their replacement without an SDK requirement that the desired process specification changed.
The compiled graph orders the gateway after protected storage; the SDK requires its independent storage binding, and the provider rechecks storage and process identity before replacement.
Docker gateway storage independently binds signing and encryption keys; its verified mountpoint supplies the process mount through OpenTofu.
Planning a new OpenShell object reaches no gateway, so the gateway and the objects it serves are planned together; refreshing an existing object needs its gateway running.

The generated graphs manage these objects and observations:

| Owner | Managed objects and observations |
|---|---|
| OpenShell provider | Workspace, provider registration, provider profile, and sandbox |
| OpenShell provider data source | Gateway version and compute drivers; managed Docker gateway readiness |
| Fabric provider | Fabric runtime configuration |
| Fabric provider data source | Fabric image capabilities and sandbox completion |
| OpenShell provider | Podman gateway process (`openshell_podman_gateway`); gateway storage, initialization, and retained bridge (`openshell_gateway_storage`) |
| vLLM provider | Retained vLLM credentials (`vllm_credential_storage`) |
| Ollama provider | Retained Ollama proxy credentials (`ollama_proxy_credential_storage`) |
| vLLM and Ollama provider data sources | Runtime contracts, service or proxy readiness, and the upstream model digest behind an Ollama proxy (`ollama_model`) |
| OpenShell provider | Kubernetes namespace and encryption key (`openshell_kubernetes_storage`), development issuer (`openshell_kubernetes_auth`), and gateway readiness (`openshell_kubernetes_gateway`) |
| Host provider data source | Engine facts and advertised hardware (`host_engine`) |
| Host provider data source | Managed vLLM and Ollama image platform and labels (`host_image`) |
| Host provider data source | Application container health (`host_container_health`) |
| Docker provider | Docker gateway, inference, proxy, and application containers; model-cache and application volumes, service-owned networks and acquired images |
| Docker provider data source | Local images selected with `imagePullPolicy: Never` |
| Helm provider | The managed Kubernetes gateway's OpenShell chart release (`helm_release.gateway`) |

Every provider type has a [lifecycle test](contributing/integration-tests.md) that plans hand-written HCL through pinned OpenTofu without SDK orchestration.
These tests do not qualify a complete standalone deployment workflow.
Do not edit SDK-generated graphs or share a deployment state directory between independently managed workflows.

### Gateway Profile Format Upgrade

The OpenShell 0.1.3 integration stores provider-profile metadata in separate annotations.
Gateway profiles created by earlier bundles used one `nemoclaw.nvidia.com/profile-v1` annotation; the current provider cannot read that format and reports an identity mismatch during plan, apply, or destroy.
There is no automatic migration.
This gateway-side format break is separate from the provider-type change described above.

## Provider Catalog

The bundle pins these providers:

| Provider | Source address | Version |
|---|---|---|
| OpenShell | `registry.opentofu.org/nvidia/openshell` | Source-derived, matching the bundle |
| Fabric | `registry.opentofu.org/nvidia/fabric` | Source-derived, matching the bundle |
| vLLM | `registry.opentofu.org/nvidia/vllm` | Source-derived, matching the bundle |
| Ollama | `registry.opentofu.org/nvidia/ollama` | Source-derived, matching the bundle |
| Host | `registry.opentofu.org/nvidia/host` | Source-derived, matching the bundle |
| Docker | `registry.opentofu.org/kreuzwerker/docker` | 4.6.0 |
| Helm | `registry.opentofu.org/hashicorp/helm` | 3.3.0 |

None of them exposes ephemeral resources or provider functions.

### OpenShell Resources and Data Sources

| Type | Manages or observes |
|---|---|
| `openshell_workspace` | Workspace |
| `openshell_inference` | [An inference server's provider and its profile](#inference-providers) |
| `openshell_web_search` | [A web search provider and its profile](#web-search) |
| `openshell_api` | [Credentials for another API and its profile](#api-credentials) |
| `openshell_sandbox` | Sandbox |
| `openshell_gateway` data source | [Gateway version and compute drivers](#gateway-capabilities) |

The `openshell` provider takes only `destroy`, which permits deleting sandboxes and workspaces during explicit teardown.
Each object names the gateway that holds it with `gateway`, the `ref` of `data.openshell_gateway`.
That data source takes the gateway `endpoint`, the `credential_env` variable holding its bearer credential, and the `tls_ca_env`, `tls_certificate_env`, and `tls_key_env` variables naming mutual TLS files; its `ref` carries those names, never their values.
For a managed Kubernetes gateway, it takes `kubernetes`, the gateway's specification, instead of the credential and TLS variables.
Each provider that reaches such a gateway opens its own port forward on a free loopback port, with the kubeconfig the specification names and the development credentials in the SDK's state directory, and keeps it open while OpenTofu runs.
A literal object of the same shape, with `type = "openshell_gateway"`, also works where no data source is read, such as an SDK teardown graph.
Objects keep their gateway connection in state, so refresh and removal reach the same gateway without provider configuration.
Credential and TLS references update in place; a different endpoint is a different gateway, so it replaces reconstructible objects, sandboxes included, and the retained workspace refuses it.
These schemas are version 1; state from an earlier provider is rejected rather than upgraded.
When a registration names a managed vLLM or Ollama proxy credential, the provider reads the key from the owning container during apply, so the key never enters OpenTofu state.

Each OpenShell resource exports a computed `ref` object identifying it: its `type`, `name`, `owner`, `generation`, and `id`, plus `workspace` for objects inside a workspace.
Objects name each other by `ref`, never by separate name strings:

- Inference, web search, API credential resources and sandboxes take `workspace = openshell_workspace.<label>.ref`.
- A sandbox takes `providers`, a list of registration refs.

A consumer checks the ref's `type` and rejects a ref of another type.
It keeps only the ref attributes it uses, so a ref can be fully known during planning before the referenced object's ID exists.
Changing a referenced object's name or replacing it replaces its consumers, subject to the replacement protections below.
These schemas are version 1; state recorded by an earlier provider schema is rejected rather than upgraded.

Other inputs are typed too:

- `openshell_sandbox` takes a `policy` block.
  The block's attributes and blocks follow the sandbox policy model with snake_case names: an optional `explicit` policy, whose named network rules are labeled blocks, and `managed` deployment grants, a list of blocks with unique `name`s.
  Because grants are unlabeled, a `dynamic "managed"` block can generate them in a sandbox that uses `for_each`; OpenTofu requires the labels of dynamic blocks to be known when it validates, before `each.key` is.
  A matcher that is either a glob or alternatives sets `value` for the glob, or `any` for the alternatives.
- `openshell_sandbox`'s `providers` takes the `ref` of a registration, of type `openshell_provider`, from `openshell_inference`, `openshell_web_search` or `openshell_api`. Each ref names the OpenShell registration it attaches in `registration`.
- `launch_json` is a JSON-encoded launch: the command, environment, and metadata to start the sandbox, the policy used when no explicit policy is authored, and the executables managed endpoint grants allow.
  OpenShell merges that policy with the authored `policy` block and managed grants, and records the launch with the sandbox; it does not depend on the agent runtime that produced the launch.
  `fabric_harnesses` returns `launch_json` for its configured agent, and Fabric reads its agent name and runtime binding back from the launch metadata.
- `openshell_sandbox`'s optional `driver_config` is OpenShell's per-driver sandbox configuration (`SandboxTemplate.driver_config`) as JSON text, usually from `jsonencode()`, keyed by driver, such as volume mounts.
  It is passed through unchanged, so OpenShell's defaults apply; see OpenShell's [driver configuration and mounts](https://github.com/NVIDIA/OpenShell/blob/bdb956f2cd65a635f1294fccf1d138d263bf650f/docs/how-it-works/sandboxes/runtimes.mdx).
  The gateway accepts it only when its driver allows driver configuration, which OpenShell disables by default, NemoClaw-installed gateways included.
  It is part of the sandbox's immutable specification: changing it, or a different configuration observed on the gateway, replaces the sandbox, as for the image; see [change paths](usage.md#choose-the-change-path).
- `openshell_sandbox`'s optional `service` blocks are OpenShell's sandbox service exposures: `name`, `target_port`, and optional `authorization_mode` (`STRIP` or `BEARER_PASSTHROUGH`).
  They are passed through unchanged in the creation request, so OpenShell's defaults apply: an omitted mode is `STRIP`, and an empty name is the unnamed endpoint.
  Like `driver_config`, they are part of the sandbox's creation: changing them, or a different endpoint observed on the gateway, replaces the sandbox.
- The computed `policy_hash` is the hash OpenShell reports for the sandbox's loaded policy, including paths OpenShell adds itself. It's recorded when the policy first loads with every declared rule intact; a different hash later is drift.
- The computed `service_urls` maps each service name to the URL the gateway reports for it, such as `openshell_sandbox.researcher.service_urls["research"]`. A service the gateway reports without a URL has no entry.
- `owner` and `generation` are optional; when omitted, the provider generates them during apply and keeps them in state, with the lost-reply limit described for [credential storage](#vllm-and-ollama-types).

```hcl
resource "openshell_sandbox" "assistant" {
  gateway      = data.openshell_gateway.current.ref
  workspace    = openshell_workspace.example.ref
  name         = "assistant"
  image        = var.image
  launch_json  = data.fabric_harnesses.assistant.launch_json
  providers    = [openshell_inference.local.ref]
  service {
    name        = "research"
    target_port = 8080
  }
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

#### Inference Providers

`openshell_inference` registers an inference server with OpenShell, together with the provider profile sandboxes use to reach it.
It takes:

- `workspace`, a workspace `ref`. The objects belong to the workspace's owner, so the resource takes no `owner`.
- `name`, the registration's name. The profile is named `nemoclaw-inference-<name>`.
- `server`, an `inference_server` object: the `ref` of a readiness read (`vllm_readiness`, `ollama_readiness`, or `ollama_proxy_readiness`), or, for a server NemoClaw doesn't run, a literal object with the same fields. It supplies the endpoint and the variable or source of the credential. The provider reads a key during apply, so the key never enters OpenTofu state.
- `api`: `openai-completions`, `openai-responses`, or `anthropic-messages`.
- `binaries`, the executables allowed to call the server.
- Optional `cluster_source`, which the profile uses to resolve the server's cluster addresses.

Plans reject a missing `server` or `binaries`; the schema lists them as optional for the same reason as web search's inputs.
A rotated credential reference updates the registration in place. Adding or removing authentication, or any other change, replaces the resource, and removal deletes both objects.
A sandbox that attaches it also needs a policy that allows traffic to the server's endpoint.
Its `ref` has type `openshell_provider`, so sandboxes take it in `providers`.
Generated graphs register each selected inference provider this way, passing a literal `inference_server` object built from the provider definition. Reading servers instead depends on one OpenTofu root ([#13254](https://github.com/NVIDIA/NemoClaw/issues/13254)) and on checking external servers ([#13256](https://github.com/NVIDIA/NemoClaw/issues/13256)).

```hcl
resource "openshell_inference" "nemotron" {
  gateway   = data.openshell_gateway.current.ref
  workspace = openshell_workspace.example.ref
  name      = "nemotron"
  server    = data.ollama_readiness.nemotron.ref
  api       = "openai-completions"
  binaries  = ["/usr/local/bin/pi"]
}
```

#### API Credentials

Use `openshell_api` when a sandbox needs to authenticate to an API other than inference or web search, such as a booking service over HTTP MCP.
It owns an OpenShell profile and registration; attach its `ref` to the sandbox's `providers`.
The profile binds credential injection to the endpoint's host, port and path subtree, and the named executables.
OpenShell owns injection and destination checks when the sandbox connects.

Set the credential in the environment of the process running OpenTofu, then name that variable in `credential_env`:

```hcl
resource "openshell_api" "booking" {
  gateway        = data.openshell_gateway.example.ref
  workspace      = openshell_workspace.example.ref
  name           = "booking"
  endpoint       = "https://booking.example.com/mcp"
  credential_env = "BOOKING_API_KEY"
  binaries       = ["/usr/bin/curl"]
}

# In openshell_sandbox.buyer:
# providers = [openshell_api.booking.ref]
```

`auth_style` defaults to `bearer`, using `Authorization` unless `header_name` overrides it.
For an API key sent without the Bearer prefix, set `auth_style = "header"` and `header_name = "X-API-Key"`.
Query parameters, OAuth and refresh flows are not supported by this resource.
Endpoints must use HTTP(S) without embedded credentials, queries, fragments or globs.
For `/mcp`, the profile allows `/mcp` and its descendants, not sibling paths.
A literal IP grants only that address; a DNS name receives no private-network grant.
`binaries` must list the absolute paths of the callers allowed to use the credential.

The provider resolves the host variable during apply and sends its value to OpenShell's credential store.
OpenTofu state and the exported `ref` contain the variable name, never its value.
OpenShell projects a credential placeholder into `NEMOCLAW_API_BOOKING_KEY` for `name = "booking"`; the agent does not receive the stored credential value.
The registration is named `booking` and its profile `nemoclaw-api-booking`.

Changing `credential_env` updates the stored credential in place on the next apply, retaining the registration and attached sandbox.
Changing only the value of the same host variable does not create a plan change; use a new variable reference to rotate it.
Credential propagation to an already-running client has not been qualified.
An unchanged plan reads the binding without resolving the host secret.
A missing profile is recreated in place; a missing registration replaces the reconstructible pair without replacing its sandbox.
Foreign ownership or an incomplete observation stops planning.

To remove the credential, first detach or explicitly remove sandboxes using its registration, then remove the API resource and apply.
Removal deletes the registration and its owned profile; it does not unset the host variable or revoke the key at the API service.
Endpoint, authentication and executable changes replace the pair, so detach consumers before making those changes.

#### Web Search

`openshell_web_search` registers a Brave or Tavily search provider with OpenShell, together with the provider profile it uses.
It takes:

- `workspace`, a workspace `ref`. The search objects belong to the workspace's owner, so the resource takes no `owner`.
- `name`, which scopes the objects it owns. Their OpenShell names derive from it, the provider, and `credential_env`.
- `provider_type`, `brave` or `tavily`. Each has a fixed endpoint.
- `credential_env`, the variable holding the search API key. The provider reads it during apply, so the key never enters OpenTofu state.
- `binaries`, the executables allowed to call the search API.

Plans reject a missing `credential_env` or `binaries`.
The schema lists both as optional so that when one of the two OpenShell objects disappears, the next plan shows drift and replaces the resource.
Any change to an input also replaces it, and removal deletes both objects.
Its `ref` has the same `openshell_provider` type as a registration's, so sandboxes take it in `providers`.

```hcl
resource "openshell_web_search" "brave" {
  gateway        = data.openshell_gateway.current.ref
  workspace      = openshell_workspace.example.ref
  name           = "assistant"
  provider_type  = "brave"
  credential_env = "BRAVE_API_KEY"
  binaries       = ["/usr/bin/curl"]
}
```

### OpenShell Gateway Installation

The `openshell` provider also installs gateways.
These types name the engine or cluster they use instead of taking a gateway `ref`, and the provider's `destroy` setting permits deleting gateways during explicit teardown.

| Type | Manages or observes |
|---|---|
| `openshell_podman_gateway` | Podman gateway process |
| `openshell_gateway_storage` | Gateway storage, initialization, and retained bridge |
| `openshell_kubernetes_storage` | Kubernetes namespace and encryption key |
| `openshell_kubernetes_auth` | Kubernetes development token issuer and OpenShift chart overrides |
| `openshell_kubernetes_gateway` | Kubernetes gateway StatefulSet identity and readiness |
| `openshell_docker_gateway_readiness` data source | [Managed Docker gateway process and health](#gateway-capabilities) |
| `openshell_docker_gateway_runtime` data source | Nothing; [computes a Docker gateway's launch](#docker-gateway-launch) |
| `openshell_gateway_prerequisites` data source | [Whether an engine can host a managed gateway](#engine-and-fabric-discovery) |

`openshell_gateway_storage` and `openshell_podman_gateway` take the gateway's `name`, `compute_driver` (`docker` or `podman`), `engine`, `image`, and `network_cidr`, optional `owner` and `generation`, generated during apply when omitted and kept in state, and optional `image_pull_policy`:

- `name` is `nc-`, 16 lowercase hexadecimal characters, a hyphen, and a lowercase name.
- `engine` is a local Unix engine socket; Podman requires its API service socket.
- `image` must be the bundle's gateway image pin, which generated graphs supply; documents do not name it.
- `network_cidr` is a private IPv4 `/24`.

`openshell_podman_gateway` also requires the gateway `endpoint`, an HTTP origin with an unprivileged loopback port.
`openshell_gateway_storage` requires `endpoint` for Podman and rejects it for Docker, whose gateway data does not depend on the listen port; it returns the volume's `data_path`.
The storage volume, bridge network, and initialization labels derive from `name`, `owner`, and the other settings, so changing any of them requires new storage.

### Fabric Resource and Data Source

| Type | Manages or observes |
|---|---|
| `fabric_agent` | The [agent a sandbox launches](#fabric-agents) and its Fabric configuration |
| `fabric_harnesses` data source | [Fabric image catalog and compatibility](#engine-and-fabric-discovery) |
| `fabric_harness` data source | One harness in an image, selected by `adapter_id`: the `launch_json` that starts it for `agent_name`, and a `ref` naming the harness (`type`, `adapter_id`, `image`, and `catalog_json`, the image catalog's records for the adapter); fails when the image installs no runtime for the adapter |

The `fabric` provider also takes only `destroy`; `fabric_agent` takes the same `gateway` ref as the sandbox it starts.
It also accepts `destroy`, but no Fabric type requires it: removing an agent stops it and leaves its sandbox.
It runs Fabric's `fabric-agent-ctl` in each sandbox through the gateway; `fabric_harnesses` instead reads the container engine named on it.

#### Fabric Agents

`fabric_agent` starts the agent in a sandbox, through the `fabric-agent-ctl serve` process the sandbox runs.
It takes the sandbox as `sandbox = openshell_sandbox.<name>.ref`, the harness that sandbox launches as `harness = data.fabric_harness.<name>.ref`, and `gateway`.
`name` is the agent's name, Fabric's `metadata.name`, and optional `description` is `metadata.description`.
`settings` is the harness's `harness.settings`.
Every section of Fabric's agent configuration is an input with Fabric's name: `instructions`, `models`, `runtime`, `tools`, `skills`, `mcp`, `workflow`, `environment`, `discovery`, `relay`, and `telemetry`.
Their types come from Fabric's published configuration schema, with snake_case names.
Named objects, such as model roles, are labeled blocks: `models "default" { ... }`.
A value Fabric leaves open, such as `settings`, is JSON text; write it with `jsonencode`.
Fields an object accepts beyond those Fabric's schema declares, such as one an adapter documents for its models, go in that object's `extensions` attribute, also as JSON text.
Fabric requires a `runtime` section, so omitting `runtime` sends an empty one.

```hcl
resource "fabric_agent" "travel" {
  gateway = data.openshell_gateway.current.ref
  sandbox = openshell_sandbox.travel.ref
  harness = data.fabric_harness.pi.ref
  name    = "travel"

  instructions {
    system {
      content = file("instructions/travel.md")
      mode    = "replace"
    }
  }

  models "default" {
    provider    = "openai"
    model       = "nemotron"
    base_url    = "https://inference.local/v1"
    api_key_env = "NEMOCLAW_ANONYMOUS_API_KEY"
  }
}
```

Planning rejects a configuration Fabric cannot parse, naming the field but not its value.
Whether the harness accepts a configuration is Fabric's to decide, inside the sandbox when the agent starts: Pi, for example, replaces system instructions and cannot append to them, so asking it to append fails during apply ([#13319](https://github.com/NVIDIA/NemoClaw/issues/13319)).
Once the sandbox is known, planning refuses a `name` or harness other than the agent and harness the sandbox launches.
Any change replaces the agent, and a changed agent needs a new sandbox, so planning refuses to replace an agent while its sandbox stays the same.
Replace the sandbox with the agent through a `terraform_data` holding the agent's configuration, as generated graphs do:

```hcl
resource "terraform_data" "assistant" {
  input = { model = var.model, instructions = var.instructions }
}

resource "openshell_sandbox" "assistant" {
  # ...
  lifecycle {
    replace_triggered_by = [terraform_data.assistant]
  }
}
```

Triggering on the `fabric_agent` itself would be a cycle, because the agent refers to its sandbox.
Keep the input to values known while planning: a value known only during apply, such as a read postponed to apply, replaces the sandbox on every apply.
Replacing a sandbox deletes its files and conversation history; keep data that must survive on a [mounted volume](agents.md#skills-on-a-mounted-volume).

After a start fails with uncertain effects, creating the agent in that sandbox again fails with guidance to replace the sandbox: `tofu apply -replace=openshell_sandbox.<name>`.
After a start loses its reply, replace the sandbox the same way before creating the agent again: Fabric would start a second runtime beside one the lost start may have left ([NVIDIA/NeMo-Fabric#487](https://github.com/NVIDIA/NeMo-Fabric/issues/487)).
Creating an agent again after removing it starts a new runtime in the same sandbox.
Generated graphs need no such step: when a plan would create an agent in a sandbox that already exists, the SDK plans again with that sandbox replaced, and the plan shows it.

Starting an agent waits for its sandbox to be ready and for `fabric-agent-ctl serve` to answer.
An explicit `Rejected` OpenShell configuration admission stops the wait even while the sandbox is `Starting`.
The diagnostic names the sandbox and includes only recognized gateway reasons; unknown backend text becomes a fixed repair message.
See [runtime policy rejection recovery](sandbox-network.md#recover-from-runtime-policy-rejection).

Fabric reports neither the configuration a runtime applied nor whether it is still running ([NVIDIA/NeMo-Fabric#420](https://github.com/NVIDIA/NeMo-Fabric/issues/420)).
So refresh checks only the sandbox: a configuration changed inside the sandbox outside OpenTofu is not reported as drift, and a runtime that stops is found when it is next invoked.
Removing the resource stops the agent through `fabric-agent-ctl stop`, as removing an attachment does, and the sandbox stays.
A runtime that already stopped, or a sandbox already gone, counts as removed; if stopping fails, the binding is kept so the next apply or destroy retries.

`fabric_agent` exports `runtime_id`, the ID Fabric gave the runtime, for invoking it with `fabric-agent-ctl invoke --runtime-id`.
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

The shared [resource lifecycle contract](../crates/nemoclaw-openshell/src/lifecycle.rs) distinguishes reconstructible objects, sandboxes included, from retained workspace identity.
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
Endpoint and policy changes that also change a sandbox's launch specification replace the sandbox; see [change paths](usage.md#choose-the-change-path).

The provider's `destroy` setting authorizes explicit teardown of workspaces; reconstructible objects, sandboxes included, do not require it.
It never authorizes deleting the workspace or bypassing identity checks.
Removing Fabric configuration stops the agent and leaves the sandbox-owned runtime host and its sandbox in place.
The SDK's destroy operation retains durable storage and deletes the workspace with the rest of the deployment's objects.
See [deletion and retention](state.md#deletion-and-retention) before removing workloads.

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
See [SDK discovery](sdk.md#discover-before-authoring-or-planning) and [onboarding target checks](../crates/nemoclaw-onboarding/README.md#target-checks).

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

[OpenShell contract tests](../crates/openshell-provider/tests/contract) exercise the production provider and pinned OpenTofu without SDK orchestration: early planning errors, saved-plan drift, unchanged apply, failed observation, recovery, and teardown.
[Deployment fixtures](../crates/nemoclaw-e2e/tests/deployment.rs) and [Fabric lifecycle fixtures](../crates/nemoclaw-e2e/tests/fabric_deployment.rs) verify that the SDK uses the same apply-time protection.
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

- `launch` has `entrypoint`, `command`, `environment` (only `NEMOCLAW_RUNTIME_SPEC`, holding `spec`), the `port` the server listens on, the `data_path` for its model cache, and `key_env`: with `authentication`, the variable a platform sets to [supply the server's API key](inference.md#supply-the-key-on-other-platforms), otherwise empty.
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
See [container limits and update policy](inference.md#set-container-limits-and-update-policy) for common fields and platform constraints.

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
See [retained sources and compatibility](build.md#retained-sources-and-compatibility) for rebuilding a mismatched image.

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

The [standalone readiness fixture](contributing/integration-tests.md#standalone-service-readiness) exercises this contract without SDK deployment orchestration.
A failed read retains managed bindings, and SDK teardown omits readiness gates.
See [runtime ownership](design/runtime.md) and [recovery](models.md#diagnose-and-recover-a-stopped-runtime).

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
This does not lock the image against concurrent removal before container creation; see the [policy limits](usage.md#control-container-image-downloads).
See [image acquisition policies](usage.md#control-container-image-downloads) for supported modes.
Plan does not pull images, and container creation does not establish application health or model compatibility.

Provider reconciliation checks the attributes refreshed by that provider; it does not guarantee detection of every out-of-band Docker configuration change.
The deployment lock excludes other NemoClaw operations using the same state directory, not concurrent Docker administrators.

## Managed Kubernetes Gateway

The runtime graph for a managed Kubernetes or OpenShift gateway declares four resources in this order:

1. `openshell_kubernetes_storage.runtime` creates and retains the namespace and encryption key, with `prevent_destroy`.
2. `openshell_kubernetes_auth.runtime` prepares the development token issuer.
   For OpenShift, its computed `gateway_values` carries the namespace's UID and group ranges as chart overrides.
3. `helm_release.gateway` installs the pinned OpenShell chart into the prepared namespace without creating the namespace or taking ownership of existing objects.
4. `openshell_kubernetes_gateway.runtime` records the chart's StatefulSet identity and reports readiness in `running`.

The three NemoClaw resources take the same cluster target and identity:

- `name`: `nc-`, 16 lowercase hexadecimal characters, and `-gateway`.
- `compute_driver`: `kubernetes` or `openshift`.
- `endpoint`: the gateway's `https://127.0.0.1:PORT` loopback endpoint.
- `kubeconfig_env`: the environment variable whose value is the kubeconfig file path.
- `context` and `namespace`: the exact kubeconfig context and the namespace for the gateway.
- `authentication_profile`: `development`.
- Optional `environment`: the names of the environment variables the kubeconfig's exec credential plugin needs.
- Optional `owner` and `generation`, generated on create when omitted.

The three resources share one private receipt, keyed by `owner` and `name`, so give `openshell_kubernetes_auth` and `openshell_kubernetes_gateway` the storage's `owner`, for example `owner = openshell_kubernetes_storage.platform.owner`.
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

[Schema snapshots](contributing/testing.md#provider-schema-snapshots) of the NemoClaw, OpenShell, and Fabric providers, [planning tests](../crates/nemoclaw-provider/tests/planning.rs), and [refresh tests](../crates/nemoclaw-provider/tests/refresh.rs) cover provider contracts.
[Fixture qualification](contributing/integration-tests.md) covers real OpenTofu protocol/lifecycle execution with explicit bundle inputs.

## Direct OpenTofu Usage

The providers are not published yet ([#12638](https://github.com/NVIDIA/NemoClaw/issues/12638)).
See [compatibility](compatibility.md) for the supported examples, import, adoption, state backends, and what each release guarantees.

Every resource and data source takes inputs that can be written in HCL.
[`examples/hcl/travel`](../examples/hcl/travel/main.tf) is a complete hand-written configuration: a Pi agent in an OpenShell sandbox, answering with a local Ollama server placed with Docker, and allowed only HTTPS `GET` requests to one site.
A system test applies it unchanged against the bundle's providers.
[`examples/hcl/travel-team`](../examples/hcl/travel-team/README.md) scales the same pattern to a team of six agents with their own sandboxes, models, and grants.
Writing one by hand:

- Install the providers from a bundle: name its `providers` directory as a filesystem mirror, and pin each NVIDIA provider to the bundle's version. Development bundles carry pre-release versions, which OpenTofu selects only when pinned exactly.
- Place model servers with any platform from `vllm_runtime` or `ollama_runtime`'s [`launch` and `requirements`](#vllm-runtime-contract), confirm them with [endpoint readiness](#runtime-capacity-and-readiness), and register them with [`openshell_inference`](#inference-providers), passing the readiness read's `ref` as `server`.
- Inference registrations take any well-formed HTTP or HTTPS endpoint. OpenShell decides which destinations sandboxes may reach, including its gateway-host alias `host.openshell.internal`.
- Register web search with [`openshell_web_search`](#web-search), which owns its profile.
- Tear the configuration down with `tofu destroy` and the provider's `destroy = true`. To keep a workspace instead, add `lifecycle { prevent_destroy = true }` to it; OpenTofu then refuses to destroy it.
