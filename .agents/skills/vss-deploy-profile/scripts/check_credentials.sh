#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Credential probes for vss-deploy-profile. Validates the keys a deploy needs
# (NGC / NVIDIA_API_KEY / HF_TOKEN) against their services so a bad key fails in
# seconds, not after a cold NIM start. Read-only: it reads env vars and curls —
# it does NOT write generated.env (the skill writes the resolved key per
# credentials.md). Each probe prints `ok` / `invalid` / `skip`; an unset key is
# a skip. Compare each result with the chosen deployment mode before continuing.
set -u

# NGC — local NIM image pulls. NGC_CLI_API_KEY (NGC CLI / VSS env) and
# NGC_API_KEY (NIM / RT-VLM containers) are the SAME personal NGC key under two
# names; resolve to one. Refuse to proceed if both are set and differ.
if [[ -n "${NGC_CLI_API_KEY:-}" ]] && [[ -n "${NGC_API_KEY:-}" ]] && \
   [[ "$NGC_CLI_API_KEY" != "$NGC_API_KEY" ]]; then
  echo "NGC: NGC_CLI_API_KEY and NGC_API_KEY differ — choose one NGC personal API key"
elif [[ -n "${NGC_CLI_API_KEY:-${NGC_API_KEY:-}}" ]]; then
  ngc_resolved="${NGC_CLI_API_KEY:-${NGC_API_KEY:-}}"
  # Probe the registry pull scope (what image pulls actually use), not
  # service=ngc - a key scoped only for nvcr.io pulls is valid for a deploy
  # but is rejected by the ngc platform scope (false negative).
  curl -sf -u "\$oauthtoken:${ngc_resolved}" \
    "https://authn.nvidia.com/token?service=registry&scope=repository:nvidia/vss-core/vss-agent:pull" >/dev/null \
    && echo "NGC key ok" || echo "NGC key invalid (401/403)"
else
  echo "NGC: not set — skip (required for any local NIM)"
fi

# build.nvidia.com — remote NIM endpoints
if [[ -n "${NVIDIA_API_KEY:-}" ]]; then
  curl -sf -H "Authorization: Bearer ${NVIDIA_API_KEY}" \
    "https://integrate.api.nvidia.com/v1/models" >/dev/null \
    && echo "NVIDIA_API_KEY ok" || echo "NVIDIA_API_KEY invalid (401/403)"
else
  echo "NVIDIA_API_KEY: not set — skip (required only for remote NIM)"
fi

# HF — edge only (gated Edge 4B)
if [[ -n "${HF_TOKEN:-}" ]]; then
  status=$(curl -sf -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer ${HF_TOKEN}" \
    "https://huggingface.co/api/models/nvidia/NVIDIA-Nemotron-Edge-4B-v2.1-EA-020126_FP8")
  [[ "$status" = "200" ]] \
    && echo "HF_TOKEN ok" \
    || echo "HF_TOKEN invalid or no access to gated Edge 4B (HTTP $status)"
else
  echo "HF_TOKEN: not set — skip (required only on edge with Edge 4B)"
fi
