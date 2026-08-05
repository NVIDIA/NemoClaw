#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -uo pipefail

readonly CUDA_PROBE='import ctypes; lib=ctypes.CDLL("libcuda.so.1"); rc=lib.cuInit(0); print(f"cuInit(0)={rc}"); raise SystemExit(rc != 0)'

run_sandbox_probe() {
  local cuda_status nvmap_status

  id
  grep '^Groups:' /proc/self/status || true
  if stat -Lc 'nvmap type=%F mode=%a uid=%u gid=%g' /dev/nvmap 2>/dev/null; then
    if [[ -r /dev/nvmap && -w /dev/nvmap ]]; then
      echo 'nvmap_access=read-write'
      nvmap_status=0
    else
      echo 'nvmap_access=denied'
      nvmap_status=1
    fi
  else
    echo 'nvmap_access=missing'
    nvmap_status=1
  fi

  python3 -c "$CUDA_PROBE"
  cuda_status=$?
  [[ "$nvmap_status" == "0" && "$cuda_status" == "0" ]]
}

run_stage() {
  local label="$1"
  shift

  printf '\n=== %s ===\n' "$label"
  "$@"
  local status=$?
  printf 'stage_status=%s\n' "$status"
  return "$status"
}

if [[ "${1:-}" == "--inside-sandbox" ]]; then
  run_sandbox_probe
  exit $?
fi

if [[ "${1:-}" == "--inside-root" ]]; then
  echo "sandbox_account=$(id sandbox 2>&1 || true)"
  for gid in ${NEMOCLAW_JETSON_DEVICE_GROUP_GIDS//,/ }; do
    getent group "$gid" || true
  done

  sandbox_uid="$(id -u sandbox)"
  sandbox_gid="$(id -g sandbox)"
  if command -v setpriv >/dev/null 2>&1; then
    exec setpriv --reuid="$sandbox_uid" --regid="$sandbox_gid" --init-groups \
      /bin/bash /tmp/nemoclaw-jetson-nvmap-poc --inside-sandbox
  fi
  if command -v runuser >/dev/null 2>&1; then
    exec runuser -u sandbox -- /bin/bash /tmp/nemoclaw-jetson-nvmap-poc --inside-sandbox
  fi
  echo 'Neither setpriv nor runuser is available to exercise initgroups().' >&2
  exit 1
fi

sandbox_name="${1:-tm}"
command -v docker >/dev/null 2>&1 || {
  echo 'docker is required.' >&2
  exit 1
}
command -v openshell >/dev/null 2>&1 || {
  echo 'openshell is required.' >&2
  exit 1
}

mapfile -t sandbox_container_ids < <(
  docker ps -q \
    --filter 'label=openshell.ai/managed-by=openshell' \
    --filter "label=openshell.ai/sandbox-name=${sandbox_name}"
)
if [[ "${#sandbox_container_ids[@]}" != "1" ]]; then
  echo "Expected one running OpenShell Docker container for sandbox '${sandbox_name}', found ${#sandbox_container_ids[@]}." >&2
  exit 1
fi

readonly sandbox_container_id="${sandbox_container_ids[0]}"
sandbox_image_id="$(docker inspect --format '{{.Image}}' "$sandbox_container_id")"
readonly sandbox_image_id
script_path="$(readlink -f "$0")"
readonly script_path

printf 'sandbox=%s\ncontainer=%s\nimage=%s\n' \
  "$sandbox_name" "$sandbox_container_id" "$sandbox_image_id"

printf '\n=== host device ===\n'
host_status=0
if stat -Lc 'type=%F mode=%a uid=%u gid=%g group=%G path=%n' /dev/nvmap 2>/dev/null; then
  host_mode="$(stat -Lc '%a' /dev/nvmap)"
  host_mode_value=$((8#${host_mode: -3}))
  if ((((host_mode_value >> 3) & 6) != 6)); then
    echo 'host_nvmap_group_access=not-read-write'
    host_status=1
  else
    echo 'host_nvmap_group_access=read-write'
  fi
else
  echo 'host_nvmap=missing'
  host_status=1
fi
if [[ -f /etc/udev/rules.d/99-zz-nemoclaw-nvmap.rules ]]; then
  echo 'host_nvmap_udev_rule=present'
else
  echo 'host_nvmap_udev_rule=missing'
fi
printf 'stage_status=%s\n' "$host_status"

mapfile -t tegra_group_gids < <(
  for device in \
    /dev/nvmap \
    /dev/nvhost-ctrl \
    /dev/nvhost-ctrl-gpu \
    /dev/nvhost-gpu \
    /dev/nvhost-as-gpu \
    /dev/nvhost-prof-gpu \
    /dev/nvhost-dbg-gpu \
    /dev/nvhost-tsg-gpu \
    /dev/nvgpu/igpu0/ctrl \
    /dev/nvgpu/igpu0/as \
    /dev/nvgpu/igpu0/prof \
    /dev/dri/renderD*; do
    [[ -c "$device" && ! -L "$device" ]] || continue
    read -r gid mode < <(stat -Lc '%g %a' "$device")
    mode_value=$((8#${mode: -3}))
    group_bits=$(((mode_value >> 3) & 6))
    other_bits=$((mode_value & 6))
    if ((gid > 0 && group_bits == 6 && other_bits != 6)); then
      printf '%s\n' "$gid"
    fi
  done | sort -nu
)
tegra_gids_csv="$(
  IFS=,
  echo "${tegra_group_gids[*]}"
)"
readonly tegra_gids_csv
echo "detected_tegra_group_gids=${tegra_gids_csv:-none}"

probe_command="$(declare -f run_sandbox_probe); CUDA_PROBE=$(printf '%q' "$CUDA_PROBE"); run_sandbox_probe"

run_stage 'outer container as root' \
  docker exec --user 0 "$sandbox_container_id" /bin/bash -lc "$probe_command"
outer_root_status=$?

run_stage 'outer container as sandbox' \
  docker exec --user sandbox "$sandbox_container_id" /bin/bash -lc "$probe_command"
outer_sandbox_status=$?

run_stage 'OpenShell sandbox execution' \
  openshell sandbox exec -n "$sandbox_name" -- /bin/bash -lc "$probe_command"
openshell_status=$?

isolated_status=1
printf '\n=== isolated Docker bootstrap POC ===\n'
if [[ "$host_status" != "0" ]]; then
  echo 'skipped: host /dev/nvmap does not grant its owning group read-write access'
elif [[ "${#tegra_group_gids[@]}" == "0" ]]; then
  echo 'skipped: no usable Tegra device groups were detected'
else
  docker_args=(
    run --rm
    --runtime nvidia
    --env NVIDIA_VISIBLE_DEVICES=all
    --env 'NVIDIA_DRIVER_CAPABILITIES=compute,utility'
    --env "NEMOCLAW_JETSON_DEVICE_GROUP_GIDS=$tegra_gids_csv"
    --volume "$script_path:/tmp/nemoclaw-jetson-nvmap-poc:ro"
    --entrypoint /usr/local/lib/nemoclaw/jetson-device-group-bootstrap.sh
  )
  for gid in "${tegra_group_gids[@]}"; do
    docker_args+=(--group-add "$gid")
  done
  docker_args+=("$sandbox_image_id" /bin/bash /tmp/nemoclaw-jetson-nvmap-poc --inside-root)
  docker "${docker_args[@]}"
  isolated_status=$?
fi
printf 'stage_status=%s\n' "$isolated_status"

printf '\n=== verdict ===\n'
if [[ "$host_status" != "0" ]]; then
  echo 'FAIL boundary=host-nvmap-mode'
elif [[ "$isolated_status" != "0" ]]; then
  echo 'FAIL boundary=docker-runtime-or-bootstrap'
elif [[ "$outer_sandbox_status" != "0" ]]; then
  echo 'FAIL boundary=recreated-container-bootstrap'
elif [[ "$openshell_status" != "0" ]]; then
  echo 'FAIL boundary=openshell-sandbox-execution'
else
  echo 'PASS boundary=end-to-end'
fi

echo "evidence host=$host_status isolated=$isolated_status outer_root=$outer_root_status outer_sandbox=$outer_sandbox_status openshell=$openshell_status"
