#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail

if [[ $# -ne 1 || ! $1 =~ ^[1-9][0-9]*$ ]]; then
  echo "usage: run-trusted-check-gates.sh <pr-number>" >&2
  exit 2
fi

mapfile -t origin_urls < <(git remote get-url --all origin)
[[ ${#origin_urls[@]} -gt 0 ]]
for url in "${origin_urls[@]}"; do
  [[ $url =~ ^https://github[.]com/NVIDIA/NemoClaw([.]git)?$ || $url =~ ^git@github[.]com:NVIDIA/NemoClaw([.]git)?$ || $url =~ ^ssh://git@github[.]com/NVIDIA/NemoClaw([.]git)?$ ]] || {
    echo "origin must identify NVIDIA/NemoClaw" >&2
    exit 3
  }
done
git fetch --no-tags origin refs/heads/main:refs/remotes/origin/main
trusted_tmp=$(mktemp -d)
trusted_root="$trusted_tmp/main"
cleanup() {
  git worktree remove --force "$trusted_root" >/dev/null 2>&1 || true
  rmdir "$trusted_tmp" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM
git worktree add --detach "$trusted_root" refs/remotes/origin/main
path=.agents/skills/nemoclaw-maintainer-day/scripts/check-gates.ts
surface=("$path" .agents/skills/nemoclaw-maintainer-day/scripts/shared.ts)
for file in "${surface[@]}"; do
  test -f "$trusted_root/$file"
  test -f "$file"
  cmp -s "$trusted_root/$file" "$file"
done
test -z "$(git status --porcelain -- "${surface[@]}")"
node --experimental-strip-types --no-warnings "$trusted_root/$path" "$1"
