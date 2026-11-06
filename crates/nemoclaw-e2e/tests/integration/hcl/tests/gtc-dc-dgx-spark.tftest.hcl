# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# The GTC DC DGX Spark examples, examples/gtc-dc/*-dgx-spark.yaml, compiled
# unchanged and planned against the fixtures with the real OpenShell, Fabric,
# host, and vLLM providers. Each plan must create a managed Docker gateway, the
# Nemotron Super vLLM service that the vLLM provider validated for the
# dgx-spark profile, and one sandbox whose agent uses that service. Nothing is
# applied: the GPU, the model download, and inference need the target host.

# Docker is mocked. Its alias follows from the runner's engine socket.
mock_provider "docker" {
  alias = "engine_23ddaef7520a85fde258e31aae3cf758"

  mock_resource "docker_image" {
    defaults = { image_id = "sha256:0000000000000000000000000000000000000000000000000000000000000001" }
  }
}

# Declare the fixtures for the hermes example before its plan reads them.
run "hermes_fixtures" {
  command = plan

  module {
    source = "./examples/gtc-dc/hermes-dgx-spark"
  }

  plan_options {
    target = [data.fixture_state.setup]
  }
}

run "hermes" {
  command = plan

  module {
    source = "./examples/gtc-dc/hermes-dgx-spark"
  }

  assert {
    condition     = docker_container.managed_gateway_runtime.name == "${module.fixtures.prefix}-gateway"
    error_message = "The plan does not create the deployment's managed gateway."
  }

  assert {
    condition = (
      docker_container.inference_service_inference_super.name == module.fixtures.services.super.name
      && jsondecode(data.vllm_runtime.inference_service_inference_super.spec).hardware.profile == "dgx-spark"
      && jsondecode(data.vllm_runtime.inference_service_inference_super.spec).model.repository == "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4"
    )
    error_message = "The plan does not create the Nemotron Super vLLM service for the dgx-spark profile."
  }

  assert {
    condition = (
      openshell_sandbox.assistant.name == "assistant"
      && data.fabric_harness.assistant_acquired.adapter_id == "nvidia.fabric.hermes"
      && fabric_agent.assistant.models["primary"].model == "nemotron-3-super"
      && fabric_agent.assistant.models["primary"].base_url == "http://172.30.181.1:19102/v1"
    )
    error_message = "The plan does not create the hermes sandbox with its agent on the vLLM service."
  }
}

# Declare the fixtures for the openclaw example before its plan reads them.
run "openclaw_fixtures" {
  command = plan

  module {
    source = "./examples/gtc-dc/openclaw-dgx-spark"
  }

  plan_options {
    target = [data.fixture_state.setup]
  }
}

run "openclaw" {
  command = plan

  module {
    source = "./examples/gtc-dc/openclaw-dgx-spark"
  }

  assert {
    condition     = docker_container.managed_gateway_runtime.name == "${module.fixtures.prefix}-gateway"
    error_message = "The plan does not create the deployment's managed gateway."
  }

  assert {
    condition = (
      docker_container.inference_service_inference_super.name == module.fixtures.services.super.name
      && jsondecode(data.vllm_runtime.inference_service_inference_super.spec).hardware.profile == "dgx-spark"
      && jsondecode(data.vllm_runtime.inference_service_inference_super.spec).model.repository == "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4"
    )
    error_message = "The plan does not create the Nemotron Super vLLM service for the dgx-spark profile."
  }

  assert {
    condition = (
      openshell_sandbox.assistant.name == "assistant"
      && data.fabric_harness.assistant_acquired.adapter_id == "nvidia.fabric.openclaw"
      && fabric_agent.assistant.models["primary"].model == "nemotron-3-super"
      && fabric_agent.assistant.models["primary"].base_url == "http://172.30.183.1:19104/v1"
    )
    error_message = "The plan does not create the openclaw sandbox with its agent on the vLLM service."
  }
}

# Declare the fixtures for the deepagents example before its plan reads them.
run "deepagents_fixtures" {
  command = plan

  module {
    source = "./examples/gtc-dc/deepagents-dgx-spark"
  }

  plan_options {
    target = [data.fixture_state.setup]
  }
}

run "deepagents" {
  command = plan

  module {
    source = "./examples/gtc-dc/deepagents-dgx-spark"
  }

  assert {
    condition     = docker_container.managed_gateway_runtime.name == "${module.fixtures.prefix}-gateway"
    error_message = "The plan does not create the deployment's managed gateway."
  }

  assert {
    condition = (
      docker_container.inference_service_inference_super.name == module.fixtures.services.super.name
      && jsondecode(data.vllm_runtime.inference_service_inference_super.spec).hardware.profile == "dgx-spark"
      && jsondecode(data.vllm_runtime.inference_service_inference_super.spec).model.repository == "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4"
    )
    error_message = "The plan does not create the Nemotron Super vLLM service for the dgx-spark profile."
  }

  assert {
    condition = (
      openshell_sandbox.assistant.name == "assistant"
      && data.fabric_harness.assistant_acquired.adapter_id == "nvidia.fabric.langchain.deepagents"
      && fabric_agent.assistant.models["primary"].model == "nemotron-3-super"
      && fabric_agent.assistant.models["primary"].base_url == "http://172.30.185.1:19106/v1"
    )
    error_message = "The plan does not create the deepagents sandbox with its agent on the vLLM service."
  }
}
