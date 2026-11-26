# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# An OpenClaw agent on NVIDIA hosted inference behind a managed Podman
# gateway. The openshell provider installs a Podman gateway's container
# itself, so the test overrides that resource, as Docker scenarios mock the
# Docker provider's container. Its storage is initialized on the engine, and
# the sandbox image is pulled through the mocked Docker provider, which talks
# to Podman's Docker-compatible API.

mock_provider "docker" {
  alias = "engine_23ddaef7520a85fde258e31aae3cf758"

  mock_resource "docker_image" {
    defaults = { image_id = "sha256:0000000000000000000000000000000000000000000000000000000000000001" }
  }
}

override_resource {
  target = openshell_podman_gateway.runtime
  values = { id = "fixture-podman-gateway", running = "true" }
}

# Declare the fixtures before the deployment's first plan reads them.
run "fixtures" {
  command = plan

  module {
    source = "./cases/podman-openclaw-nvidia"
  }

  plan_options {
    target = [data.fixture_state.setup]
  }
}

run "deploy" {
  module {
    source = "./cases/podman-openclaw-nvidia"
  }
}

# A second apply changes nothing: it reads what deploy produced, including
# data sources that only apply reads.
run "verify" {
  module {
    source = "./cases/podman-openclaw-nvidia"
  }

  # The real provider initialized the gateway's storage on the engine, and the
  # gateway it serves reports the Podman driver.
  assert {
    condition = (
      contains(module.observed.engine.volumes, "${module.fixtures.prefix}-gateway-data")
      && openshell_podman_gateway.runtime.id == "fixture-podman-gateway"
      && data.openshell_gateway.apply.compatible
      && contains(data.openshell_gateway.apply.compute_drivers, "podman")
    )
    error_message = "The Podman gateway's storage or driver is not as configured."
  }

  # The mocked pull's image ID reaches the real harness read.
  assert {
    condition = (
      data.fabric_harness.assistant_acquired.image == openshell_sandbox.assistant.image
      && data.fabric_harness.assistant_acquired.image_id == module.fixtures.image_id
      && data.fabric_harness.assistant_acquired.adapter_id == "nvidia.fabric.openclaw"
    )
    error_message = "The sandbox image did not hand off to the OpenClaw harnesses."
  }

  # OpenShell created the sandbox in the deployment's workspace, and Fabric
  # started its agent with the configuration the SDK compiled.
  assert {
    condition = (
      toset(keys(module.observed.agents)) == toset(module.fixtures.sandboxes)
      && module.observed.agents.assistant.workspace == openshell_workspace.deployment.name
      && module.observed.agents.assistant.labels["nemoclaw.nvidia.com/uid"] == module.fixtures.owner
      && module.observed.openshell.fabric_starts[module.observed.agents.assistant.id] == 1
      && module.observed.agents.assistant.start.configuration == jsondecode(terraform_data.agent_assistant.input)
    )
    error_message = "The sandbox or its agent differs from the configuration."
  }
}

# OpenTofu removes what the last applying run applied, with its variables:
# this run permits deletion, as the SDK's teardown graph does.
run "teardown" {
  module {
    source = "./cases/podman-openclaw-nvidia"
  }

  variables {
    permit_destroy = true
  }
}
