#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -uo pipefail

phase="${1:-}"
container="${2:-}"
sample="${3:-}"
workspace="${4:-}"

[[ "$phase" == before-nim-image-pull || "$phase" == readiness-final || "$phase" =~ ^readiness-[0-9]+$ ]] || exit 2
[[ -z "$container" || "$container" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || exit 2
[[ -d "$workspace" ]] || exit 2

if [[ "$sample" =~ ^[0-9]+$ ]]; then
  ((sample == 1 || sample % 12 == 0)) || exit 0
else
  [[ "$sample" == initial || "$sample" == final ]] || exit 2
fi

# Read only storage metadata. Docker's container environment contains NGC credentials.
printf 'nim-storage-snapshot phase=%s timestamp=%s\n' "$phase" "$(date -u +%FT%TZ)"
docker_root="$(timeout 5 docker info --format '{{.DockerRootDir}}' 2>/dev/null)" || docker_root=''
for target in / "$workspace" "$docker_root"; do
  [[ -n "$target" && -d "$target" ]] || continue
  printf 'storage-target=%s\n' "$target"
  timeout 5 findmnt -n -T "$target" -o TARGET,SOURCE,FSTYPE 2>&1 || true
  timeout 5 df -P -B1 "$target" 2>&1 || true
  timeout 5 df -P -i "$target" 2>&1 || true
done
if [[ "$sample" == initial || "$sample" == 1 || "$sample" == final ]]; then
  printf 'docker-storage-usage\n'
  timeout 10 docker system df 2>&1 || true
fi
if [[ -n "$container" ]]; then
  cache_mount="$(timeout 5 docker container inspect "$container" --format '{{range .Mounts}}{{if eq .Destination "/opt/nim/.cache"}}{{.Type}}:{{.Source}}{{end}}{{end}}' 2>/dev/null)" || cache_mount=unavailable
  printf 'nim-cache-mount=%s\n' "${cache_mount:-none}"
  timeout 15 docker exec "$container" sh -c 'df -P -B1 /opt/nim/.cache; df -P -i /opt/nim/.cache; du -sk /opt/nim/.cache' 2>&1 || true
fi
