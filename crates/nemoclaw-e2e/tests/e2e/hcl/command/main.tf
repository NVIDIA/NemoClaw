# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Runs one fixed command in each target's sandbox: hcl_live::command runs it
# with the pinned OpenShell CLI's `sandbox exec`, as a person would, or on a
# managed Kubernetes gateway through the SDK's port-forward. Reports hold the
# exit status and whether the output contained the expected text and not the
# forbidden text; the output stays private, and the module's output names
# only the targets that failed.

terraform {
  required_version = "= 1.12.12"
}

variable "context" {
  type = object({
    config           = string
    state_dir        = string
    probe_executable = string
    openshell        = string
    work_dir         = string
    evidence_dir     = string
  })
}

variable "connection" {
  description = "The gateway and workspace apply reports, which the OpenShell CLI selects; a managed Kubernetes gateway needs none."
  type = object({
    gatewayEndpoint = string
    workspace       = string
  })
  default = null
}

variable "targets" {
  description = "By name: the sandbox, the command and its arguments, and optionally text the output must contain and text it must not contain, which may be sensitive."
  type        = any
}

resource "terraform_data" "command" {
  for_each         = var.targets
  triggers_replace = uuid()
  provisioner "local-exec" {
    command = "exec \"$NEMOCLAW_HCL_PROBE\" hcl_live::command --exact --ignored --quiet"
    environment = {
      NEMOCLAW_HCL_PROBE     = var.context.probe_executable
      NEMOCLAW_HCL_OPENSHELL = var.context.openshell
      NEMOCLAW_HCL_CONFIG    = var.context.config
      NEMOCLAW_HCL_STATE     = var.context.state_dir
      NEMOCLAW_HCL_ENDPOINT  = var.connection == null ? "" : var.connection.gatewayEndpoint
      NEMOCLAW_HCL_WORKSPACE = var.connection == null ? "" : var.connection.workspace
      NEMOCLAW_HCL_SANDBOX   = each.value.sandbox
      NEMOCLAW_HCL_COMMAND   = jsonencode(each.value.command)
      NEMOCLAW_HCL_CONTAINS  = try(each.value.contains, null) == null ? "" : each.value.contains
      NEMOCLAW_HCL_EXCLUDES  = try(each.value.excludes, null) == null ? "" : each.value.excludes
      NEMOCLAW_HCL_REPORT    = "${var.context.evidence_dir}/${each.key}-${self.id}.json"
      NEMOCLAW_HCL_OUTPUT    = "${var.context.work_dir}/${self.id}.output"
    }
  }
}

locals {
  # Each report is read after its command: the ID is unknown until apply.
  failed = [
    for name, command in terraform_data.command : name
    if !jsondecode(file("${var.context.evidence_dir}/${name}-${command.id}.json")).matched
    || jsondecode(file("${var.context.evidence_dir}/${name}-${command.id}.json")).exit_code != 0
  ]
}

output "failed" {
  description = "Targets whose command did not exit 0 with the expected output."
  value       = local.failed
}
