#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Defense-in-depth guard: primary enforcement of legacy fixture pin rejection is
# in Dockerfile and Dockerfile.base install blocks. This script prevents the
# fixture flag from reaching production Docker build commands.

set -euo pipefail

readonly legacy_fixture_key="NEMOCLAW_E2E_FIXTURE_LEGACY_OPENCLAW"

fail_legacy_fixture() {
  echo "ERROR: ${legacy_fixture_key}=1 is only allowed in explicit stale-upgrade E2E fixture builds." >&2
  echo "       Do not pass it to production Docker image build args." >&2
  exit 1
}

if [ "${NEMOCLAW_E2E_FIXTURE_LEGACY_OPENCLAW:-0}" = "1" ]; then
  fail_legacy_fixture
fi

previous_arg=""
for arg in "$@"; do
  case "$arg" in
    "${legacy_fixture_key}=1" | "--build-arg=${legacy_fixture_key}=1")
      fail_legacy_fixture
      ;;
  esac

  if [ "$previous_arg" = "--build-arg" ] && [ "$arg" = "${legacy_fixture_key}=1" ]; then
    fail_legacy_fixture
  fi
  previous_arg="$arg"
done
