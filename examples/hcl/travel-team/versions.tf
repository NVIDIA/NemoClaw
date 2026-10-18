# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# A travel planning team: four researchers, a scheduler, and a buyer, each an
# agent in its own OpenShell sandbox with its own model and network policy.
# README.md describes the team, and how to run its workflow.

terraform {
  required_version = "= 1.12.6"
  # Pin the NVIDIA providers to your bundle's version, for example
  # version = "0.1.0", and install them from the bundle's providers directory.
  required_providers {
    docker    = { source = "registry.opentofu.org/kreuzwerker/docker", version = "4.6.0" }
    ollama    = { source = "registry.opentofu.org/nvidia/ollama" }
    openshell = { source = "registry.opentofu.org/nvidia/openshell" }
    fabric    = { source = "registry.opentofu.org/nvidia/fabric" }
  }
}

provider "docker" {
  host = var.docker_host
}
provider "ollama" {
  destroy = var.destroy
}
provider "openshell" {
  destroy = var.destroy
}
provider "fabric" {
  destroy = var.destroy
}
