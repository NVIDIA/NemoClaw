# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# An OpenClaw agent on NVIDIA hosted inference and a Hermes agent on a managed
# Ollama service, on one managed Docker gateway.

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

override_resource {
  target = docker_container.ollama_service_ollama-server
  values = { id = "fixture-ollama-server-container" }
}

# Declare the fixtures before the deployment's first plan reads them.
run "fixtures" {
  command = plan

  module {
    source = "./cases/docker-hosted-ollama-two-agents"
  }

  plan_options {
    target = [data.fixture_state.setup]
  }
}

run "deploy" {
  module {
    source = "./cases/docker-hosted-ollama-two-agents"
  }
}

# A second apply changes nothing: it reads what deploy produced, including
# data sources that only apply reads.
run "verify" {

  module {
    source = "./cases/docker-hosted-ollama-two-agents"
  }

  # Both harnesses resolve to the one mocked sandbox pull, behind a ready
  # gateway and Ollama service.
  assert {
    condition = (
      data.fabric_harness.assistant_acquired.adapter_id == "nvidia.fabric.openclaw"
      && data.fabric_harness.researcher_acquired.adapter_id == "nvidia.fabric.hermes"
      && data.fabric_harness.researcher_acquired.image_id == data.fabric_harness.assistant_acquired.image_id
      && data.ollama_readiness.ollama_service_ollama-server.ready
      && data.openshell_docker_gateway_readiness.current.ready
    )
    error_message = "The images, the Ollama service, or the gateway did not hand off to the agents."
  }

  # One registration per provider: hosted with the environment credential,
  # Ollama at the service without one.
  assert {
    condition = (
      length(module.observed.registrations) == 2
      && openshell_inference.inference_nvidia-4bd9a6f30569077adaf61353.server.endpoint == "${module.observed.http.endpoint}/v1"
      && module.observed.registrations[openshell_inference.inference_nvidia-4bd9a6f30569077adaf61353.registration].credentials == {
        (openshell_inference.inference_nvidia-4bd9a6f30569077adaf61353.sandbox_env) = "env:NVIDIA_INFERENCE_API_KEY"
      }
      && openshell_inference.inference_local-ceb21a97a2146548236ff520.server.endpoint == "http://172.20.0.1:${data.ollama_runtime.ollama_service_ollama-server.launch.port}/v1"
      && module.observed.registrations[openshell_inference.inference_local-ceb21a97a2146548236ff520.registration].credentials == {}
    )
    error_message = "The hosted and Ollama bindings are not registered as configured."
  }

  # Each sandbox names only its own provider and may reach only its endpoint.
  assert {
    condition = (
      module.observed.agents.assistant.providers == [openshell_inference.inference_nvidia-4bd9a6f30569077adaf61353.registration]
      && module.observed.agents.assistant.policy_endpoints == ["${trimprefix(module.observed.http.endpoint, "http://")}/v1/**"]
      && module.observed.agents.researcher.providers == [openshell_inference.inference_local-ceb21a97a2146548236ff520.registration]
      && module.observed.agents.researcher.policy_endpoints == ["172.20.0.1:${data.ollama_runtime.ollama_service_ollama-server.launch.port}/v1/**"]
    )
    error_message = "A sandbox's inference binding or network access crosses to the other agent's provider."
  }

  # Fabric started each agent once, in its own sandbox, with its compiled
  # configuration and its own provider's address.
  assert {
    condition = (
      length([for agent in values(module.observed.agents) : agent if agent.start != null]) == 2
      && module.observed.agents.assistant.start.configuration == jsondecode(terraform_data.agent_assistant.input)
      && module.observed.agents.researcher.start.configuration == jsondecode(terraform_data.agent_researcher.input)
      && module.observed.agents.assistant.start.configuration.models.primary.base_url == openshell_inference.inference_nvidia-4bd9a6f30569077adaf61353.server.endpoint
      && module.observed.agents.researcher.start.configuration.harness.adapter_id == "nvidia.fabric.hermes"
      && module.observed.agents.researcher.start.configuration.models.primary.base_url == openshell_inference.inference_local-ceb21a97a2146548236ff520.server.endpoint
    )
    error_message = "A Fabric agent did not start in its own sandbox with its own configuration."
  }

  assert {
    condition     = module.observed.http.requests == []
    error_message = "Configuring and starting the agents called the inference upstream."
  }
}

# OpenTofu removes what the last applying run applied, with its variables:
# this run permits deletion, as the SDK's teardown graph does.
run "teardown" {
  module {
    source = "./cases/docker-hosted-ollama-two-agents"
  }

  variables {
    permit_destroy = true
  }
}
