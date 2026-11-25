# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Research sources supplement the endpoint rules attached by the providers.
# The booking provider owns both the credential and the MCP rules.

locals {
  grants = {
    for role in keys(local.roles) : role => {
      for host in lookup(var.research_sources, role, []) : "${role}-${replace(host, ".", "-")}" => host
    }
  }
}
