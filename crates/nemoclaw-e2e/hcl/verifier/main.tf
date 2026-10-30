# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

terraform {
  required_version = "= 1.12.9"
}

variable "context" {
  type = object({
    config           = string
    state_dir        = string
    probe_executable = string
    evidence_dir     = string
  })
}
variable "targets" {
  type = any
  validation {
    condition     = length(var.targets) > 0
    error_message = "The verifier must select at least one target."
  }
}

resource "terraform_data" "probe" {
  for_each = var.targets
  # Every test apply recollects observations, including repeated identical scenarios.
  triggers_replace = uuid()
  provisioner "local-exec" {
    command = "\"$NEMOCLAW_HCL_PROBE\" hcl_live::probe --exact --ignored --quiet"
    environment = {
      NEMOCLAW_HCL_PROBE            = var.context.probe_executable
      NEMOCLAW_HCL_CONFIG           = var.context.config
      NEMOCLAW_HCL_STATE            = var.context.state_dir
      NEMOCLAW_HCL_AGENT            = each.value.agent
      NEMOCLAW_HCL_REQUEST          = jsonencode(each.value.request)
      NEMOCLAW_HCL_RESPONSE_POINTER = each.value.response_pointer
      NEMOCLAW_HCL_REPORT           = "${var.context.evidence_dir}/${each.key}-${self.id}.json"
    }
  }
}

# The resource ID is unknown until apply, so each report is read after its probe.
locals {
  reports = {
    for name, probe in terraform_data.probe :
    name => jsondecode(file("${var.context.evidence_dir}/${name}-${probe.id}.json"))
  }
}

output "failed" {
  description = "Targets whose agent did not reply with text from the expected runtime."
  value = [
    for name, report in local.reports : name if !(
      report.succeeded && report.reply &&
      report.agent.observed == report.agent.expected &&
      report.runtime.observed == report.runtime.expected
    )
  ]
}
