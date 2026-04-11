#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

socket_exists() {
  local socket_path="$1"

  if [ -n "${NEMOCLAW_TEST_SOCKET_PATHS:-}" ]; then
    case ":$NEMOCLAW_TEST_SOCKET_PATHS:" in
      *":$socket_path:"*) return 0 ;;
    esac
    return 1
  fi

  [ -S "$socket_path" ]
}

find_colima_docker_socket() {
  local home_dir="${1:-${HOME:-/tmp}}"
  local socket_path

  for socket_path in \
    "$home_dir/.colima/default/docker.sock" \
    "$home_dir/.config/colima/default/docker.sock"; do
    if socket_exists "$socket_path"; then
      printf '%s\n' "$socket_path"
      return 0
    fi
  done

  return 1
}

find_docker_desktop_socket() {
  local home_dir="${1:-${HOME:-/tmp}}"
  local socket_path="$home_dir/.docker/run/docker.sock"

  if socket_exists "$socket_path"; then
    printf '%s\n' "$socket_path"
    return 0
  fi

  return 1
}

detect_docker_host() {
  if [ -n "${DOCKER_HOST:-}" ]; then
    printf '%s\n' "$DOCKER_HOST"
    return 0
  fi

  local home_dir="${1:-${HOME:-/tmp}}"
  local socket_path

  if socket_path="$(find_colima_docker_socket "$home_dir")"; then
    printf 'unix://%s\n' "$socket_path"
    return 0
  fi

  if socket_path="$(find_podman_socket "$home_dir")"; then
    printf 'unix://%s\n' "$socket_path"
    return 0
  fi

  if socket_path="$(find_docker_desktop_socket "$home_dir")"; then
    printf 'unix://%s\n' "$socket_path"
    return 0
  fi

  return 1
}

docker_host_runtime() {
  local docker_host="${1:-${DOCKER_HOST:-}}"

  case "$docker_host" in
    unix://*"/.colima/default/docker.sock" | unix://*"/.config/colima/default/docker.sock")
      printf 'colima\n'
      ;;
    unix://*"/podman/machine/podman.sock" | unix://*"/podman/podman.sock")
      printf 'podman\n'
      ;;
    unix://*"/.docker/run/docker.sock")
      printf 'docker-desktop\n'
      ;;
    "")
      return 1
      ;;
    *)
      printf 'custom\n'
      ;;
  esac
}

infer_container_runtime_from_info() {
  local info="${1:-}"
  local normalized
  normalized="$(printf '%s' "$info" | tr '[:upper:]' '[:lower:]')"

  if [[ -z "${normalized// /}" ]]; then
    printf 'unknown\n'
  elif [[ "$normalized" == *podman* ]]; then
    printf 'podman\n'
  elif [[ "$normalized" == *colima* ]]; then
    printf 'colima\n'
  elif [[ "$normalized" == *"docker desktop"* ]]; then
    printf 'docker-desktop\n'
  elif [[ "$normalized" == *docker* ]]; then
    printf 'docker\n'
  else
    printf 'unknown\n'
  fi
}

find_podman_socket() {
  local home_dir="${1:-${HOME:-/tmp}}"
  local socket_path

  if [ "$(uname -s)" = "Darwin" ]; then
    for socket_path in \
      "$home_dir/.local/share/containers/podman/machine/podman.sock" \
      "/var/run/docker.sock"; do
      if socket_exists "$socket_path"; then
        printf '%s\n' "$socket_path"
        return 0
      fi
    done
  else
    local uid
    uid="$(id -u 2>/dev/null || echo 1000)"
    # XDG_RUNTIME_DIR takes priority (user-set, may differ from /run/user/$uid)
    local xdg_sock="${XDG_RUNTIME_DIR:-/run/user/$uid}/podman/podman.sock"
    for socket_path in \
      "$xdg_sock" \
      "/run/user/$uid/podman/podman.sock" \
      "/run/podman/podman.sock"; do
      if socket_exists "$socket_path"; then
        printf '%s\n' "$socket_path"
        return 0
      fi
    done
  fi

  return 1
}

is_loopback_ip() {
  local ip="${1:-}"
  [[ "$ip" == 127.* ]]
}

is_wsl() {
  local release="${1:-$(uname -r 2>/dev/null || true)}"

  if [ -n "${WSL_DISTRO_NAME:-}" ] || [ -n "${WSL_INTEROP:-}" ]; then
    return 0
  fi

  printf '%s' "$release" | grep -qi "microsoft"
}

first_non_loopback_nameserver() {
  local resolv_conf="${1:-}"

  if [ -z "$resolv_conf" ]; then
    return 1
  fi

  printf '%s\n' "$resolv_conf" \
    | awk '$1 == "nameserver" && $2 !~ /^127\./ { print $2; exit }'
}

get_colima_vm_nameserver() {
  if ! command -v colima >/dev/null 2>&1; then
    return 1
  fi

  local profile="${COLIMA_PROFILE:-default}"
  local resolv_conf
  resolv_conf="$(colima ssh --profile "$profile" -- cat /etc/resolv.conf </dev/null 2>/dev/null || true)"
  first_non_loopback_nameserver "$resolv_conf"
}

resolve_coredns_upstream() {
  local container_resolv_conf="${1:-}"
  local host_resolv_conf="${2:-}"
  local runtime="${3:-unknown}"
  local nameserver=""

  nameserver="$(first_non_loopback_nameserver "$container_resolv_conf" || true)"
  if [ -n "$nameserver" ]; then
    printf '%s\n' "$nameserver"
    return 0
  fi

  if [ "$runtime" = "colima" ]; then
    nameserver="$(get_colima_vm_nameserver || true)"
    if [ -n "$nameserver" ]; then
      printf '%s\n' "$nameserver"
      return 0
    fi
  fi

  nameserver="$(first_non_loopback_nameserver "$host_resolv_conf" || true)"
  if [ -n "$nameserver" ]; then
    printf '%s\n' "$nameserver"
    return 0
  fi

  return 1
}

select_openshell_cluster_container() {
  local gateway_name="${1:-}"
  local containers="${2:-}"
  local matches=""
  local count=0
  local match_count=0

  if [ -z "$containers" ]; then
    return 1
  fi

  count="$(printf '%s\n' "$containers" | awk 'NF { count += 1 } END { print count + 0 }')"

  if [ -n "$gateway_name" ]; then
    matches="$(printf '%s\n' "$containers" | grep -F -- "$gateway_name" || true)"
    match_count="$(printf '%s\n' "$matches" | awk 'NF { count += 1 } END { print count + 0 }')"

    if [ "$match_count" -eq 1 ]; then
      printf '%s\n' "$matches"
      return 0
    fi

    if [ "$match_count" -gt 1 ]; then
      return 1
    fi
  fi

  if [ "$count" -eq 1 ]; then
    printf '%s\n' "$containers"
    return 0
  fi

  return 1
}

get_local_provider_base_url() {
  local provider="${1:-}"

  case "$provider" in
    vllm-local) printf 'http://host.openshell.internal:8000/v1\n' ;;
    ollama-local)
      local endpoint
      endpoint="$(resolve_ollama_route_url || true)"
      if [ -n "$endpoint" ]; then
        printf '%s/v1\n' "$endpoint"
      else
        printf 'http://host.openshell.internal:11434/v1\n'
      fi
      ;;
    *) return 1 ;;
  esac
}

normalize_ollama_service_url() {
  local raw_url="${1:-}"
  raw_url="${raw_url%/}"
  raw_url="${raw_url%/v1}"
  [ -n "$raw_url" ] || return 1
  printf '%s\n' "$raw_url"
}

first_ipv4_default_gateway() {
  local route_output="${1:-}"

  printf '%s\n' "$route_output" | awk '/^default / { for (i = 1; i <= NF; i += 1) if ($i == "via") { print $(i + 1); exit } }'
}

ollama_override_service_url() {
  local override="${NEMOCLAW_OLLAMA_BASE_URL:-}"

  if [ -z "$override" ]; then
    return 1
  fi

  normalize_ollama_service_url "$override"
}

ollama_service_url_candidates() {
  local resolv_conf="${1:-$(cat /etc/resolv.conf 2>/dev/null || true)}"
  local route_output="${2:-$(ip route show default 2>/dev/null || true)}"
  local nameserver=""
  local gateway=""

  if ollama_override_service_url >/dev/null 2>&1; then
    ollama_override_service_url
  fi

  printf 'http://localhost:11434\n'

  if ! is_wsl; then
    return 0
  fi

  nameserver="$(first_non_loopback_nameserver "$resolv_conf" || true)"
  if [ -n "$nameserver" ]; then
    printf 'http://%s:11434\n' "$nameserver"
  fi

  gateway="$(first_ipv4_default_gateway "$route_output" || true)"
  if [ -n "$gateway" ] && ! is_loopback_ip "$gateway" && [ "$gateway" != "$nameserver" ]; then
    printf 'http://%s:11434\n' "$gateway"
  fi
}

resolve_ollama_host_url() {
  local service_url

  while IFS= read -r service_url; do
    [ -n "$service_url" ] || continue
    if curl -sf "$service_url/api/tags" >/dev/null 2>&1; then
      printf '%s\n' "$service_url"
      return 0
    fi
  done < <(ollama_service_url_candidates)

  return 1
}

resolve_ollama_route_url() {
  local host_url

  host_url="$(resolve_ollama_host_url || true)"
  case "$host_url" in
    http://localhost:11434) printf 'http://host.openshell.internal:11434\n' ;;
    http://* | https://*)
      if is_wsl; then
        printf 'http://host.docker.internal:11434\n'
      else
        printf '%s\n' "$host_url"
      fi
      ;;
    *) return 1 ;;
  esac
}

check_local_provider_health() {
  local provider="${1:-}"

  case "$provider" in
    vllm-local)
      curl -sf http://localhost:8000/v1/models >/dev/null 2>&1
      ;;
    ollama-local)
      resolve_ollama_host_url >/dev/null
      ;;
    *)
      return 1
      ;;
  esac
}
