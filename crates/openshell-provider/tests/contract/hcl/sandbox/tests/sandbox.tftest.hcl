# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# Sandbox settings reach the gateway as written, report their service URLs,
# and replace the sandbox when they change.

run "deploy" {
  assert {
    condition = [for sandbox in local.openshell.created_sandboxes : sandbox.driver_config if sandbox.name == "researcher"] == [{
      docker = {
        mounts      = [{ type = "volume", source = "skills", target = "/sandbox/skills" }]
        tmpfs_bytes = 1048576
      }
    }]
    error_message = "The gateway must receive the driver configuration as written."
  }
  assert {
    condition = contains(local.openshell.exposures, [
      { service = "research", target_port = 8080, authorization_mode = "SERVICE_AUTHORIZATION_MODE_UNSPECIFIED" },
      { service = "writer", target_port = 7000, authorization_mode = "SERVICE_AUTHORIZATION_MODE_BEARER_PASSTHROUGH" },
    ])
    error_message = "The creation request must carry the exposures as written, leaving an omitted authorization mode to OpenShell: ${jsonencode(local.openshell.exposures)}"
  }
  assert {
    condition = terraform_data.caller.output == tomap({
      research = "http://team--researcher--research.services.fixture.test/"
      writer   = "http://team--researcher--writer.services.fixture.test/"
    })
    error_message = "Another resource must receive the reported service URLs in the same apply."
  }
  assert {
    condition     = [for sandbox in local.openshell.created_sandboxes : sandbox.providers if sandbox.name != "researcher"] == [[], []]
    error_message = "Sandboxes without providers must attach none."
  }
  assert {
    condition = [for sandbox in local.openshell.created_sandboxes : sandbox.policy_middlewares if sandbox.name == "researcher"] == [{
      guard = {
        name       = "guard"
        middleware = "decision-guard"
        order      = 10
        on_error   = "fail_closed"
        config     = { mode = "block", terms = ["forbidden"] }
        include    = ["docs.example.com"]
        exclude    = ["trusted.example.com"]
      }
    }]
    error_message = "The gateway must receive the middleware binding as written: ${jsonencode(local.openshell.created_sandboxes)}"
  }
}

# Reading the bound policy back, including its middleware binding, finds
# nothing to change.
run "unchanged" {
  assert {
    condition     = length(local.openshell.created_sandboxes) == 3
    error_message = "An unchanged apply must keep the sandbox and its middleware binding."
  }
}

# GetSandbox reports no URLs, so a refresh reads each service endpoint.
run "refresh" {
  plan_options { mode = refresh-only }
  assert {
    condition     = length(openshell_sandbox.agent.service_urls) == 2
    error_message = "A refresh must keep the service URLs."
  }
}

run "change_service" {
  variables { services = { research = { target_port = 9090 } } }
}

run "remove_services" {
  variables { services = {} }
}

run "change_mount" {
  variables {
    services = {}
    target   = "/sandbox/other"
  }
  assert {
    condition     = length(local.openshell.created_sandboxes) == 6 && length(local.openshell.sandboxes) == 3
    error_message = "A changed service, removed services, and a changed mount must each replace the sandbox."
  }
}

# Teardown mode lets the test's cleanup delete the workspace.
run "teardown" {
  variables {
    services   = {}
    target     = "/sandbox/other"
    destroying = true
  }
}
