# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# Sandbox settings reach the gateway as written, report their service URLs,
# and replace the sandbox when they change. Each observe_ run applies the
# previous run's configuration again and reads the fake gateway.

run "deploy" {}

run "observe_deployed" {
  assert {
    condition = local.gateway_state.sandboxes["team/researcher"].driver_config == {
      docker = {
        mounts      = [{ type = "volume", source = "skills", target = "/sandbox/skills" }]
        tmpfs_bytes = 1048576
      }
    }
    error_message = "The gateway must receive the driver configuration as written."
  }
  assert {
    condition = contains(local.gateway_state.exposures, [
      { service = "research", target_port = 8080, authorization_mode = "SERVICE_AUTHORIZATION_MODE_UNSPECIFIED" },
      { service = "writer", target_port = 7000, authorization_mode = "SERVICE_AUTHORIZATION_MODE_BEARER_PASSTHROUGH" },
    ])
    error_message = "The creation request must carry the exposures as written, leaving an omitted authorization mode to OpenShell: ${jsonencode(local.gateway_state.exposures)}"
  }
  assert {
    condition = terraform_data.caller.output == tomap({
      research = "http://team--researcher--research.services.fixture.test/"
      writer   = "http://team--researcher--writer.services.fixture.test/"
    })
    error_message = "Another resource must receive the reported service URLs in the same apply."
  }
  assert {
    condition     = local.gateway_state.sandboxes["team/omitted"].providers == [] && local.gateway_state.sandboxes["team/empty"].providers == []
    error_message = "Sandboxes without providers must attach none."
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

run "change_mount" {
  variables { target = "/sandbox/other" }
}

run "change_service" {
  variables {
    target   = "/sandbox/other"
    services = { research = { target_port = 9090 } }
  }
}

run "remove_services" {
  variables {
    target   = "/sandbox/other"
    services = {}
  }
}

run "observe_replacements" {
  variables {
    target     = "/sandbox/other"
    services   = {}
    destroying = true
  }
  assert {
    condition     = local.gateway_state.created.sandboxes == 6 && length(local.gateway_state.sandboxes) == 3
    error_message = "A changed mount, a changed service, and removed services must each replace the sandbox: ${local.gateway_state.created.sandboxes} created."
  }
}
