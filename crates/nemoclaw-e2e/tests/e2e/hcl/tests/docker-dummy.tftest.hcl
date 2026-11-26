# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# The reference dummy agent behind a managed Docker gateway, with its
# workspace on a named volume: apply, the configured reply, a marker written
# in the workspace, an unchanged plan, destroy that keeps only the gateway's
# storage, then a redeploy that reuses that storage with a new gateway
# container, the marker read back in the new sandbox, the reply again, and
# destroy. It needs no model or credentials; cargo ci live-docker runs it.
# Before the first destroy, sandbox requests check that the gateway's
# external middleware sees the requests its binding selects, blocks the one it
# denies and the one whose check fails (the binding is fail_closed) before the
# destination, and that an excluded destination bypasses it.

# The workspace volume, which a platform provides before apply. The agent
# image runs agents as 10001:10001 (image/fabric/Dockerfile).
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

# The agent runs after the apply process exited.
run "reply" {
  module {
    source = "./verifier"
  }

  variables {
    targets = {
      assistant = {
        agent            = "main"
        request          = { message = "dummy-lifecycle" }
        response_pointer = "/output/message"
        answer           = "dummy-reply"
      }
    }
  }

  assert {
    condition     = length(output.failed) == 0
    error_message = "failed: ${join(", ", output.failed)}"
  }
}

# The agent's user writes a marker in the workspace before destroy.
run "write_marker" {
  module {
    source = "./command"
  }

  variables {
    connection = run.apply.result.connection
    targets = {
      write = {
        sandbox  = "assistant"
        command  = ["sh", "-c", "echo nemoclaw-volume-test > /sandbox/workspace/nemoclaw-volume-test && cat /sandbox/workspace/nemoclaw-volume-test"]
        contains = "nemoclaw-volume-test\n"
      }
    }
  }

  assert {
    condition     = length(output.failed) == 0
    error_message = "failed: ${join(", ", output.failed)}"
  }
}

# The sandbox requests the case's effect recorder at the gateway network's
# host address, which the middleware binding selects, and at the default
# bridge's gateway, which it excludes. The middleware denies /deny and fails
# on /fail, which its fail_closed binding must block. /fail goes last so that
# no later request depends on how the supervisor treats a failed service.
run "middleware" {
  module {
    source = "./command"
  }

  variables {
    connection = run.apply.result.connection
    targets = {
      requests = {
        sandbox = "assistant"
        command = ["python3", "-c", <<-EOT
          import json, sys, urllib.error, urllib.request
          selected, excluded = (f"http://{e['host']}:{e['port']}" for e in json.loads(sys.argv[1]))
          for url in (f"{selected}/allow", f"{selected}/deny", f"{excluded}/bypass", f"{selected}/fail"):
              try: print(urllib.request.urlopen(url, timeout=10).status)
              except urllib.error.HTTPError as error: print(error.status)
        EOT
        , jsonencode(yamldecode(file(jsondecode(var.context).config)).spec.sandboxes.assistant.network.policy.explicit.network_policies.fixture.endpoints)]
        contains = "200\n403\n200\n403\n"
      }
    }
  }

  assert {
    condition     = length(output.failed) == 0
    error_message = "A request returned an unexpected status: ${join(", ", output.failed)}"
  }

  # hcl_live::case's fixture records each request before answering it.
  assert {
    condition = (
      { for path, count in jsondecode(file("${jsondecode(var.context).evidence_dir}/middleware-effects.json")).middleware : path => count if path != "/fail" }
      == { "/allow" = 1, "/deny" = 1 }
    )
    error_message = "Middleware must see the allowed and denied requests once each and not the excluded one: ${file("${jsondecode(var.context).evidence_dir}/middleware-effects.json")}"
  }

  # The fixture records /fail before it errors. The count is a floor because
  # OpenShell may call a failing service more than once.
  assert {
    condition     = lookup(jsondecode(file("${jsondecode(var.context).evidence_dir}/middleware-effects.json")).middleware, "/fail", 0) >= 1
    error_message = "Middleware must be called for the request it fails: ${file("${jsondecode(var.context).evidence_dir}/middleware-effects.json")}"
  }

  # Neither the denied request nor the one whose check failed may arrive.
  assert {
    condition     = jsondecode(file("${jsondecode(var.context).evidence_dir}/middleware-effects.json")).destination == { "/allow" = 1, "/bypass" = 1 }
    error_message = "The allowed and excluded requests must reach the destination once each, and neither the denied nor the failed one: ${file("${jsondecode(var.context).evidence_dir}/middleware-effects.json")}"
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

# The retained storage, with its encryption key, is refreshed rather than
# created again, and the gateway runs in a new container.
run "redeploy" {
  module {
    source = "./cli"
  }

  variables {
    operation = "apply"
  }

  assert {
    condition = (
      output.exit_code == 0 && output.result.outcome == "succeeded"
      && !contains(keys(output.changes), "openshell_gateway_storage.runtime")
      && contains(keys(output.changes), "docker_container.managed_gateway_runtime")
    )
    error_message = "Redeploy failed, created the gateway's storage again, or kept no new gateway container: ${output.error}"
  }
}

# Destroy kept the volume, and the new sandbox reads the marker that the
# destroyed one wrote.
run "read_marker" {
  module {
    source = "./command"
  }

  variables {
    connection = run.redeploy.result.connection
    targets = {
      read = {
        sandbox  = "assistant"
        command  = ["cat", "/sandbox/workspace/nemoclaw-volume-test"]
        contains = "nemoclaw-volume-test\n"
      }
    }
  }

  assert {
    condition     = length(output.failed) == 0
    error_message = "failed: ${join(", ", output.failed)}"
  }
}

run "reply_after_redeploy" {
  module {
    source = "./verifier"
  }

  variables {
    targets = {
      assistant = {
        agent            = "main"
        request          = { message = "dummy-lifecycle" }
        response_pointer = "/output/message"
        answer           = "dummy-reply"
      }
    }
  }

  assert {
    condition     = length(output.failed) == 0
    error_message = "failed: ${join(", ", output.failed)}"
  }
}

run "destroy_after_redeploy" {
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
