# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# The team, and the three layers it runs on: inference, the gateway, and the
# agents. Each layer is a local module; values flow from one to the next
# through typed inputs and outputs.

locals {
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
  # it searches the web.
  roles = merge(
    { for topic in keys(local.researchers) : topic => { harness = "hermes", model = "local", search = true } },
    {
      scheduler = { harness = "hermes", model = "frontier", search = false }
      buyer     = { harness = "hermes", model = "frontier", search = false }
    },
  )
}

# Each role's harness, read here because two layers need it: the gateway's
# registrations allow its executables, and the agents' sandboxes launch it.
data "fabric_harness" "agent" {
  for_each   = local.roles
  image      = local.harnesses[each.value.harness].image
  adapter_id = local.harnesses[each.value.harness].adapter_id
  agent_name = each.key
  engine     = var.image_engine
}

locals {
  agent_harnesses = {
    for role, harness in data.fabric_harness.agent : role => {
      image       = local.harnesses[local.roles[role].harness].image
      launch_json = harness.launch_json
      ref         = harness.ref
      binaries    = jsondecode(harness.launch_json).binaries
    }
  }
  model_binaries = {
    for model in ["local", "frontier"] : model => sort(distinct(flatten([
      for role, settings in local.roles : local.agent_harnesses[role].binaries if settings.model == model
    ])))
  }
}

module "inference" {
  source = "./modules/inference"

  hardware_profile       = var.hardware_profile
  model_memory_gib       = var.model_memory_gib
  local_model            = var.local_model
  local_model_agents     = length(local.researchers)
  ollama_image           = var.ollama_image
  model_bind_address     = var.model_bind_address
  model_endpoint         = var.model_endpoint
  sandbox_model_endpoint = var.sandbox_model_endpoint
  frontier               = var.frontier
}

module "gateway" {
  source = "./modules/gateway"

  endpoint        = var.gateway_endpoint
  workspace       = var.workspace
  local_server    = module.inference.local_server
  frontier_server = module.inference.frontier_server
  search          = var.search
  bookings        = var.bookings
  binaries = {
    local    = local.model_binaries.local
    frontier = local.model_binaries.frontier
    search   = sort(distinct(flatten([for role, settings in local.roles : local.agent_harnesses[role].binaries if settings.search])))
    bookings = local.agent_harnesses.buyer.binaries
  }
}

module "agents" {
  source = "./modules/agents"

  gateway          = module.gateway.gateway
  workspace        = module.gateway.workspace
  registrations    = module.gateway.registrations
  frontier_key_env = module.gateway.frontier_key_env
  booking_rules    = module.gateway.booking_rules
  models           = module.inference.models
  researchers      = local.researchers
  roles            = local.roles
  harnesses        = local.agent_harnesses
  bookings         = var.bookings
  research_sources = var.research_sources
  skills_volume    = var.skills_volume
}
