# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Copied beside each compiled scenario: it declares the fixtures for the
# scenario's document and reads what they recorded.

variable "permit_destroy" {
  description = "Whether the openshell and fabric providers may delete, as in the SDK's teardown graph. A scenario's last run sets it."
  type        = bool
  default     = false
}

variable "compute_driver" {
  description = "The compute driver the fixture gateway reports instead of the one the document requires."
  type        = string
  default     = null
}

variable "fault" {
  description = "A fault the fixtures apply when a targeted plan reads `setup`: `stop_agent_runtimes` or `delete_provider_registrations`."
  type        = string
  default     = null
}

variable "effects" {
  description = "The `effects` output of an earlier run, for comparison."
  type        = number
  default     = null
}

module "fixtures" {
  source         = "../../modules/fixtures"
  document       = "${path.module}/nemoclaw.yaml"
  compute_driver = var.compute_driver
}

# A first run targets this data source, so the fixtures are declared before
# the deployment's first plan reads them.
data "fixture_state" "setup" {
  declare = var.fault == null ? module.fixtures.declare : jsonencode(merge(jsondecode(module.fixtures.declare), { fault = var.fault }))
}

# Read at plan time: in a plan run after deploy, it reports what deploy did.
module "observed" {
  source = "../../modules/observed"
}

output "effects" {
  description = "How many objects the gateway has created, updated, or deleted, as this run's plan read it."
  value       = module.observed.openshell.effects
}
