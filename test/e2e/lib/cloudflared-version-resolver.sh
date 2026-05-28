#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Invalid state: Cloudflare's APT retention can drop a previously pinned
# cloudflared version while newer signed packages remain available. The source
# boundary is only Cloudflare's GPG-signed APT metadata; do not scrape a second
# source to recover old pins. The source-fix constraint is to choose an
# available signed package above the floor, or use CLOUDFLARED_VERSION for exact
# repro. Regression coverage lives in test/cloudflared-version-resolver.test.ts.
# Remove this resolver once Cloudflare retains pinned versions long enough for
# nightly E2E, or CI caches a vetted package.

CLOUDFLARED_DEFAULT_MIN_VERSION="${CLOUDFLARED_DEFAULT_MIN_VERSION:-2026.5.1}"

# Return success when the candidate is syntactically valid for dpkg comparison.
cloudflared_is_debian_version() {
  local version="${1:-}"
  [[ "$version" =~ ^[0-9][0-9A-Za-z.+:~-]*$ ]] || return 1
  dpkg --compare-versions "$version" eq "$version" >/dev/null 2>&1
}

# Choose the newest signed Cloudflare APT version that satisfies the floor.
cloudflared_resolve_package_version() {
  local available_versions="${1:-}"
  local min_version="${2:-${CLOUDFLARED_MIN_VERSION:-$CLOUDFLARED_DEFAULT_MIN_VERSION}}"
  local override_version="${3:-${CLOUDFLARED_VERSION:-}}"

  # Emergency repro knob: install the exact requested version and let APT report
  # unavailable overrides, rather than silently substituting another package.
  if [[ -n "$override_version" ]]; then
    printf '%s\n' "$override_version"
    return 0
  fi

  if [[ -z "$available_versions" ]]; then
    printf 'ERROR: no cloudflared versions available in Cloudflare APT repo\n' >&2
    return 1
  fi

  if ! cloudflared_is_debian_version "$min_version"; then
    printf 'ERROR: invalid CLOUDFLARED_MIN_VERSION %q\n' "$min_version" >&2
    return 1
  fi

  local version best_version=""
  while IFS= read -r version; do
    [[ -z "$version" ]] && continue
    if ! cloudflared_is_debian_version "$version"; then
      printf 'ERROR: invalid cloudflared version from Cloudflare APT repo: %q\n' "$version" >&2
      return 1
    fi
    if dpkg --compare-versions "$version" ge "$min_version"; then
      if [[ -z "$best_version" ]] || dpkg --compare-versions "$version" gt "$best_version"; then
        best_version="$version"
      fi
    fi
  done <<<"$available_versions"

  if [[ -z "$best_version" ]]; then
    printf 'ERROR: no cloudflared version in Cloudflare APT repo meets minimum %s\n' "$min_version" >&2
    return 1
  fi

  printf '%s\n' "$best_version"
}
