# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# OpenClaw on NVIDIA hosted inference behind a managed Docker gateway:
# apply, fresh hosted replies and native tools across recreate, configuration
# change and restore on retained volumes, an unchanged plan, and destroy that
# keeps only the gateway's storage. Live / HCL runs it. Skill retention stays
# separate from native startup and readiness.

run "volume" {
  module {
    source = "./volume"
  }

  variables {
    owner = "10001:10001"
  }
}

run "apply" {
  module {
    source = "./cli"
  }

  variables {
    operation = "apply"
  }

  assert {
    condition     = output.exit_code == 0 && output.result.outcome == "succeeded"
    error_message = "Apply failed: ${output.error}"
  }
}

# The probe verifies the initial runtime after the apply process exits, then
# destroys and recreates it, changes the tool configuration, and restores it.
# Each replacement must answer a fresh request and use its native tools.
run "recreate_and_restore" {
  module {
    source = "./lifecycle"
  }
}

run "unchanged_plan" {
  module {
    source = "./cli"
  }

  variables {
    operation = "plan"
  }

  assert {
    condition     = output.exit_code == 0 && output.changes == {}
    error_message = "A plan of the applied deployment has changes or failed: ${output.error}"
  }
}

run "destroy" {
  module {
    source = "./cli"
  }

  variables {
    operation = "destroy"
  }

  assert {
    condition = (
      output.exit_code == 0 && output.result.outcome == "destroyed"
      && toset(output.result.retained) == toset(["openshell_gateway_storage.runtime"])
    )
    error_message = "Destroy failed or retained other resources: ${output.error}"
  }
}
