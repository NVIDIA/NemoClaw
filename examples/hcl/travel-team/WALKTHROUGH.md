<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Travel Team Walkthrough

This walks through the travel team's HCL file by file, in the order OpenTofu wires it together: the root, then its `inference`, `gateway`, and `agents` modules.
Each excerpt is followed by what it does and why.
[README.md](README.md) covers running and using the team.

## `versions.tf`: Providers

```hcl
required_providers {
  docker    = { source = "registry.opentofu.org/kreuzwerker/docker", version = "4.7.0" }
  ollama    = { source = "registry.opentofu.org/nvidia/ollama" }
  openshell = { source = "registry.opentofu.org/nvidia/openshell" }
  fabric    = { source = "registry.opentofu.org/nvidia/fabric" }
}
```

Each provider owns one part of the team:

- **Docker** runs the local model server.
- **Ollama** describes how to run that server, and checks that it's ready.
- **OpenShell** holds the workspace, sandboxes, and registered credentials.
- **Fabric** runs an agent in each sandbox.

Pin the NVIDIA providers to your bundle's version before running `tofu init`.
Each module names the providers it uses by source alone, and uses the versions and provider settings here, so the pins live in one place.

```hcl
provider "openshell" {
  destroy = var.destroy
}
```

The NVIDIA providers delete the objects they own only when `destroy` is `true`, so a plain `tofu destroy` fails.
To tear the team down, run `tofu destroy -var destroy=true`.

## `main.tf`: The Team and Its Layers

```hcl
roles = merge(
  { for topic in keys(local.researchers) : topic => { harness = "hermes", model = "local", search = true } },
  {
    scheduler = { harness = "hermes", model = "frontier", search = false }
    buyer     = { harness = "hermes", model = "frontier", search = false }
  },
)
```

This table describes the team.
Grants, registrations, sandboxes, and agents are all derived from it, so adding a researcher means adding one entry to `local.researchers`.
Every role runs Hermes.

```hcl
binaries = jsondecode(harness.launch_json).binaries
```

`data.fabric_harness.agent` reads each role's harness from its image.
Each role's executables come from its harness, so grants and registrations follow when an image changes.
The root reads the harness because two layers need it: the gateway's registrations allow its executables, and the agents' sandboxes launch it.

```hcl
module "gateway" {
  source = "./modules/gateway"

  endpoint        = var.gateway_endpoint
  workspace       = var.workspace
  local_server    = module.inference.local_server
  frontier_server = module.inference.frontier_server
```

The root calls one module per layer, and values flow one way through their typed inputs and outputs.
The `inference` module describes each model's server, the `gateway` module registers those servers, and the `agents` module attaches the registrations to sandboxes.
To place a layer differently, for example to run the model on Kubernetes, change that module and keep its inputs and outputs.

## `modules/inference`: Models

```hcl
data "ollama_runtime" "local" {
  hardware {
    profile = var.hardware_profile
  }
  memory {
    gpu_memory_gib = var.model_memory_gib
  }
```

This read contacts no machine.
For the hardware profile, a memory budget, and a model pinned by digest, it returns how to run Ollama, as `launch` (entrypoint, command, environment, data path, and port) and `requirements` (shared memory, GPUs, and ulimits).

```hcl
max_sequences = min(var.local_model_agents, 2)
```

The researchers share the model and work at the same time, so the server serves two of them at once, the most NemoClaw's Ollama runtime allows.
The root passes the number of researchers as `local_model_agents`.

```hcl
resource "docker_container" "ollama" {
  name       = "travel-team-ollama"
  image      = var.ollama_image
  entrypoint = local.ollama_launch.entrypoint
  command    = local.ollama_launch.command
  env        = [for name, value in local.ollama_launch.environment : "${name}=${value}"]
```

OpenTofu's Docker provider runs the container from that launch.
To run the server on Kubernetes, Podman, or another platform, replace this resource with that platform's own and use the same `launch` and `requirements`.
The container publishes its port on `model_bind_address` only, and keeps models on `docker_volume.models`, so replacing it doesn't download them again.

```hcl
data "ollama_readiness" "local" {
  contract         = data.ollama_runtime.local.spec
  endpoint         = var.model_endpoint
  sandbox_endpoint = local.sandbox_endpoint
  read_trigger     = docker_container.ollama.id != ""
}
```

The read asks the server at `endpoint`, the address this machine uses, for its models, and is ready once the pinned model is listed.
Because `read_trigger` depends on the container, a fresh install reads it during apply, after the container starts.

```hcl
output "local_server" {
  description = "The local model's server, at the address sandboxes use, without a credential."
  value = {
    type              = "inference_server"
    endpoint          = local.sandbox_endpoint
    credential_env    = ""
    credential_source = ""
  }
  depends_on = [data.ollama_readiness.local]
}
```

The local model's registration takes this literal server rather than the readiness read's `ref`.
The read reports its values only during apply when the server changes, and a registration whose server is unknown when planning would be replaced, which OpenShell refuses while sandboxes attach it.
The output depends on the read instead, so whatever takes it waits for the model to be ready.
`frontier_server` describes the hosted model the same way: NemoClaw doesn't run it, so nothing checks it, and `credential_env` names the variable that holds its key.
`models` gives the agents each model's name and the base URL sandboxes reach it at.

## `modules/gateway`: Workspace and Credentials

```hcl
data "openshell_gateway" "current" {
  endpoint                 = var.endpoint
  required_compute_drivers = ["docker"]
}
```

The team runs on an existing gateway; this checks that it's reachable and runs the Docker driver, which the skills volume's `driver_config` targets.
Every OpenShell and Fabric object takes its `ref`, which the module outputs as `gateway`.

```hcl
resource "openshell_inference" "local" {
  gateway   = local.gateway
  workspace = openshell_workspace.team.ref
  name      = "local"
  # Depends on the model's readiness read, so this is registered once the
  # model is ready.
  server   = var.local_server
  api      = "openai-completions"
  binaries = var.binaries.local
}
```

This registers the local model once it's ready, because `local_server` waits for the readiness read; the sandboxes that attach it, and their agents, wait for it too.
`binaries` limits the registration to the executables of the harnesses that use the local model.
`openshell_inference.frontier` registers the hosted model the same way, without waiting for the local model. During apply, NemoClaw's OpenTofu provider reads the key from the environment variable named in `credential_env` and sends it to OpenShell. The key stays out of OpenTofu state.

```hcl
sandbox_env = var.search.provider == "brave" ? "BRAVE_SEARCH_API_KEY" : null
```

One web search registration, which only researchers attach.
Inside a sandbox, an agent finds a provider's key in a variable OpenShell sets; Hermes's Brave plugin reads `BRAVE_SEARCH_API_KEY`, so the registration names that variable instead of the default `BRAVE_API_KEY`.

The buyer alone attaches `openshell_api.bookings`.
The registration holds the credential. Its profile carries the `mcp` block's rules for setup, tool listing, and calls to `var.bookings.tools`.
This rule permits the `get_quote` tool.

```hcl
mcp {
  rules {
    allow {
      method = "tools/call"
      tool {
        value = "get_quote"
      }
    }
  }
}
```

OpenShell enforces these rules on the credentialed endpoint. The buyer's sandbox policy adds no separate grant for that destination.

The module outputs the workspace's ref, each registration's ref in `registrations`, the variable sandboxes find the hosted model's key in as `frontier_key_env`, and the booking rules, which join the buyer's configuration.

## `modules/agents`: Sandboxes and Agents

```hcl
instructions = {
  for role, text in merge(
```

Instructions are Markdown templates in `instructions/` with the JSON Schemas of each hand-off from `schemas/` embedded, so a researcher's reply schema is also the scheduler's input schema.

```hcl
provider    = "custom"
model       = var.models.local.name
```

Hermes's `custom` profile is for OpenAI-compatible servers.
It sends the `reasoning_effort` that turns a model's reasoning off, which Fabric's Hermes adapter asks for by default; Ollama and NVIDIA's API both honor it.
With reasoning on, Nemotron spends its output budget reasoning and misses Fabric's invocation deadline.
The hosted model uses the same profile, and its `api_key_env` is the gateway's `frontier_key_env`, the variable sandboxes see its key in.

```hcl
tools = settings.search ? ["web"] : role == "scheduler" ? ["delegation"] : ["bookings"]
```

Hermes enables exactly the toolsets listed, and all of its defaults, terminal and code execution included, without a list.
Researchers only search, the scheduler only delegates its feasibility review, and the buyer only uses the booking service's MCP toolset.

- **Behavior:** researchers run at temperature 0.2 with 16 turns and 2048 output tokens, the scheduler at 0.3 with 12 turns, and the buyer at 0 with 24 turns.
- **Instructions:** researchers search once or twice per stop and keep only options whose price they found; the scheduler delegates one review; the buyer quotes every option before booking any.

```hcl
for host in lookup(var.research_sources, role, []) : "${role}-${replace(host, ".", "-")}" => host
```

`local.grants` names the research sources for each role. Each researcher gets `GET` access to its own sources over HTTPS. The scheduler and buyer use their attached providers.

```hcl
resource "terraform_data" "agent_config" {
  for_each = local.agent_configs
  input    = jsonencode(each.value)
}
```

This holds each agent's configuration, so the sandbox can be replaced when it changes.

```hcl
providers = concat(
  [var.registrations[each.value.model]],
  each.value.search ? [var.registrations.search] : [],
  each.key == "buyer" ? [var.registrations.bookings] : [],
)
```

Each sandbox runs its harness's launch, Fabric's `fabric-agent-ctl serve`, and attaches exactly one model registration, plus web search for researchers and the booking service's key for the buyer.
Researchers also mount the optional skills volume through `driver_config`, which OpenShell receives unchanged, with its own defaults.

```hcl
policy {
  dynamic "managed" {
    for_each = local.grants[each.key]
    content {
      name = managed.key
```

Grants are unlabeled `managed` blocks, each with a `name`.
A `dynamic` block can't take labels from `each.key`, because OpenTofu doesn't know `each.key` yet when it validates the configuration.

```hcl
lifecycle {
  replace_triggered_by = [terraform_data.agent_config[each.key]]
}
```

Fabric starts one agent per sandbox, so changing an agent's configuration replaces its sandbox.
Without this trigger, `fabric_agent` refuses to change in a sandbox that stays.
Replacing a sandbox deletes its files, except those on mounted volumes.
If the trigger's input weren't known when planning, every apply would replace every sandbox.

The `skills` block applies only to researchers with a skills volume. The buyer's `mcp` block passes the booking URL and `custom_headers` to Hermes. OpenTofu's `$${` escape leaves the `${NEMOCLAW_API_BOOKINGS_KEY}` reference for Hermes to expand from its environment. OpenShell substitutes the stored key when forwarding an admitted request. The URL, header, and policy rules are part of the buyer's replacement trigger.

In the [Docker booking authentication test](README.md#booking-authentication), the service received the expected bearer key on both the quote and booking requests.

## `outputs.tf`: Invoking Agents

```hcl
output "agents" {
  description = "What invoking each agent needs: its workspace, sandbox, agent name, and Fabric runtime ID."
  value       = module.agents.agents
}
```

The `agents` module lists each role's workspace, sandbox, agent name, and Fabric runtime ID, and the root passes them on.
This is everything `openshell sandbox exec … fabric-agent-ctl invoke` needs to call an agent; [README.md](README.md#use-it) shows the commands.
