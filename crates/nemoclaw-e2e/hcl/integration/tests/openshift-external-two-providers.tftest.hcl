# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# An OpenShift gateway with an Anthropic Messages and an NVIDIA provider.
# The gateway uses no engine, so nothing is mocked.

# Declare the fixtures before the deployment's first plan reads them.
run "fixtures" {
  command = plan

  module {
    source = "./cases/openshift-external-two-providers"
  }

  plan_options {
    target = [data.fixture_state.setup]
  }
}

run "deploy" {
  module {
    source = "./cases/openshift-external-two-providers"
  }
}

# A second apply changes nothing: it reads what deploy produced, including
# data sources that only apply reads.
run "verify" {

  module {
    source = "./cases/openshift-external-two-providers"
  }

  assert {
    condition = (
      data.openshell_gateway.apply.compatible
      && module.observed.engine.requests == []
      && data.fabric_harness.researcher.adapter_id == "nvidia.fabric.hermes"
    )
    error_message = "The OpenShift gateway or the harnesses from the metadata bundle were not found."
  }

  # Each registration holds its own API's base URL and the credential from its
  # provider's environment variable.
  assert {
    condition = alltrue([
      for binding in [
        openshell_inference.inference_hosted-a709e032675b6402ba79e0e7,
        openshell_inference.inference_nvidia-2406835b0b5ea2fc5d28d9fe,
        openshell_inference.inference_nvidia-8f0a5f5bd85d88c70c88b494,
      ] :
      module.observed.registrations[binding.registration].credentials == { (binding.sandbox_env) = "env:${binding.server.credential_env}" }
      && contains(values(module.observed.registrations[binding.registration].config), binding.server.endpoint)
    ]) && openshell_inference.inference_hosted-a709e032675b6402ba79e0e7.api == "anthropic-messages"
    error_message = "A registration's API, base URL, or credential differs from its provider."
  }

  # The OpenClaw sandbox names the Anthropic binding and one NVIDIA binding;
  # the Hermes sandbox names only its own NVIDIA binding.
  assert {
    condition = (
      contains(module.observed.agents.assistant.providers, openshell_inference.inference_hosted-a709e032675b6402ba79e0e7.registration)
      && length(module.observed.agents.assistant.providers) == 2
      && length(module.observed.agents.researcher.providers) == 1
      && length(setintersection(module.observed.agents.assistant.providers, module.observed.agents.researcher.providers)) == 0
    )
    error_message = "A sandbox names another agent's binding or misses its own."
  }

  # The fixtures serve both providers at one address, the only one either
  # sandbox may reach.
  assert {
    condition = alltrue([
      for agent in values(module.observed.agents) :
      toset(agent.policy_endpoints) == toset(["${trimprefix(module.observed.http.endpoint, "http://")}/v1/**"])
    ])
    error_message = "A sandbox's network policy allows more than its providers' address."
  }

  # OpenClaw starts with both routes, Anthropic by default; Hermes with one.
  assert {
    condition = (
      module.observed.agents.assistant.start.configuration == jsondecode(terraform_data.agent_assistant.input)
      && module.observed.agents.researcher.start.configuration == jsondecode(terraform_data.agent_researcher.input)
      && module.observed.agents.assistant.start.configuration.models.smart.api_key_env == openshell_inference.inference_hosted-a709e032675b6402ba79e0e7.sandbox_env
      && module.observed.agents.assistant.start.configuration.models.default == module.observed.agents.assistant.start.configuration.models.smart
      && module.observed.http.requests == []
    )
    error_message = "An agent did not start with its routes and key names, or inference was called."
  }
}

# This plan reads what verify's apply left: it changed no gateway objects.
run "unchanged" {
  command = plan

  module {
    source = "./cases/openshift-external-two-providers"
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
    source = "./cases/openshift-external-two-providers"
  }

  variables {
    permit_destroy = true
  }
}
