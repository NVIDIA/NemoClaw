#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail
umask 077

scan_root="${SCAN_ROOT:?Missing SCAN_ROOT}"
helper="$GITHUB_WORKSPACE/.github/scripts/managed-image-scan-results.mts"
prefix="managed-scan-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${AGENT}-${ARCH}"
failed=0

# Called by the EXIT trap, including scanner failures.
# shellcheck disable=SC2329
cleanup() {
  local cleanup_failed=0 name
  for name in grype secrets malware; do
    docker rm --force "$prefix-$name" >/dev/null 2>&1 || true
    if ! remaining="$(docker ps -aq --filter "name=^/$prefix-$name$")" || [ -n "$remaining" ]; then
      cleanup_failed=1
    fi
  done
  rm -rf "$scan_root"
  if [ "$cleanup_failed" -ne 0 ]; then
    echo "ERROR: Could not remove a scan container." >&2
    exit 1
  fi
}
trap cleanup EXIT

# Pull by workload digest. No candidate image is executed or given credentials.
reference="$(node "$helper" candidate "$CONTRACT")"
docker pull --platform "$PLATFORM" "$reference" >"$scan_root/pull.log" 2>&1
image_id="$(docker image inspect --format '{{.Id}}' "$reference")"
[[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]]
docker save "$image_id" >"$scan_root/image.tar"

record_result() {
  local category="$1" code="$2" path="$3" result=FAIL
  if node "$helper" result "$category" "$code" "$path" >/dev/null 2>&1; then
    result=PASS
  else
    failed=1
  fi
  # Only fixed category names and pass/fail reach the public job summary.
  printf '| %s | %s |\n' "$category" "$result" >>"$GITHUB_STEP_SUMMARY"
}
printf '### Managed image security scans\n\n| Scan | Result |\n| --- | --- |\n' >>"$GITHUB_STEP_SUMMARY"

code=0
docker run --rm --name "$prefix-grype" --cap-drop=ALL --security-opt=no-new-privileges \
  --volume "$scan_root/image.tar:/scan/image.tar:ro" \
  "$GRYPE_IMAGE" docker-archive:/scan/image.tar --fail-on critical --output json \
  >"$scan_root/vulnerabilities.json" 2>"$scan_root/grype.log" || code=$?
record_result vulnerabilities "$code" "$scan_root/vulnerabilities.json"

code=0
docker run --rm --name "$prefix-secrets" --cap-drop=ALL --security-opt=no-new-privileges \
  --volume "$scan_root/image.tar:/scan/image.tar:ro" \
  --volume "$GITHUB_WORKSPACE/.nspect-allowlist.toml:/allowlist.toml:ro" \
  "$PULSE_SECRET_IMAGE" docker --image file:///scan/image.tar \
  --allowlist=/allowlist.toml --json --results=verified,unknown --fail --fail-on-scan-errors \
  >"$scan_root/secrets.jsonl" 2>"$scan_root/secrets.log" || code=$?
record_result secrets "$code" "$scan_root/secrets.jsonl"

# The approved scanner alone receives short-lived OIDC request credentials.
# Charon authorizes image submission and report retrieval for this repository/ref.
code=0
docker create --name "$prefix-malware" --network host \
  --cap-drop=ALL --security-opt=no-new-privileges --workdir /tmp \
  --env ACTIONS_ID_TOKEN_REQUEST_URL --env ACTIONS_ID_TOKEN_REQUEST_TOKEN \
  --env CI=true --env GITHUB_ACTIONS=true \
  "$PULSE_MALWARE_IMAGE" pulse-malware-scanner-cli \
  --nspect "$NSPECT_ID" --tenant github-first --base-url http://127.0.0.1:8888 \
  --output-dir=. --wait=true --wait-retries=50 --backoff-sec=2 --max-poll-wait-sec=60 \
  image-scan --image-ref "$reference" --platform "$PLATFORM" >/dev/null
docker start --attach "$prefix-malware" >"$scan_root/malware.log" 2>&1 || code=$?
docker cp "$prefix-malware:/tmp/malware_report_1.json" "$scan_root/malware.json" >/dev/null 2>&1 || code=1
record_result malware "$code" "$scan_root/malware.json"
exit "$failed"
