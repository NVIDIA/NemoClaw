# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# Sandbox settings reach the gateway as written and report their service URLs.
# Changed, added, and removed service exposures update the sandbox in place;
# a changed mount replaces it.

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

# One apply changes research's port, returns writer to the default
# authorization mode, and adds api.
run "change_services" {
  variables {
    services = {
      research = { target_port = 9090 }
      writer   = { target_port = 7000 }
      api      = { target_port = 8642, authorization_mode = "BEARER_PASSTHROUGH" }
    }
  }
  assert {
    condition     = length(local.openshell.created_sandboxes) == 3
    error_message = "Changing exposures must keep the sandbox."
  }
  assert {
    condition = { for key, endpoint in local.openshell.services : key => endpoint if startswith(key, "team/researcher/") } == {
      "team/researcher/api"      = { target_port = 8642, authorization_mode = "SERVICE_AUTHORIZATION_MODE_BEARER_PASSTHROUGH" }
      "team/researcher/research" = { target_port = 9090, authorization_mode = "SERVICE_AUTHORIZATION_MODE_STRIP" }
      "team/researcher/writer"   = { target_port = 7000, authorization_mode = "SERVICE_AUTHORIZATION_MODE_STRIP" }
    }
    error_message = "The gateway must hold research's new port, writer's default mode, and the added api: ${jsonencode(local.openshell.services)}"
  }
  assert {
    condition = terraform_data.caller.output == tomap({
      api      = "http://team--researcher--api.services.fixture.test/"
      research = "http://team--researcher--research.services.fixture.test/"
      writer   = "http://team--researcher--writer.services.fixture.test/"
    })
    error_message = "Another resource must receive the updated URLs in the same apply."
  }
}

run "remove_services" {
  variables { services = {} }
  assert {
    condition     = length(local.openshell.created_sandboxes) == 3
    error_message = "Removing every exposure must keep the sandbox."
  }
  assert {
    condition     = [for key in keys(local.openshell.services) : key if startswith(key, "team/researcher/")] == []
    error_message = "The gateway must hold none of the removed exposures: ${jsonencode(local.openshell.services)}"
  }
  assert {
    condition     = length(terraform_data.caller.output) == 0
    error_message = "Another resource must receive no URLs."
  }
}

run "change_mount" {
  variables {
    services = {}
    target   = "/sandbox/other"
  }
  assert {
    condition     = length(local.openshell.created_sandboxes) == 4 && length(local.openshell.sandboxes) == 3
    error_message = "A changed mount must replace the sandbox."
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
