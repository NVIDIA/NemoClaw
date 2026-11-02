# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# examples/hcl/travel-team, authored HCL applied unchanged with the bundle's
# providers: six Hermes agents in for_each sandboxes, each with its own model,
# registrations, and grants. This scenario owns the example's per-role wiring
# and a hosted-model change that replaces only the agents that use it.

mock_provider "docker" {}

run "fixtures" {
  module {
    source = "./modules/observed"
  }

  variables {
    declare = jsonencode({
      compute_driver = "docker"
      models         = ["nemotron-mini:4b"]
      images = [{
        reference      = "hermes@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        id             = "sha256:hermes"
        fabric_catalog = true
      }]
    })
  }
}

run "deploy" {
  module {
    source = "./examples/hcl/travel-team"
  }

  variables {
    docker_host            = "unix:///mocked/docker.sock"
    gateway_endpoint       = run.fixtures.openshell.endpoint
    images                 = { hermes = "hermes@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }
    image_engine           = run.fixtures.engine.endpoint
    ollama_image           = "ollama-runtime@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    local_model            = { name = "nemotron-mini:4b", digest = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" }
    model_endpoint         = "${run.fixtures.http.endpoint}/v1"
    sandbox_model_endpoint = "http://10.0.0.8:11434/v1"
    frontier = {
      endpoint       = "${run.fixtures.http.endpoint}/v1"
      model          = "nvidia/nemotron-3.5-super-vl-120b-a12b"
      credential_env = "NVIDIA_API_KEY"
    }
    search = {
      provider       = "brave"
      credential_env = "BRAVE_API_KEY"
    }
    bookings = {
      url            = "https://bookings.example.com/mcp"
      tools          = ["get_quote", "book_option"]
      credential_env = "BOOKINGS_API_KEY"
    }
  }

  assert {
    condition     = alltrue([for agent in values(output.agents) : agent.runtime_id != ""])
    error_message = "An agent reports no runtime."
  }
}

run "observe" {
  module {
    source = "./modules/observed"
  }

  assert {
    condition     = length(output.registrations) == 4
    error_message = "The team does not register two models, web search, and the booking service."
  }

  # Everyone has one model; researchers also search, and the buyer reaches
  # the booking service.
  assert {
    condition = { for role, agent in output.agents : role => length(agent.providers) } == {
      flights = 2, stays = 2, transport = 2, attractions = 2, scheduler = 1, buyer = 2
    }
    error_message = "A role does not attach exactly its registrations."
  }

  # OpenShell grants attached providers' endpoints itself, so policies hold
  # only researchers' sources and the buyer's booking service.
  assert {
    condition = (
      output.agents.scheduler.policy_endpoints == []
      && contains(output.agents.flights.policy_endpoints, "api.flights.example.com:443")
      && contains(output.agents.attractions.policy_endpoints, "api.attractions.example.com:443")
      && anytrue([for endpoint in output.agents.buyer.policy_endpoints : startswith(endpoint, "bookings.example.com:443")])
    )
    error_message = "A role's policy grants the wrong destinations."
  }

  assert {
    condition = { for role, agent in output.agents : role => agent.start.configuration.tools.enabled } == {
      flights   = ["web"], stays = ["web"], transport = ["web"], attractions = ["web"]
      scheduler = ["delegation"], buyer = ["bookings"]
    }
    error_message = "A role did not start with its toolsets."
  }

  assert {
    condition = (
      output.agents.flights.start.configuration.models.default.model == "nemotron-mini:4b"
      && output.agents.buyer.start.configuration.mcp.servers.bookings.url == "https://bookings.example.com/mcp"
    )
    error_message = "A researcher's local model or the buyer's booking service is missing."
  }
}

run "change_frontier" {
  module {
    source = "./examples/hcl/travel-team"
  }

  variables {
    docker_host            = "unix:///mocked/docker.sock"
    gateway_endpoint       = run.observe.openshell.endpoint
    images                 = { hermes = "hermes@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }
    image_engine           = run.observe.engine.endpoint
    ollama_image           = "ollama-runtime@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    local_model            = { name = "nemotron-mini:4b", digest = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" }
    model_endpoint         = "${run.observe.http.endpoint}/v1"
    sandbox_model_endpoint = "http://10.0.0.8:11434/v1"
    frontier = {
      endpoint       = "${run.observe.http.endpoint}/v1"
      model          = "nvidia/llama-3.1-nemotron-ultra-253b-v1"
      credential_env = "NVIDIA_API_KEY"
    }
    search = {
      provider       = "brave"
      credential_env = "BRAVE_API_KEY"
    }
    bookings = {
      url            = "https://bookings.example.com/mcp"
      tools          = ["get_quote", "book_option"]
      credential_env = "BOOKINGS_API_KEY"
    }
  }
}

run "teardown" {
  module {
    source = "./examples/hcl/travel-team"
  }

  variables {
    docker_host            = "unix:///mocked/docker.sock"
    gateway_endpoint       = run.observe.openshell.endpoint
    images                 = { hermes = "hermes@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }
    image_engine           = run.observe.engine.endpoint
    ollama_image           = "ollama-runtime@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    local_model            = { name = "nemotron-mini:4b", digest = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" }
    model_endpoint         = "${run.observe.http.endpoint}/v1"
    sandbox_model_endpoint = "http://10.0.0.8:11434/v1"
    frontier = {
      endpoint       = "${run.observe.http.endpoint}/v1"
      model          = "nvidia/llama-3.1-nemotron-ultra-253b-v1"
      credential_env = "NVIDIA_API_KEY"
    }
    search = {
      provider       = "brave"
      credential_env = "BRAVE_API_KEY"
    }
    bookings = {
      url            = "https://bookings.example.com/mcp"
      tools          = ["get_quote", "book_option"]
      credential_env = "BOOKINGS_API_KEY"
    }
    destroy = true
  }
}

# The hosted model change replaced the scheduler's and buyer's sandboxes, which
# use it, and left every researcher's.
run "changed" {
  command = plan

  module {
    source = "./modules/observed"
  }

  variables {
    baseline = run.observe.openshell
  }

  assert {
    condition = sort([
      for role, id in output.openshell.sandboxes : role if id != var.baseline.sandboxes[role]
    ]) == tolist(["buyer", "scheduler"])
    error_message = "The hosted model change did not replace exactly the scheduler's and buyer's sandboxes."
  }
}
