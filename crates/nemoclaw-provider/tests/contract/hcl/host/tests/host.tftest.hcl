# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# Passing host checks. The fixtures answer reads only.

run "checks" {
  command = plan

  assert {
    condition = (
      data.host_engine.present.status == "available"
      && jsondecode(data.host_engine.present.engine_json).architecture == "arm64"
      && can(jsondecode(data.host_engine.present.hardware_json).status)
    )
    error_message = "A served engine must report its facts: ${data.host_engine.present.engine_json}"
  }
  assert {
    condition = (
      jsondecode(data.host_engine.unreachable.engine_json).status == "unknown"
      && jsondecode(data.host_engine.unreachable.hardware_json).status == "unknown"
    )
    error_message = "An engine nothing serves must be unknown, not a failed plan."
  }

  assert {
    condition     = jsondecode(data.host_image.vllm.observation_json).status == "available"
    error_message = "An image with the required label must be available: ${data.host_image.vllm.observation_json}"
  }
  assert {
    condition     = alltrue([for check in data.host_container_health.application : check.healthy])
    error_message = "A healthy container must pass each health check."
  }
  assert {
    condition = data.vllm_readiness.qwen.ref == {
      type              = "inference_server"
      endpoint          = "http://10.0.0.8:18898/v1"
      model             = "qwen"
      credential_env    = ""
      credential_source = ""
    }
    error_message = "A server listing its model must be ready, and its ref must name the address sandboxes use."
  }
}

# OpenShell owns destination checks: the gateway-host alias is a valid
# address for sandboxes.
run "gateway_host_alias" {
  command = plan
  variables { sandbox_endpoint = "http://host.openshell.internal:18898/v1" }
  assert {
    condition     = data.vllm_readiness.qwen.ref.endpoint == "http://host.openshell.internal:18898/v1"
    error_message = "Readiness must accept the gateway-host alias."
  }
}
