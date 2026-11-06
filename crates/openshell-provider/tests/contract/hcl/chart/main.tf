# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# The pinned OpenShell gateway chart rendered by the bundled Helm provider
# with the values the SDK prepares. Rendering pulls the chart by digest and
# needs no cluster. The contract runner writes each scenario's values to
# inputs/ from the SDK; the test files hold the expectations.

terraform {
  required_version = "= 1.12.12"
  required_providers {
    helm = {
      source = "hashicorp/helm"
    }
  }
}

provider "helm" {}

variable "chart" {
  description = "The pinned chart's OCI reference with its digest."
  type        = string
}

variable "values" {
  description = "Paths of the values documents, applied in order."
  type        = list(string)
}

locals {
  release   = "nc-0123456789abcdef-gateway"
  namespace = "agents"
  documents = [for document in split("\n---", data.helm_template.gateway.manifest) : try(yamldecode(document), null)]
  objects   = [for object in local.documents : object if can(object.kind)]
  # OpenShell's gateway configuration, which the chart renders from values.
  configuration = one([for object in local.objects : object.data["gateway.toml"] if object.kind == "ConfigMap" && can(object.data["gateway.toml"])])
}

data "helm_template" "gateway" {
  name      = local.release
  namespace = local.namespace
  chart     = var.chart
  validate  = false
  values    = [for path in var.values : file(path)]
}

output "release" {
  value = local.release
}

output "manifest" {
  value = data.helm_template.gateway.manifest
}

output "objects" {
  value = local.objects
}

output "configuration" {
  value = local.configuration
}
