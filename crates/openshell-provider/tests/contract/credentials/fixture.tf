# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# Observations for the native tests: each plan reads what the fake gateway
# holds, and `fixture` declares a change made behind OpenTofu, such as
# { remove = ["sandboxes"] }.
variable "fixture" { default = null }
data "fixture_state" "gateway" {
  declare = var.fixture == null ? null : jsonencode(var.fixture)
}
locals {
  gateway_state = jsondecode(data.fixture_state.gateway.observations)
}
