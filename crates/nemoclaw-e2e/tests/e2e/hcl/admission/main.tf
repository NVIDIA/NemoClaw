# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Refuses or allows StatefulSets in a kind case's namespace through
# hcl_live::admission, so that a gateway install fails after Helm has stored
# its release. Refusing reports whether the API server enforces the refusal;
# allowing reports how many records of the gateway's release remain and which
# resources the deployment's state binds.

terraform {
  required_version = "= 1.12.12"
}

variable "context" {
  type = object({
    config           = string
    state_dir        = string
    probe_executable = string
    evidence_dir     = string
  })
}

variable "refuse" {
  description = "Refuse StatefulSets when true; allow them again and report when false."
  type        = bool
}

resource "terraform_data" "admission" {
  # Every run block runs the probe again.
  triggers_replace = uuid()
  provisioner "local-exec" {
    command = "exec \"$NEMOCLAW_HCL_PROBE\" hcl_live::admission --exact --ignored --quiet"
    environment = {
      NEMOCLAW_HCL_PROBE  = var.context.probe_executable
      NEMOCLAW_HCL_CONFIG = var.context.config
      NEMOCLAW_HCL_STATE  = var.context.state_dir
      NEMOCLAW_HCL_ACTION = var.refuse ? "refuse" : "allow"
      NEMOCLAW_HCL_REPORT = "${var.context.evidence_dir}/admission-${self.id}.json"
    }
  }
}

# The report is read after the probe: the ID is unknown until apply.
locals {
  report = jsondecode(file("${var.context.evidence_dir}/admission-${terraform_data.admission.id}.json"))
}

output "refusing" {
  description = "Whether the API server refused a dry-run StatefulSet with the policy's message."
  value       = try(local.report.refusing, false)
}

output "releases" {
  description = "Records of the gateway's Helm release in its namespace, after allowing StatefulSets again."
  value       = try(local.report.releases, null)
}

output "bound" {
  description = "Addresses of the managed resources the deployment's state binds, after allowing StatefulSets again."
  value       = try(local.report.bound, [])
}
