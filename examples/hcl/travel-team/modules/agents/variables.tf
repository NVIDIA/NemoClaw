# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

variable "gateway" {
  description = "The gateway's ref, from the gateway layer."
  type = object({
    type                = string
    endpoint            = string
    credential_env      = string
    tls_ca_env          = string
    tls_certificate_env = string
    tls_key_env         = string
    kubernetes          = string
  })
}
variable "workspace" {
  description = "The workspace's ref, from the gateway layer."
  type        = object({ type = string, name = string, owner = string, generation = string, id = string })
}
variable "registrations" {
  description = "The refs of the gateway layer's registrations: local, frontier, search, and bookings."
  type = map(object({
    type         = string
    workspace    = string
    name         = string
    registration = string
    owner        = string
    generation   = string
    id           = string
  }))
}
variable "frontier_key_env" {
  description = "The variable sandboxes find the hosted model's key in, from the gateway layer."
  type        = string
}
variable "booking_rules" {
  description = "The MCP methods and tools the booking registration allows, from the gateway layer."
  type        = list(object({ method = string, tool = string }))
}
variable "models" {
  description = "Each model's name and the base URL sandboxes reach it at, from the inference layer: local and frontier."
  type        = map(object({ name = string, endpoint = string }))
}
variable "researchers" {
  description = "What each researcher looks into, by researcher."
  type        = map(string)
}
variable "roles" {
  description = "Each role's harness, its model (local or frontier), and whether it searches the web."
  type        = map(object({ harness = string, model = string, search = bool }))
}
variable "harnesses" {
  description = "Each role's harness: its image, the launch that starts its agent, the harness's ref, and its executables."
  type = map(object({
    image       = string
    launch_json = string
    ref         = object({ type = string, adapter_id = string, image = string, catalog_json = string })
    binaries    = list(string)
  }))
}
variable "bookings" {
  description = "The booking service the buyer reaches over MCP Streamable HTTP, and the only tools it may call."
  type        = object({ url = string, tools = list(string) })
}
variable "research_sources" {
  description = "HTTPS hosts each researcher may read with GET, besides web search."
  type        = map(list(string))
}
variable "skills_volume" {
  description = "Docker volume of research skills, mounted into each researcher's sandbox; null mounts nothing."
  type        = string
}
