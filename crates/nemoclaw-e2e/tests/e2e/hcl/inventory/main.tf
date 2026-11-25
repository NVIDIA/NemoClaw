# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Lists the containers, volumes, networks, and images on the case's Docker
# engine, as the QA plan's 005-DEPLOY records them around a plan. Another
# workload on the same engine that creates or removes an object between two
# listings changes them too, so compare listings taken close together.

terraform {
  required_version = "= 1.13.9"
}

variable "context" {
  type = object({
    config   = string
    work_dir = string
  })
}

variable "baseline" {
  description = "An earlier listing, for an assertion to compare: OpenTofu's assertions cannot reference runs."
  type        = any
  default     = null
}

locals {
  engine = yamldecode(file(var.context.config)).spec.gateway.target.docker.engine
}

resource "terraform_data" "listing" {
  # Every run block lists the objects again.
  triggers_replace = uuid()
  provisioner "local-exec" {
    command = <<-EOT
      mkdir -p "$LISTING" && cd "$LISTING" || exit 1
      docker --host "$ENGINE" container ls --all --quiet --no-trunc | sort > containers || exit 1
      docker --host "$ENGINE" volume ls --quiet | sort > volumes || exit 1
      docker --host "$ENGINE" network ls --quiet --no-trunc | sort > networks || exit 1
      docker --host "$ENGINE" image ls --all --quiet --no-trunc | sort -u > images || exit 1
    EOT
    environment = {
      ENGINE  = local.engine
      LISTING = "${var.context.work_dir}/inventory-${self.id}"
    }
  }
}

locals {
  directory = "${var.context.work_dir}/inventory-${terraform_data.listing.id}"
}

output "objects" {
  description = "By kind, the IDs or names on the engine."
  value = {
    for kind in ["containers", "volumes", "networks", "images"] :
    kind => compact(split("\n", file("${local.directory}/${kind}")))
  }
}

output "baseline" {
  description = "var.baseline, for a later run to pass on."
  value       = var.baseline
}
