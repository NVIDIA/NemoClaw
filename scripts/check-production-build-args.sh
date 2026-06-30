#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Defense-in-depth guard: primary enforcement of legacy fixture pin rejection is
# in Dockerfile and Dockerfile.base install blocks. This script prevents the
# fixture flag, versions, and pin overrides from reaching production Docker
# build commands.

set -euo pipefail

readonly legacy_fixture_key="NEMOCLAW_E2E_FIXTURE_LEGACY_OPENCLAW"

fail_legacy_fixture() {
  echo "ERROR: ${legacy_fixture_key}=1 is only allowed in explicit stale-upgrade E2E fixture builds." >&2
  echo "       Do not pass it to production Docker image build args." >&2
  exit 1
}

fail_legacy_pin() {
  echo "ERROR: legacy OpenClaw fixture versions and pin overrides are not allowed in production image builds." >&2
  echo "       Use only the reviewed production OpenClaw pin in production build args." >&2
  exit 1
}

check_legacy_pin_arg() {
  case "$1" in
    OPENCLAW_VERSION=2026.3.11 | OPENCLAW_VERSION=2026.4.24 | \
      OPENCLAW_2026_3_11_INTEGRITY | OPENCLAW_2026_3_11_INTEGRITY=* | \
      OPENCLAW_2026_3_11_TARBALL | OPENCLAW_2026_3_11_TARBALL=* | \
      OPENCLAW_2026_4_24_INTEGRITY | OPENCLAW_2026_4_24_INTEGRITY=* | \
      OPENCLAW_2026_4_24_TARBALL | OPENCLAW_2026_4_24_TARBALL=*)
      fail_legacy_pin
      ;;
  esac
}

if [ "${NEMOCLAW_E2E_FIXTURE_LEGACY_OPENCLAW:-0}" = "1" ]; then
  fail_legacy_fixture
fi

case "${OPENCLAW_VERSION:-}" in
  2026.3.11 | 2026.4.24) fail_legacy_pin ;;
esac

if [ -n "${OPENCLAW_2026_3_11_INTEGRITY+x}" ] \
  || [ -n "${OPENCLAW_2026_3_11_TARBALL+x}" ] \
  || [ -n "${OPENCLAW_2026_4_24_INTEGRITY+x}" ] \
  || [ -n "${OPENCLAW_2026_4_24_TARBALL+x}" ]; then
  fail_legacy_pin
fi

previous_arg=""
for arg in "$@"; do
  case "$arg" in
    "${legacy_fixture_key}=1" | "--build-arg=${legacy_fixture_key}=1")
      fail_legacy_fixture
      ;;
  esac

  check_legacy_pin_arg "${arg#--build-arg=}"

  if [ "$previous_arg" = "--build-arg" ] && [ "$arg" = "${legacy_fixture_key}=1" ]; then
    fail_legacy_fixture
  fi
  previous_arg="$arg"
done
