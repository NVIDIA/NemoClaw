# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# A managed vLLM service with bearer authentication and one OpenClaw agent.

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
    source = "./cases/docker-openclaw-vllm-bearer"
  }

  plan_options {
    target = [data.fixture_state.setup]
  }
}

run "deploy" {
  module {
    source = "./cases/docker-openclaw-vllm-bearer"
  }
}

# A second apply changes nothing: it reads what deploy produced, including
# data sources that only apply reads.
run "verify" {

  module {
    source = "./cases/docker-openclaw-vllm-bearer"
  }

  # Docker inputs: the vLLM container runs the acquired image with the
  # runtime launch the real vLLM provider computed, on its data volume and the
  # credential storage that provider created, with GPUs, at the gateway
  # network's host address.
  assert {
    condition = (
      docker_container.inference_service_inference_qwen.image == module.fixtures.image_id
      && docker_container.inference_service_inference_qwen.env == toset(["NEMOCLAW_RUNTIME_SPEC=${data.vllm_runtime.inference_service_inference_qwen.spec}"])
      && toset([for mount in docker_container.inference_service_inference_qwen.mounts : "${mount.source}:${mount.target}"]) == toset([
        "${docker_volume.inference_storage_inference_qwen.name}:/data",
        "${vllm_credential_storage.inference_qwen_auth.name}:/credentials",
      ])
      && [for port in docker_container.inference_service_inference_qwen.ports : "${port.ip}:${port.external}"] == ["172.30.131.1:${data.vllm_runtime.inference_service_inference_qwen.launch.port}"]
      && docker_container.inference_service_inference_qwen.gpus == "all"
    )
    error_message = "The vLLM container's Docker inputs do not match its runtime launch and credential storage."
  }

  # The real vLLM provider created the credential volume on the engine, and
  # readiness read the mocked container's status and generated key by ID.
  assert {
    condition = (
      contains(module.observed.engine.volumes, vllm_credential_storage.inference_qwen_auth.name)
      && jsondecode(data.host_image.runtime_image_acquired_inference_service_inference_qwen.observation_json).status == "available"
      && data.vllm_readiness.inference_service_inference_qwen.container_id == docker_container.inference_service_inference_qwen.id
      && data.vllm_readiness.inference_service_inference_qwen.ready
      && contains(module.observed.engine.requests, "GET /containers/fixture-qwen-container/archive?path=%2Fdata%2Fstatus.json")
      && contains(module.observed.engine.requests, "GET /containers/fixture-qwen-container/archive?path=%2Fcredentials%2Finference-key")
    )
    error_message = "The vLLM credential storage or container did not hand off to a ready service."
  }

  # OpenShell registered the service's address with the key the runtime
  # generated, the sandbox may reach only that address, and Fabric started the
  # agent with the address, model, and the sandbox's name for the key.
  assert {
    condition = (
      openshell_inference.inference_qwen-b075dac4a454574dfe89ff08.server.endpoint == "http://172.30.131.1:${data.vllm_runtime.inference_service_inference_qwen.launch.port}/v1"
      && keys(module.observed.registrations) == [openshell_inference.inference_qwen-b075dac4a454574dfe89ff08.registration]
      && values(module.observed.registrations)[0].config["OPENAI_BASE_URL"] == openshell_inference.inference_qwen-b075dac4a454574dfe89ff08.server.endpoint
      && values(module.observed.registrations)[0].credentials == {
        (openshell_inference.inference_qwen-b075dac4a454574dfe89ff08.sandbox_env) = "file:${module.fixtures.services.qwen.name}:/credentials/inference-key"
      }
      && module.observed.agents.assistant.providers == [openshell_inference.inference_qwen-b075dac4a454574dfe89ff08.registration]
      && module.observed.agents.assistant.policy_endpoints == ["172.30.131.1:${data.vllm_runtime.inference_service_inference_qwen.launch.port}/v1/**"]
      && module.observed.agents.assistant.start.configuration == jsondecode(terraform_data.agent_assistant.input)
      && module.observed.agents.assistant.start.configuration.models.primary.base_url == openshell_inference.inference_qwen-b075dac4a454574dfe89ff08.server.endpoint
      && module.observed.agents.assistant.start.configuration.models.primary.api_key_env == openshell_inference.inference_qwen-b075dac4a454574dfe89ff08.sandbox_env
      && module.observed.agents.assistant.start.configuration.models.primary.model == "Qwen/Qwen3-4B"
    )
    error_message = "The vLLM binding, its key, the sandbox's access, or the agent's configuration differs from the service."
  }

  assert {
    condition     = module.observed.http.requests == []
    error_message = "A deployment without hosted inference called the inference upstream."
  }
}

# This plan reads what verify's apply left: it changed no gateway objects.
run "unchanged" {
  command = plan

  module {
    source = "./cases/docker-openclaw-vllm-bearer"
  }

  variables {
    effects = run.verify.effects
  }

  assert {
    condition     = module.observed.openshell.effects == var.effects
    error_message = "The second apply changed gateway objects."
  }
}

# OpenTofu removes what the last applying run applied, with its variables:
# this run permits deletion, as the SDK's teardown graph does. It refers to no
# earlier run, which would stop OpenTofu's cleanup.
run "teardown" {
  module {
    source = "./cases/docker-openclaw-vllm-bearer"
  }

  variables {
    permit_destroy = true
  }
}
