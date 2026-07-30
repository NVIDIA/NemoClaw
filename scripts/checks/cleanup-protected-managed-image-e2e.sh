#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

runner_temp="${RUNNER_TEMP:?RUNNER_TEMP is required}"
contract_path="${NEMOCLAW_PROTECTED_MANAGED_IMAGE_CONTRACT:-${runner_temp}/protected-managed-images.json}"
expected_contract_path="${runner_temp}/protected-managed-images.json"
[[ "${contract_path}" == "${expected_contract_path}" ]] || {
  echo "ERROR: refusing an unexpected protected managed-image contract path" >&2
  exit 1
}
protected_home="${NEMOCLAW_PROTECTED_MANAGED_IMAGE_HOME:?NEMOCLAW_PROTECTED_MANAGED_IMAGE_HOME is required}"
expected_protected_home="${runner_temp}/nemoclaw-managed-image-home"
[[ "${protected_home}" == "${expected_protected_home}" && ! -L "${protected_home}" ]] || {
  echo "ERROR: refusing an unexpected protected managed-image home" >&2
  exit 1
}
adapter_state_root="${protected_home}/.nemoclaw"
ollama_pid_path="${runner_temp}/protected-managed-image-ollama.pid"

for required_tool in awk docker grep jq lsof ps sed seq sort tr; do
  command -v "${required_tool}" >/dev/null 2>&1 || {
    echo "ERROR: protected managed-image cleanup requires ${required_tool}" >&2
    exit 1
  }
done
docker info >/dev/null 2>&1 || {
  echo "ERROR: protected managed-image cleanup requires a reachable Docker daemon" >&2
  exit 1
}

cleanup_failed=0
cleanup_error() {
  cleanup_failed=1
  echo "ERROR: $*" >&2
}

docker_error_marker="${runner_temp}/protected-managed-image-cleanup-docker-error-$$"
rm -f -- "${docker_error_marker}"
docker_capture() {
  if ! docker "$@" 2>/dev/null; then
    : >"${docker_error_marker}"
  fi
  return 0
}

remove_container_ids() {
  local label="$1"
  shift
  local ids=("$@")
  ((${#ids[@]} == 0)) && return 0
  docker rm -f "${ids[@]}" >/dev/null 2>&1 || cleanup_error "could not remove ${label}"
}

remove_container_ids_with_anonymous_volumes() {
  local label="$1"
  shift
  local ids=("$@")
  ((${#ids[@]} == 0)) && return 0
  docker rm -f -v "${ids[@]}" >/dev/null 2>&1 \
    || cleanup_error "could not remove ${label} and its anonymous volumes"
}

mapfile -t protected_registry_ids < <(
  docker_capture ps -a --no-trunc --format '{{.ID}} {{.Names}}' \
    | awk '$2 ~ /^nemoclaw-protected-(gpu|rollback)-[1-9][0-9]*-[1-9][0-9]*$/ { print $1 }'
)
remove_container_ids_with_anonymous_volumes \
  "protected registry containers" \
  "${protected_registry_ids[@]}"
if [[ -n "$(lsof -tiTCP:5000 -sTCP:LISTEN 2>/dev/null || true)" ]]; then
  cleanup_error "protected registry port 5000 remained occupied after cleanup"
fi

mapfile -t protected_vllm_ids < <(
  docker_capture ps -aq --no-trunc --filter "name=^/nemoclaw-managed-image-vllm-e2e$"
)
remove_container_ids "protected vLLM container" "${protected_vllm_ids[@]}"
if docker container inspect nemoclaw-managed-image-vllm-e2e >/dev/null 2>&1; then
  cleanup_error "protected vLLM container remained after cleanup"
fi

protected_sandboxes=(
  nemoclaw-managed-openclaw-ollama
  nemoclaw-managed-hermes-ollama
  nemoclaw-managed-dcode-ollama
  nemoclaw-managed-openclaw-vllm
  nemoclaw-managed-hermes-vllm
  nemoclaw-managed-dcode-vllm
  nemoclaw-managed-openclaw-rollback
  nemoclaw-managed-hermes-rollback
  nemoclaw-managed-dcode-rollback
)
for sandbox_name in "${protected_sandboxes[@]}"; do
  mapfile -t sandbox_ids < <(
    docker_capture ps -aq --no-trunc \
      --filter "label=openshell.ai/managed-by=openshell" \
      --filter "label=openshell.ai/sandbox-name=${sandbox_name}"
  )
  remove_container_ids "sandbox ${sandbox_name}" "${sandbox_ids[@]}"
  if [[ -n "$(docker_capture ps -aq --no-trunc --filter "label=openshell.ai/managed-by=openshell" --filter "label=openshell.ai/sandbox-name=${sandbox_name}")" ]]; then
    cleanup_error "protected sandbox container ${sandbox_name} remained after cleanup"
  fi
done

mapfile -t protected_network_rows < <(
  docker_capture network ls --no-trunc --format '{{.ID}} {{.Name}}' \
    | awk '$2 ~ /^nemoclaw-managed-pr-[1-9][0-9]*-[a-z0-9]+$/ { print $1 " " $2 }'
)
for row in "${protected_network_rows[@]}"; do
  network_id="${row%% *}"
  network_name="${row#* }"
  if ! docker network rm "${network_id}" >/dev/null 2>&1; then
    cleanup_error "could not remove protected network ${network_name}"
  fi
done
if docker_capture network ls --format '{{.Name}}' | grep -Eq '^nemoclaw-managed-pr-[1-9][0-9]*-[a-z0-9]+$'; then
  cleanup_error "one or more protected managed-image networks remained after cleanup"
fi

shopt -s nullglob
state_dirs=("${runner_temp}"/nemoclaw-managed-openshell-*)
shopt -u nullglob
declare -A gateway_pids=()
for state_dir in "${state_dirs[@]}"; do
  state_name="${state_dir##*/}"
  if [[ ! -d "${state_dir}" || ! "${state_name}" =~ ^nemoclaw-managed-openshell-[A-Za-z0-9]+$ ]]; then
    cleanup_error "refusing unexpected managed-image gateway state path ${state_dir}"
    continue
  fi
  pid_file="${state_dir}/openshell-gateway.pid"
  if [[ -f "${pid_file}" ]]; then
    gateway_pid="$(tr -d '[:space:]' <"${pid_file}")"
    if [[ "${gateway_pid}" =~ ^[1-9][0-9]*$ ]]; then
      gateway_pids["${gateway_pid}"]=1
    else
      cleanup_error "invalid gateway PID file in ${state_dir}"
    fi
  fi
done

mapfile -t compat_gateway_ids < <(
  docker_capture ps -aq --no-trunc --filter "name=^/nemoclaw-openshell-gateway$"
)
for compat_gateway_id in "${compat_gateway_ids[@]}"; do
  compat_gateway_network="$(
    docker_capture inspect --format '{{.HostConfig.NetworkMode}}' "${compat_gateway_id}"
  )"
  mapfile -t compat_gateway_mounts < <(
    docker_capture inspect --format '{{range .Mounts}}{{println .Source}}{{end}}' \
      "${compat_gateway_id}"
  )
  compat_gateway_owned=0
  for state_dir in "${state_dirs[@]}"; do
    for mount_source in "${compat_gateway_mounts[@]}"; do
      [[ "${mount_source}" == "${state_dir}" ]] && compat_gateway_owned=1
    done
  done
  if [[ "${compat_gateway_network}" != "host" || "${compat_gateway_owned}" -ne 1 ]]; then
    cleanup_error \
      "refusing to remove unverified OpenShell compatibility gateway container ${compat_gateway_id}"
    continue
  fi
  remove_container_ids "protected OpenShell compatibility gateway container" \
    "${compat_gateway_id}"
done
if [[ -n "$(docker_capture ps -aq --no-trunc --filter "name=^/nemoclaw-openshell-gateway$")" ]]; then
  cleanup_error "protected OpenShell compatibility gateway container remained after cleanup"
fi

while IFS= read -r gateway_pid; do
  [[ "${gateway_pid}" =~ ^[1-9][0-9]*$ ]] && gateway_pids["${gateway_pid}"]=1
done < <(lsof -tiTCP:8080 -sTCP:LISTEN 2>/dev/null || true)

gateway_cleanup_safe=1
for gateway_pid in "${!gateway_pids[@]}"; do
  kill -0 "${gateway_pid}" 2>/dev/null || continue
  cmdline="$(tr '\000' ' ' <"/proc/${gateway_pid}/cmdline" 2>/dev/null || true)"
  process_env="$(tr '\000' '\n' <"/proc/${gateway_pid}/environ" 2>/dev/null || true)"
  process_state_dir="$(sed -n 's/^NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR=//p' <<<"${process_env}" | tail -n1)"
  owned_state=0
  for state_dir in "${state_dirs[@]}"; do
    [[ "${process_state_dir}" == "${state_dir}" ]] && owned_state=1
  done
  if [[ "${owned_state}" -ne 1 ]] \
    || ! grep -Fxq 'NEMOCLAW_GATEWAY_PORT=8080' <<<"${process_env}" \
    || ! grep -Fxq 'OPENSHELL_GATEWAY=nemoclaw' <<<"${process_env}" \
    || [[ ! "${cmdline}" =~ openshell-gateway && ! "${cmdline}" =~ openshell[[:space:]]+gateway[[:space:]]+start ]]; then
    cleanup_error "refusing to signal unverified PID ${gateway_pid} on the protected gateway boundary"
    gateway_cleanup_safe=0
    continue
  fi
  kill "${gateway_pid}" 2>/dev/null || true
  for _ in $(seq 1 30); do
    kill -0 "${gateway_pid}" 2>/dev/null || break
    sleep 0.1
  done
  if kill -0 "${gateway_pid}" 2>/dev/null; then
    kill -9 "${gateway_pid}" 2>/dev/null || true
  fi
  if kill -0 "${gateway_pid}" 2>/dev/null; then
    cleanup_error "protected gateway PID ${gateway_pid} remained after cleanup"
    gateway_cleanup_safe=0
  fi
done
if [[ -n "$(lsof -tiTCP:8080 -sTCP:LISTEN 2>/dev/null || true)" ]]; then
  cleanup_error "protected gateway port 8080 remained occupied after cleanup"
  gateway_cleanup_safe=0
fi
if [[ "${gateway_cleanup_safe}" -eq 1 ]]; then
  for state_dir in "${state_dirs[@]}"; do
    state_name="${state_dir##*/}"
    if [[ -d "${state_dir}" && "${state_name}" =~ ^nemoclaw-managed-openshell-[A-Za-z0-9]+$ ]]; then
      rm -rf -- "${state_dir}"
    fi
  done
fi

stop_owned_local_inference_process() {
  local label="$1"
  local pid_path="$2"
  local port="$3"
  local command_pattern="$4"
  local expected_environment="$5"
  local runtime_pid=""
  local runtime_args=""
  local runtime_env=""
  local -a remaining_runtime_pids=()
  if [[ -e "${pid_path}" ]]; then
    if [[ -L "${pid_path}" || ! -f "${pid_path}" ]]; then
      cleanup_error "refusing invalid protected ${label} PID path"
      return
    fi
    runtime_pid="$(tr -d '[:space:]' <"${pid_path}")"
    if [[ ! "${runtime_pid}" =~ ^[1-9][0-9]*$ ]]; then
      cleanup_error "invalid protected ${label} PID"
      return
    fi
  fi

  if [[ -n "${runtime_pid}" ]] && kill -0 "${runtime_pid}" 2>/dev/null; then
    runtime_args="$(tr '\000' ' ' <"/proc/${runtime_pid}/cmdline" 2>/dev/null || true)"
    runtime_env="$(tr '\000' '\n' <"/proc/${runtime_pid}/environ" 2>/dev/null || true)"
    if [[ ! "${runtime_args}" =~ ${command_pattern} ]] \
      || ! grep -Fxq "HOME=${protected_home}" <<<"${runtime_env}" \
      || ! grep -Fxq "${expected_environment}" <<<"${runtime_env}"; then
      cleanup_error "refusing to signal unverified protected ${label} PID ${runtime_pid}"
      return
    fi
    kill "${runtime_pid}" 2>/dev/null || true
    for _ in $(seq 1 30); do
      kill -0 "${runtime_pid}" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "${runtime_pid}" 2>/dev/null; then
      kill -9 "${runtime_pid}" 2>/dev/null || true
      for _ in $(seq 1 30); do
        kill -0 "${runtime_pid}" 2>/dev/null || break
        sleep 0.1
      done
    fi
    if kill -0 "${runtime_pid}" 2>/dev/null; then
      cleanup_error "protected ${label} PID ${runtime_pid} remained after cleanup"
    fi
  fi

  mapfile -t remaining_runtime_pids < <(
    lsof -tiTCP:"${port}" -sTCP:LISTEN 2>/dev/null || true
  )
  if ((${#remaining_runtime_pids[@]} > 0)); then
    cleanup_error \
      "protected ${label} port ${port} is occupied by an unowned or surviving listener"
  fi
}

stop_owned_local_inference_process \
  "Ollama runtime" \
  "${ollama_pid_path}" \
  11434 \
  'ollama[[:space:]]+serve' \
  'OLLAMA_HOST=127.0.0.1:11434'
stop_owned_local_inference_process \
  "Ollama auth proxy" \
  "${adapter_state_root}/ollama-auth-proxy.pid" \
  11435 \
  'ollama-auth-proxy\.(js|mts)' \
  'OLLAMA_PROXY_PORT=11435'

if [[ -f "${contract_path}" ]]; then
  if jq -e '
    length == 3 and
    all(.[];
      (.reference | test("^localhost:5000/nemoclaw-managed-protected/[^@[:space:]]+@sha256:[a-f0-9]{64}$")) and
      (.localContentId | test("^sha256:[a-f0-9]{64}$"))
    )
  ' "${contract_path}" >/dev/null; then
    while IFS=$'\t' read -r reference content_id; do
      docker image rm -f "${reference}" "${content_id}" >/dev/null 2>&1 || true
      if docker image inspect "${reference}" >/dev/null 2>&1 \
        || docker image inspect "${content_id}" >/dev/null 2>&1; then
        cleanup_error "protected image ${reference} remained after exact cleanup"
      fi
    done < <(jq -r '.[] | [.reference, .localContentId] | @tsv' "${contract_path}")
  else
    cleanup_error "protected managed-image cleanup contract is invalid"
  fi
fi

mapfile -t protected_image_ids < <(
  docker_capture image ls --no-trunc --format '{{.Repository}} {{.ID}}' \
    | awk '$1 ~ /^localhost:5000\/nemoclaw-managed-protected\/[^[:space:]]+$/ { print $2 }' \
    | sort -u
)
if ((${#protected_image_ids[@]} > 0)); then
  docker image rm -f "${protected_image_ids[@]}" >/dev/null 2>&1 \
    || cleanup_error "could not remove partial protected managed images"
fi
if docker_capture image ls --no-trunc --format '{{.Repository}}' \
  | grep -Eq '^localhost:5000/nemoclaw-managed-protected/[^[:space:]]+$'; then
  cleanup_error "one or more protected managed-image repositories remained after cleanup"
fi

if [[ -f "${docker_error_marker}" ]]; then
  cleanup_error "one or more Docker inventory commands failed during protected cleanup"
fi
docker info >/dev/null 2>&1 \
  || cleanup_error "Docker daemon was not reachable after protected managed-image cleanup"
if [[ "${cleanup_failed}" -ne 0 ]]; then
  rm -f -- "${docker_error_marker}"
  exit 1
fi
rm -f -- "${contract_path}" "${contract_path}.tmp" "${docker_error_marker}"
rm -f -- "${ollama_pid_path}"
rm -rf -- "${protected_home}"
echo "Protected managed-image E2E resources are clean."
