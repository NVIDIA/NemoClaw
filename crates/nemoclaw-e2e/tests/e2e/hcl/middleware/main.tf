# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Observe the external fixture after sandbox requests, and expose its bound URLs.
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

variable "baseline" {
  type    = string
  default = null
}

locals {
  policy    = yamldecode(file(var.context.config)).spec.sandboxes.assistant.network.policy.explicit
  endpoints = local.policy.network_policies.fixture.endpoints
  port      = local.endpoints[0].port
}

resource "terraform_data" "observation" {
  triggers_replace = uuid()
  provisioner "local-exec" {
    command = "exec \"$PROBE\" hcl_live::middleware_observation --exact --ignored --quiet"
    environment = {
      PROBE                  = var.context.probe_executable
      NEMOCLAW_HCL_HTTP_PORT = tostring(local.port)
      NEMOCLAW_HCL_STATE     = var.context.state_dir
      NEMOCLAW_HCL_REPORT    = "${var.context.evidence_dir}/middleware-${self.id}.json"
    }
  }
}

locals {
  report = jsondecode(file("${var.context.evidence_dir}/middleware-${terraform_data.observation.id}.json"))
}

output "sandbox" {
  value = local.report.sandbox
}
output "same_sandbox" {
  value = var.baseline == null || local.report.sandbox == var.baseline
}
output "effects" {
  value = local.report.effects
}
output "targets" {
  value = { for path, index in { allow = 0, deny = 0, bypass = 1 } : path => {
    sandbox = "assistant"
    command = ["python3", "-c", <<-PY
      import urllib.request, urllib.error
      try:
          print(urllib.request.urlopen("http://${local.endpoints[index].host}:${local.port}/${path}", timeout=10).status)
      except urllib.error.HTTPError as error:
          print(error.code)
    PY
    ]
    contains = path == "deny" ? "403" : "200"
  } }
}
