# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Two deployments on one gateway. In the first, the researcher's sandbox
# attaches its hosted and local registrations and the writer's only the local
# one; the second deployment's editor attaches only its own registration.
# Applying the first again after the second changes nothing. Each run asserts
# what the run before it left. OpenTofu tears down both deployments, and the
# runner checks that the gateway holds nothing afterwards.

run "fixtures" {
  command = plan

  module {
    source = "./cases/external-multiple-providers"
  }

  plan_options {
    target = [data.fixture_state.setup]
  }
}

run "deploy_first" {
  module {
    source = "./cases/external-multiple-providers"
  }
}

run "deploy_second" {
  module {
    source = "./cases/external-multiple-providers-writer"
  }

  assert {
    condition = (
      length(module.observed.registrations) == 2
      && sort(module.observed.agents.researcher.providers) == sort(keys(module.observed.registrations))
    )
    error_message = "The researcher does not attach exactly the hosted and local registrations."
  }

  assert {
    condition = tolist(module.observed.agents.writer.providers) == tolist([
      for name, registration in module.observed.registrations : name if length(registration.credentials) == 0
    ])
    error_message = "The writer does not attach only the local registration."
  }

  assert {
    condition = sort(flatten([
      for registration in values(module.observed.registrations) : values(registration.credentials)
    ])) == tolist(["env:HOSTED_API_KEY"])
    error_message = "Only the hosted registration holds a credential, from HOSTED_API_KEY."
  }
}

run "reapply_first" {
  module {
    source = "./cases/external-multiple-providers"
  }

  assert {
    condition = (
      length(module.observed.openshell.workspaces) == 2
      && module.observed.agents.editor.workspace != module.observed.agents.writer.workspace
    )
    error_message = "The second deployment does not have its own workspace."
  }

  # Registration names are scoped by workspace, so both deployments register
  # the local provider under one name. Each registration carries its own
  # deployment's owner, and each sandbox attaches only its workspace's.
  assert {
    condition = alltrue([
      for provider in module.observed.openshell.created_providers :
      provider.labels["nemoclaw.nvidia.com/uid"] == (
        provider.workspace == module.observed.agents.editor.workspace
        ? "7db61f79-1965-45ac-824a-1c3f3b26aa5d"
        : "cb18eaf0-1a4e-47b8-b254-6fe4e49bc360"
      )
    ]) && length(module.observed.openshell.created_providers) == 3
    error_message = "A registration does not carry the owner of its deployment's workspace."
  }

  assert {
    condition = alltrue(flatten([
      for sandbox in module.observed.openshell.created_sandboxes : [
        for name in sandbox.providers : contains([
          for provider in module.observed.openshell.created_providers : provider.name if provider.workspace == sandbox.workspace
        ], name)
      ]
    ]))
    error_message = "A sandbox attaches a registration outside its deployment's workspace."
  }
}

# Applying the first deployment again, after the second exists, changed no
# gateway object.
run "first_unchanged" {
  command = plan

  module {
    source = "./cases/external-multiple-providers-writer"
  }

  variables {
    baseline = run.reapply_first.gateway
  }

  assert {
    condition = (
      module.observed.openshell.effects == var.baseline.effects
      && module.observed.openshell.sandboxes == var.baseline.sandboxes
    )
    error_message = "Applying the first deployment again changed the gateway."
  }
}

# OpenTofu's cleanup reevaluates each module's last applying run's variables,
# and silently skips the destroy when one references a run whose outputs it no
# longer keeps; the runner's teardown check would report what remained.
run "teardown_second" {
  module {
    source = "./cases/external-multiple-providers-writer"
  }

  variables {
    permit_destroy = true
  }
}

run "teardown_first" {
  module {
    source = "./cases/external-multiple-providers"
  }

  variables {
    permit_destroy = true
  }
}
