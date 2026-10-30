# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Three OpenClaw agents share one registration; removing one leaves the
# others and everything they share.

# Docker is mocked. Its alias follows from the runner's engine socket, and
# its IDs match what the fixtures module declares to the engine.
mock_provider "docker" {
  alias = "engine_23ddaef7520a85fde258e31aae3cf758"

  mock_resource "docker_image" {
    defaults = { image_id = "sha256:0000000000000000000000000000000000000000000000000000000000000001" }
  }
}

override_resource {
  target = docker_container.managed_gateway_runtime
  values = { id = "fixture-gateway-container" }
}

# Declare the fixtures before the deployment's first plan reads them.
run "fixtures" {
  command = plan

  module {
    source = "./cases/docker-openclaw-three-agents"
  }

  plan_options {
    target = [data.fixture_state.setup]
  }
}

run "deploy" {
  module {
    source = "./cases/docker-openclaw-three-agents"
  }
}

# A second apply changes nothing: it reads what deploy produced.
run "verify" {
  module {
    source = "./cases/docker-openclaw-three-agents"
  }

  # Each sandbox runs its own agent with its own model and attaches the one
  # shared registration.
  assert {
    condition = (
      length(module.observed.registrations) == 1
      && alltrue([
        for name, model in { assistant = "qwen3:4b", researcher = "qwen3:8b", reviewer = "qwen3:14b" } :
        module.observed.agents[name].providers == keys(module.observed.registrations)
        && module.observed.agents[name].start.configuration.metadata.name == name
        && module.observed.agents[name].start.configuration.models.default.model == model
      ])
    )
    error_message = "An agent has another model, or a sandbox does not attach the shared registration."
  }
}

# This plan reads what verify's apply left: it changed no gateway objects.
run "unchanged" {
  command = plan

  module {
    source = "./cases/docker-openclaw-three-agents"
  }

  variables {
    effects = run.verify.effects
  }

  assert {
    condition     = module.observed.openshell.effects == var.effects
    error_message = "The second apply changed gateway objects."
  }
}

# The step's document has no researcher.
run "remove_researcher" {
  module {
    source = "./cases/docker-openclaw-three-agents"
  }

  variables {
    step = "remove-researcher"
  }
}

# This plan reads what the removal left. The only gateway change deleted the
# researcher's sandbox, after its agent stopped; the other agents were neither
# replaced, stopped, nor started again, and the registration, profile, and
# workspace remain.
run "researcher_removed" {
  command = plan

  module {
    source = "./cases/docker-openclaw-three-agents"
  }

  variables {
    step    = "remove-researcher"
    effects = run.remove_researcher.effects
  }

  assert {
    condition = (
      module.observed.openshell.effects == var.effects + 1
      && module.observed.openshell.sandboxes == ["assistant", "reviewer"]
      && length(module.observed.openshell.created_sandboxes) == 3
      && [for exec in module.observed.openshell.execs : exec.sandbox if contains(exec.command, "stop")] == ["researcher"]
      && alltrue([for name in ["assistant", "reviewer"] : module.observed.openshell.fabric_starts[module.observed.agents[name].id] == 1])
      && module.observed.openshell.providers == keys(module.observed.registrations)
      && length(module.observed.openshell.created_providers) == 1
      && length(module.observed.openshell.profiles) == 1
      && length(module.observed.openshell.workspaces) == 1
    )
    error_message = "Removing the researcher changed another agent or a shared object, or left the researcher's sandbox or runtime."
  }
}

# OpenTofu removes what the last applying run applied, with its variables:
# this run permits deletion, as the SDK's teardown graph does. It refers to no
# earlier run, which would stop OpenTofu's cleanup.
run "teardown" {
  module {
    source = "./cases/docker-openclaw-three-agents"
  }

  variables {
    step           = "remove-researcher"
    permit_destroy = true
  }
}
