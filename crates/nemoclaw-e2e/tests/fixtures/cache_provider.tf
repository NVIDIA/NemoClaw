# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

terraform {
  required_providers {
    nemoclaw = { source = "registry.opentofu.org/nvidia/nemoclaw", version = "@PROVIDER_VERSION@" }
    docker   = { source = "registry.opentofu.org/kreuzwerker/docker", version = "4.6.0" }
  }
}
variable "name" { type = string }
variable "owner" { type = string }
variable "enabled" { default = true }
variable "revision" { default = "initial" }
variable "fail_start" { default = false }
provider "nemoclaw" { endpoint = "http://127.0.0.1:1" }
provider "docker" { host = "@ENGINE@" }
resource "docker_volume" "cache" {
  name = "${var.name}-data"
  labels {
    label = "nemoclaw.nvidia.com/uid"
    value = var.owner
  }
  lifecycle { prevent_destroy = true }
}
resource "nemoclaw_inference_storage" "credentials" {
  spec = jsonencode({ Name = "${var.name}-auth", Owner = var.owner, Generation = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", Engine = "@ENGINE@" })
  lifecycle { prevent_destroy = true }
}
data "docker_image" "fixture" { name = "@FIXTURE_IMAGE@" }
resource "docker_container" "runtime" {
  count                 = var.enabled ? 1 : 0
  name                  = var.name
  image                 = data.docker_image.fixture.id
  entrypoint            = var.fail_start ? ["/does-not-exist"] : ["python3", "-c"]
  command               = ["import pathlib,secrets,time; p=pathlib.Path('/credentials/key'); p.exists() or p.write_text(secrets.token_hex(32)); pathlib.Path('/data/model').write_text('reconstructed'); time.sleep(3600)"]
  env                   = ["REVISION=${var.revision}"]
  network_mode          = "none"
  restart               = "no"
  must_run              = true
  wait                  = false
  destroy_grace_seconds = 1
  labels {
    label = "nemoclaw.nvidia.com/uid"
    value = var.owner
  }
  mounts {
    type   = "volume"
    source = docker_volume.cache.name
    target = "/data"
  }
  mounts {
    type   = "volume"
    source = "${var.name}-auth"
    target = "/credentials"
  }
  depends_on = [nemoclaw_inference_storage.credentials]
}
