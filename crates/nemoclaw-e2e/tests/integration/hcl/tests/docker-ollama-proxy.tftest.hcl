# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# An authenticating proxy in front of an existing Ollama daemon. The proxy's
# key lives in a retained volume, the agent's registration reads it from
# there, and it never reaches OpenTofu state. An unchanged apply changes
# nothing. Replacing the proxy container keeps the volume, the key, and the
# registration, and leaves the agent alone.

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

# Every proxy container the mock creates is the one the engine holds, with the
# key in its /data volume.
override_resource {
  target = docker_container.ollama_proxy_ollama-auth
  values = { id = "fixture-ollama-auth-container" }
}

run "fixtures" {
  command = plan

  module {
    source = "./cases/docker-ollama-proxy"
  }

  plan_options {
    target = [data.fixture_state.setup]
  }
}

run "deploy" {
  module {
    source = "./cases/docker-ollama-proxy"
  }
}

run "verify" {
  module {
    source = "./cases/docker-ollama-proxy"
  }

  assert {
    condition = (
      length(module.observed.registrations) == 1
      && one(values(module.observed.registrations)).config["OPENAI_BASE_URL"] == "http://127.0.0.1:11435/v1"
    )
    error_message = "The agent's registration does not name the proxy's endpoint."
  }

  assert {
    condition     = values(one(values(module.observed.registrations)).credentials) == ["file:${module.fixtures.prefix}-ollama-proxy-ollama-auth:/data/inference-key"]
    error_message = "The registration does not hold the key from the proxy's /data volume."
  }

  assert {
    condition     = contains(module.observed.engine.volumes, "${module.fixtures.prefix}-ollama-proxy-ollama-auth-auth")
    error_message = "The proxy's key volume was not created."
  }

  # The readiness check reads the key, but neither it nor any resource that
  # names the proxy keeps it, so it never reaches OpenTofu state.
  assert {
    condition = !anytrue([
      for value in [
        data.ollama_proxy_readiness.ollama_proxy_ollama-auth,
        data.ollama_proxy_runtime.ollama_proxy_ollama-auth,
        ollama_proxy_credential_storage.ollama-auth,
        docker_container.ollama_proxy_ollama-auth,
        openshell_inference.inference_local-5834fdcc94534d6506776906,
        fabric_agent.assistant,
      ] : strcontains(jsonencode(value), module.fixtures.key)
    ])
    error_message = "The proxy's key reached OpenTofu state."
  }
}

# Verify's apply changed nothing: no gateway change, no new registration, and
# no agent started again. var.baseline is what verify observed after deploy.
run "unchanged" {
  command = plan

  module {
    source = "./cases/docker-ollama-proxy"
  }

  variables {
    baseline = run.verify.baseline
  }

  assert {
    condition = (
      module.observed.openshell.effects == var.baseline.effects
      && module.observed.openshell.fabric_starts == var.baseline.fabric_starts
    )
    error_message = "An unchanged apply changed the gateway or started the agent again."
  }
}

run "replace_proxy" {
  module {
    source = "./cases/docker-ollama-proxy"
  }

  variables {
    baseline = run.verify.baseline
  }

  plan_options {
    replace = [docker_container.ollama_proxy_ollama-auth]
  }
}

# What the replacement left, compared with what verify observed after deploy.
run "retained" {
  command = plan

  module {
    source = "./cases/docker-ollama-proxy"
  }

  variables {
    baseline = run.replace_proxy.baseline
  }

  assert {
    condition = (
      contains(module.observed.engine.volumes, "${module.fixtures.prefix}-ollama-proxy-ollama-auth-auth")
      && !anytrue([for request in module.observed.engine.requests : startswith(request, "DELETE /volumes/")])
    )
    error_message = "Replacing the proxy deleted its key volume."
  }

  assert {
    condition = (
      length(module.observed.openshell.created_providers) == length(var.baseline.created_providers)
      && values(one(values(module.observed.registrations)).credentials) == ["file:${module.fixtures.prefix}-ollama-proxy-ollama-auth:/data/inference-key"]
    )
    error_message = "Replacing the proxy registered the key again, or from somewhere else."
  }

  assert {
    condition = (
      module.observed.openshell.sandboxes == var.baseline.sandboxes
      && module.observed.openshell.fabric_starts == var.baseline.fabric_starts
    )
    error_message = "Replacing the proxy replaced the agent's sandbox or started the agent again."
  }
}

# OpenTofu removes what the last applying run applied, with its variables:
# this run permits deletion, as the SDK's teardown graph does.
run "teardown" {
  module {
    source = "./cases/docker-ollama-proxy"
  }

  variables {
    permit_destroy = true
  }
}
