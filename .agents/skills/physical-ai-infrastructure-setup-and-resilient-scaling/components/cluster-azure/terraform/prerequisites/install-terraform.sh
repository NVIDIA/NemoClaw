#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Install terraform via HashiCorp apt repo (Ubuntu/Debian).
# Idempotent — exits 0 if terraform already on PATH at >= 1.9.8.
set -euo pipefail

REQUIRED_VERSION="1.9.8"

version_ge() {
  local got="${1#v}"
  local want="${2#v}"
  got="${got%%[-+]*}"
  want="${want%%[-+]*}"
  awk -v got="${got}" -v want="${want}" '
    BEGIN {
      split(got, g, ".")
      split(want, w, ".")
      for (i = 1; i <= 3; i++) {
        if ((g[i] + 0) > (w[i] + 0)) exit 0
        if ((g[i] + 0) < (w[i] + 0)) exit 1
      }
    }
  '
}

if command -v terraform &>/dev/null; then
  v=$(terraform version -json | jq -r '.terraform_version')
  if version_ge "${v}" "${REQUIRED_VERSION}"; then
    echo "terraform ${v} already installed"
    exit 0
  fi
  echo "terraform ${v} below required ${REQUIRED_VERSION} — reinstalling"
fi

if [[ "${EUID}" -ne 0 ]]; then
  echo "ERROR: must run as root — use: sudo $0"
  exit 1
fi

source /etc/os-release
: "${VERSION_CODENAME:?VERSION_CODENAME missing in /etc/os-release}"

# HashiCorp official install (GPG + apt repo):
# https://developer.hashicorp.com/terraform/install#linux
apt-get update -y
apt-get install -y gnupg software-properties-common curl
install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://apt.releases.hashicorp.com/gpg \
  | gpg --dearmor --yes -o /etc/apt/keyrings/hashicorp-archive-keyring.gpg
chmod 0644 /etc/apt/keyrings/hashicorp-archive-keyring.gpg
echo "deb [signed-by=/etc/apt/keyrings/hashicorp-archive-keyring.gpg] https://apt.releases.hashicorp.com ${VERSION_CODENAME} main" \
  > /etc/apt/sources.list.d/hashicorp.list
apt-get update -y
apt-get install -y terraform

terraform version
