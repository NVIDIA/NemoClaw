#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Shared fail-closed corporate-proxy CA merge used by the OpenClaw and Hermes
# entrypoints. The caller owns _NEMOCLAW_CORPORATE_CA_FILE.
_nemoclaw_ca_merge_warn() {
  echo "[nemoclaw] WARNING: corporate proxy CA merge failed at ${1}; keeping OpenShell-only trust — external TLS through the corporate proxy may fail (#6210)" >&2
}

merge_corporate_proxy_ca() {
  if [ -L "$_NEMOCLAW_CORPORATE_CA_FILE" ]; then
    echo "[nemoclaw] refusing symlinked corporate CA at ${_NEMOCLAW_CORPORATE_CA_FILE}; expected a regular file (#8650)" >&2
    exit 1
  fi
  [ -s "$_NEMOCLAW_CORPORATE_CA_FILE" ] || return 0
  _base_bundle=""
  if [ -n "${SSL_CERT_FILE:-}" ] && [ -f "${SSL_CERT_FILE}" ]; then
    _base_bundle="$SSL_CERT_FILE"
  elif [ -f /etc/ssl/certs/ca-certificates.crt ]; then
    _base_bundle="/etc/ssl/certs/ca-certificates.crt"
  fi
  _merged="/tmp/nemoclaw-ca-bundle.pem"
  _tmp="$(mktemp "${_merged}.XXXXXX" 2>/dev/null)" || {
    _nemoclaw_ca_merge_warn "create temp bundle (${_merged})"
    return 0
  }
  if [ -n "$_base_bundle" ]; then
    cat "$_base_bundle" >>"$_tmp" 2>/dev/null || {
      rm -f "$_tmp"
      _nemoclaw_ca_merge_warn "append OpenShell bundle"
      return 0
    }
    printf '\n' >>"$_tmp" 2>/dev/null || {
      rm -f "$_tmp"
      _nemoclaw_ca_merge_warn "append OpenShell bundle"
      return 0
    }
  fi

  _ca_append_status=0
  python3 -I - "$_NEMOCLAW_CORPORATE_CA_FILE" "$_tmp" <<'PY_APPEND_CORPORATE_CA' || _ca_append_status=$?
import errno
import os
import stat
import sys

source, target = sys.argv[1], sys.argv[2]
try:
    descriptor = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
except OSError as error:
    raise SystemExit(2 if error.errno == errno.ELOOP else 3)
try:
    if not stat.S_ISREG(os.fstat(descriptor).st_mode):
        raise SystemExit(2)
    with open(target, "ab") as merged:
        while True:
            chunk = os.read(descriptor, 65536)
            if not chunk:
                break
            merged.write(chunk)
finally:
    os.close(descriptor)
PY_APPEND_CORPORATE_CA
  if [ "$_ca_append_status" -eq 2 ]; then
    rm -f "$_tmp"
    echo "[nemoclaw] refusing corporate CA at ${_NEMOCLAW_CORPORATE_CA_FILE}; expected a regular file, not a symlink (#8650)" >&2
    exit 1
  fi
  if [ "$_ca_append_status" -ne 0 ]; then
    rm -f "$_tmp"
    _nemoclaw_ca_merge_warn "append corporate CA"
    return 0
  fi
  chmod 0444 "$_tmp" 2>/dev/null || {
    rm -f "$_tmp"
    _nemoclaw_ca_merge_warn "set merged bundle permissions (${_merged})"
    return 0
  }
  if [ -L "$_merged" ]; then
    rm -f "$_merged" 2>/dev/null || true
  fi
  mv -f "$_tmp" "$_merged" 2>/dev/null || {
    rm -f "$_tmp"
    _nemoclaw_ca_merge_warn "install merged bundle (${_merged})"
    return 0
  }

  export SSL_CERT_FILE="$_merged"
  export CURL_CA_BUNDLE="$_merged"
  export REQUESTS_CA_BUNDLE="$_merged"
  export GIT_SSL_CAINFO="$_merged"
  export NODE_EXTRA_CA_CERTS="$_merged"
  export _NEMOCLAW_CORPORATE_CA_MERGED=1
  echo "[nemoclaw] merged corporate proxy CA into sandbox trust bundle (#6210)" >&2
}
