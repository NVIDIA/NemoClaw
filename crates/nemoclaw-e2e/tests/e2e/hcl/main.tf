# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

terraform {
  required_version = "= 1.12.9"
}

# Set by hcl_live::case. Each module declares the fields it reads.
variable "context" {
  type = object({
    config           = string
    state_dir        = string
    cli              = string
    probe_executable = string
    openshell        = string
    work_dir         = string
    evidence_dir     = string
  })
}

# A kind case's cluster, which cargo ci live-kind sets as TF_VAR_kubeconfig.
variable "kubeconfig" {
  type    = string
  default = ""
}
