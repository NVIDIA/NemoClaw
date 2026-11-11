# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

terraform {
  required_version = "= 1.12.12"
}

variable "context" {
  type = object({
    config           = string
    state_dir        = string
    cli              = string
    probe_executable = string
    work_dir         = string
  })
}

resource "terraform_data" "lifecycle" {
  triggers_replace = uuid()
  provisioner "local-exec" {
    command = <<-EOT
      for credential in "$CREDENTIALS"/*; do
        [ -f "$credential" ] && export "$(basename "$credential")=$(cat "$credential")"
      done
      exec "$PROBE" openclaw_lifecycle::recreate_and_restore_establish_a_usable_openclaw_runtime --exact --ignored --quiet
    EOT
    environment = {
      PROBE                     = var.context.probe_executable
      NEMOCLAW_LIFECYCLE_CONFIG = var.context.config
      NEMOCLAW_LIFECYCLE_STATE  = var.context.state_dir
      NEMOCLAW_LIFECYCLE_CLI    = var.context.cli
      CREDENTIALS               = "${var.context.work_dir}/credentials"
    }
  }
}
