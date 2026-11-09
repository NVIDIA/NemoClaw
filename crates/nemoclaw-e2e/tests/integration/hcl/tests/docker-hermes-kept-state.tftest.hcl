# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Replacing a Hermes sandbox whose /sandbox/artifacts is a volume: the new
# sandbox mounts the same volume, and the agent starts again with kept state
# under the same name, so Fabric hands it the folder the old runtime used.
# That Hermes finds its sessions there needs real Hermes; the live suite owns it.
# Each sandbox also mounts a skills volume on /sandbox/skills, and each start
# request lists that path in the agent's skills.paths.

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

# Teardown's plan observes what the replacement left.
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
      try(jsondecode(exec.stdin).skills.paths, null) if contains(exec.command, "start")
    ] == [["/sandbox/skills"], ["/sandbox/skills"]]
    error_message = "The agent did not start in each sandbox with /sandbox/skills in its skills paths."
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
