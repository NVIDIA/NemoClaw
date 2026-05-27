#!/bin/sh
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -eu

run_proxy() {
  if [ "$#" -ne 2 ]; then
    echo "nemoclaw-ssh-proxy: usage: nemoclaw-ssh-proxy <host> <port>" >&2
    exit 1
  fi

  target_host="$1"
  target_port="$2"
  connect_host="$target_host"
  hosts_file="${NEMOCLAW_SSH_HOSTS_FILE:-/etc/hosts}"
  proxy="${HTTPS_PROXY:-${https_proxy:-${HTTP_PROXY:-${http_proxy:-}}}}"

  if [ -r "$hosts_file" ]; then
    hosts_ip="$(
      awk -v host="$target_host" '
              /^[[:space:]]*(#|$)/ { next }
              {
                  for (i = 2; i <= NF; i++) {
                      if ($i == "#") {
                          break
                      }
                      if ($i == host) {
                          print $1
                          exit
                      }
                  }
              }
          ' "$hosts_file"
    )"
    if [ -n "$hosts_ip" ]; then
      connect_host="$hosts_ip"
    fi
  fi

  if [ -z "$proxy" ]; then
    exec nc "$connect_host" "$target_port"
  fi

  case "$proxy" in
    http://*) proxy="${proxy#http://}" ;;
    https://*)
      echo "nemoclaw-ssh-proxy: HTTPS proxies are not supported for OpenSSH CONNECT" >&2
      exit 1
      ;;
  esac

  proxy="${proxy%%/*}"
  if [ -z "$proxy" ]; then
    echo "nemoclaw-ssh-proxy: proxy URL is missing a host" >&2
    exit 1
  fi

  exec nc -X connect -x "$proxy" "$connect_host" "$target_port"
}

run_askpass() {
  askpass_input="${NEMOCLAW_SSH_ASKPASS_INPUT:-}"
  askpass_input_opened=0
  if [ ! -t 0 ] && [ -n "$askpass_input" ]; then
    if exec <"$askpass_input"; then
      askpass_input_opened=1
    fi
  fi

  if [ ! -t 0 ] && [ "$askpass_input_opened" != "1" ] && [ "${NEMOCLAW_SSH_ASKPASS_ALLOW_STDIN:-}" != "1" ]; then
    exit 1
  fi

  prompt=${1:-Password:}
  stty_state=""
  if [ -t 0 ]; then
    stty_state=$(stty -g 2>/dev/null || true)
    stty -echo 2>/dev/null || true
  fi

  restore_tty() {
    if [ -n "$stty_state" ]; then
      stty "$stty_state" 2>/dev/null || true
    fi
  }

  trap restore_tty EXIT HUP INT TERM

  printf "%s " "$prompt" >&2
  IFS= read -r password
  printf "\n" >&2
  printf "%s\n" "$password"
}

run_ssh() {
  real_ssh=${NEMOCLAW_REAL_SSH:-/usr/bin/ssh}

  if { [ -t 0 ] || [ "${NEMOCLAW_SSH_FORCE_ASKPASS:-}" = "1" ]; } && [ -z "${SSH_ASKPASS:-}" ]; then
    export SSH_ASKPASS=/usr/local/bin/nemoclaw-ssh-askpass
    export SSH_ASKPASS_REQUIRE=force
    export DISPLAY="${DISPLAY:-nemoclaw}"
    if [ -t 0 ] && { [ -L "/proc/$$/fd/0" ] || [ -e "/proc/$$/fd/0" ]; }; then
      export NEMOCLAW_SSH_ASKPASS_INPUT="/proc/$$/fd/0"
    fi
  fi

  exec "$real_ssh" "$@"
}

case "$(basename "$0")" in
  nemoclaw-ssh-proxy) run_proxy "$@" ;;
  nemoclaw-ssh-askpass) run_askpass "$@" ;;
  ssh | nemoclaw-ssh | nemoclaw-ssh.sh) run_ssh "$@" ;;
  *)
    echo "nemoclaw-ssh: unknown invocation name: $(basename "$0")" >&2
    exit 1
    ;;
esac
