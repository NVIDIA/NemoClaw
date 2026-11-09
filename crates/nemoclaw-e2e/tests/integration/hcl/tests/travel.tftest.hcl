# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# examples/hcl/travel, authored HCL applied unchanged with the bundle's
# providers: Ollama placed through the mocked Docker provider from its runtime
# launch, readiness against the fixture upstream listing the model, and the Pi
# agent in its sandbox on the fixture gateway. This scenario owns the authored
# example's unchanged reapply.

mock_provider "docker" {}

# Declares the Pi image on the fixture engine and the model the upstream
# lists, and returns the fixtures' endpoints. OpenTofu keeps only the latest
# applying run's outputs of a module, so runs after observe read them there.
run "fixtures" {
  module {
    source = "./modules/observed"
  }

  variables {
    declare = jsonencode({
      compute_driver = "docker"
      models         = ["nemotron-mini:4b"]
      images = [{
        reference      = "pi@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        id             = "sha256:pi"
        fabric_catalog = true
      }]
    })
  }
}

run "deploy" {
  module {
    source = "./examples/hcl/travel"
  }

  variables {
    docker_host            = "unix:///mocked/docker.sock"
    gateway_endpoint       = run.fixtures.openshell.endpoint
    ollama_image           = "ollama-runtime@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    pi_image               = "pi@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    pi_image_engine        = run.fixtures.engine.endpoint
    model                  = { name = "nemotron-mini:4b", digest = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" }
    model_endpoint         = "${run.fixtures.http.endpoint}/v1"
    sandbox_model_endpoint = "http://10.0.0.8:11434/v1"
  }

  assert {
    condition     = fabric_agent.travel.runtime_id != ""
    error_message = "The agent reports no runtime."
  }
}

run "observe" {
  module {
    source = "./modules/observed"
  }

  assert {
    condition = (
      length(output.registrations) == 1
      && one(values(output.registrations)).config["OPENAI_BASE_URL"] == "http://10.0.0.8:11434/v1"
    )
    error_message = "The model is not registered once, at the address sandboxes use."
  }

  assert {
    condition = (
      toset(keys(output.agents)) == toset(["travel"])
      && toset(output.agents.travel.providers) == toset(keys(output.registrations))
      && contains(output.agents.travel.policy_endpoints, "10.0.0.8:11434/v1/**")
      && contains(output.agents.travel.policy_endpoints, "travel.example.com:443")
    )
    error_message = "The sandbox does not attach the registration, or its policy misses the model or travel.example.com."
  }

  assert {
    condition = (
      output.agents.travel.start.configuration.metadata.name == "travel"
      && output.agents.travel.start.configuration.models.default.model == "nemotron-mini:4b"
      && startswith(output.agents.travel.start.configuration.instructions.system.content, "You research travel options")
    )
    error_message = "The agent did not start with its name, model, and instructions."
  }
}

# Applying again with destroy permitted, which OpenTofu's cleanup uses,
# changes no resource.
run "teardown" {
  module {
    source = "./examples/hcl/travel"
  }

  variables {
    docker_host            = "unix:///mocked/docker.sock"
    gateway_endpoint       = run.observe.openshell.endpoint
    ollama_image           = "ollama-runtime@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    pi_image               = "pi@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    pi_image_engine        = run.observe.engine.endpoint
    model                  = { name = "nemotron-mini:4b", digest = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" }
    model_endpoint         = "${run.observe.http.endpoint}/v1"
    sandbox_model_endpoint = "http://10.0.0.8:11434/v1"
    destroy                = true
  }
}

run "unchanged" {
  command = plan

  module {
    source = "./modules/observed"
  }

  variables {
    baseline = run.observe.openshell
  }

  assert {
    condition = (
      output.openshell.effects == var.baseline.effects
      && output.openshell.fabric_starts == var.baseline.fabric_starts
    )
    error_message = "Applying the unchanged example changed the gateway or started the agent again."
  }
}
