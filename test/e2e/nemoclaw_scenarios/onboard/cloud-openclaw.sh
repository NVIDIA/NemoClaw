#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Onboard worker: cloud-openclaw profile. Runs `nemoclaw onboard` with the
# openclaw agent against the NVIDIA cloud provider.

e2e_onboard_cloud_openclaw() {
  local sandbox_name
  sandbox_name="$(e2e_context_get E2E_SANDBOX_NAME)"
  : "${sandbox_name:=e2e-cloud-openclaw}"
  nemoclaw onboard --agent openclaw --provider nvidia --sandbox "${sandbox_name}" --yes
}
