# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# A managed Ollama service and one OpenClaw agent on a managed Docker gateway.

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
    source = "./cases/docker-openclaw-ollama"
  }

  plan_options {
    target = [data.fixture_state.setup]
  }
}

run "deploy" {
  module {
    source = "./cases/docker-openclaw-ollama"
  }
}

# A second apply changes nothing: it reads what deploy produced, including
# data sources that only apply reads.
run "verify" {

  module {
    source = "./cases/docker-openclaw-ollama"
  }

  # Docker inputs: the Ollama container runs the acquired image with the
  # runtime launch the real Ollama provider computed, on the service volume,
  # GPUs, and the gateway network's host address.
  assert {
    condition = (
      docker_container.ollama_service_ollama-server.image == module.fixtures.image_id
      && docker_container.ollama_service_ollama-server.entrypoint == data.ollama_runtime.ollama_service_ollama-server.launch.entrypoint
      && docker_container.ollama_service_ollama-server.env == toset(["NEMOCLAW_RUNTIME_SPEC=${data.ollama_runtime.ollama_service_ollama-server.spec}"])
      && [for mount in docker_container.ollama_service_ollama-server.mounts : "${mount.source}:${mount.target}"] == ["${docker_volume.ollama_service_storage_ollama-server.name}:${data.ollama_runtime.ollama_service_ollama-server.launch.data_path}"]
      && [for port in docker_container.ollama_service_ollama-server.ports : "${port.ip}:${port.external}"] == ["172.20.0.1:${data.ollama_runtime.ollama_service_ollama-server.launch.port}"]
      && docker_container.ollama_service_ollama-server.gpus == "all"
      && data.ollama_runtime.ollama_service_ollama-server.requirements.gpu
    )
    error_message = "The Ollama container's Docker inputs do not match its runtime launch."
  }

  # The real host provider found the acquired runtime image on the engine,
  # and readiness read the mocked container and its runtime status by ID.
  assert {
    condition = (
      jsondecode(data.host_image.runtime_image_acquired_ollama_service_ollama-server.observation_json).status == "available"
      && data.ollama_readiness.ollama_service_ollama-server.container_id == docker_container.ollama_service_ollama-server.id
      && data.ollama_readiness.ollama_service_ollama-server.ready
      && contains(module.observed.engine.requests, "GET /containers/fixture-ollama-server-container/archive?path=%2Fdata%2Fstatus.json")
    )
    error_message = "The Ollama image or container did not hand off to a ready service."
  }

  # OpenShell registered the service's address without a credential, the
  # sandbox may reach only that address, and Fabric started the agent with
  # that address and model.
  assert {
    condition = (
      openshell_inference.inference_local-5834fdcc94534d6506776906.server.endpoint == "http://172.20.0.1:${data.ollama_runtime.ollama_service_ollama-server.launch.port}/v1"
      && keys(module.observed.registrations) == [openshell_inference.inference_local-5834fdcc94534d6506776906.registration]
      && values(module.observed.registrations)[0].config["OPENAI_BASE_URL"] == openshell_inference.inference_local-5834fdcc94534d6506776906.server.endpoint
      && values(module.observed.registrations)[0].credentials == {}
      && module.observed.agents.assistant.providers == [openshell_inference.inference_local-5834fdcc94534d6506776906.registration]
      && module.observed.agents.assistant.policy_endpoints == ["172.20.0.1:${data.ollama_runtime.ollama_service_ollama-server.launch.port}/v1/**"]
      && module.observed.agents.assistant.start.command == ["/opt/fabric/bin/fabric-agent-ctl", "start", "--agent", "main", "--config", "-"]
      && module.observed.agents.assistant.start.configuration == jsondecode(terraform_data.agent_assistant.input)
      && module.observed.agents.assistant.start.configuration.models.primary.base_url == openshell_inference.inference_local-5834fdcc94534d6506776906.server.endpoint
      && module.observed.agents.assistant.start.configuration.models.primary.model == "qwen3:0.6b"
    )
    error_message = "The Ollama binding, the sandbox's access to it, or the agent's configuration differs from the service."
  }

  assert {
    condition     = module.observed.http.requests == []
    error_message = "A deployment without hosted inference called the inference upstream."
  }
}

# OpenTofu removes what the last applying run applied, with its variables:
# this run permits deletion, as the SDK's teardown graph does.
run "teardown" {
  module {
    source = "./cases/docker-openclaw-ollama"
  }

  variables {
    permit_destroy = true
  }
}
