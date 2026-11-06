# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# The named volumes a Docker case's sandboxes mount, provisioned with the
# bundled Docker provider before the case's first apply, as
# docs/build-deploy/state.md asks of a platform: each volume carries
# OpenShell's default approval labels for the deployment's workspace, and the
# sandbox's identity owns its root. NemoClaw's destroy leaves the volumes;
# tofu test removes them when the case ends.

terraform {
  required_version = "= 1.12.12"
  required_providers {
    docker = {
      source = "kreuzwerker/docker"
    }
  }
}

variable "context" {
  type = object({
    config = string
  })
}

variable "owner" {
  description = "The UID:GID that the sandboxes run as, which must be able to write each volume."
  type        = string
}

locals {
  document = yamldecode(file(var.context.config))
  # OpenShell admits a volume for the workspace that its label names, which
  # NemoClaw derives from the deployment's UID.
  workspace = "nc-${substr(sha256(local.document.metadata.uid), 0, 16)}"
  # Each mounted volume and the image of the sandbox that mounts it.
  volumes = merge([
    for sandbox in values(local.document.spec.sandboxes) : {
      for mount in try(sandbox.driverConfig.docker.mounts, []) : mount.source => sandbox.image.ref
      if mount.type == "volume"
    }
  ]...)
  # live-docker removes anything left with the deployment's UID label.
  owner_label = {
    label = "nemoclaw.nvidia.com/uid"
    value = local.document.metadata.uid
  }
}

provider "docker" {
  host = local.document.spec.gateway.engine
}

resource "docker_volume" "mounted" {
  for_each = local.volumes
  name     = each.key
  labels {
    label = "openshell.ai/sandbox-attachable"
    value = "true"
  }
  labels {
    label = "openshell.ai/sandbox-attachable-workspace"
    value = local.workspace
  }
  labels {
    label = local.owner_label.label
    value = local.owner_label.value
  }
}

# A new volume's root belongs to root. The sandbox's own image, run once as
# root without a network, hands it to the sandbox's identity.
resource "docker_container" "owner" {
  for_each     = local.volumes
  name         = "${each.key}-owner"
  image        = each.value
  user         = "0:0"
  entrypoint   = ["chown", var.owner, "/volume"]
  network_mode = "none"
  must_run     = false
  attach       = true
  mounts {
    type   = "volume"
    source = docker_volume.mounted[each.key].name
    target = "/volume"
  }
  labels {
    label = local.owner_label.label
    value = local.owner_label.value
  }
  lifecycle {
    postcondition {
      condition     = self.exit_code == 0
      error_message = "Cannot give the ${each.key} volume to ${var.owner}."
    }
  }
}
