# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# Compiled graph through real providers; Docker workloads and model serving use fixtures.
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
  target = docker_container.inference_service_inference_local-nim
  values = { id = "fixture-local-nim-container" }
}
override_resource {
  target = docker_container.inference_service_inference_local-nim_proxy
  values = { id = "fixture-local-nim-proxy-container" }
}
run "fixtures" {
  command = plan
  module {
    source = "./cases/docker-openclaw-nim"
  }
  plan_options { target = [data.fixture_state.setup] }
}
run "deploy" {
  module {
    source = "./cases/docker-openclaw-nim"
  }
}
run "verify" {
  module {
    source = "./cases/docker-openclaw-nim"
  }
  assert {
    condition = (
      length(docker_container.inference_service_inference_local-nim.ports) == 0
      && length(docker_container.inference_service_inference_local-nim.networks_advanced) == 1
      && length(docker_container.inference_service_inference_local-nim_proxy.networks_advanced) == 2
      && [for port in docker_container.inference_service_inference_local-nim_proxy.ports : "${port.ip}:${port.external}"] == ["172.30.121.1:18888"]
      && length([for mount in docker_container.inference_service_inference_local-nim.mounts : mount if mount.target == "/run/nemoclaw/ngc-api-key" && mount.source == "/etc/nemoclaw/secrets/ngc-key-v1" && mount.read_only]) == 1
      && data.vllm_readiness.inference_service_inference_local-nim.ready
    )
    error_message = "NIM must isolate the native listener, expose only its proxy, mount an operator credential reference read-only, and pass publication readiness."
  }
  assert {
    condition = (
      one(values(module.observed.registrations)).config["OPENAI_BASE_URL"] == "http://172.30.121.1:18888/v1"
      && contains(values(one(values(module.observed.registrations)).credentials), "file:${module.fixtures.services.local-nim.name}:/credentials/inference-key")
      && module.observed.agents.assistant.start.configuration.models.primary.model == "meta/llama-3.1-8b-instruct"
      && module.observed.agents.assistant.start.configuration.models.primary.base_url == "http://172.30.121.1:18888/v1"
    )
    error_message = "The NIM agent must use its published route and retained service key."
  }
}
run "unchanged" {
  command = plan
  module {
    source = "./cases/docker-openclaw-nim"
  }
  variables { baseline = run.verify.gateway }
  assert {
    condition = (
      module.observed.openshell.effects == var.baseline.effects
      && module.observed.openshell.fabric_starts == var.baseline.fabric_starts
      && module.observed.openshell.sandboxes == var.baseline.sandboxes
    )
    error_message = "Unchanged NIM apply must preserve gateway effects, agent starts, and sandbox bindings."
  }
}
run "teardown" {
  module {
    source = "./cases/docker-openclaw-nim"
  }
  variables { permit_destroy = true }
}
