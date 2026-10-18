<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Travel Team Walkthrough

This walks through the travel team's HCL file by file, in the order OpenTofu wires it together.
Each excerpt is followed by what it does and why.
[README.md](README.md) covers running and using the team.

## `versions.tf`: Providers

```hcl
required_providers {
  docker    = { source = "registry.opentofu.org/kreuzwerker/docker", version = "4.6.0" }
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

```hcl
provider "openshell" {
  destroy = var.destroy
}
```

The NVIDIA providers delete the objects they own only when `destroy` is `true`, so a plain `tofu destroy` fails.
To tear the team down, run `tofu destroy -var destroy=true`.

## `models.tf`: Models

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
max_sequences = min(length(local.researchers), 2)
```

The researchers share the model and work at the same time, so the server serves two of them at once, the most NemoClaw's Ollama runtime allows.

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
  sandbox_endpoint = coalesce(var.sandbox_model_endpoint, var.model_endpoint)
  read_trigger     = docker_container.ollama.id != ""
}
```

The read asks the server at `endpoint`, the address this machine uses, for its models, and is ready once the pinned model is listed.
Because `read_trigger` depends on the container, a fresh install reads it during apply, after the container starts.

```hcl
local_server = {
  type              = "inference_server"
  endpoint          = coalesce(var.sandbox_model_endpoint, var.model_endpoint)
  credential_env    = ""
  credential_source = ""
}
```

The local model's registration takes this literal server rather than the readiness read's `ref`.
The read reports its values only during apply when the server changes, and a registration whose server is unknown when planning would be replaced, which OpenShell refuses while sandboxes attach it.
The registration waits for the read through `depends_on` instead.
`local.frontier_server` describes the hosted model the same way: NemoClaw doesn't run it, so nothing checks it, and `credential_env` names the variable that holds its key.

## `registrations.tf`: Workspace and Credentials

```hcl
data "openshell_gateway" "current" {
  endpoint                 = var.gateway_endpoint
  required_compute_drivers = ["docker"]
}
```

This checks that the gateway is reachable and runs the Docker driver, which the skills volume's `driver_config` targets.
Every OpenShell and Fabric object takes its `ref`, as `local.gateway`.

```hcl
resource "openshell_inference" "local" {
  gateway   = local.gateway
  workspace = openshell_workspace.team.ref
  name      = "local"
  server    = local.local_server
  api       = "openai-completions"
  binaries  = local.model_binaries.local
  # Registered once the model is ready.
  depends_on = [data.ollama_readiness.local]
}
```

This registers the local model once it's ready, so the sandboxes that attach it, and their agents, wait for it too.
`binaries` limits the registration to the executables of the harnesses that use the local model.
`openshell_inference.frontier` registers the hosted model the same way, and OpenShell reads its key from `credential_env` during apply; the key never enters OpenTofu state.

```hcl
sandbox_env = var.search.provider == "brave" ? "BRAVE_SEARCH_API_KEY" : null
```

One web search registration, which only researchers attach.
Inside a sandbox, an agent finds a provider's key in a variable OpenShell sets; Hermes's Brave plugin reads `BRAVE_SEARCH_API_KEY`, so the registration names that variable instead of the default `BRAVE_API_KEY`.

```hcl
resource "openshell_api" "bookings" {
  gateway        = local.gateway
  workspace      = openshell_workspace.team.ref
  name           = "bookings"
  endpoint       = var.bookings.url
  credential_env = var.bookings.credential_env
  binaries       = local.binaries.buyer
}
```

This registers the booking service's key for the buyer's executables only.
OpenShell puts the key into a request in place of its placeholder, so the agent never sees the key itself.
Hermes doesn't send that placeholder to MCP servers yet, so for now the service receives no key; [#13313](https://github.com/NVIDIA/NemoClaw/issues/13313) tracks it.

## `policies.tf`: Network Grants

OpenShell denies every request a sandbox's policy doesn't grant.
It already grants each attached provider's endpoint, such as a model, web search, or the booking service, to the executables its registration names.
The policy grants only what no provider covers: researchers' own sources, and the booking service's MCP tools.

```hcl
port = url.port != null ? tonumber(url.port) : (url.scheme == "https" ? 443 : 80)
```

A URL without a port has a `null` port, which `tonumber` returns unchanged rather than rejecting, so `try(tonumber(url.port), 443)` would not fall back.

```hcl
allowed_ips = can(cidrhost("${url.host}/32", 0)) ? ["${url.host}/32"] : null
```

For a booking service at a literal IP address, OpenShell's own policy for the provider pins that address, and a grant on the same endpoint must agree.

```hcl
protocol    = "mcp"
rules = concat(
  [for method in ["initialize", "notifications/initialized", "tools/list"] : { method = method, path = null, tool = null }],
  [for tool in var.bookings.tools : { method = "tools/call", path = null, tool = tool }],
)
```

The booking grant allows MCP setup, tool listing, and calls to the listed tools only.
Hermes can't limit which of an MCP server's tools an agent calls, so this grant is what does; OpenShell enforces it on the buyer's traffic.

```hcl
for host in lookup(var.research_sources, role, []) : "${role}-${replace(host, ".", "-")}" => {
```

`local.grants` gives each role a map of named grants: each researcher gets `GET` access to its own sources from `research_sources`, the buyer gets the booking grant, and the scheduler gets none.

## `agents.tf`: Sandboxes and Agents

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
Every role runs Hermes; Fabric's Deep Agents adapter can't turn a model's reasoning off yet ([NVIDIA/NeMo-Fabric#433](https://github.com/NVIDIA/NeMo-Fabric/issues/433)), and a reasoning model there can't finish within Fabric's 320-second invocation deadline.

```hcl
binaries = { for role, harness in data.fabric_harness.agent : role => jsondecode(harness.launch_json).binaries }
```

Each role's executables come from its harness, so grants and registrations follow when an image changes.

```hcl
instructions = {
  for role, text in merge(
```

Instructions are Markdown templates with the JSON Schemas of each hand-off embedded, so a researcher's reply schema is also the scheduler's input schema.

```hcl
provider    = "custom"
model       = var.local_model.name
```

Hermes's `custom` profile is for OpenAI-compatible servers.
It sends the `reasoning_effort` that turns a model's reasoning off, which Fabric's Hermes adapter asks for by default; Ollama and NVIDIA's API both honor it.
With reasoning on, Nemotron spends its output budget reasoning and misses Fabric's invocation deadline.
The hosted model uses the same profile, and its `api_key_env` is `openshell_inference.frontier.sandbox_env`, the variable sandboxes see its key in.

```hcl
tools = settings.search ? ["web"] : role == "scheduler" ? ["delegation"] : ["bookings"]
```

Hermes enables exactly the toolsets listed, and all of its defaults, terminal and code execution included, without a list.
Researchers only search, the scheduler only delegates its feasibility review, and the buyer only uses the booking service's MCP toolset.

- **Behavior:** researchers run at temperature 0.2 with 16 turns and 2048 output tokens, the scheduler at 0.3 with 12 turns, and the buyer at 0 with 24 turns.
- **Instructions:** researchers search once or twice per stop and keep only options whose price they found; the scheduler delegates one review; the buyer quotes every option before booking any.

```hcl
resource "terraform_data" "agent_config" {
  for_each = local.agent_configs
  input    = jsonencode(each.value)
}
```

This holds each agent's configuration, so the sandbox can be replaced when it changes.

```hcl
providers = concat(
  [each.value.model == "local" ? openshell_inference.local.ref : openshell_inference.frontier.ref],
  each.value.search ? [openshell_web_search.research.ref] : [],
  each.key == "buyer" ? [openshell_api.bookings.ref] : [],
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

```hcl
dynamic "mcp" {
  for_each = each.value.bookings ? [var.bookings] : []
```

This starts each agent in its sandbox with Fabric's configuration format.
The `skills` and `mcp` blocks are dynamic, so only researchers with a skills volume read skills, and only the buyer reaches the booking service.

## `outputs.tf`: Invoking Agents

```hcl
output "agents" {
  description = "What invoking each agent needs: its workspace, sandbox, agent name, and Fabric runtime ID."
  value = {
    for role, agent in fabric_agent.agent : role => {
      workspace  = openshell_workspace.team.name
      sandbox    = openshell_sandbox.agent[role].name
      agent      = agent.name
      runtime_id = agent.runtime_id
    }
  }
}
```

This is everything `openshell sandbox exec … fabric-agent-ctl invoke` needs to call an agent; [README.md](README.md#use-it) shows the commands.
