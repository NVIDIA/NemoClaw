#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

version="${1:-}"
output="${2:-}"
max_attempts=3
retry_delays=(1 2)
url="https://github.com/NousResearch/hermes-agent/archive/refs/tags/${version}.tar.gz"
partial="${output}.partial"
curl_error="${output}.curl-error"

if [[ ! "$version" =~ ^v[0-9]{4}[.][0-9]+[.][0-9]+$ ]]; then
  echo "Hermes archive download outcome=failed-no-retry attempt=0/${max_attempts} failure=invalid-version" >&2
  exit 2
fi
if [[ "$output" != /* ]]; then
  echo "Hermes archive download outcome=failed-no-retry attempt=0/${max_attempts} failure=invalid-output" >&2
  exit 2
fi

cleanup() {
  rm -f -- "$partial" "$curl_error"
}
trap cleanup EXIT
rm -f -- "$output"

for ((attempt = 1; attempt <= max_attempts; attempt += 1)); do
  rm -f -- "$partial" "$curl_error"
  http_status=""
  if http_status="$(curl \
    --disable \
    --silent \
    --show-error \
    --location \
    --proto '=https' \
    --proto-redir '=https' \
    --tlsv1.2 \
    --connect-timeout 15 \
    --max-time 120 \
    --output "$partial" \
    --write-out '%{http_code}' \
    "$url" 2>"$curl_error")"; then
    curl_status=0
  else
    curl_status=$?
  fi
  rm -f -- "$curl_error"

  if ((curl_status != 0)); then
    echo "Hermes archive download outcome=failed-no-retry attempt=${attempt}/${max_attempts} failure=curl-exit-${curl_status}" >&2
    exit 1
  fi

  if [[ "$http_status" == "200" ]]; then
    if [[ ! -f "$partial" || ! -s "$partial" ]]; then
      echo "Hermes archive download outcome=failed-no-retry attempt=${attempt}/${max_attempts} failure=empty-response" >&2
      exit 1
    fi
    if ! mv -- "$partial" "$output" 2>/dev/null; then
      echo "Hermes archive download outcome=failed-no-retry attempt=${attempt}/${max_attempts} failure=output-publish" >&2
      exit 1
    fi
    if ((attempt == 1)); then
      outcome="passed-first-attempt"
    else
      outcome="passed-after-retry"
    fi
    echo "Hermes archive download outcome=${outcome} attempt=${attempt}/${max_attempts}" >&2
    exit 0
  fi

  rm -f -- "$partial"
  if [[ "$http_status" != "429" ]]; then
    if [[ "$http_status" =~ ^[0-9]{3}$ ]]; then
      failure="http-${http_status}"
    else
      failure="invalid-http-status"
    fi
    echo "Hermes archive download outcome=failed-no-retry attempt=${attempt}/${max_attempts} failure=${failure}" >&2
    exit 1
  fi

  if ((attempt == max_attempts)); then
    echo "Hermes archive download outcome=exhausted attempt=${attempt}/${max_attempts} failure=http-429" >&2
    exit 1
  fi
  delay="${retry_delays[$((attempt - 1))]}"
  echo "Hermes archive download outcome=transient-external attempt=${attempt}/${max_attempts} failure=http-429 retry-in=${delay}s" >&2
  sleep "$delay"
done
