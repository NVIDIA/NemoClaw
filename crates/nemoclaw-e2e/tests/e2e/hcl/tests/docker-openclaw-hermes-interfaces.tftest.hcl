# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# OpenClaw's and Hermes's native interfaces, reached as apply reports them:
# apply lists each interface; with the pinned OpenShell CLI's forward and
# the token apply names, OpenClaw's Control UI loads and serves its
# configuration, Hermes's API server lists its models and answers a chat
# completion with the stub model's reply, and Hermes's dashboard page loads
# with a session token that then opens the notes skill as its volume holds
# it and starts a browser chat that answers a prompt with the stub's reply.
# No token that a token file holds is in the deployment's state or apply's
# output. OpenClaw's terminal UI, opened with the dashboard's token through
# `openshell sandbox exec --tty`, shows the stub's reply to a prompt and exits
# on Ctrl-D, and so does Hermes's, opened with the command apply reports for
# its terminal interface. The stub refuses requests without the run's key, so
# the reply also shows NemoClaw sent the configured key. OpenClaw, in claw,
# and Hermes, in hermes-messages, reach the stub through an anthropic
# provider, and hermes-messages's API server answers a chat completion with
# the stub's reply too; the stub accepts a Messages request's key only in
# x-api-key, so OpenClaw's and Hermes's replies show that each called
# Anthropic's Messages API with the key where the provider places it.
# In claw and hermes,
# the agent's user can write and read a file in the agent's workspace, and
# the key is not in the environment a command sees. In claw, python3 reaches
# the stub at a path only the document grants, and OpenShell refuses its
# connection to the managed gateway, which no grant names. Destroy keeps only
# the gateway's storage. cargo ci live-docker runs it.
#
# Each agent starts with two skills.directories entries, each on its own
# volume: a writable folder of skills and one skill, read-only for OpenClaw
# and writable for Hermes. OpenClaw's folder holds two skills and a
# file that isn't one; Hermes's is empty. Each skill's description is a
# marker that the stub looks for in requests, so the replies in OpenClaw's
# terminal UI and from Hermes's API server name the skills that each running
# harness found on its volumes and offered the model. The agent's user can
# write to each skill volume except OpenClaw's read-only one, which refuses
# the write with EROFS.
#
# Then one change to the claw and hermes agents' instructions, as a person
# edits the document, replaces both their sandboxes, and hermes-messages's
# binding stays as it was. Before the change, apply records each sandbox's ID
# and its agent's runtime ID, the agent's user writes a marker in each
# workspace and artifacts volume, each sandbox reads its supplied skills'
# hashes, each agent answers through Fabric from its recorded runtime, and a
# plan has no changes. After the change, state names a new sandbox and
# runtime for each changed agent, and every agent answers from its recorded
# runtime, a changed one with the stub's reply naming the skills it found
# again and the changed instructions. Their interfaces answer through the
# forwards and token files that the change's apply reports, and the gateway
# no longer lists the old sandboxes, whose runtimes went with them. In the new
# sandboxes, the markers and the skills' hashes are as before, and Hermes's
# kept native home still holds what its first runtime recorded of an earlier
# request and of the prompt typed in its terminal UI. tofu test removes the
# caller's volumes after the case.

# The skills volumes, which a platform provides before apply. The agent images
# run agents as 10001:10001 (image/fabric/Dockerfile). OpenClaw's bundled
# skills take precedence over skills of the same name in skills.directories,
# so no skill here shares a name with one of them.
run "volume" {
  module {
    source = "./volume"
  }

  variables {
    owner = "10001:10001"
    files = {
      "claw:/sandbox/skills" = {
        "digest/SKILL.md"    = "---\nname: digest\ndescription: nemoclaw-skill-digest\n---\n\nDigest the workspace.\n"
        "translate/SKILL.md" = "---\nname: translate\ndescription: nemoclaw-skill-translate\n---\n\nTranslate the reply.\n"
        "README.md"          = "Skills shared by the deployment's agents.\n"
      }
      "claw:/sandbox/review-skill" = {
        "SKILL.md" = "---\nname: review\ndescription: nemoclaw-skill-review\n---\n\nReview the change.\n"
      }
      "hermes:/sandbox/notes-skill" = {
        "SKILL.md" = "---\nname: notes\ndescription: nemoclaw-skill-notes\n---\n\nKeep notes.\n"
      }
    }
  }
}

run "model" {
  module {
    source = "./model"
  }

  # A completion names each skill whose description its request holds,
  # instructions when the request holds the instructions of a change below,
  # and browser and tui when it holds the browser chat's or the terminal UI's
  # prompt.
  variables {
    key   = var.model_key
    reply = "nemoclaw-stub-reply"
    markers = {
      browser      = "nemoclaw-browser-turn"
      digest       = "nemoclaw-skill-digest"
      instructions = "nemoclaw-instructions-changed"
      notes        = "nemoclaw-skill-notes"
      review       = "nemoclaw-skill-review"
      translate    = "nemoclaw-skill-translate"
      tui          = "nemoclaw-tui-turn"
    }
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
      "hermes/terminal//terminal_command/false",
      "hermes-messages/api/8642/bearer_token/true",
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
    reported   = run.apply.result
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
      # Hermes offers one skill: notes, on its own volume.
      api_chat = {
        sandbox    = "hermes"
        port       = 8642
        token_path = one([for access in run.apply.result.interfaces : access.tokenPath if access.sandbox == "hermes" && access.interface == "api"])
        path       = "/v1/chat/completions"
        body = {
          model    = "hermes-agent"
          messages = [{ role = "user", content = "Reply to this NemoClaw live test." }]
        }
        answer = "nemoclaw-stub-reply notes"
      }
      # This agent has no skills, so the reply names none.
      messages_chat = {
        sandbox    = "hermes-messages"
        port       = 8642
        token_path = one([for access in run.apply.result.interfaces : access.tokenPath if access.sandbox == "hermes-messages"])
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
      # A browser reads the dashboard's session token from its page; with it,
      # the dashboard's skill editor opens notes from its volume.
      dashboard_skill = {
        sandbox    = "hermes"
        port       = 9119
        token_path = null
        page_token = "__HERMES_SESSION_TOKEN__"
        path       = "/api/skills/content?name=notes"
        contains   = "\"content\":${jsonencode(run.volume.files["hermes:/sandbox/notes-skill"]["SKILL.md"])},\"path\":\"/sandbox/notes-skill/SKILL.md\""
      }
      # Browser chat runs Hermes's terminal UI in a pseudo-terminal behind
      # /api/pty, which takes the page's session token and the page's origin.
      # The reply names the prompt's marker, so this turn's prompt reached the
      # model. The pseudo-terminal needs the read-write /dev/pts that the
      # Hermes image's default policy grants (image/fabric/Dockerfile's
      # adapters.json).
      browser_chat = {
        sandbox    = "hermes"
        port       = 9119
        token_path = null
        page_token = "__HERMES_SESSION_TOKEN__"
        path       = "/api/pty"
        prompt     = "Reply to nemoclaw-browser-turn."
        contains   = "nemoclaw-stub-reply browser notes"
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
# "connected | idle" once it can take a prompt. OpenClaw offers three skills:
# review, on its own volume, and digest and translate, in its folder.
# Hermes's terminal UI opens with the command apply reports, Fabric's attach
# helper, which reads the backend's token itself; its status line reads
# "ready" once the agent has started. The prompt's marker makes the stub name
# it, so the reply answers this prompt, and the kept native home must hold it
# after the replacement below.
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
        reply      = "nemoclaw-stub-reply digest review translate"
      }
      hermes_tui = {
        sandbox = "hermes"
        command = split(" ", one([for access in run.apply.result.interfaces : access.terminal if access.sandbox == "hermes" && access.interface == "terminal"]))
        ready   = "ready"
        prompt  = "Reply to nemoclaw-tui-turn."
        reply   = "nemoclaw-stub-reply notes tui"
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
# agents as UID 10001 (image/fabric/runtime.json). A sandbox sees its
# provider registration's key in a NEMOCLAW_INFERENCE_<PROVIDER>_..._KEY
# variable (crates/nemoclaw-openshell/src/profile.rs), MESSAGES for claw and
# MODEL for hermes; the environment must have that variable but not the key
# itself.
#
# Each sandbox's managed inference grant gives the image's executables,
# python3 among them, its provider endpoint's paths. Only claw's document also
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
        contains = "NEMOCLAW_INFERENCE_MESSAGES_"
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
      # The case mounts every skill volume writable but OpenClaw's review skill.
      claw_skill_volumes = {
        sandbox = "claw"
        command = ["python3", "-c", <<-EOT
          import errno, sys
          for folder in sys.argv[1:]:
              try: open(f"{folder}/nemoclaw-live-test", "w").close(); print(folder, "writable")
              except OSError as error: print(folder, errno.errorcode[error.errno])
        EOT
        , "/sandbox/skills", "/sandbox/review-skill"]
        contains = "/sandbox/skills writable\n/sandbox/review-skill EROFS\n"
      }
      hermes_skill_volumes = {
        sandbox = "hermes"
        command = ["python3", "-c", <<-EOT
          import errno, sys
          for folder in sys.argv[1:]:
              try: open(f"{folder}/nemoclaw-live-test", "w").close(); print(folder, "writable")
              except OSError as error: print(folder, errno.errorcode[error.errno])
        EOT
        , "/sandbox/skills", "/sandbox/notes-skill"]
        contains = "/sandbox/skills writable\n/sandbox/notes-skill writable\n"
      }
      # What a replacement must keep: a marker in each artifacts volume,
      # beside the workspace marker above, and the supplied skills' bytes.
      claw_artifacts = {
        sandbox  = "claw"
        command  = ["sh", "-c", "echo nemoclaw-live-test > /sandbox/artifacts/nemoclaw-live-test && cat /sandbox/artifacts/nemoclaw-live-test"]
        contains = "nemoclaw-live-test\n"
      }
      hermes_artifacts = {
        sandbox  = "hermes"
        command  = ["sh", "-c", "echo nemoclaw-live-test > /sandbox/artifacts/nemoclaw-live-test && cat /sandbox/artifacts/nemoclaw-live-test"]
        contains = "nemoclaw-live-test\n"
      }
      claw_skill_hashes = {
        sandbox  = "claw"
        command  = ["sha256sum", "/sandbox/review-skill/SKILL.md", "/sandbox/skills/digest/SKILL.md", "/sandbox/skills/translate/SKILL.md"]
        contains = "${sha256(run.volume.files["claw:/sandbox/review-skill"]["SKILL.md"])}  /sandbox/review-skill/SKILL.md\n${sha256(run.volume.files["claw:/sandbox/skills"]["digest/SKILL.md"])}  /sandbox/skills/digest/SKILL.md\n${sha256(run.volume.files["claw:/sandbox/skills"]["translate/SKILL.md"])}  /sandbox/skills/translate/SKILL.md\n"
      }
      hermes_skill_hashes = {
        sandbox  = "hermes"
        command  = ["sha256sum", "/sandbox/notes-skill/SKILL.md"]
        contains = "${sha256(run.volume.files["hermes:/sandbox/notes-skill"]["SKILL.md"])}  /sandbox/notes-skill/SKILL.md\n"
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

# Each agent answers through Fabric from the runtime that state records.
# Hermes's request text is a marker that its kept native home must still hold
# after the replacement.
run "replies" {
  module {
    source = "./verifier"
  }

  variables {
    targets = {
      claw = {
        agent            = "main"
        request          = "Reply to this NemoClaw live test."
        response_pointer = "/output/response"
        answer           = "nemoclaw-stub-reply digest review translate"
      }
      hermes = {
        agent            = "hermes"
        request          = "Reply to nemoclaw-kept-home-check."
        response_pointer = "/output/response"
        answer           = "nemoclaw-stub-reply notes"
      }
    }
  }

  assert {
    condition     = length(output.failed) == 0
    error_message = "failed: ${join(", ", output.failed)}"
  }
}

# The bindings that apply recorded, which each change compares against.
run "unchanged_plan" {
  module {
    source = "./cli"
  }

  variables {
    operation = "plan"
    baseline  = run.apply.bindings
  }

  assert {
    condition     = output.exit_code == 0 && output.changes == {}
    error_message = "A plan of the applied deployment has changes or failed: ${output.error}"
  }
}

# Changing an agent's instructions replaces only its sandbox
# (crates/nemoclaw-sdk/src/compile.rs), so one change to both agents' replaces
# both their sandboxes and leaves hermes-messages's as it was. The stub names
# the instructions' marker, so a reply shows that the runtime which gave it
# started with them.
run "replace" {
  module {
    source = "./cli"
  }

  variables {
    operation = "apply"
    agent_changes = {
      for name in ["claw", "hermes"] : name => {
        instructions = { system = { mode = "replace", content = "Answer as the nemoclaw-instructions-changed agent." } }
      }
    }
    baseline = run.unchanged_plan.baseline
  }

  assert {
    condition     = output.exit_code == 0 && output.result.outcome == "succeeded"
    error_message = "The change's apply failed: ${output.error}"
  }

  assert {
    condition     = alltrue([for name in ["claw", "hermes"] : output.bindings[name].sandbox != var.baseline[name].sandbox])
    error_message = "The change did not replace both changed agents' sandboxes."
  }

  assert {
    condition     = alltrue([for name in ["claw", "hermes"] : output.bindings[name].runtime != var.baseline[name].runtime])
    error_message = "A changed agent still records the runtime from before the change."
  }

  assert {
    condition     = alltrue([for name in ["claw", "hermes"] : output.bindings[name].agent_sandbox == output.bindings[name].sandbox])
    error_message = "A changed agent does not name its new sandbox."
  }

  assert {
    condition     = output.bindings["hermes-messages"] == var.baseline["hermes-messages"]
    error_message = "The change replaced hermes-messages's sandbox or restarted its agent."
  }
}

run "replies_after_replacement" {
  module {
    source = "./verifier"
  }

  variables {
    targets = {
      claw = {
        agent            = "main"
        request          = "Reply to this NemoClaw live test."
        response_pointer = "/output/response"
        answer           = "nemoclaw-stub-reply digest instructions review translate"
      }
      hermes = {
        agent            = "hermes"
        request          = "Reply to this NemoClaw live test."
        response_pointer = "/output/response"
        answer           = "nemoclaw-stub-reply instructions notes"
      }
      hermes-messages = {
        agent            = "hermes-messages"
        request          = "Reply to this NemoClaw live test."
        response_pointer = "/output/response"
        answer           = "nemoclaw-stub-reply"
      }
    }
  }

  assert {
    condition     = length(output.failed) == 0
    error_message = "failed: ${join(", ", output.failed)}"
  }
}

# Each changed agent's interfaces answer through the port and token file that
# the change's apply reports: Hermes's API server with the new instructions,
# its dashboard opening notes again from its volume, and OpenClaw's Control
# UI.
run "access_after_replacement" {
  module {
    source = "./interface"
  }

  variables {
    connection = run.replace.result.connection
    reported   = run.replace.result
    targets = {
      api_chat = {
        sandbox    = "hermes"
        port       = one([for access in run.replace.result.interfaces : access.port if access.sandbox == "hermes" && access.interface == "api"])
        token_path = one([for access in run.replace.result.interfaces : access.tokenPath if access.sandbox == "hermes" && access.interface == "api"])
        path       = "/v1/chat/completions"
        body = {
          model    = "hermes-agent"
          messages = [{ role = "user", content = "Reply to this NemoClaw live test." }]
        }
        answer = "nemoclaw-stub-reply instructions notes"
      }
      dashboard_skill = {
        sandbox    = "hermes"
        port       = one([for access in run.replace.result.interfaces : access.port if access.sandbox == "hermes" && access.interface == "dashboard"])
        token_path = null
        page_token = "__HERMES_SESSION_TOKEN__"
        path       = "/api/skills/content?name=notes"
        contains   = "\"content\":${jsonencode(run.volume.files["hermes:/sandbox/notes-skill"]["SKILL.md"])},\"path\":\"/sandbox/notes-skill/SKILL.md\""
      }
      control_ui_config = {
        sandbox    = "claw"
        port       = one([for access in run.replace.result.interfaces : access.port if access.sandbox == "claw"])
        token_path = one([for access in run.replace.result.interfaces : access.tokenPath if access.sandbox == "claw"])
        path       = "/control-ui-config.json"
        contains   = "basePath"
      }
    }
  }

  assert {
    condition     = length(output.failed) == 0
    error_message = "failed: ${join(", ", output.failed)}"
  }
}

# Read without the agents, in the new sandboxes and through the gateway. The
# kept native home is <artifacts>/.fabric/state/<adapter>/<agent name>
# (NeMo Fabric's runtime.keep_state), which Hermes's first runtime wrote the
# earlier request and the terminal UI's prompt into; the prompt there shows
# that the terminal UI's turn ran on the runtime's Hermes home.
run "kept_after_replacement" {
  module {
    source = "./command"
  }

  variables {
    connection = run.replace.result.connection
    targets = {
      claw_markers = {
        sandbox  = "claw"
        command  = ["cat", "/sandbox/workspace/nemoclaw-live-test", "/sandbox/artifacts/nemoclaw-live-test"]
        contains = "nemoclaw-live-test\nnemoclaw-live-test\n"
      }
      hermes_markers = {
        sandbox  = "hermes"
        command  = ["cat", "/sandbox/workspace/nemoclaw-live-test", "/sandbox/artifacts/nemoclaw-live-test"]
        contains = "nemoclaw-live-test\nnemoclaw-live-test\n"
      }
      claw_skill_hashes = {
        sandbox  = "claw"
        command  = ["sha256sum", "/sandbox/review-skill/SKILL.md", "/sandbox/skills/digest/SKILL.md", "/sandbox/skills/translate/SKILL.md"]
        contains = "${sha256(run.volume.files["claw:/sandbox/review-skill"]["SKILL.md"])}  /sandbox/review-skill/SKILL.md\n${sha256(run.volume.files["claw:/sandbox/skills"]["digest/SKILL.md"])}  /sandbox/skills/digest/SKILL.md\n${sha256(run.volume.files["claw:/sandbox/skills"]["translate/SKILL.md"])}  /sandbox/skills/translate/SKILL.md\n"
      }
      hermes_skill_hashes = {
        sandbox  = "hermes"
        command  = ["sha256sum", "/sandbox/notes-skill/SKILL.md"]
        contains = "${sha256(run.volume.files["hermes:/sandbox/notes-skill"]["SKILL.md"])}  /sandbox/notes-skill/SKILL.md\n"
      }
      hermes_kept_home = {
        sandbox  = "hermes"
        command  = ["grep", "-rlF", "nemoclaw-kept-home-check", "/sandbox/artifacts/.fabric/state/nvidia.fabric.hermes/hermes"]
        contains = "/sandbox/artifacts/.fabric/state/nvidia.fabric.hermes/hermes/"
      }
      hermes_tui_home = {
        sandbox  = "hermes"
        command  = ["grep", "-rlF", "nemoclaw-tui-turn", "/sandbox/artifacts/.fabric/state/nvidia.fabric.hermes/hermes"]
        contains = "/sandbox/artifacts/.fabric/state/nvidia.fabric.hermes/hermes/"
      }
      old_claw_sandbox = {
        sandbox  = null
        command  = ["sandbox", "list", "--ids"]
        contains = run.replace.bindings.claw.sandbox
        excludes = run.replace.baseline.claw.sandbox
      }
      old_hermes_sandbox = {
        sandbox  = null
        command  = ["sandbox", "list", "--ids"]
        contains = run.replace.bindings.hermes.sandbox
        excludes = run.replace.baseline.hermes.sandbox
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
