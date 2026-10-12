#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Exercise the installed CLI and real OpenShell file-transfer boundary (#11378).
# The owning cloud-onboard test removes the disposable sandbox, including these
# remote fixtures, even when a transfer assertion fails.

set -euo pipefail

: "${SANDBOX_NAME:?SANDBOX_NAME must name the disposable test sandbox}"
download_dir=$(mktemp -d "${TMPDIR:-/tmp}/nemoclaw-download-paths.XXXXXX")
trap 'rm -rf -- "$download_dir"' EXIT
remote_root="-${download_dir##*/}"

# The sandbox shell expands $1; the host must pass the script literally.
# shellcheck disable=SC2016
openshell sandbox exec --name "$SANDBOX_NAME" -- sh -eu -c '
  mkdir -p -- "./$1/nested directory"
  printf "hyphen-file\n" > "./$1/file.txt"
  printf "hyphen-directory\n" > "./$1/nested directory/child file.txt"
  ln -s -- file.txt "./$1/link.txt"
' sh "$remote_root"

nemoclaw "$SANDBOX_NAME" download -- "$remote_root/file.txt" "$download_dir/file.txt"
printf 'hyphen-file\n' >"$download_dir/expected-file.txt"
cmp "$download_dir/expected-file.txt" "$download_dir/file.txt"

nemoclaw "$SANDBOX_NAME" download -- "$remote_root/nested directory" "$download_dir/directory"
printf 'hyphen-directory\n' >"$download_dir/expected-directory.txt"
cmp "$download_dir/expected-directory.txt" "$download_dir/directory/child file.txt"

# Refusing a normalized symlink source must also preserve the host destination.
printf 'keep-existing-destination\n' >"$download_dir/refused.txt"
cp "$download_dir/refused.txt" "$download_dir/expected-refused.txt"
if nemoclaw "$SANDBOX_NAME" download -- "$remote_root/link.txt" "$download_dir/refused.txt" >"$download_dir/refusal.log" 2>&1; then
  printf '%s\n' 'sandbox-download-paths: symbolic-link source was accepted' >&2
  exit 1
fi
cat "$download_dir/refusal.log"
grep -Fq 'source is not a regular file or directory' "$download_dir/refusal.log"
cmp "$download_dir/expected-refused.txt" "$download_dir/refused.txt"

openshell sandbox exec --name "$SANDBOX_NAME" -- rm -rf -- "./$remote_root"
printf '%s\n' 'sandbox-download-paths: OK (file bytes, directory bytes, symlink refusal)'
