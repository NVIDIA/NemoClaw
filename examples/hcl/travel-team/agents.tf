# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

locals {
  gateway = data.openshell_gateway.current.ref

  # What each researcher looks into. A key names the researcher's sandbox and
  # agent.
  researchers = {
    flights     = "flights for each leg of the trip: nonstop and one-stop options, fares, fare rules, and baggage allowances"
    stays       = "places to stay near each stop's points of interest: hotels and apartments, nightly rates, cancellation terms, and reviews"
    transport   = "getting around: airport transfers, transit passes, trains between cities, and car rental where transit is poor"
    attractions = "things to do at each stop: attractions, opening hours, ticket prices, advance booking requirements, and seasonal closures"
  }

  harnesses = {
    hermes = { adapter_id = "nvidia.fabric.hermes", image = var.images.hermes }
  }

  # Every agent's sandbox, from one table: its harness, its model, and whether
  # it searches the web. Agent configurations follow below, one per role.
  roles = merge(
    { for topic in keys(local.researchers) : topic => { harness = "hermes", model = "local", search = true } },
    {
      scheduler = { harness = "hermes", model = "frontier", search = false }
      buyer     = { harness = "hermes", model = "frontier", search = false }
    },
  )

  # Each role's harness executables, which its grants and registrations allow.
  binaries = { for role, harness in data.fabric_harness.agent : role => jsondecode(harness.launch_json).binaries }
  model_binaries = {
    for model in ["local", "frontier"] : model => sort(distinct(flatten([
      for role, settings in local.roles : local.binaries[role] if settings.model == model
    ])))
  }
  search_binaries = sort(distinct(flatten([for role, settings in local.roles : local.binaries[role] if settings.search])))

  # Where the optional skills volume appears in researchers' sandboxes.
  skills_path = "/sandbox/skills"

  # The JSON Schemas that structure each hand-off, embedded in instructions
  # without their license comment.
  schemas = {
    for name in ["trip-request", "research-result", "itinerary", "booking"] : name => jsonencode({
      for key, value in jsondecode(file("${path.module}/schemas/${name}.json")) : key => value if key != "$comment"
    })
  }

  # Instructions are Markdown templates; their license comments are not
  # instructions.
  instructions = {
    for role, text in merge(
      {
        for topic, focus in local.researchers : topic => templatefile("${path.module}/instructions/researcher.md.tftpl", {
          topic  = topic
          focus  = focus
          trip   = local.schemas["trip-request"]
          result = local.schemas["research-result"]
        })
      },
      {
        scheduler = templatefile("${path.module}/instructions/scheduler.md.tftpl", {
          topics    = keys(local.researchers)
          trip      = local.schemas["trip-request"]
          result    = local.schemas["research-result"]
          itinerary = local.schemas["itinerary"]
        })
        buyer = templatefile("${path.module}/instructions/buyer.md.tftpl", {
          tools     = var.bookings.tools
          itinerary = local.schemas["itinerary"]
          booking   = local.schemas["booking"]
        })
      },
    ) : role => trimspace(replace(text, "/(?s)<!--.*?-->/", ""))
  }
}

# Each agent's configuration, built once. It configures the agent, and a change
# to it replaces the agent's sandbox: Fabric starts one agent per sandbox.
# Every value is known when planning, so an unchanged team plans no changes;
# the model's readiness read gates agents through their inference
# registrations instead.
locals {
  models = {
    local = {
      # Hermes's custom profile is for OpenAI-compatible servers such as
      # Ollama; it sends the reasoning_effort that turns reasoning off, as
      # Fabric's Hermes adapter asks by default.
      provider    = "custom"
      model       = var.local_model.name
      base_url    = coalesce(var.sandbox_model_endpoint, var.model_endpoint)
      api_key_env = "NEMOCLAW_ANONYMOUS_API_KEY"
    }
    frontier = {
      # As for the local model: the custom profile sends the hosted endpoint
      # the reasoning_effort that turns reasoning off.
      provider = "custom"
      model    = var.frontier.model
      base_url = var.frontier.endpoint
      # Sandboxes see the key in the registration's variable, not in
      # credential_env, which names it on this machine.
      api_key_env = openshell_inference.frontier.sandbox_env
    }
  }

  behavior = merge(
    {
      for topic, focus in local.researchers : topic => {
        description = "Researches ${focus}."
        temperature = 0.2
        max_tokens  = 2048
        max_turns   = 16
      }
    },
    {
      scheduler = {
        description = "Composes a day-by-day itinerary from the researchers' findings."
        temperature = 0.3
        max_tokens  = 8192
        max_turns   = 12
      }
      buyer = {
        description = "Books exactly what a person approved."
        temperature = 0
        max_tokens  = 4096
        max_turns   = 24
      }
    },
  )

  agent_configs = {
    for role, settings in local.roles : role => merge(local.behavior[role], local.models[settings.model], {
      instructions = local.instructions[role]
      # The buyer reaches the booking service over MCP.
      bookings = role == "buyer"
      # Researchers read skills from the optional volume.
      skills = settings.search && var.skills_volume != null ? [local.skills_path] : []
      # Hermes enables exactly the toolsets listed, and all of its defaults
      # without a list. Researchers only search, the scheduler only delegates
      # its feasibility review, and the buyer only uses the booking service's
      # MCP toolset.
      tools = settings.search ? ["web"] : role == "scheduler" ? ["delegation"] : ["bookings"]
    })
  }
}

data "fabric_harness" "agent" {
  for_each   = local.roles
  image      = local.harnesses[each.value.harness].image
  adapter_id = local.harnesses[each.value.harness].adapter_id
  agent_name = each.key
  engine     = var.image_engine
}

# Holds each agent's configuration so that a change replaces its sandbox.
resource "terraform_data" "agent_config" {
  for_each = local.agent_configs
  input    = jsonencode(each.value)
}

resource "openshell_sandbox" "agent" {
  for_each    = local.roles
  gateway     = local.gateway
  workspace   = openshell_workspace.team.ref
  owner       = openshell_workspace.team.owner
  name        = each.key
  image       = local.harnesses[each.value.harness].image
  launch_json = data.fabric_harness.agent[each.key].launch_json
  providers = concat(
    [each.value.model == "local" ? openshell_inference.local.ref : openshell_inference.frontier.ref],
    each.value.search ? [openshell_web_search.research.ref] : [],
    each.key == "buyer" ? [openshell_api.bookings.ref] : [],
  )
  # The skills volume, for researchers, mounted with OpenShell's defaults.
  driver_config = each.value.search && var.skills_volume != null ? jsonencode({
    docker = { mounts = [{ type = "volume", source = var.skills_volume, target = local.skills_path }] }
  }) : null
  policy {
    dynamic "managed" {
      for_each = local.grants[each.key]
      content {
        name = managed.key
        dynamic "binaries" {
          for_each = local.binaries[each.key]
          content {
            path = binaries.value
          }
        }
        endpoints {
          host        = managed.value.host
          port        = managed.value.port
          path        = managed.value.path
          allowed_ips = managed.value.allowed_ips
          protocol    = managed.value.protocol
          enforcement = "enforce"
          dynamic "rules" {
            for_each = managed.value.rules
            content {
              allow {
                method = rules.value.method
                path   = rules.value.path
                dynamic "tool" {
                  for_each = rules.value.tool == null ? [] : [rules.value.tool]
                  content {
                    value = tool.value
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  lifecycle {
    replace_triggered_by = [terraform_data.agent_config[each.key]]
  }
}

resource "fabric_agent" "agent" {
  for_each    = local.agent_configs
  gateway     = local.gateway
  sandbox     = openshell_sandbox.agent[each.key].ref
  harness     = data.fabric_harness.agent[each.key].ref
  name        = each.key
  description = each.value.description
  instructions {
    system {
      content = each.value.instructions
      mode    = "replace"
    }
  }
  models "default" {
    provider    = each.value.provider
    model       = each.value.model
    base_url    = each.value.base_url
    api_key_env = each.value.api_key_env
    temperature = each.value.temperature
    max_tokens  = each.value.max_tokens
  }
  runtime {
    max_turns = each.value.max_turns
  }
  dynamic "tools" {
    for_each = each.value.tools == null ? [] : [each.value.tools]
    content {
      enabled = tools.value
    }
  }
  dynamic "skills" {
    for_each = length(each.value.skills) > 0 ? [each.value.skills] : []
    content {
      paths = skills.value
    }
  }
  # The booking service. Hermes can't filter an MCP server's tools, so the
  # buyer's OpenShell policy enforces which tools it may call.
  dynamic "mcp" {
    for_each = each.value.bookings ? [var.bookings] : []
    content {
      servers "bookings" {
        transport = "streamable-http"
        url       = mcp.value.url
        exposure  = "harness_native"
      }
    }
  }
}
