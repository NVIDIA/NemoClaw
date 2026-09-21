# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
terraform {
  required_version = "= 1.12.6"
  required_providers {
    nemoclaw = { source = "registry.opentofu.org/nvidia/nemoclaw", version = "@PROVIDER_VERSION@" }
    docker = { source = "registry.opentofu.org/kreuzwerker/docker", version = "4.6.0" }
  }
}
variable "name" { type = string }
variable "owner" { type = string }
variable "port" { type = number }
variable "subnet" { type = string }
provider "docker" { host = "@ENGINE@" }
provider "nemoclaw" {
  alias = "bootstrap"
  endpoint = "http://127.0.0.1:1"
}
provider "nemoclaw" {
  endpoint = docker_container.gateway.id != "" ? "http://127.0.0.1:${var.port}" : ""
}
data "docker_image" "gateway" { name = "@GATEWAY_IMAGE@" }
resource "nemoclaw_gateway_storage" "gateway" {
  provider = nemoclaw.bootstrap
  spec = jsonencode({
    layout = 1, kind = "managed_gateway", name = var.name, owner = var.owner,
    generation = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    gateway = { management = "managed", endpoint = "http://127.0.0.1:8080",
      engine = "@ENGINE@", image = "@GATEWAY_IMAGE@", networkCIDR = var.subnet }
  })
  lifecycle { prevent_destroy = true }
  depends_on = [data.docker_image.gateway]
}
resource "docker_container" "gateway" {
  name = var.name
  image = data.docker_image.gateway.id
  user = "0:0"
  entrypoint = ["/usr/local/bin/openshell-gateway"]
  command = ["--config", "${nemoclaw_gateway_storage.gateway.data_path}/gateway.toml", "--name", var.name, "--bind-address", "127.0.0.1", "--port", tostring(var.port)]
  env = ["XDG_STATE_HOME=${nemoclaw_gateway_storage.gateway.data_path}/state", "OPENSHELL_DB_URL=sqlite:${nemoclaw_gateway_storage.gateway.data_path}/gateway.db"]
  network_mode = "host"
  restart = "no"
  must_run = true
  wait = false
  remove_volumes = false
  destroy_grace_seconds = 10
  capabilities { drop = ["ALL"] }
  security_opts = ["no-new-privileges"]
  labels {
    label = "nemoclaw.nvidia.com/uid"
    value = var.owner
  }
  mounts {
    type = "volume"
    source = "${var.name}-data"
    target = nemoclaw_gateway_storage.gateway.data_path
  }
  mounts {
    type = "bind"
    source = "/var/run/docker.sock"
    target = "/var/run/docker.sock"
  }
}
data "nemoclaw_gateway_capabilities" "ready" {
  required_compute_drivers = ["docker"]
  wait_timeout_seconds = 90
  depends_on = [docker_container.gateway]
  lifecycle {
    postcondition {
      condition = self.compatible
      error_message = "Gateway does not support Docker."
    }
  }
}
resource "nemoclaw_workspace" "probe" {
  name = substr(var.name, 0, 19)
  owner = var.owner
  generation = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  depends_on = [data.nemoclaw_gateway_capabilities.ready]
  lifecycle { prevent_destroy = true }
}
output "gateway_version" { value = data.nemoclaw_gateway_capabilities.ready.gateway_version }
output "workspace_id" { value = nemoclaw_workspace.probe.id }
