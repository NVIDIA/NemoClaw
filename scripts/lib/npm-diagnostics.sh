#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

sanitize_npm_diagnostics() {
  LC_ALL=C sed -E \
    -e $'s/\033\\][^\007\033]*(\007|\033\\\\)//g' \
    -e $'s/\033\\[[0-?]*[ -\\/]*[@-~]//g' \
    | LC_ALL=C tr '\015' '\012' \
    | LC_ALL=C tr -cd '\11\12\40-\176' \
    | awk '
    BEGIN { private_key = 0 }
    {
      line = $0
      lower = tolower(line)
      if (line ~ /-----BEGIN ([A-Z0-9]+ )?PRIVATE[ ]KEY-----/) {
        print "<REDACTED>"
        private_key = 1
        next
      }
      if (private_key) {
        if (line ~ /-----END ([A-Z0-9]+ )?PRIVATE[ ]KEY-----/) private_key = 0
        next
      }
      if (lower ~ /(authorization|proxy-authorization|cookie|set-cookie)[ \t]*[:=]/ ||
          lower ~ /(bearer|basic)[ \t]+[^ \t]/ ||
          lower ~ /(^|[^a-z0-9])[a-z0-9_.-]*(auth|credential|key|pass|passwd|password|secret|token)[a-z0-9_.-]*[ \t]*[:=]/) {
        print "<REDACTED CREDENTIAL LINE>"
        next
      }
      print line
    }
  ' \
    | sed -E \
      -e 's#[A-Za-z][A-Za-z0-9+.-]*://[^[:space:]'"'"'"]+#<REDACTED_URL>#g' \
      -e 's#(github_pat_|ghp_|glpat-|gsk_|hf_|nvcf-|nvapi-|pypi-|sk-(ant-|proj-)?|tvly-|xapp-|xox[bpas]-)[A-Za-z0-9_-]{8,}#<REDACTED>#g' \
      -e 's#eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{10,}#<REDACTED>#g' \
      -e 's#[A-Za-z0-9_+/=-]{32,}#<REDACTED>#g'
}

bounded_npm_diagnostic_excerpt() {
  local limit="${1:-3900}"
  LC_ALL=C awk -v limit="$limit" '
    {
      tail = tail $0 ORS
      if (length(tail) > limit) tail = substr(tail, length(tail) - limit + 1)
      if ($0 ~ /^npm (error|ERR!|verbose stack)( |$)/ && length(errors) < 2000)
        errors = substr(errors $0 ORS, 1, 2000)
    }
    END {
      remaining = limit - length(errors)
      if (length(tail) > remaining) tail = substr(tail, length(tail) - remaining + 1)
      printf "%s%s", errors, tail
    }
  '
}
