#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Onboard worker: cloud-hermes profile. Runs `nemoclaw onboard` with the
# hermes agent against the NVIDIA cloud provider.

e2e_onboard_cloud_hermes() {
  local sandbox_name
  sandbox_name="$(e2e_context_get E2E_SANDBOX_NAME)"
  : "${sandbox_name:=e2e-cloud-hermes}"
  nemoclaw onboard --agent hermes --provider nvidia --sandbox "${sandbox_name}" --yes
}
