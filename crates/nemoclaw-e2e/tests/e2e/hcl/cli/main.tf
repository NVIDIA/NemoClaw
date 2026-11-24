# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Runs one bundled nemoclaw command against the case's deployment, or a
# change to it, and reports its result and the bindings that the
# deployment's state records afterward. The CLI owns the deployment and its
# state.

terraform {
  required_version = "= 1.13.10"
}

variable "context" {
  type = object({
    cli       = string
    config    = string
    state_dir = string
    work_dir  = string
  })
}

variable "operation" {
  description = "plan, apply, or destroy."
  type        = string
  validation {
    condition     = contains(["plan", "apply", "destroy"], var.operation)
    error_message = "The operation must be plan, apply, or destroy."
  }
}

variable "empty_path" {
  description = "Run the CLI with an empty PATH, which shows it needs no program from the host, such as helm."
  type        = bool
  default     = false
}

variable "agent_changes" {
  description = "Fields to set in sandboxes' agents, by sandbox and then field, as a person edits the case's document before a plan or apply. The command reads the changed document from its private operation directory."
  type        = any
  default     = {}
}

variable "baseline" {
  description = "What an earlier run reported, such as its bindings, for assertions to compare: OpenTofu's assertions cannot reference runs, and it keeps only the latest applying run's outputs of a module."
  type        = any
  default     = null
}

locals {
  case = yamldecode(file(var.context.config))
  # JSON is YAML, so the CLI reads the changed document as it reads the case.
  document = length(var.agent_changes) == 0 ? null : jsonencode(merge(local.case, {
    spec = merge(local.case.spec, {
      sandboxes = merge(local.case.spec.sandboxes, {
        for name, fields in var.agent_changes : name => merge(local.case.spec.sandboxes[name], {
          agent = merge(local.case.spec.sandboxes[name].agent, fields)
        })
      })
    })
  }))
  config = local.document == null ? var.context.config : "document.yaml"
  arguments = {
    plan    = ["plan", "--output", "json", "--non-interactive", local.config]
    apply   = ["apply", "--output", "json", "--non-interactive", local.config]
    destroy = ["destroy", "--output", "json"]
  }[var.operation]
}

resource "terraform_data" "operation" {
  # Every run block runs its command again, including identical repeated ones.
  triggers_replace = uuid()
  provisioner "local-exec" {
    # The exit status is recorded rather than raised, so the run's assertion
    # reports a failed command's message. Each file in the private
    # credentials directory, such as a kind case's OIDC token, becomes the
    # variable it names.
    command = <<-EOT
      mkdir -p "$OPERATION" && cd "$OPERATION" || exit 1
      [ -z "$DOCUMENT" ] || printf '%s' "$DOCUMENT" > document.yaml || exit 1
      for credential in "$CREDENTIALS"/*; do
        [ -f "$credential" ] && export "$(basename "$credential")=$(cat "$credential")"
      done
      ${var.empty_path ? "PATH= " : ""}"$NEMOCLAW" --progress off --state-dir "$STATE" ${join(" ", [for argument in local.arguments : format("'%s'", replace(argument, "'", "'\\''"))])} >stdout 2>stderr
      echo $? >exit
    EOT
    environment = {
      NEMOCLAW    = var.context.cli
      STATE       = var.context.state_dir
      OPERATION   = "${var.context.work_dir}/${self.id}"
      CREDENTIALS = "${var.context.work_dir}/credentials"
      DOCUMENT    = local.document == null ? "" : local.document
    }
  }
}

# The operation's ID is unknown until apply, so its output and the state are
# read after the command ran. They stay in the private work directory and the
# state directory.
locals {
  directory = "${var.context.work_dir}/${terraform_data.operation.id}"
  exit_code = tonumber(trimspace(file("${local.directory}/exit")))
  result    = local.exit_code == 0 ? jsondecode(file("${local.directory}/stdout")) : null
  state = try(jsondecode(file(
    "${var.context.state_dir}/${terraform_data.operation.id == "" ? "" : "terraform.tfstate"}"
  )), { resources = [] })
  managed = [
    for resource in local.state.resources : resource
    if resource.mode == "managed" && length(resource.instances) > 0
  ]
  agents = {
    for resource in local.managed : resource.name => resource.instances[0].attributes
    if resource.type == "fabric_agent"
  }
}

output "exit_code" {
  value = local.exit_code
}

output "error" {
  description = "A failed command's message: with --output json, the CLI reports it, already redacted, in its JSON result on standard output; otherwise standard error."
  value = local.exit_code == 0 ? "" : try(
    jsondecode(file("${local.directory}/stdout")).error.message,
    trimspace(file("${local.directory}/stderr")),
  )
}

output "result" {
  description = "The command's JSON result, or null when it failed."
  value       = local.result
}

output "changes" {
  description = "The result's changes by resource address: actions and reason."
  value       = { for change in try(local.result.changes, []) : change.resource => change }
}

output "bindings" {
  description = "By sandbox, what the deployment's state records after the command, which later operations use: the sandbox's ID, its agent's runtime ID, and the sandbox ID its agent names."
  value = {
    for resource in local.managed : resource.name => {
      sandbox       = resource.instances[0].attributes.id
      runtime       = try(local.agents[resource.name].runtime_id, null)
      agent_sandbox = try(local.agents[resource.name].sandbox.id, null)
    } if resource.type == "openshell_sandbox"
  }
}

output "baseline" {
  description = "var.baseline, for a later run to pass on."
  value       = var.baseline
}
