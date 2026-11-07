# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# The named volumes a Docker case's sandboxes mount, provisioned with the
# bundled Docker provider before the case's first apply, as
# docs/build-deploy/state.md asks of a platform: each volume carries
# OpenShell's default approval labels for the deployment's workspace, holds
# the files the case names for it, and belongs to the sandbox's identity.
# NemoClaw's destroy leaves the volumes;
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

variable "files" {
  description = "Files to write in a volume before its sandbox starts: by \"SANDBOX:TARGET\", the sandbox's name and the volume's mount target, then by path in the volume."
  type        = map(map(string))
  default     = {}
}

locals {
  document = yamldecode(file(var.context.config))
  # OpenShell admits a volume for the workspace that its label names, which
  # NemoClaw derives from the deployment's UID.
  workspace = "nc-${substr(sha256(local.document.metadata.uid), 0, 16)}"
  # Each mounted volume, the image of the sandbox that mounts it, and the
  # files to write in it.
  volumes = merge([
    for name, sandbox in local.document.spec.sandboxes : {
      for mount in try(sandbox.driverConfig.docker.mounts, []) : mount.source => {
        image = sandbox.image.ref
        files = lookup(var.files, "${name}:${mount.target}", {})
      }
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
# root without a network, writes the volume's files and hands it to the
# sandbox's identity. Each file's content arrives in its own environment
# variable, so the script quotes only paths.
resource "docker_container" "owner" {
  for_each = local.volumes
  name     = "${each.key}-owner"
  image    = each.value.image
  user     = "0:0"
  entrypoint = length(each.value.files) == 0 ? ["chown", var.owner, "/volume"] : ["sh", "-c", join("\n", concat(
    ["set -e"],
    [for index, path in keys(each.value.files) : "mkdir -p \"$(dirname '/volume/${path}')\" && printf '%s' \"$NEMOCLAW_VOLUME_FILE_${index}\" > '/volume/${path}'"],
    ["chown -R ${var.owner} /volume"],
  ))]
  env          = [for index, path in keys(each.value.files) : "NEMOCLAW_VOLUME_FILE_${index}=${each.value.files[path]}"]
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
