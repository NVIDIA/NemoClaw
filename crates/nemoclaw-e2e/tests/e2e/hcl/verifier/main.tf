# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

terraform {
  required_version = "= 1.12.12"
}

variable "context" {
  type = object({
    config           = string
    state_dir        = string
    probe_executable = string
    work_dir         = string
    evidence_dir     = string
  })
}

variable "targets" {
  description = "By name: the agent, its request, the reply's JSON pointer, and optionally the one-word answer the reply must be."
  type        = any
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
    # Each file in the private credentials directory, such as a kind case's
    # OIDC token, becomes the variable it names, as for the cli module.
    command = <<-EOT
      for credential in "$CREDENTIALS"/*; do
        [ -f "$credential" ] && export "$(basename "$credential")=$(cat "$credential")"
      done
      exec "$NEMOCLAW_HCL_PROBE" hcl_live::probe --exact --ignored --quiet
    EOT
    environment = {
      NEMOCLAW_HCL_PROBE            = var.context.probe_executable
      NEMOCLAW_HCL_CONFIG           = var.context.config
      NEMOCLAW_HCL_STATE            = var.context.state_dir
      NEMOCLAW_HCL_AGENT            = each.value.agent
      NEMOCLAW_HCL_REQUEST          = jsonencode(each.value.request)
      NEMOCLAW_HCL_RESPONSE_POINTER = each.value.response_pointer
      NEMOCLAW_HCL_REPORT           = "${var.context.evidence_dir}/${each.key}-${self.id}.json"
      NEMOCLAW_HCL_REPLY            = "${var.context.work_dir}/${self.id}.reply"
      CREDENTIALS                   = "${var.context.work_dir}/credentials"
    }
  }
}

# The resource ID is unknown until apply, so each report is read after its
# probe. Reports are published; replies stay in the private work directory.
locals {
  reports = {
    for name, probe in terraform_data.probe :
    name => jsondecode(file("${var.context.evidence_dir}/${name}-${probe.id}.json"))
  }
  answered = {
    for name, probe in terraform_data.probe : name => (
      try(var.targets[name].answer, null) == null ? true :
      lower(trimsuffix(trimsuffix(trimspace(file("${var.context.work_dir}/${probe.id}.reply")), "."), "!")) == lower(var.targets[name].answer)
    )
  }
}

output "failed" {
  description = "Targets whose agent did not reply with text, or the expected answer, from the expected runtime."
  value = [
    for name, report in local.reports : name if !(
      report.succeeded && report.reply && local.answered[name] &&
      report.agent.observed == report.agent.expected &&
      report.runtime.observed == report.runtime.expected
    )
  ]
}
