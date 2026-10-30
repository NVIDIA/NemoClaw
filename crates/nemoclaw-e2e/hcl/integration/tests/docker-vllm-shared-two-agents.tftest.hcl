# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# One authenticated vLLM service shared by an OpenClaw and a Hermes agent.

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
    source = "./cases/docker-vllm-shared-two-agents"
  }

  plan_options {
    target = [data.fixture_state.setup]
  }
}

run "deploy" {
  module {
    source = "./cases/docker-vllm-shared-two-agents"
  }
}

# A second apply changes nothing: it reads what deploy produced, including
# data sources that only apply reads.
run "verify" {

  module {
    source = "./cases/docker-vllm-shared-two-agents"
  }

  # One authenticated vLLM container serves both agents from the credential
  # storage the real vLLM provider created.
  assert {
    condition = (
      contains([for mount in docker_container.inference_service_inference_qwen.mounts : "${mount.source}:${mount.target}"], "${vllm_credential_storage.inference_qwen_auth.name}:/credentials")
      && contains(module.observed.engine.volumes, vllm_credential_storage.inference_qwen_auth.name)
      && data.vllm_readiness.inference_service_inference_qwen.ready
    )
    error_message = "The shared vLLM service did not become ready with its credential storage."
  }

  # Each harness has its own registration of the one service, holding the
  # generated key; each sandbox names only its own, and its agent starts with
  # that registration's key name and the shared address.
  assert {
    condition = (
      length(module.observed.registrations) == 2
      && module.observed.agents.assistant.providers != module.observed.agents.researcher.providers
      && alltrue([
        for binding in [openshell_inference.inference_qwen-b075dac4a454574dfe89ff08, openshell_inference.inference_qwen-baed0ef93c97fa7f05788644] :
        module.observed.registrations[binding.registration].credentials == {
          (binding.sandbox_env) = "file:${module.fixtures.services.qwen.name}:/credentials/inference-key"
        }
      ])
      && alltrue([
        for sandbox in ["assistant", "researcher"] :
        length(module.observed.agents[sandbox].providers) == 1
        && module.observed.agents[sandbox].policy_endpoints == ["172.30.131.1:${data.vllm_runtime.inference_service_inference_qwen.launch.port}/v1/**"]
        && module.observed.agents[sandbox].start.configuration.models.primary.base_url == "http://172.30.131.1:${data.vllm_runtime.inference_service_inference_qwen.launch.port}/v1"
        && contains([
          for binding in [openshell_inference.inference_qwen-b075dac4a454574dfe89ff08, openshell_inference.inference_qwen-baed0ef93c97fa7f05788644] :
          binding.sandbox_env if[binding.registration] == module.observed.agents[sandbox].providers
        ], module.observed.agents[sandbox].start.configuration.models.primary.api_key_env)
      ])
      && module.observed.agents.assistant.start.configuration == jsondecode(terraform_data.agent_assistant.input)
      && module.observed.agents.researcher.start.configuration == jsondecode(terraform_data.agent_researcher.input)
    )
    error_message = "The shared service's registrations, keys, bindings, or agent configurations differ from the configuration."
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
    source = "./cases/docker-vllm-shared-two-agents"
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
    source = "./cases/docker-vllm-shared-two-agents"
  }

  variables {
    permit_destroy = true
  }
}
