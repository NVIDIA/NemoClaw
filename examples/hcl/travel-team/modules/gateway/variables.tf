# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

variable "endpoint" {
  description = "OpenShell gateway endpoint."
  type        = string
}
variable "workspace" {
  description = "OpenShell workspace that holds the team's registrations and sandboxes."
  type        = string
}
variable "local_server" {
  description = "The local model's server, from the inference layer."
  type        = object({ type = string, endpoint = string, credential_env = string, credential_source = string })
}
variable "frontier_server" {
  description = "The hosted model's server, from the inference layer."
  type        = object({ type = string, endpoint = string, credential_env = string, credential_source = string })
}
variable "binaries" {
  description = "The executables each registration allows: those of the harnesses that use it."
  type        = object({ local = list(string), frontier = list(string), search = list(string), bookings = list(string) })
}
variable "search" {
  description = "Web search: brave or tavily, and the variable holding its API key."
  type        = object({ provider = string, credential_env = string })
}
variable "bookings" {
  description = "The booking service's MCP Streamable HTTP endpoint, the only tools callers may use, and the variable holding its API key."
  type        = object({ url = string, tools = list(string), credential_env = string })
}
