# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Requests services that sandboxes expose, as a person would with what apply
# reports: hcl_live::interface reads each target's token in its sandbox and
# forwards its port with the pinned OpenShell CLI, then sends one request.
# Reports hold status codes; tokens and response bodies stay private, and the
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
  description = "By name: the sandbox, the service port, the token file apply reports or null, the request path, an optional JSON body to POST, text the response must contain, or the one-word answer a chat completion must be."
  type        = any
}

resource "terraform_data" "request" {
  for_each         = var.targets
  triggers_replace = uuid()
  provisioner "local-exec" {
    command = "exec \"$NEMOCLAW_HCL_PROBE\" hcl_live::interface --exact --ignored --quiet"
    environment = {
      NEMOCLAW_HCL_PROBE      = var.context.probe_executable
      NEMOCLAW_HCL_OPENSHELL  = var.context.openshell
      NEMOCLAW_HCL_ENDPOINT   = var.connection.gatewayEndpoint
      NEMOCLAW_HCL_WORKSPACE  = var.connection.workspace
      NEMOCLAW_HCL_SANDBOX    = each.value.sandbox
      NEMOCLAW_HCL_PORT       = tostring(each.value.port)
      NEMOCLAW_HCL_TOKEN_PATH = try(each.value.token_path, null) == null ? "" : each.value.token_path
      NEMOCLAW_HCL_PATH       = each.value.path
      NEMOCLAW_HCL_BODY       = try(jsonencode(each.value.body), "")
      NEMOCLAW_HCL_REPORT     = "${var.context.evidence_dir}/${each.key}-${self.id}.json"
      NEMOCLAW_HCL_RESPONSE   = "${var.context.work_dir}/${self.id}.response"
    }
  }
}

locals {
  # Each response is read after its request: the ID is unknown until apply.
  results = {
    for name, request in terraform_data.request : name => {
      status = jsondecode(file("${var.context.evidence_dir}/${name}-${request.id}.json")).status
      body   = file("${var.context.work_dir}/${request.id}.response")
    }
  }
  failed = [
    for name, target in var.targets : name
    if local.results[name].status != 200
    || (try(target.contains, null) != null && !strcontains(local.results[name].body, try(target.contains, "")))
    || (try(target.answer, null) != null && try(lower(trimsuffix(trimsuffix(trimspace(jsondecode(local.results[name].body).choices[0].message.content), "."), "!")), "") != lower(try(target.answer, "")))
  ]
}

output "failed" {
  description = "Targets that did not answer 200 with the expected content."
  value       = local.failed
}
