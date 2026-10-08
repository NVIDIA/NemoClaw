#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

update_attempts=1
update_timeout=300s
install_timeout=300s
acquire_timeout=30
if [ "${1:-}" = --retry-transient-update ]; then
  update_attempts=3
  update_timeout=120s
  install_timeout=180s
  acquire_timeout=20
  shift
fi

if [ "$#" -eq 0 ]; then
  echo "::error title=Missing APT packages::Provide pinned package=version specifications." >&2
  exit 2
fi
for package_spec in "$@"; do
  if [[ ! "$package_spec" =~ ^[A-Za-z0-9][A-Za-z0-9.+-]*(:[A-Za-z0-9][A-Za-z0-9.+-]*)?=[^[:space:]=]+$ ]]; then
    echo "::error title=Unpinned APT package::Expected package=version." >&2
    exit 2
  fi
done

ubuntu_sources=/etc/apt/sources.list.d/ubuntu.sources
if ! sudo test -f "$ubuntu_sources" || ! sudo test -r "$ubuntu_sources"; then
  echo "::error title=Missing Ubuntu APT source::Expected readable $ubuntu_sources." >&2
  exit 1
fi
if [ -z "${RUNNER_TEMP:-}" ] || [ ! -d "$RUNNER_TEMP" ]; then
  echo "::error title=Missing runner temporary directory::RUNNER_TEMP must be a directory." >&2
  exit 1
fi

runner_temp_mode="$(stat -c '%a' "$RUNNER_TEMP")"
apt_lists="$(mktemp -d "$RUNNER_TEMP/nemoclaw-apt-lists.XXXXXXXX")"
isolated_sources_dir="$(mktemp -d "$RUNNER_TEMP/nemoclaw-ubuntu-sources.XXXXXXXX")"
isolated_sources="$isolated_sources_dir/ubuntu.sources"
cleanup() {
  local status=$?
  trap - EXIT
  sudo rm -rf -- "$apt_lists" || status=1
  rm -rf -- "$isolated_sources_dir" || status=1
  sudo chmod "$runner_temp_mode" "$RUNNER_TEMP" || status=1
  exit "$status"
}
trap cleanup EXIT

# APT cannot reliably fetch a mirror+file auxiliary list from a custom lists
# directory during install. Resolve only the runner's Ubuntu mirrorlist URI;
# keep each stanza's suites, components, and Signed-By key.
if ! sudo awk '
  $0 == "URIs: mirror+file:/etc/apt/apt-mirrors.txt" {
    print "URIs: https://archive.ubuntu.com/ubuntu"
    replaced++
    next
  }
  /mirror\+file:/ { unexpected = 1 }
  { print }
  END { if (replaced < 1 || unexpected) exit 1 }
' "$ubuntu_sources" | tee "$isolated_sources" >/dev/null; then
  echo "::error title=Unsupported Ubuntu APT source::Expected the Ubuntu archive mirrorlist URI in $ubuntu_sources." >&2
  exit 1
fi
chmod 0755 "$isolated_sources_dir"
chmod 0644 "$isolated_sources"

# APT's _apt user needs traversal into the isolated package-list directory.
sudo chmod o+x "$RUNNER_TEMP"
sudo chmod 0755 "$apt_lists"
sudo install -d -o _apt -g root -m 0700 "$apt_lists/partial"

apt_options=(
  -o "Dir::Etc::sourcelist=$isolated_sources"
  -o "Dir::Etc::sourceparts=-"
  -o "Dir::State::lists=$apt_lists"
  -o "Acquire::http::Timeout=$acquire_timeout"
  -o "Acquire::https::Timeout=$acquire_timeout"
)
if [ "$update_attempts" -gt 1 ]; then
  apt_options+=(-o "Acquire::Retries=2")
fi

run_apt() {
  local operation="$1"
  local duration="$2"
  local attempt="$3"
  local total="$4"
  shift 4
  local log status
  log="$(mktemp "$RUNNER_TEMP/nemoclaw-apt-${operation}.XXXXXXXX")"
  echo "Installing pinned Pi tools: APT $operation started (attempt $attempt/$total)."
  if { sudo timeout -k 10s "$duration" apt-get "${apt_options[@]}" "$@"; } >"$log" 2>&1; then
    rm -f -- "$log"
    echo "Installing pinned Pi tools: APT $operation completed."
    return 0
  else
    status=$?
  fi
  if [ "$status" -eq 124 ]; then
    if [ "$operation" = update ] && [ "$attempt" -lt "$total" ]; then
      echo "::warning title=APT update timed out::Ubuntu package update exceeded $duration on attempt $attempt/$total; retrying the idempotent metadata update." >&2
    else
      echo "::error title=APT $operation timed out::Ubuntu package $operation exceeded $duration on attempt $attempt/$total." >&2
    fi
  elif [ "$status" -eq 137 ]; then
    echo "::error title=APT $operation was force-killed::Ubuntu package $operation exited with status 137 on attempt $attempt/$total; it may have exceeded $duration and been killed by timeout." >&2
  else
    echo "::error title=APT $operation failed::Ubuntu package $operation exited with status $status on attempt $attempt/$total." >&2
  fi
  tail -c 8192 "$log" | tail -n 60 >&2
  rm -f -- "$log"
  return "$status"
}

for ((attempt = 1; attempt <= update_attempts; attempt++)); do
  if run_apt update "$update_timeout" "$attempt" "$update_attempts" update; then
    break
  else
    status=$?
  fi
  if [ "$status" -ne 124 ] || [ "$attempt" -eq "$update_attempts" ]; then
    exit "$status"
  fi
done
run_apt install "$install_timeout" 1 1 install -y --no-install-recommends "$@"
