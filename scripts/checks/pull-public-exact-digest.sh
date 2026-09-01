#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <ghcr-reference-at-digest> <platform>" >&2
  exit 2
fi

reference="$1"
platform="$2"
# Observed GHCR publication remained anonymously unavailable through +168s
# and became readable at +211s. Keep retries bounded by both wall time and count.
max_attempts=10
deadline_seconds=300
retry_delays=(2 4 8 16 30 30 30 30 30)

if [[ ! "$reference" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$ ]]; then
  echo "ERROR: public image reference must be an exact lowercase GHCR digest" >&2
  exit 2
fi
if [ "$platform" != "linux/amd64" ]; then
  echo "ERROR: public image pull platform must be linux/amd64" >&2
  exit 2
fi
if [ -z "${RUNNER_TEMP:-}" ] || [ ! -d "$RUNNER_TEMP" ]; then
  echo "ERROR: RUNNER_TEMP must name an existing directory" >&2
  exit 2
fi

anonymous_config="$(mktemp -d "$RUNNER_TEMP/managed-pr-anonymous.XXXXXX")"
attempt_log="$anonymous_config/pull.log"
chmod 700 "$anonymous_config"
trap 'rm -rf -- "$anonymous_config"' EXIT
started_at="$SECONDS"

for ((attempt = 1; attempt <= max_attempts; attempt += 1)); do
  elapsed="$((SECONDS - started_at))"
  if [ "$elapsed" -ge "$deadline_seconds" ]; then
    completed_attempts="$((attempt - 1))"
    echo "::error::GHCR anonymous exact-digest pull outcome=exhausted attempt=$completed_attempts/$max_attempts failure=anonymous-unavailable limit=elapsed-deadline elapsed=${elapsed}s deadline=${deadline_seconds}s" >&2
    exit 1
  fi

  : >"$attempt_log"
  if env -u DOCKER_AUTH_CONFIG DOCKER_CONFIG="$anonymous_config" \
    docker pull --platform "$platform" "$reference" >"$attempt_log" 2>&1; then
    if [ "$attempt" -eq 1 ]; then
      outcome="passed-first-attempt"
    else
      outcome="passed-after-retry"
    fi
    echo "::notice::GHCR anonymous exact-digest pull outcome=$outcome attempt=$attempt/$max_attempts"
    exit 0
  else
    status="$?"
  fi

  if [ "$status" -ne 1 ]; then
    echo "::error::GHCR anonymous exact-digest pull outcome=failed-no-retry attempt=$attempt/$max_attempts docker-exit=$status" >&2
    exit "$status"
  fi

  elapsed="$((SECONDS - started_at))"
  if [ "$elapsed" -ge "$deadline_seconds" ]; then
    echo "::error::GHCR anonymous exact-digest pull outcome=exhausted attempt=$attempt/$max_attempts failure=anonymous-unavailable limit=elapsed-deadline elapsed=${elapsed}s deadline=${deadline_seconds}s" >&2
    exit "$status"
  fi

  if [ "$attempt" -eq "$max_attempts" ]; then
    echo "::error::GHCR anonymous exact-digest pull outcome=exhausted attempt=$attempt/$max_attempts failure=anonymous-unavailable limit=attempt-cap elapsed=${elapsed}s deadline=${deadline_seconds}s" >&2
    exit "$status"
  fi

  delay="${retry_delays[$((attempt - 1))]}"
  remaining="$((deadline_seconds - elapsed))"
  if [ "$delay" -gt "$remaining" ]; then
    delay="$remaining"
  fi
  echo "::warning::GHCR anonymous exact-digest pull outcome=transient-external attempt=$attempt/$max_attempts failure=anonymous-unavailable elapsed=${elapsed}s deadline=${deadline_seconds}s retry-in=${delay}s" >&2
  sleep "$delay"
done
