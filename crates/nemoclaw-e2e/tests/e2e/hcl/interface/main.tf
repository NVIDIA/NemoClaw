# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Requests services that sandboxes expose, as a person would with what apply
# reports: hcl_live::interface reads each target's token in its sandbox, or
# from the page the service serves, and forwards its port with the pinned
# OpenShell CLI, then sends one request, or chats through a WebSocket as a
# browser does. A token read from a token file must appear in neither the
# deployment's state nor the apply's output.
# Reports hold status codes; tokens and response bodies stay private, and the
# output names only the targets that failed, with why when the probe knows.

terraform {
  required_version = "= 1.13.9"
}

variable "context" {
  type = object({
    probe_executable = string
    openshell        = string
    state_dir        = string
    work_dir         = string
    evidence_dir     = string
  })
}

variable "reported" {
  description = "The JSON result of the apply that reported the targets' interfaces."
  type        = any
}

variable "connection" {
  description = "The gateway and workspace apply reports, which the OpenShell CLI selects."
  type = object({
    gatewayEndpoint = string
    workspace       = string
  })
}

variable "targets" {
  description = "By name: the sandbox, the service port, the token file apply reports or null, optionally the page global that holds a session token instead, the request path, an optional JSON body to POST or a prompt to type into the terminal UI that a WebSocket at the path serves, text the response or the screen after the prompt must contain, or the answer a chat completion must be."
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
      NEMOCLAW_HCL_PAGE_TOKEN = try(each.value.page_token, "")
      NEMOCLAW_HCL_PATH       = each.value.path
      NEMOCLAW_HCL_BODY       = try(jsonencode(each.value.body), "")
      NEMOCLAW_HCL_PROMPT     = try(each.value.prompt, "")
      NEMOCLAW_HCL_CONTAINS   = try(each.value.contains, "")
      NEMOCLAW_HCL_STATE      = var.context.state_dir
      NEMOCLAW_HCL_REPORTED   = jsonencode(var.reported)
      NEMOCLAW_HCL_REPORT     = "${var.context.evidence_dir}/${each.key}-${self.id}.json"
      NEMOCLAW_HCL_RESPONSE   = "${var.context.work_dir}/${self.id}.response"
    }
  }
}

locals {
  # Each response is read after its request: the ID is unknown until apply.
  results = {
    for name, request in terraform_data.request : name => merge(
      jsondecode(file("${var.context.evidence_dir}/${name}-${request.id}.json")),
      { body = file("${var.context.work_dir}/${request.id}.response") },
    )
  }
  # Why a target failed, when the probe knows: how a chat's connection ended,
  # and where its token appears.
  why = {
    for name, result in local.results : name => join("; ", concat(
      result.closed == null ? [] : [result.closed],
      [for place in result.exposed : "its token is in ${place}"],
    ))
  }
  failed = [
    for name, target in var.targets : local.why[name] == "" ? name : "${name} (${local.why[name]})"
    # A WebSocket answers its upgrade with 101.
    if local.results[name].status != (try(target.prompt, null) == null ? 200 : 101)
    || local.why[name] != ""
    || (try(target.contains, null) != null && !strcontains(local.results[name].body, try(target.contains, "")))
    || (try(target.answer, null) != null && try(lower(trimsuffix(trimsuffix(trimspace(jsondecode(local.results[name].body).choices[0].message.content), "."), "!")), "") != lower(try(target.answer, "")))
  ]
}

output "failed" {
  description = "Targets that did not answer 200 with the expected content."
  value       = local.failed
}
