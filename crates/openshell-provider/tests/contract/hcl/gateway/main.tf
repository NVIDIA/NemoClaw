# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# Gateway installation types that plan from typed settings: the Docker
# gateway's launch, whether an engine can host a gateway, and the managed
# Kubernetes resources, planned without a cluster.
terraform {
  required_providers {
    openshell = { source = "registry.opentofu.org/nvidia/openshell" }
  }
}
variable "engine" { type = string }
variable "gateway_endpoint" { default = "http://127.0.0.1:17670" }
variable "data_path" { default = "/var/lib/docker/volumes/nc-0123456789abcdef-gateway-data/_data" }
variable "namespace" { default = "agents" }
provider "openshell" {}

data "openshell_docker_gateway_runtime" "gateway" {
  name      = "nc-0123456789abcdef-gateway"
  endpoint  = var.gateway_endpoint
  data_path = var.data_path
  config    = jsonencode({ "openshell.gateway" = { log_level = "debug" } })
}

# The managed Docker gateway's storage: its volume, key, and certificates.
# Planning it must leave the engine unchanged; the fixture engine refuses any
# request but a read.
resource "openshell_gateway_storage" "docker" {
  name           = "nc-0123456789abcdef-gateway"
  owner          = "302ff5e1-088d-42ce-959f-4ff4c3570c13"
  generation     = "0123456789abcdef0123456789abcdef"
  compute_driver = "docker"
  engine         = var.engine
  image          = "ghcr.io/nvidia/openshell/gateway@sha256:9b94165a3dbcf6d454b822e5b21f371f168c44155c8fa1d6dd55ba091a041d1f"
  network_cidr   = "172.30.110.0/24"
}

data "openshell_gateway_prerequisites" "docker" {
  engine         = var.engine
  compute_driver = "docker"
}
data "openshell_gateway_prerequisites" "podman" {
  engine         = var.engine
  compute_driver = "podman"
}

locals {
  cluster = {
    name                   = "nc-0123456789abcdef-gateway"
    compute_driver         = "openshift"
    endpoint               = "https://127.0.0.1:17671"
    kubeconfig_env         = "TEST_CLUSTER_KUBECONFIG"
    context                = "selected"
    namespace              = var.namespace
    authentication_profile = "development"
    environment            = ["AWS_PROFILE"]
  }
}
resource "openshell_kubernetes_storage" "platform" {
  name                   = local.cluster.name
  compute_driver         = local.cluster.compute_driver
  endpoint               = local.cluster.endpoint
  kubeconfig_env         = local.cluster.kubeconfig_env
  context                = local.cluster.context
  namespace              = local.cluster.namespace
  authentication_profile = local.cluster.authentication_profile
  environment            = local.cluster.environment
}
resource "openshell_kubernetes_auth" "platform" {
  name                   = local.cluster.name
  compute_driver         = local.cluster.compute_driver
  endpoint               = local.cluster.endpoint
  kubeconfig_env         = local.cluster.kubeconfig_env
  context                = local.cluster.context
  namespace              = local.cluster.namespace
  authentication_profile = local.cluster.authentication_profile
  environment            = local.cluster.environment
  # The provider generates the storage's owner; the others share it.
  owner = openshell_kubernetes_storage.platform.owner
}
resource "openshell_kubernetes_gateway" "platform" {
  name                   = local.cluster.name
  compute_driver         = local.cluster.compute_driver
  endpoint               = local.cluster.endpoint
  kubeconfig_env         = local.cluster.kubeconfig_env
  context                = local.cluster.context
  namespace              = local.cluster.namespace
  authentication_profile = local.cluster.authentication_profile
  environment            = local.cluster.environment
  owner                  = openshell_kubernetes_storage.platform.owner
  generation             = openshell_kubernetes_auth.platform.generation
}
