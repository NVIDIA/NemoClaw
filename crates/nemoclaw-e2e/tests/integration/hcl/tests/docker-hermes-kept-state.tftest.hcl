# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Replacing a Hermes sandbox whose /sandbox/artifacts is a volume: the new
# sandbox mounts the same volume, and the agent starts again with kept state
# under the same name, so Fabric hands it the folder the old runtime used.
# That Hermes finds its sessions there needs real Hermes; the live suite owns it.
# Each sandbox also mounts a skills volume on /sandbox/skills, and each start
# request lists that path as a folder of skills in the agent's
# skills.directories, refusing duplicate names.
#
# Only one runtime uses the kept state at a time: the old runtime stops before
# the agent starts in the new sandbox. The agent then records the new sandbox
# and runtime, Fabric's later checks name that runtime, and the next unchanged
# apply replaces, stops, and starts nothing. That a replacement leaves
# other agents alone is kubernetes-external-three-agents.tftest.hcl's.

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

run "fixtures" {
  command = plan

  module {
    source = "./cases/docker-hermes-kept-state"
  }

  plan_options {
    target = [data.fixture_state.setup]
  }
}

run "deploy" {
  module {
    source = "./cases/docker-hermes-kept-state"
  }
}

run "replace_hermes" {
  module {
    source = "./cases/docker-hermes-kept-state"
  }

  plan_options {
    replace = [openshell_sandbox.hermes]
  }
}

# An unchanged apply after the replacement. It plans after the replacement
# finished, so its assertions read what the replacement did.
run "reapply" {
  module {
    source = "./cases/docker-hermes-kept-state"
  }

  assert {
    condition = [
      for exec in module.observed.openshell.execs :
      contains(exec.command, "start") ? "start" : "stop"
      if contains(exec.command, "start") || contains(exec.command, "stop")
    ] == ["start", "stop", "start"]
    error_message = "The old runtime was not stopped before the agent started in the new sandbox."
  }

  assert {
    condition     = toset(module.observed.openshell.fabric_stopped) == toset([module.observed.openshell.created_sandboxes[0].id])
    error_message = "The stop did not reach the runtime in the old sandbox."
  }
}

# Reapply changed nothing and found the agent running under the binding the
# replacement recorded. var.baseline is what reapply observed when it planned.
run "unchanged" {
  command = plan

  module {
    source = "./cases/docker-hermes-kept-state"
  }

  variables {
    baseline = run.reapply.baseline
  }

  assert {
    condition     = module.observed.openshell.effects == var.baseline.effects
    error_message = "The apply after the replacement changed the gateway."
  }

  assert {
    condition     = module.observed.openshell.sandboxes == var.baseline.sandboxes
    error_message = "The apply after the replacement replaced the sandbox."
  }

  assert {
    condition = (
      module.observed.openshell.fabric_starts == var.baseline.fabric_starts
      && toset(module.observed.openshell.fabric_stopped) == toset(var.baseline.fabric_stopped)
    )
    error_message = "The apply after the replacement stopped or started the agent."
  }

  assert {
    condition     = fabric_agent.hermes.sandbox.id == module.observed.openshell.sandboxes.hermes
    error_message = "The agent does not record the new sandbox."
  }

  assert {
    condition = fabric_agent.hermes.runtime_id != one([
      for exec in module.observed.openshell.execs :
      exec.command[index(exec.command, "--runtime-id") + 1] if contains(exec.command, "stop")
    ])
    error_message = "The agent still records the runtime that was stopped."
  }

  assert {
    condition = toset([
      for position, exec in module.observed.openshell.execs :
      exec.command[index(exec.command, "--runtime-id") + 1]
      if contains(exec.command, "check") && contains(exec.command, "--runtime-id") && position > max([
        for started, start in module.observed.openshell.execs : started if contains(start.command, "start")
      ]...)
    ]) == toset([fabric_agent.hermes.runtime_id])
    error_message = "Fabric's checks after the replacement do not all name the runtime the agent records."
  }
}

# Teardown's plan observes what the replacement and reapply left.
run "teardown" {
  module {
    source = "./cases/docker-hermes-kept-state"
  }

  variables {
    permit_destroy = true
  }

  assert {
    condition = (
      length(module.observed.openshell.created_sandboxes) == 2
      && module.observed.openshell.sandboxes.hermes == module.observed.openshell.created_sandboxes[1].id
    )
    error_message = "The Hermes sandbox was not replaced by exactly one new sandbox."
  }

  assert {
    condition = alltrue([
      for sandbox in module.observed.openshell.created_sandboxes :
      contains(sandbox.driver_config.docker.mounts, {
        type      = "volume"
        source    = "hermes-artifacts"
        target    = "/sandbox/artifacts"
        read_only = false
      })
    ])
    error_message = "A Hermes sandbox does not mount the artifacts volume on /sandbox/artifacts."
  }

  assert {
    condition = alltrue([
      for sandbox in module.observed.openshell.created_sandboxes :
      contains(sandbox.driver_config.docker.mounts, {
        type      = "volume"
        source    = "hermes-skills"
        target    = "/sandbox/skills"
        read_only = false
      })
    ])
    error_message = "A Hermes sandbox does not mount the skills volume on /sandbox/skills."
  }

  assert {
    condition = [
      for exec in module.observed.openshell.execs :
      try(jsondecode(exec.stdin).skills, null) if contains(exec.command, "start")
      ] == [
      { directories = [{ folder = "/sandbox/skills" }], duplicates = "reject" },
      { directories = [{ folder = "/sandbox/skills" }], duplicates = "reject" },
    ]
    error_message = "The agent did not start in each sandbox with /sandbox/skills as a folder of skills that refuses duplicate names."
  }

  assert {
    condition = [
      for exec in module.observed.openshell.execs : [
        jsondecode(exec.stdin).metadata.name,
        jsondecode(exec.stdin).runtime.keep_state,
        jsondecode(exec.stdin).runtime.artifacts,
      ] if contains(exec.command, "start")
      ] == [
      ["hermes", true, "/sandbox/artifacts"],
      ["hermes", true, "/sandbox/artifacts"],
    ]
    error_message = "The agent did not start in each sandbox with kept state, its artifacts path, and the same name."
  }
}
