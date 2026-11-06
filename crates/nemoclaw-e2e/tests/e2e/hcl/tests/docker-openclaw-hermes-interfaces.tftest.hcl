# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# OpenClaw's and Hermes's native interfaces, reached as apply reports them:
# apply lists each interface; with the pinned OpenShell CLI's forward and
# the token apply names, OpenClaw's Control UI loads and serves its
# configuration, Hermes's API server lists its models and answers a chat
# completion with the stub model's reply, and Hermes's dashboard page loads
# with its session token. The stub refuses requests without the run's key,
# so the reply also shows NemoClaw sent the configured key. In each sandbox,
# the agent's user can write and read a file in the agent's workspace, and
# the key is not in the environment a command sees. Destroy keeps only the
# gateway's storage. cargo ci live-docker runs it.

run "model" {
  module {
    source = "./model"
  }

  variables {
    key   = var.model_key
    reply = "nemoclaw-stub-reply"
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

  assert {
    condition = toset([
      for access in try(output.result.interfaces, []) :
      "${access.sandbox}/${access.interface}/${try(access.port, "")}/${access.signIn}/${can(access.tokenPath)}"
      ]) == toset([
      "claw/dashboard/18789/token_in_url_fragment/true",
      "hermes/api/8642/bearer_token/true",
      "hermes/dashboard/9119/none/false",
    ])
    error_message = "Apply must report each interface with its port, sign-in, and token file."
  }
}

run "interfaces" {
  module {
    source = "./interface"
  }

  variables {
    connection = run.apply.result.connection
    targets = {
      control_ui = {
        sandbox    = "claw"
        port       = 18789
        token_path = null
        path       = "/"
        contains   = "<"
      }
      control_ui_config = {
        sandbox    = "claw"
        port       = 18789
        token_path = one([for access in run.apply.result.interfaces : access.tokenPath if access.sandbox == "claw"])
        path       = "/control-ui-config.json"
        contains   = "basePath"
      }
      api_models = {
        sandbox    = "hermes"
        port       = 8642
        token_path = one([for access in run.apply.result.interfaces : access.tokenPath if access.sandbox == "hermes" && access.interface == "api"])
        path       = "/v1/models"
      }
      api_chat = {
        sandbox    = "hermes"
        port       = 8642
        token_path = one([for access in run.apply.result.interfaces : access.tokenPath if access.sandbox == "hermes" && access.interface == "api"])
        path       = "/v1/chat/completions"
        body = {
          model    = "hermes-agent"
          messages = [{ role = "user", content = "Reply to this NemoClaw live test." }]
        }
        answer = "nemoclaw-stub-reply"
      }
      dashboard = {
        sandbox    = "hermes"
        port       = 9119
        token_path = null
        path       = "/"
        contains   = "__HERMES_SESSION_TOKEN__"
      }
    }
  }

  assert {
    condition     = length(output.failed) == 0
    error_message = "failed: ${join(", ", output.failed)}"
  }
}

# The SDK's Fabric configuration (crates/nemoclaw-sdk/src/fabric_config.rs)
# makes /sandbox/workspace each agent's workspace, and the agent image runs
# agents as UID 10001 (image/fabric/runtime.json). A sandbox sees the model
# registration's key in a NEMOCLAW_INFERENCE_MODEL_..._KEY variable
# (crates/nemoclaw-openshell/src/profile.rs); the environment must have that
# variable but not the key itself.
run "commands" {
  module {
    source = "./command"
  }

  variables {
    connection = run.apply.result.connection
    targets = {
      claw_workspace = {
        sandbox  = "claw"
        command  = ["sh", "-c", "echo nemoclaw-live-test > /sandbox/workspace/nemoclaw-live-test && cat /sandbox/workspace/nemoclaw-live-test && id -u"]
        contains = "nemoclaw-live-test\n10001\n"
      }
      claw_environment = {
        sandbox  = "claw"
        command  = ["env"]
        contains = "NEMOCLAW_INFERENCE_MODEL_"
        excludes = var.model_key
      }
      hermes_workspace = {
        sandbox  = "hermes"
        command  = ["sh", "-c", "echo nemoclaw-live-test > /sandbox/workspace/nemoclaw-live-test && cat /sandbox/workspace/nemoclaw-live-test && id -u"]
        contains = "nemoclaw-live-test\n10001\n"
      }
      hermes_environment = {
        sandbox  = "hermes"
        command  = ["env"]
        contains = "NEMOCLAW_INFERENCE_MODEL_"
        excludes = var.model_key
      }
    }
  }

  assert {
    condition     = length(output.failed) == 0
    error_message = "failed: ${join(", ", output.failed)}"
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
