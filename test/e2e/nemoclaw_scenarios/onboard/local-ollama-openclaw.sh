#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Onboard worker: local-ollama-openclaw profile. Runs `nemoclaw onboard`
# with the openclaw agent against a local Ollama runtime.

e2e_onboard_local_ollama_openclaw() {
  local sandbox_name
  sandbox_name="$(e2e_context_get E2E_SANDBOX_NAME)"
  : "${sandbox_name:=e2e-local-ollama-openclaw}"
  nemoclaw onboard --agent openclaw --provider ollama --sandbox "${sandbox_name}" --yes
}
