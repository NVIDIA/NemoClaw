# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

variable "hardware_profile" {
  description = "The GPU host's hardware profile, which sizes Ollama's memory budget."
  type        = string
}
variable "model_memory_gib" {
  description = "GPU memory, in GiB, the model server may use for weights and runtime headroom."
  type        = number
}
variable "local_model" {
  description = "The Ollama model to serve, pinned by digest."
  type        = object({ name = string, digest = string })
}
variable "local_model_agents" {
  description = "How many agents share the local model."
  type        = number
}
variable "ollama_image" {
  description = "Managed Ollama runtime image, pinned by digest."
  type        = string
}
variable "model_bind_address" {
  description = "Host address the model server publishes its port on."
  type        = string
}
variable "model_endpoint" {
  description = "Ollama's OpenAI-compatible URL from this machine, ending in /v1."
  type        = string
}
variable "sandbox_model_endpoint" {
  description = "Ollama's OpenAI-compatible URL from the gateway and sandboxes, ending in /v1; null uses model_endpoint."
  type        = string
}
variable "frontier" {
  description = "The hosted model: an OpenAI-compatible endpoint ending in /v1, the model, and the variable holding its API key."
  type        = object({ endpoint = string, model = string, credential_env = string })
}
