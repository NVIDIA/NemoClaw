# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# The agents layer: each role's sandbox and agent, on the gateway layer's
# workspace and registrations. The root configures the providers and pins
# their versions.
terraform {
  required_providers {
    openshell = { source = "registry.opentofu.org/nvidia/openshell" }
    fabric    = { source = "registry.opentofu.org/nvidia/fabric" }
  }
}

locals {
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
        for topic, focus in var.researchers : topic => templatefile("${path.module}/instructions/researcher.md.tftpl", {
          topic  = topic
          focus  = focus
          trip   = local.schemas["trip-request"]
          result = local.schemas["research-result"]
        })
      },
      {
        scheduler = templatefile("${path.module}/instructions/scheduler.md.tftpl", {
          topics    = keys(var.researchers)
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
      model       = var.models.local.name
      base_url    = var.models.local.endpoint
      api_key_env = "NEMOCLAW_ANONYMOUS_API_KEY"
    }
    frontier = {
      # As for the local model: the custom profile sends the hosted endpoint
      # the reasoning_effort that turns reasoning off.
      provider = "custom"
      model    = var.models.frontier.name
      base_url = var.models.frontier.endpoint
      # Sandboxes see the key in the registration's variable, not in
      # credential_env, which names it on this machine.
      api_key_env = var.frontier_key_env
    }
  }

  behavior = merge(
    {
      for topic, focus in var.researchers : topic => {
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
    for role, settings in var.roles : role => merge(
      local.behavior[role], local.models[settings.model],
      {
        instructions = local.instructions[role]
        # The buyer reaches the booking service over MCP.
        bookings = role == "buyer"
        # Researchers read the folder of skills on the optional volume.
        skills = settings.search && var.skills_volume != null ? [local.skills_path] : []
        # Hermes enables exactly the toolsets listed, and all of its defaults
        # without a list. Researchers only search, the scheduler only delegates
        # its feasibility review, and the buyer only uses the booking service's
        # MCP toolset.
        tools = settings.search ? ["web"] : role == "scheduler" ? ["delegation"] : ["bookings"]
      },
      role == "buyer" ? {
        booking_mcp = {
          url     = var.bookings.url
          headers = { Authorization = "Bearer $${NEMOCLAW_API_BOOKINGS_KEY}" }
          rules   = var.booking_rules
        }
      } : {},
    )
  }

  # Research sources supplement the endpoint rules attached by the providers.
  # The booking provider owns both the credential and the MCP rules.
  grants = {
    for role in keys(var.roles) : role => {
      for host in lookup(var.research_sources, role, []) : "${role}-${replace(host, ".", "-")}" => host
    }
  }
}

# Holds each agent's configuration so that a change replaces its sandbox.
resource "terraform_data" "agent_config" {
  for_each = local.agent_configs
  input    = jsonencode(each.value)
}

resource "openshell_sandbox" "agent" {
  for_each    = var.roles
  gateway     = var.gateway
  workspace   = var.workspace
  owner       = var.workspace.owner
  name        = each.key
  image       = var.harnesses[each.key].image
  launch_json = var.harnesses[each.key].launch_json
  providers = concat(
    [var.registrations[each.value.model]],
    each.value.search ? [var.registrations.search] : [],
    each.key == "buyer" ? [var.registrations.bookings] : [],
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
          for_each = var.harnesses[each.key].binaries
          content {
            path = binaries.value
          }
        }
        endpoints {
          host        = managed.value
          port        = 443
          protocol    = "rest"
          enforcement = "enforce"
          rules {
            allow {
              method = "GET"
              path   = "/**"
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
  gateway     = var.gateway
  sandbox     = openshell_sandbox.agent[each.key].ref
  harness     = var.harnesses[each.key].ref
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
      # Hermes finds each skill in a folder of skills, and the agent doesn't
      # start when two of them share a name.
      dynamic "directories" {
        for_each = skills.value
        content {
          folder = directories.value
        }
      }
      duplicates = "reject"
    }
  }
  # The booking registration enforces the MCP rules and replaces the header's
  # placeholder with the stored key.
  dynamic "mcp" {
    for_each = each.value.bookings ? [each.value.booking_mcp] : []
    content {
      servers "bookings" {
        transport      = "streamable-http"
        url            = mcp.value.url
        exposure       = "harness_native"
        custom_headers = mcp.value.headers
      }
    }
  }
}
