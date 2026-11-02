# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# What the fake gateway received and holds, read after this module's
# resources change, so a run's assertions see that run's result.
data "fixture_state" "gateway" {
  depends_on = [openshell_workspace.example, openshell_web_search.brave, openshell_sandbox.agent, openshell_sandbox.omitted, openshell_sandbox.empty]
}
locals {
  openshell = jsondecode(data.fixture_state.gateway.observations).openshell
}
