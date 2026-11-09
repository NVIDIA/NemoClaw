# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# The live E2E local scenario: one OpenClaw agent on an unauthenticated managed
# vLLM service behind a managed Docker gateway.

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
  target = docker_container.inference_service_inference_qwen
  values = { id = "fixture-qwen-container" }
}

# Declare the fixtures before the deployment's first plan reads them.
run "fixtures" {
  command = plan

  module {
    source = "./cases/docker-openclaw-vllm"
  }

  plan_options {
    target = [data.fixture_state.setup]
  }
}

run "deploy" {
  module {
    source = "./cases/docker-openclaw-vllm"
  }
}

# A second apply changes nothing: it reads what deploy produced, including
# data sources that only apply reads.
run "verify" {

  module {
    source = "./cases/docker-openclaw-vllm"
  }

  # Without authentication the vLLM container mounts only its data volume,
  # no credential storage exists, and readiness reads its status but no key.
  assert {
    condition = (
      docker_container.inference_service_inference_qwen.image == module.fixtures.image_id
      && docker_container.inference_service_inference_qwen.env == toset(["NEMOCLAW_RUNTIME_SPEC=${data.vllm_runtime.inference_service_inference_qwen.spec}"])
      && [for mount in docker_container.inference_service_inference_qwen.mounts : "${mount.source}:${mount.target}"] == ["${docker_volume.inference_storage_inference_qwen.name}:/data"]
      && [for port in docker_container.inference_service_inference_qwen.ports : "${port.ip}:${port.external}"] == ["172.30.121.1:${data.vllm_runtime.inference_service_inference_qwen.launch.port}"]
      && module.observed.engine.volumes == ["${module.fixtures.prefix}-gateway-data"]
      && data.vllm_readiness.inference_service_inference_qwen.ready
      && contains(module.observed.engine.requests, "GET /containers/fixture-qwen-container/archive?path=%2Fdata%2Fstatus.json")
      && length([for request in module.observed.engine.requests : request if strcontains(request, "inference-key")]) == 0
    )
    error_message = "The vLLM container's inputs or readiness differ from an unauthenticated service."
  }

  # OpenShell registered the service's address without a credential, the
  # isolated sandbox may reach only that address, and Fabric started the agent
  # with that address and model.
  assert {
    condition = (
      length(module.observed.registrations) == 1
      && one(values(module.observed.registrations)).config["OPENAI_BASE_URL"] == "http://172.30.121.1:${data.vllm_runtime.inference_service_inference_qwen.launch.port}/v1"
      && one(values(module.observed.registrations)).credentials == {}
      && module.observed.agents.assistant.providers == [one(values(module.observed.registrations)).name]
      && module.observed.agents.assistant.policy_endpoints == ["172.30.121.1:${data.vllm_runtime.inference_service_inference_qwen.launch.port}/v1/**"]
      && module.observed.agents.assistant.start.configuration == jsondecode(terraform_data.agent_assistant.input)
      && module.observed.agents.assistant.start.configuration.models.primary.base_url == "http://172.30.121.1:${data.vllm_runtime.inference_service_inference_qwen.launch.port}/v1"
      && module.observed.agents.assistant.start.configuration.models.primary.model == "Qwen/Qwen3-4B"
    )
    error_message = "The vLLM binding, the sandbox's access to it, or the agent's configuration differs from the service."
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
    source = "./cases/docker-openclaw-vllm"
  }

  variables {
    permit_destroy = true
  }
}
