# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# The fixture declaration for a scenario's document. The gateway reports the
# compute driver the document requires, unless compute_driver overrides it.
# With a managed Docker gateway, the engine holds what a mocked Docker
# provider would have created: the pulled images, the running gateway
# container, and each managed service's running container, whose runtime
# reports ready and, with bearer authentication, holds its generated key.
# Test files give the mocked resources the same IDs: image_id for every
# image, fixture-gateway-container for the gateway container, and
# fixture-SERVICE-container for each service's container.

variable "document" {
  description = "Path of the scenario's nemoclaw.yaml."
  type        = string
}

variable "compute_driver" {
  description = "The compute driver the gateway reports; null for the one the document requires."
  type        = string
  default     = null
}

locals {
  spec   = yamldecode(file(var.document)).spec
  owner  = yamldecode(file(var.document)).metadata.uid
  prefix = "nc-${substr(sha256(local.owner), 0, 16)}"
  docker = try(local.spec.gateway.engine, "") != ""
  driver = coalesce(var.compute_driver, local.spec.gateway.runtime.provider == "docker" ? "docker" : "kubernetes")
  # The SDK's default when a sandbox names no image.
  sandbox_images = distinct([
    for sandbox in values(local.spec.sandboxes) :
    try(sandbox.image.ref, "nc-fabric-owner-20260924@sha256:c4c0d3add3869e49d0ce8d03bd7e41bbe2682d0df285ef6fde5f181b123cf83e")
  ])
  services = {
    for name in sort(keys(try(local.spec.services, {}))) : name => {
      service       = local.spec.services[name]
      container_id  = "fixture-${name}-container"
      container     = local.spec.services[name].kind == "vllm" ? "${local.prefix}-inference-${name}" : "${local.prefix}-ollama-${name}"
      authenticated = try(local.spec.services[name].authentication, "") == "bearer"
    }
  }
  # Mocked pulls report one image ID, so the engine reports it for every image.
  image_id = format("sha256:%064d", 1)
  key      = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
}

output "image_id" {
  description = "The ID of every image, which a test file's Docker mock reports for each pull."
  value       = local.image_id
}

output "sandboxes" {
  description = "The document's sandbox names, sorted."
  value       = sort(keys(local.spec.sandboxes))
}

output "owner" {
  value = local.owner
}

output "prefix" {
  description = "The prefix of the deployment's engine object names."
  value       = local.prefix
}

output "services" {
  description = "Each service's container name and ID, by service."
  value       = { for name, service in local.services : name => { name = service.container, id = service.container_id } }
}

output "declare" {
  description = "The declaration for the fixture_state data source."
  value = !local.docker ? jsonencode({ compute_driver = local.driver }) : jsonencode({
    compute_driver = local.driver
    images = concat(
      [for reference in local.sandbox_images : { reference = reference, id = local.image_id, fabric_catalog = true }],
      [for name, service in local.services : {
        reference = service.service.image
        id        = local.image_id
        # A service built for another architecture, such as amd64 vLLM, says so.
        architecture = try(service.service.hardware.architecture, null)
        labels = merge(
          { "org.nemoclaw.backend" = service.service.kind },
          service.authenticated ? {
            "org.nemoclaw.inference.authentication" = "bearer-v1"
            "org.nemoclaw.inference.routes"         = "openai-v2"
          } : {}
        )
      }],
    )
    containers = concat(
      [{
        id      = "fixture-gateway-container"
        name    = "${local.prefix}-gateway"
        image   = local.image_id
        labels  = { "nemoclaw.nvidia.com/uid" = local.owner }
        running = true
      }],
      [for name, service in local.services : {
        id      = service.container_id
        name    = service.container
        image   = local.image_id
        labels  = { "nemoclaw.nvidia.com/uid" = local.owner }
        running = true
        # OpenShell finds an authenticated service by name for its key.
        by_name    = service.authenticated
        started_at = "2026-01-01T00:00:00Z"
        mounts = merge(
          { "/data" = "${service.container}-data" },
          service.authenticated ? { "/credentials" = "${service.container}-auth" } : {}
        )
        files = merge(
          { "/data/status.json" = jsonencode({ phase = "ready", updated = "2026-01-01T00:00:05Z", detail = "serving", pid = 7 }) },
          service.authenticated ? { "/credentials/inference-key" = local.key } : {}
        )
      }],
    )
  })
}
