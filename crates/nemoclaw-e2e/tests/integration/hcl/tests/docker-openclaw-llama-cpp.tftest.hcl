# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# The compiled graph through real providers and fixture engine/gateway APIs.
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
  target = docker_container.inference_service_inference_muse
  values = { id = "fixture-muse-container" }
}
run "fixtures" {
  command = plan
  module {
    source = "./cases/docker-openclaw-llama-cpp"
  }
  plan_options { target = [data.fixture_state.setup] }
}
run "deploy" {
  module {
    source = "./cases/docker-openclaw-llama-cpp"
  }
}
run "verify" {
  module {
    source = "./cases/docker-openclaw-llama-cpp"
  }
  assert {
    condition = (
      docker_container.inference_service_inference_muse.env == toset(["NEMOCLAW_RUNTIME_SPEC=${data.vllm_llama_cpp_runtime.inference_service_inference_muse.spec}"])
      && toset([for mount in docker_container.inference_service_inference_muse.mounts : "${mount.source}:${mount.target}"]) == toset([
        "${docker_volume.inference_storage_inference_muse.name}:/data",
        "${vllm_credential_storage.inference_muse_auth.name}:/credentials"
      ])
      && data.vllm_readiness.inference_service_inference_muse.ready
    )
    error_message = "llama.cpp must run its typed contract with retained model and credential storage."
  }
  assert {
    condition = (
      one(values(module.observed.registrations)).config["OPENAI_BASE_URL"] == "http://172.30.121.1:18898/v1"
      && one(values(module.observed.agents)).start.configuration.models.primary.model == "muse-glimmer"
      && contains(values(one(values(module.observed.registrations)).credentials), "file:${module.fixtures.services.muse.name}:/credentials/inference-key")
    )
    error_message = "The agent route must use the managed alias and its runtime credential reference."
  }
}
run "teardown" {
  module {
    source = "./cases/docker-openclaw-llama-cpp"
  }
  variables { permit_destroy = true }
}
