#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

canonical="${INPUT_NVIDIA_INFERENCE_API_KEY:-}"
public_alias="${INPUT_NVIDIA_API_KEY:-}"

# Keep the hosted E2E contract canonical: NVIDIA_INFERENCE_API_KEY is the
# hosted CI source secret and COMPATIBLE_API_KEY is the custom endpoint
# credential. NVIDIA_API_KEY is emitted only when the caller explicitly opts in
# for documented legacy consumers that still assert the older env name.
for value in "${canonical}" "${public_alias}"; do
  if [[ "${value}" == *$'\n'* || "${value}" == *$'\r'* ]]; then
    echo "::error::Hosted inference credentials must be single-line values." >&2
    exit 1
  fi
done

if [[ "${canonical}" != nvapi-* && "${public_alias}" == nvapi-* ]]; then
  canonical="${public_alias}"
fi
if [[ "${public_alias}" != nvapi-* && "${canonical}" == nvapi-* ]]; then
  public_alias="${canonical}"
fi

if [[ "${INPUT_REQUIRE_HOSTED_INFERENCE:-true}" == "true" ]]; then
  if [[ -z "${canonical}" ]]; then
    echo "::error::NVIDIA_INFERENCE_API_KEY secret is required for hosted CI inference." >&2
    exit 1
  fi
  if [[ "${canonical}" != nvapi-* ]]; then
    echo "::error::NVIDIA_INFERENCE_API_KEY must be nvapi-prefixed for hosted CI inference." >&2
    exit 1
  fi
fi

{
  printf 'NEMOCLAW_E2E_USE_HOSTED_INFERENCE=1\n'
  printf 'NEMOCLAW_PROVIDER=custom\n'
  printf 'NEMOCLAW_ENDPOINT_URL=https://inference-api.nvidia.com/v1\n'
  printf 'NEMOCLAW_MODEL=nvidia/nvidia/nemotron-3-super-v3\n'
  printf 'NEMOCLAW_COMPAT_MODEL=nvidia/nvidia/nemotron-3-super-v3\n'
  printf 'NEMOCLAW_PREFERRED_API=openai-completions\n'
  if [[ -n "${canonical}" ]]; then
    printf 'NVIDIA_INFERENCE_API_KEY=%s\n' "${canonical}"
    printf 'COMPATIBLE_API_KEY=%s\n' "${canonical}"
  fi
  if [[ "${INPUT_EXPORT_NVIDIA_API_KEY:-false}" == "true" && -n "${public_alias}" ]]; then
    printf 'NVIDIA_API_KEY=%s\n' "${public_alias}"
  fi
} >>"${GITHUB_ENV}"
