# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Opens one terminal UI in each target's sandbox: hcl_live::terminal runs the
# command with the pinned OpenShell CLI's `sandbox exec --tty` in a
# pseudo-terminal, types the prompt, waits for the reply, and quits with
# Ctrl-D. A TOKEN argument becomes the token in the target's token file.
# Reports hold whether the ready text and the reply appeared and the exit
# status; the screen output and the token stay private, and the module's
# output names only the targets that failed.

terraform {
  required_version = "= 1.12.12"
}

variable "context" {
  type = object({
    probe_executable = string
    openshell        = string
    work_dir         = string
    evidence_dir     = string
  })
}

variable "connection" {
  description = "The gateway and workspace apply reports, which the OpenShell CLI selects."
  type = object({
    gatewayEndpoint = string
    workspace       = string
  })
}

variable "targets" {
  description = "By name: the sandbox, the command and its arguments, the token file a TOKEN argument stands for, the text the terminal UI shows once it can take a prompt, the prompt, and the text its reply must contain."
  type = map(object({
    sandbox    = string
    command    = list(string)
    token_path = optional(string)
    ready      = string
    prompt     = string
    reply      = string
  }))
}

resource "terraform_data" "terminal" {
  for_each         = var.targets
  triggers_replace = uuid()
  provisioner "local-exec" {
    command = "exec \"$NEMOCLAW_HCL_PROBE\" hcl_live::terminal --exact --ignored --quiet"
    environment = {
      NEMOCLAW_HCL_PROBE      = var.context.probe_executable
      NEMOCLAW_HCL_OPENSHELL  = var.context.openshell
      NEMOCLAW_HCL_ENDPOINT   = var.connection.gatewayEndpoint
      NEMOCLAW_HCL_WORKSPACE  = var.connection.workspace
      NEMOCLAW_HCL_SANDBOX    = each.value.sandbox
      NEMOCLAW_HCL_COMMAND    = jsonencode(each.value.command)
      NEMOCLAW_HCL_TOKEN_PATH = each.value.token_path == null ? "" : each.value.token_path
      NEMOCLAW_HCL_READY      = each.value.ready
      NEMOCLAW_HCL_PROMPT     = each.value.prompt
      NEMOCLAW_HCL_REPLY      = each.value.reply
      NEMOCLAW_HCL_REPORT     = "${var.context.evidence_dir}/${each.key}-${self.id}.json"
      NEMOCLAW_HCL_OUTPUT     = "${var.context.work_dir}/${self.id}.output"
    }
  }
}

locals {
  # Each report is read after its terminal UI closes: the ID is unknown until apply.
  reports = {
    for name, terminal in terraform_data.terminal :
    name => jsondecode(file("${var.context.evidence_dir}/${name}-${terminal.id}.json"))
  }
  failed = [
    for name, report in local.reports : name
    if !report.ready || !report.replied || report.exit_code != 0
  ]
}

output "failed" {
  description = "Targets whose terminal UI did not show the ready text and the reply, or did not exit 0 after Ctrl-D."
  value       = local.failed
}
