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

variable "sandbox_create_delay_ms" {
  description = "How long the gateway takes to create each sandbox."
  type        = number
  default     = 0
}

variable "sandbox_delete_delay_ms" {
  description = "How long the gateway takes to answer each sandbox deletion."
  type        = number
  default     = 0
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
      service      = local.spec.services[name]
      container_id = "fixture-${name}-container"
      container = lookup({
        vllm        = "${local.prefix}-inference-${name}"
        ollamaProxy = "${local.prefix}-ollama-proxy-${name}"
      }, local.spec.services[name].kind, "${local.prefix}-ollama-${name}")
      # An Ollama proxy keeps its key in its retained /data volume.
      proxy         = local.spec.services[name].kind == "ollamaProxy"
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

output "key" {
  description = "The key every authenticated service holds, which must never reach OpenTofu state."
  value       = local.key
}

output "services" {
  description = "Each service's container name and ID, by service."
  value       = { for name, service in local.services : name => { name = service.container, id = service.container_id } }
}

output "declare" {
  description = "The declaration for the fixture_state data source."
  value = jsonencode(merge({
    compute_driver          = local.driver
    sandbox_create_delay_ms = var.sandbox_create_delay_ms
    sandbox_delete_delay_ms = var.sandbox_delete_delay_ms
    # The models an Ollama proxy's existing daemon lists.
    models = [
      for service in values(try(local.spec.services, {})) :
      { name = service.upstream.model.name, digest = service.upstream.model.digest }
      if service.kind == "ollamaProxy"
    ]
    # Only a managed Docker gateway's engine holds images and containers.
    }, [for docker in [local.docker] : {
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
          by_name    = service.authenticated || service.proxy
          started_at = "2026-01-01T00:00:00Z"
          mounts = service.proxy ? tomap({ "/data" = "${service.container}-auth" }) : tomap(merge(
            { "/data" = "${service.container}-data" },
            service.authenticated ? { "/credentials" = "${service.container}-auth" } : {}
          ))
          files = service.proxy ? tomap({ "/data/inference-key" = local.key }) : tomap(merge(
            { "/data/status.json" = jsonencode({ phase = "ready", updated = "2026-01-01T00:00:05Z", detail = "serving", pid = 7 }) },
            service.authenticated ? { "/credentials/inference-key" = local.key } : {}
          ))
        }],
      )
  } if docker]...))
}
