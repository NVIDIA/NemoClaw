# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# The live E2E hosted scenario: OpenClaw agents on NVIDIA hosted inference
# behind a managed Docker gateway. Assertions cover every sandbox the shared
# document declares, and the assistant's resources by name.

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
    source = "./cases/docker-openclaw-nvidia"
  }

  plan_options {
    target = [data.fixture_state.setup]
  }
}

run "deploy" {
  module {
    source = "./cases/docker-openclaw-nvidia"
  }
}

# A second apply changes nothing: it reads what deploy produced, including
# data sources that only apply reads.
run "verify" {

  module {
    source = "./cases/docker-openclaw-nvidia"
  }

  # Docker inputs: the gateway container runs the pulled image, mounts the
  # storage's data path, receives the configuration the
  # real OpenShell provider returned, and carries the owner label.
  assert {
    condition = (
      docker_container.managed_gateway_runtime.image == module.fixtures.image_id
      && contains([for mount in docker_container.managed_gateway_runtime.mounts : mount.target if mount.type == "volume"], openshell_gateway_storage.runtime.data_path)
      && docker_container.managed_gateway_runtime.command == data.openshell_docker_gateway_runtime.managed_gateway_runtime.command
      && [for file in docker_container.managed_gateway_runtime.upload : file.content] == [data.openshell_docker_gateway_runtime.managed_gateway_runtime.config_file]
      && { for label in docker_container.managed_gateway_runtime.labels : label.label => label.value }["nemoclaw.nvidia.com/uid"] == module.fixtures.owner
    )
    error_message = "The gateway container's Docker inputs do not match its storage and runtime configuration."
  }

  # The real providers initialized storage on the engine, then read the
  # mocked container by its ID and reached a ready, compatible gateway.
  assert {
    condition = (
      contains(module.observed.engine.volumes, "${module.fixtures.prefix}-gateway-data")
      && data.openshell_docker_gateway_readiness.current.engine == module.observed.engine.endpoint
      && data.openshell_docker_gateway_readiness.current.container_id == docker_container.managed_gateway_runtime.id
      && contains(module.observed.engine.requests, "GET /containers/fixture-gateway-container/json")
      && data.openshell_docker_gateway_readiness.current.ready
      && data.openshell_gateway.apply.compatible
      && contains(data.openshell_gateway.apply.compute_drivers, "docker")
    )
    error_message = "The gateway container did not hand off to a ready, compatible gateway."
  }

  # The mocked pull's image ID reaches the real harness read.
  assert {
    condition = (
      data.fabric_harness.assistant_acquired.image == openshell_sandbox.assistant.image
      && data.fabric_harness.assistant_acquired.image_id == module.fixtures.image_id
      && data.fabric_harness.assistant_acquired.adapter_id == "nvidia.fabric.openclaw"
    )
    error_message = "The sandbox image did not hand off to the OpenClaw harnesses."
  }

  # OpenShell stored one registration at the fixture upstream. It holds the
  # credential from NVIDIA_INFERENCE_API_KEY under the name each Fabric agent
  # reads its key from.
  assert {
    condition = (
      length(module.observed.registrations) == 1
      && one(values(module.observed.registrations)).labels["nemoclaw.nvidia.com/uid"] == module.fixtures.owner
      && one(values(module.observed.registrations)).config["OPENAI_BASE_URL"] == "${module.observed.http.endpoint}/v1"
      && one(values(module.observed.registrations)).credentials == {
        (fabric_agent.assistant.models["primary"].api_key_env) = "env:NVIDIA_INFERENCE_API_KEY"
      }
    )
    error_message = "The NVIDIA inference binding is not registered as configured."
  }

  # OpenShell created every sandbox in the deployment's workspace; each names
  # the registration, may reach only the inference endpoint, and runs Fabric.
  assert {
    condition = (
      toset(keys(module.observed.agents)) == toset(module.fixtures.sandboxes)
      && module.observed.agents.assistant.id == openshell_sandbox.assistant.id
      && alltrue([
        for agent in values(module.observed.agents) :
        agent.workspace == openshell_workspace.deployment.name
        && agent.labels["nemoclaw.nvidia.com/uid"] == module.fixtures.owner
        && agent.providers == [one(values(module.observed.registrations)).name]
        && agent.policy_endpoints == ["${trimprefix(module.observed.http.endpoint, "http://")}/v1/**"]
        && agent.command == jsondecode(data.fabric_harness.assistant_acquired.launch_json).command
      ])
      && openshell_sandbox.assistant.policy_hash != ""
    )
    error_message = "A sandbox's identity, inference binding, or policy differs from the configuration."
  }

  # Fabric started every agent once, in its sandbox, through ExecSandbox;
  # the assistant with the configuration the SDK compiled, after OpenShell
  # created its sandbox.
  assert {
    condition = (
      alltrue([
        for agent in values(module.observed.agents) :
        agent.start != null && module.observed.openshell.fabric_starts[agent.id] == 1
      ])
      && fabric_agent.assistant.sandbox == openshell_sandbox.assistant.ref
      && fabric_agent.assistant.models["primary"].base_url == "${module.observed.http.endpoint}/v1"
      && module.observed.agents.assistant.start.command == ["/opt/fabric/bin/fabric-agent-ctl", "start", "--agent", "assistant", "--config", "-"]
      && module.observed.agents.assistant.start.configuration == jsondecode(terraform_data.agent_assistant.input)
      && index(module.observed.openshell.rpcs, "CreateProvider") < index(module.observed.openshell.rpcs, "CreateSandbox")
      && index(module.observed.openshell.rpcs, "CreateSandbox") < index(module.observed.openshell.rpcs, "ExecSandbox")
    )
    error_message = "A Fabric agent did not start in its sandbox with its compiled configuration."
  }

  assert {
    condition     = module.observed.http.requests == []
    error_message = "Configuring and starting the agents called the inference upstream."
  }
}

# The agent's runtime exits inside its sandbox, which keeps running.
run "stop_agent" {
  command = plan

  module {
    source = "./cases/docker-openclaw-nvidia"
  }

  variables {
    fault   = "stop_agent_runtimes"
    effects = run.verify.effects
  }

  plan_options {
    target = [data.fixture_state.setup]
  }

  # A targeted plan evaluates no module outputs, so read the data source.
  assert {
    condition     = jsondecode(data.fixture_state.setup.observations).openshell.effects == var.effects
    error_message = "The second apply changed gateway objects."
  }
}

# Apply starts the agent again.
run "restart_agent" {
  module {
    source = "./cases/docker-openclaw-nvidia"
  }
}

# This apply reads what the restart left: no changed gateway objects, and the
# agent started again in its original sandbox.
run "restarted" {
  module {
    source = "./cases/docker-openclaw-nvidia"
  }

  variables {
    effects = run.restart_agent.effects
  }

  assert {
    condition = (
      module.observed.openshell.effects == var.effects
      && length(module.observed.openshell.created_sandboxes) == 1
      && module.observed.openshell.fabric_starts[module.observed.agents.assistant.id] == 2
    )
    error_message = "The restart changed gateway objects, or the agent did not start again in its sandbox."
  }
}

# Nothing was left to do: the apply after the restart started nothing.
run "settled" {
  command = plan

  module {
    source = "./cases/docker-openclaw-nvidia"
  }

  variables {
    effects = run.restarted.effects
  }

  assert {
    condition = (
      module.observed.openshell.effects == var.effects
      && module.observed.openshell.fabric_starts[module.observed.agents.assistant.id] == 2
    )
    error_message = "The apply after the restart changed gateway objects or started the agent again."
  }
}

# OpenTofu removes what the last applying run applied, with its variables:
# this run permits deletion, as the SDK's teardown graph does. It refers to no
# earlier run, which would stop OpenTofu's cleanup.
run "teardown" {
  module {
    source = "./cases/docker-openclaw-nvidia"
  }

  variables {
    permit_destroy = true
  }
}
