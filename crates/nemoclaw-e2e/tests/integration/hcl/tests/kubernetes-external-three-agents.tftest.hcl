# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# The three-agent example for an external Kubernetes gateway, compiled
# unchanged: assistant, researcher, and reviewer share one registration. This
# scenario owns unchanged reconciliation, recovery of what the gateway lost,
# and one agent's replacement leaving the others alone. Each run asserts what
# the run before it left: a run's observations are read when it plans. Runs
# compare with what verify observed after deploy through var.baseline, which
# each applying run passes on as its baseline output.

variables {
  # Long enough that sandboxes created together overlap.
  sandbox_create_delay_ms = 500
}

run "fixtures" {
  command = plan

  module {
    source = "./examples/kubernetes/external-gateway"
  }

  plan_options {
    target = [data.fixture_state.setup]
  }
}

run "deploy" {
  module {
    source = "./examples/kubernetes/external-gateway"
  }
}

run "verify" {
  module {
    source = "./examples/kubernetes/external-gateway"
  }

  assert {
    condition     = length(module.observed.registrations) == 1
    error_message = "The three agents do not share one registration."
  }

  assert {
    condition     = one(values(module.observed.registrations)).config["OPENAI_BASE_URL"] == "${module.observed.http.endpoint}/v1"
    error_message = "The registration does not name the inference endpoint."
  }

  assert {
    condition = one(values(module.observed.registrations)).credentials == {
      (fabric_agent.assistant.models["primary"].api_key_env) = "env:INFERENCE_API_KEY"
    }
    error_message = "The registration does not hold the credential from INFERENCE_API_KEY under the agents' key name."
  }

  assert {
    condition = {
      for name, agent in module.observed.agents : name => agent.providers
      } == {
      for name in ["assistant", "researcher", "reviewer"] : name => [one(values(module.observed.registrations)).name]
    }
    error_message = "A sandbox is missing, or does not name exactly the shared registration."
  }

  assert {
    condition = alltrue([
      for agent in values(module.observed.agents) :
      contains(agent.policy_endpoints, "${trimprefix(module.observed.http.endpoint, "http://")}/v1/**")
    ])
    error_message = "A sandbox's policy does not allow the inference endpoint."
  }

  assert {
    condition = {
      for name, agent in module.observed.agents : name => [
        agent.start.configuration.metadata.name,
        agent.start.configuration.models.default.base_url,
      ]
      } == {
      assistant  = ["main", "${module.observed.http.endpoint}/v1"]
      researcher = ["researcher", "${module.observed.http.endpoint}/v1"]
      reviewer   = ["reviewer", "${module.observed.http.endpoint}/v1"]
    }
    error_message = "An agent did not start with its own name and the inference endpoint."
  }

  assert {
    condition     = module.observed.agents.assistant.start.configuration == jsondecode(terraform_data.agent_assistant.input)
    error_message = "The assistant did not start with the configuration the SDK compiled."
  }

  assert {
    condition     = module.observed.openshell.peak_sandbox_creates >= 2
    error_message = "Independent sandboxes were created one at a time."
  }

  assert {
    condition     = module.observed.http.requests == []
    error_message = "Deploying called the inference upstream."
  }

  assert {
    condition = alltrue([
      for exec in module.observed.openshell.execs : !anytrue([
        for argument in exec.command :
        contains(["probe", "health", "--message"], argument) || strcontains(argument, "-probe")
      ])
    ])
    error_message = "Deploying ran an inference or runtime probe in a sandbox."
  }
}

# Verify's apply changed nothing: no gateway mutation and no agent start since
# deploy. The same run then stops the researcher's runtime inside its sandbox,
# and changes the reviewer's model inside its sandbox, outside OpenTofu.
run "stop_researcher_runtime" {
  command = plan

  module {
    source = "./examples/kubernetes/external-gateway"
  }

  variables {
    gateway_change = { stop_agent_runtime = "researcher", change_agent_model = "reviewer" }
    baseline       = run.verify.baseline
  }

  plan_options {
    target = [data.fixture_state.setup]
  }

  assert {
    condition     = jsondecode(data.fixture_state.setup.observations).openshell.effects == var.baseline.effects
    error_message = "An unchanged apply changed the gateway."
  }

  assert {
    condition     = jsondecode(data.fixture_state.setup.observations).openshell.fabric_starts == var.baseline.fabric_starts
    error_message = "An unchanged apply started an agent."
  }
}

run "restart_researcher" {
  module {
    source = "./examples/kubernetes/external-gateway"
  }

  variables {
    baseline = run.verify.baseline
  }
}

# The researcher's agent started again in the same sandbox; the others did not
# start again. Fabric reports no applied configuration, so the reviewer's
# changed model is not drift. The same run then makes the gateway forget the registration.
run "forget_registration" {
  command = plan

  module {
    source = "./examples/kubernetes/external-gateway"
  }

  variables {
    gateway_change = { forget_registrations = true }
    baseline       = run.restart_researcher.baseline
  }

  plan_options {
    target = [data.fixture_state.setup]
  }

  assert {
    condition     = jsondecode(data.fixture_state.setup.observations).openshell.sandboxes == var.baseline.sandboxes
    error_message = "Restarting the researcher's agent, or the reviewer's model changed inside its sandbox, replaced a sandbox."
  }

  assert {
    condition = {
      for name, id in var.baseline.sandboxes : name => jsondecode(data.fixture_state.setup.observations).openshell.fabric_starts[id]
    } == { assistant = 1, researcher = 2, reviewer = 1 }
    error_message = "Only the stopped researcher should have started again; the reviewer's changed model is not drift."
  }
}

run "reregister" {
  module {
    source = "./examples/kubernetes/external-gateway"
  }

  variables {
    baseline = run.restart_researcher.baseline
  }
}

# The registration was created again under its name, and no sandbox changed.
# This run then replaces only the researcher's sandbox.
run "replace_researcher" {
  module {
    source = "./examples/kubernetes/external-gateway"
  }

  variables {
    baseline = run.reregister.baseline
  }

  plan_options {
    replace = [openshell_sandbox.researcher]
  }

  assert {
    condition = (
      tolist(keys(module.observed.registrations)) == tolist(var.baseline.registrations)
      && length(module.observed.openshell.created_providers) == 2
    )
    error_message = "The forgotten registration was not created again under its name."
  }

  assert {
    condition     = module.observed.openshell.sandboxes == var.baseline.sandboxes
    error_message = "Registering again replaced a sandbox."
  }
}

# The researcher runs in a new sandbox. The assistant and reviewer kept their
# sandboxes and agents, which were neither stopped nor started, and the shared
# registration stayed. OpenTofu's cleanup reevaluates this last run's
# variables and silently skips the destroy when one references a run whose
# outputs it no longer keeps, so this run compares only with what the fixtures
# recorded.
run "teardown" {
  module {
    source = "./examples/kubernetes/external-gateway"
  }

  variables {
    permit_destroy = true
  }

  assert {
    condition = {
      for name in ["assistant", "researcher", "reviewer"] :
      name => length([for sandbox in module.observed.openshell.created_sandboxes : sandbox if sandbox.name == name])
    } == { assistant = 1, researcher = 2, reviewer = 1 }
    error_message = "Replacing the researcher did not create exactly one sandbox, the researcher's."
  }

  assert {
    condition     = [for exec in module.observed.openshell.execs : exec.sandbox if contains(exec.command, "stop")] == ["researcher"]
    error_message = "An agent other than the researcher's was stopped."
  }

  assert {
    condition = [
      for name in ["assistant", "reviewer", "researcher"] :
      module.observed.openshell.fabric_starts[module.observed.openshell.sandboxes[name]]
    ] == [1, 1, 1]
    error_message = "The researcher's agent did not start once in its new sandbox, or another agent started again."
  }

  assert {
    condition     = length(module.observed.openshell.created_providers) == 2
    error_message = "Replacing the researcher's sandbox registered inference again."
  }
}
