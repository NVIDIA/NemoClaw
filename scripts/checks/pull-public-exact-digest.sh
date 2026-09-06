#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
  echo "usage: $0 <ghcr-reference-at-digest> <platform> [anonymous-docker-config]" >&2
  exit 2
fi

reference="$1"
platform="$2"
# Observed GHCR publication remained anonymously unavailable through +900s
# and all manifest, configuration, and layer HEADs returned 200 by about +1106s.
max_attempts=65
deadline_seconds=1800

if [[ ! "$reference" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$ ]]; then
  echo "ERROR: public image reference must be an exact lowercase GHCR digest" >&2
  exit 2
fi
if [ "$platform" != "linux/amd64" ] && [ "$platform" != "linux/arm64" ]; then
  echo "ERROR: public image pull platform must be linux/amd64 or linux/arm64" >&2
  exit 2
fi
if [ -z "${RUNNER_TEMP:-}" ] || [ ! -d "$RUNNER_TEMP" ]; then
  echo "ERROR: RUNNER_TEMP must name an existing directory" >&2
  exit 2
fi

owns_anonymous_config=1
if [ "$#" -eq 3 ]; then
  anonymous_config="$3"
  owns_anonymous_config=0
  if [ -L "$anonymous_config" ] || [ ! -d "$anonymous_config" ]; then
    echo "ERROR: supplied anonymous Docker configuration must be a non-symlink directory" >&2
    exit 2
  fi
  runner_temp_real="$(cd "$RUNNER_TEMP" && pwd -P)"
  anonymous_config_real="$(cd "$anonymous_config" && pwd -P)"
  case "$anonymous_config_real/" in
    "$runner_temp_real/"*) ;;
    *)
      echo "ERROR: supplied anonymous Docker configuration must be inside RUNNER_TEMP" >&2
      exit 2
      ;;
  esac
  if [ -n "$(find -P "$anonymous_config" -mindepth 1 -print -quit)" ]; then
    echo "ERROR: supplied anonymous Docker configuration must be empty" >&2
    exit 2
  fi
else
  anonymous_config="$(mktemp -d "$RUNNER_TEMP/managed-pr-anonymous.XXXXXX")"
fi
attempt_log="$(mktemp "$RUNNER_TEMP/managed-public-pull.XXXXXX")"
chmod 700 "$anonymous_config"
cleanup_anonymous_config() {
  rm -f -- "$attempt_log"
  if [ "$owns_anonymous_config" -eq 1 ]; then
    rm -rf -- "$anonymous_config"
  fi
}
trap cleanup_anonymous_config EXIT
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
    elapsed="$((SECONDS - started_at))"
    rm -f -- "$attempt_log"
    echo "::notice::GHCR anonymous exact-digest pull outcome=$outcome attempt=$attempt/$max_attempts elapsed=${elapsed}s deadline=${deadline_seconds}s"
    exit 0
  else
    status="$?"
  fi

  last_line="$(awk 'NF { line=$0 } END { sub(/\r$/, "", line); print line }' "$attempt_log")"
  if grep -Fq "max depth exceeded" "$attempt_log"; then
    echo "::error::GHCR anonymous exact-digest pull outcome=failed-no-retry attempt=$attempt/$max_attempts docker-exit=$status failure=layer-depth-exceeded" >&2
    exit "$status"
  fi
  retryable_visibility=0
  if [[ "$last_line" == *"$reference: not found" ]]; then
    retryable_visibility=1
  elif [ "$status" -eq 1 ] && { grep -Eq '^Error response from daemon: Head .+: denied$' "$attempt_log" \
    || grep -Fxq 'denied: permission_denied' "$attempt_log" \
    || grep -Fxq "ERROR: $reference: not found" "$attempt_log" \
    || grep -Eq '^(Error response from daemon: failed to resolve reference "ghcr[.]io/[^"]+": )?unexpected status from HEAD request to https://ghcr[.]io/.+: (401 Unauthorized|403 Forbidden|404 Not Found)$' "$attempt_log" \
    || grep -Eiq '(^|:[[:space:]]|[[:space:]])manifest unknown(:|[[:space:]]|$)' "$attempt_log" \
    || grep -Fq 'unexpected status from anonymous HEAD request' "$attempt_log" \
    || grep -Fq 'failed to resolve exact digest from anonymous GHCR' "$attempt_log"; }; then
    retryable_visibility=1
  fi
  if [ "$retryable_visibility" -ne 1 ]; then
    if [ "$status" -eq 1 ]; then
      failure=" failure=terminal-docker-exit-1"
    else
      failure=""
    fi
    echo "::error::GHCR anonymous exact-digest pull outcome=failed-no-retry attempt=$attempt/$max_attempts docker-exit=$status${failure}" >&2
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

  if [ "$attempt" -le 4 ]; then
    delay="$((1 << attempt))"
  else
    delay=30
  fi
  remaining="$((deadline_seconds - elapsed))"
  if [ "$delay" -gt "$remaining" ]; then
    delay="$remaining"
  fi
  echo "::warning::GHCR anonymous exact-digest pull outcome=transient-external attempt=$attempt/$max_attempts failure=anonymous-unavailable elapsed=${elapsed}s deadline=${deadline_seconds}s retry-in=${delay}s" >&2
  sleep "$delay"
done
