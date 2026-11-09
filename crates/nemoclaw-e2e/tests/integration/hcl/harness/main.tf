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

variable "sandbox_create_delay_ms" {
  description = "How long the fixture gateway takes to create each sandbox, so that overlapping creations show."
  type        = number
  default     = 0
}

variable "sandbox_delete_delay_ms" {
  description = "How long the fixture gateway takes to answer each sandbox deletion."
  type        = number
  default     = 0
}

variable "baseline" {
  description = "What an earlier run observed, for assertions to compare: a test file passes run.NAME.gateway or run.NAME.openshell, because OpenTofu's assertions cannot reference runs."
  type        = any
  default     = null
}

module "fixtures" {
  source                  = "../../modules/fixtures"
  document                = "${path.module}/nemoclaw.yaml"
  compute_driver          = var.compute_driver
  sandbox_create_delay_ms = var.sandbox_create_delay_ms
  sandbox_delete_delay_ms = var.sandbox_delete_delay_ms
}

# A first run targets this data source, so the fixtures are declared before
# the deployment's first plan reads them.
data "fixture_state" "setup" {
  declare = module.fixtures.declare
}

# Read at plan time: in a plan run after deploy, it reports what deploy did.
module "observed" {
  source = "../../modules/observed"
}

# What the gateway held when this run planned, which is what the previous run
# left. OpenTofu keeps only the latest applying run's outputs of a module, so a
# later run passes baseline on as var.baseline to keep comparing with it.
output "gateway" {
  description = "The observed OpenShell records at this run's plan."
  value       = module.observed.openshell
}

output "baseline" {
  description = "var.baseline, or without one this run's observed OpenShell records."
  value       = var.baseline != null ? var.baseline : module.observed.openshell
}
