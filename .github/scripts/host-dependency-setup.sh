#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

if (($# != 0)); then
  echo "::error::Host dependency setup does not accept arguments." >&2
  exit 1
fi

if [[ -z "${HOST_DEPENDENCY_PACKAGES:-}" ]]; then
  echo "::error::Host dependency setup requires at least one package." >&2
  exit 1
fi

if [[ "${HOST_DEPENDENCY_PACKAGES}" == *[$'\t\r\n']* ]]; then
  echo "::error::Host dependency packages must be space-separated on one line." >&2
  exit 1
fi

read -r -a requested_packages <<<"${HOST_DEPENDENCY_PACKAGES}"
if ((${#requested_packages[@]} == 0)); then
  echo "::error::Host dependency setup requires at least one package." >&2
  exit 1
fi
allowlist=" expect iptables "
for package in "${requested_packages[@]}"; do
  if [[ "${allowlist}" != *" ${package} "* ]]; then
    echo "::error::Host dependency package '${package}' is outside the reviewed allowlist." >&2
    exit 1
  fi
done

for attempt in 1 2 3; do
  if sudo apt-get update; then
    break
  fi
  if [[ "${attempt}" -eq 3 ]]; then
    echo "::error::apt-get update failed after 3 attempts." >&2
    exit 1
  fi
  echo "::warning::apt-get update attempt ${attempt} failed; retrying." >&2
  sleep $((attempt * 5))
done
sudo apt-get install -y --no-install-recommends "${requested_packages[@]}"
