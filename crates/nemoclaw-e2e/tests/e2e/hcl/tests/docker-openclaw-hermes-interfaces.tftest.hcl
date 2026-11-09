# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# OpenClaw's and Hermes's native interfaces, reached as apply reports them:
# apply lists each interface; with the pinned OpenShell CLI's forward and
# the token apply names, OpenClaw's Control UI loads and serves its
# configuration, Hermes's API server lists its models and answers a chat
# completion with the stub model's reply, and Hermes's dashboard page loads
# with its session token. OpenClaw's terminal UI, opened with the dashboard's
# token through `openshell sandbox exec --tty`, shows the stub's reply to a
# prompt and exits on Ctrl-D. The stub refuses requests without the run's key,
# so the reply also shows NemoClaw sent the configured key. In each sandbox,
# the agent's user can write and read a file in the agent's workspace, and
# the key is not in the environment a command sees. In hermes, a command can
# open a pseudo-terminal, as browser chat does. In claw, python3 reaches
# the stub at a path only the document grants, and OpenShell refuses its
# connection to the managed gateway, which no grant names. Destroy keeps only
# the gateway's storage. cargo ci live-docker runs it.
#
# Each agent starts with two skills.paths entries, each on its own volume: a
# folder of skills and a folder that is one skill. OpenClaw's folder holds
# two skills and a file that isn't one; Hermes's is empty.

# The skills volumes, which a platform provides before apply. The agent images
# run agents as 10001:10001 (image/fabric/Dockerfile).
run "volume" {
  module {
    source = "./volume"
  }

  variables {
    owner = "10001:10001"
    files = {
      "claw:/sandbox/skills" = {
        "summarize/SKILL.md" = "---\nname: summarize\ndescription: Summarize the workspace.\n---\n\nSummarize the workspace.\n"
        "translate/SKILL.md" = "---\nname: translate\ndescription: Translate the reply.\n---\n\nTranslate the reply.\n"
        "README.md"          = "Skills shared by the deployment's agents.\n"
      }
      "claw:/sandbox/review-skill" = {
        "SKILL.md" = "---\nname: review\ndescription: Review the change.\n---\n\nReview the change.\n"
      }
      "hermes:/sandbox/notes-skill" = {
        "SKILL.md" = "---\nname: notes\ndescription: Keep notes.\n---\n\nKeep notes.\n"
      }
    }
  }
}

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

# OpenClaw's terminal UI is a client of the Gateway that serves the Control
# UI, at the dashboard's port and with its token; its status line reads
# "connected | idle" once it can take a prompt.
run "terminal" {
  module {
    source = "./terminal"
  }

  variables {
    connection = run.apply.result.connection
    targets = {
      openclaw_tui = {
        sandbox    = "claw"
        command    = ["openclaw", "tui", "--url", "ws://127.0.0.1:18789", "--token", "TOKEN"]
        token_path = one([for access in run.apply.result.interfaces : access.tokenPath if access.sandbox == "claw"])
        ready      = "connected | idle"
        prompt     = "Reply to this NemoClaw live test."
        reply      = "nemoclaw-stub-reply"
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
#
# Hermes's browser chat runs its terminal UI in a pseudo-terminal, which needs
# the read-write access to /dev/pts that the Hermes image's default policy
# grants (image/fabric/Dockerfile's adapters.json).
#
# Each sandbox's managed inference grant gives the image's executables,
# python3 among them, the model's /v1/** paths. Only claw's document also
# grants python3 the stub's /health; the stub refuses requests without the
# key, so its 401 shows that python3 reached it. The managed gateway listens
# at the gateway network's second address (crates/nemoclaw-sdk/src/config/mod.rs),
# which the sandbox's OpenShell proxy can reach but no grant names; OpenShell
# refuses the connection with EACCES.
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
      hermes_pseudo_terminal = {
        sandbox  = "hermes"
        command  = ["python3", "-c", "import os; os.openpty(); print('pty-ok')"]
        contains = "pty-ok\n"
      }
      claw_granted_endpoint = {
        sandbox = "claw"
        command = ["python3", "-c", <<-EOT
          import errno, sys, urllib.error, urllib.request
          try: print(urllib.request.urlopen(sys.argv[1], timeout=10).status)
          except urllib.error.HTTPError as error: print(error.status)
          except urllib.error.URLError as error: print(errno.errorcode.get(error.reason.errno, error.reason))
        EOT
        , "${trimsuffix(yamldecode(file(jsondecode(var.context).config)).spec.inferenceProviders.model.endpoint, "/v1")}/health"]
        contains = "401\n"
      }
      claw_undeclared_host = {
        sandbox = "claw"
        command = ["python3", "-c", <<-EOT
          import errno, sys, urllib.error, urllib.request
          try: print(urllib.request.urlopen(sys.argv[1], timeout=10).status)
          except urllib.error.HTTPError as error: print(error.status)
          except urllib.error.URLError as error: print(errno.errorcode.get(error.reason.errno, error.reason))
        EOT
        , "http://${cidrhost(yamldecode(file(jsondecode(var.context).config)).spec.gateway.networkCIDR, 2)}${regex(":[0-9]+$", run.apply.result.connection.gatewayEndpoint)}/"]
        contains = "EACCES\n"
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
