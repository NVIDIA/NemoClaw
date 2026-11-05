# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

variable "docker_host" {
  description = "Docker engine that runs the local model server."
  type        = string
}
variable "gateway_endpoint" {
  description = "OpenShell gateway endpoint."
  type        = string
}
variable "workspace" {
  description = "OpenShell workspace that holds the team's sandboxes."
  type        = string
  default     = "travel-team"
}
variable "images" {
  description = "Agent images by harness, pinned by digest. Every role uses Hermes."
  type        = object({ hermes = string })
}
variable "image_engine" {
  description = "Engine that holds the agent images, read for their Fabric catalogs."
  type        = string
}
variable "ollama_image" {
  description = "Managed Ollama runtime image, pinned by digest."
  type        = string
}
variable "local_model" {
  description = "The Ollama model the researchers use, pinned by digest."
  type        = object({ name = string, digest = string })
}
variable "hardware_profile" {
  description = "The GPU host's hardware profile, which sizes Ollama's memory budget."
  type        = string
  default     = "dgx-spark"
}
variable "model_memory_gib" {
  description = "GPU memory, in GiB, the model server may use for weights and runtime headroom. The server stops at startup if the model needs more."
  type        = number
  default     = 16
}
variable "model_bind_address" {
  description = "Host address the model server publishes its port on. Sandboxes run in their own containers, so they can't reach the host's loopback: publish on an address they can reach, such as the host's address on the gateway's bridge network."
  type        = string
  default     = "127.0.0.1"
}
variable "model_endpoint" {
  description = "Ollama's OpenAI-compatible URL from this machine, ending in /v1."
  type        = string
  default     = "http://127.0.0.1:11434/v1"
}
variable "sandbox_model_endpoint" {
  description = "Ollama's OpenAI-compatible URL from the gateway and sandboxes, ending in /v1. The default reaches a server on the gateway's host through OpenShell's alias; OpenShell checks the destination."
  type        = string
  default     = "http://host.openshell.internal:11434/v1"
}
variable "frontier" {
  description = "Hosted frontier model for the scheduler and buyer: an OpenAI-compatible endpoint ending in /v1, the model, and the variable holding its API key."
  type        = object({ endpoint = string, model = string, credential_env = string })
  default = {
    endpoint       = "https://integrate.api.nvidia.com/v1"
    model          = "nvidia/nemotron-3.5-super-vl-120b-a12b"
    credential_env = "NVIDIA_API_KEY"
  }
}
variable "search" {
  description = "Web search for the researchers: brave or tavily, and the variable holding its API key. Hermes, which the researchers run, ships a Brave plugin but no Tavily plugin."
  type        = object({ provider = string, credential_env = string })
  default     = { provider = "brave", credential_env = "BRAVE_API_KEY" }
  validation {
    condition     = contains(["brave", "tavily"], var.search.provider)
    error_message = "search.provider must be brave or tavily."
  }
}
variable "research_sources" {
  description = "HTTPS hosts each researcher may read with GET, besides web search."
  type        = map(list(string))
  default = {
    flights     = ["api.flights.example.com"]
    stays       = ["api.stays.example.com"]
    transport   = ["api.transit.example.com"]
    attractions = ["api.attractions.example.com"]
  }
  validation {
    condition     = alltrue([for researcher in keys(var.research_sources) : contains(["flights", "stays", "transport", "attractions"], researcher)])
    error_message = "research_sources keys must name researchers: flights, stays, transport, or attractions."
  }
}
variable "bookings" {
  description = "The booking service the buyer reaches over MCP Streamable HTTP, the only tools it may call, and the variable holding its API key."
  type        = object({ url = string, tools = list(string), credential_env = string })
  default = {
    url            = "https://bookings.example.com/mcp"
    tools          = ["get_quote", "book_option"]
    credential_env = "BOOKINGS_API_KEY"
  }
}
variable "skills_volume" {
  description = "Optional Docker volume of research skills, mounted into each researcher's sandbox. Needs a gateway whose Docker driver allows driver configuration; null mounts nothing."
  type        = string
  default     = null
}
variable "destroy" {
  description = "Permit deleting provider-owned objects; set for tofu destroy."
  type        = bool
  default     = false
}
