# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Runs one bundled nemoclaw command against the case's deployment and reports
# its result. The CLI owns the deployment and its state.

terraform {
  required_version = "= 1.12.12"
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

locals {
  arguments = {
    plan    = ["plan", "--output", "json", "--non-interactive", var.context.config]
    apply   = ["apply", "--output", "json", "--non-interactive", var.context.config]
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
    }
  }
}

# The operation's ID is unknown until apply, so its output is read after the
# command ran. It stays in the private work directory.
locals {
  directory = "${var.context.work_dir}/${terraform_data.operation.id}"
  exit_code = tonumber(trimspace(file("${local.directory}/exit")))
  result    = local.exit_code == 0 ? jsondecode(file("${local.directory}/stdout")) : null
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
