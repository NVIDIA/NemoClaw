#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Validate one Pi managed image: its runtime contract, pinned Pi version, and
# managed model catalog, then start it through its declared entrypoint and prove
# PID 1 drops privileges, hardens its limits, and persists the trusted proxy and
# corporate CA environment before it holds the sandbox open.

set -euo pipefail

usage() {
  echo "usage: $0 --reference <image> --platform <linux/amd64|linux/arm64>" >&2
  exit 2
}

reference=""
platform=""
while (($# > 0)); do
  case "$1" in
    --reference)
      (($# >= 2)) || usage
      reference="$2"
      shift 2
      ;;
    --platform)
      (($# >= 2)) || usage
      platform="$2"
      shift 2
      ;;
    *)
      usage
      ;;
  esac
done
[[ -n "$reference" && "$reference" != *$'\n'* ]] || usage
[[ "$platform" == "linux/amd64" || "$platform" == "linux/arm64" ]] || usage

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
work_root="${RUNNER_TEMP:-/tmp}"

image_json="$(docker image inspect "$reference")"
if ! jq -e \
  --arg platform "$platform" \
  '
    length == 1 and (
      .[0].Config.Labels["io.nvidia.nemoclaw.agent"] == "pi" and
      .[0].Config.Labels["io.nvidia.nemoclaw.managed-image.platform"] == $platform and
      .[0].Config.Labels["io.nvidia.nemoclaw.managed-image.startup-profile"] == "1" and
      .[0].Config.Entrypoint == ["/usr/local/bin/nemoclaw-start"]
    )
  ' <<<"$image_json" >/dev/null; then
  echo "ERROR: the Pi image does not carry the managed-image runtime contract." >&2
  exit 1
fi
expected_version="$(
  node -p 'require(process.argv[1]).dependencies["@earendil-works/pi-coding-agent"]' \
    "$repo_root/agents/pi/pi-runtime/package.json"
)"
version="$(
  docker run --rm --platform "$platform" --network none \
    --entrypoint /usr/local/bin/pi "$reference" --version
)"
if ! grep -Fq "$expected_version" <<<"$version"; then
  echo "ERROR: the Pi image does not run the pinned Pi ${expected_version}." >&2
  exit 1
fi
docker run --rm --platform "$platform" --network none --entrypoint /bin/bash "$reference" -c '
  set -eu
  test "$(stat -c %a /sandbox/.pi/agent/models.json)" = 600
  test "$(stat -c %U /sandbox/.pi/agent/models.json)" = sandbox
  node -e "const c=require(\"/sandbox/.pi/agent/models.json\"); if (!c.defaultModel || !c.providers.openshell.baseUrl) process.exit(1)"
  runtime=/usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs
  test -f "$runtime"
  test ! -L "$runtime"
  test "$(stat -c "%u:%g:%a" "$runtime")" = 0:0:444
  test -x /usr/local/bin/nemoclaw-managed-startup-hold
  test ! -e /usr/local/bin/nemoclaw-managed-bootstrap
  test ! -e /usr/local/lib/nemoclaw/managed-bootstrap-trampoline.sh
'

# The checks above bypass /usr/local/bin/nemoclaw-start with a direct
# --entrypoint override. Start the image through its declared entrypoint with no
# command, matching a real launch.
corporate_ca_dir="$(mktemp -d "$work_root/pi-image-ca.XXXXXX")"
corporate_ca="$corporate_ca_dir/corporate-ca.pem"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -subj '/CN=NemoClaw Pi image CA handoff' \
  -addext 'basicConstraints=critical,CA:TRUE' \
  -keyout "$corporate_ca_dir/corporate-ca.key" \
  -out "$corporate_ca" >/dev/null 2>&1
chmod 0444 "$corporate_ca"
entrypoint_container="$(
  docker run -d \
    --platform "$platform" \
    --network none \
    --env SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    --mount "type=bind,src=$corporate_ca,dst=/usr/local/share/nemoclaw/corporate-ca.pem,readonly" \
    "$reference"
)"
cleanup_entrypoint_container() {
  docker rm -f "$entrypoint_container" >/dev/null 2>&1 || true
  rm -r -- "$corporate_ca_dir"
}
trap cleanup_entrypoint_container EXIT
entrypoint_deadline=$(($(date +%s) + 30))
while ! docker logs "$entrypoint_container" 2>&1 | grep -q 'Setting up NemoClaw Pi runtime'; do
  if [ "$(docker inspect --format '{{.State.Running}}' "$entrypoint_container" 2>/dev/null)" != "true" ]; then
    echo "ERROR: the Pi entrypoint exited before reaching its held state." >&2
    docker logs "$entrypoint_container" >&2 || true
    exit 1
  fi
  if [ "$(date +%s)" -ge "$entrypoint_deadline" ]; then
    echo "ERROR: the Pi entrypoint did not reach its held state in time." >&2
    docker logs "$entrypoint_container" >&2 || true
    exit 1
  fi
  sleep 1
done
pid1_status="$(docker exec "$entrypoint_container" cat /proc/1/status)"
pid1_uid="$(printf '%s\n' "$pid1_status" | awk '/^Uid:/ {print $2}')"
if [ "$pid1_uid" != "999" ]; then
  echo "ERROR: the Pi entrypoint did not drop PID 1 to the sandbox uid: $pid1_uid" >&2
  exit 1
fi
pid1_limits="$(docker exec "$entrypoint_container" cat /proc/1/limits)"
if ! grep -qE '^Max processes +512 +512 ' <<<"$pid1_limits"; then
  echo "ERROR: the Pi entrypoint did not harden PID 1 nproc to exactly 512." >&2
  exit 1
fi
if ! grep -qE '^Max open files +65536 +65536 ' <<<"$pid1_limits"; then
  echo "ERROR: the Pi entrypoint did not harden PID 1 nofile to exactly 65536." >&2
  exit 1
fi
runtime_env="$(docker exec "$entrypoint_container" cat /tmp/nemoclaw-proxy-env.sh)"
merged_ca=/tmp/nemoclaw-ca-bundle.pem
merged_ca_status="$(docker exec "$entrypoint_container" stat -c '%u:%g:%a' "$merged_ca")"
if [ "$merged_ca_status" != "999:999:444" ]; then
  echo "ERROR: the Pi merged CA bundle is not protected: $merged_ca_status" >&2
  exit 1
fi
for ca_variable in \
  SSL_CERT_FILE \
  CURL_CA_BUNDLE \
  REQUESTS_CA_BUNDLE \
  GIT_SSL_CAINFO \
  NODE_EXTRA_CA_CERTS; do
  expected_export="export ${ca_variable}=${merged_ca}"
  if ! grep -qF "$expected_export" <<<"$runtime_env"; then
    echo "ERROR: the Pi entrypoint did not persist the merged CA variable ($expected_export)." >&2
    exit 1
  fi
done
docker exec --user 999:999 "$entrypoint_container" node -e '
  const fs = require("node:fs");
  const { X509Certificate } = require("node:crypto");
  const mounted = new X509Certificate(
    fs.readFileSync("/usr/local/share/nemoclaw/corporate-ca.pem"),
  );
  const bundle = fs.readFileSync(process.argv[1], "utf8");
  const blocks = bundle.match(
    /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
  );
  if (!blocks?.some((block) =>
    new X509Certificate(block).fingerprint256 === mounted.fingerprint256
  )) process.exit(1);
' "$merged_ca"
docker exec --user 999:999 "$entrypoint_container" /bin/bash -ceu '
  unset HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy
  unset SSL_CERT_FILE CURL_CA_BUNDLE REQUESTS_CA_BUNDLE GIT_SSL_CAINFO NODE_EXTRA_CA_CERTS
  source /tmp/nemoclaw-proxy-env.sh
  proxy_url=http://10.200.0.1:3128
  for proxy_variable in HTTP_PROXY HTTPS_PROXY http_proxy https_proxy; do
    if [ "${!proxy_variable}" != "$proxy_url" ]; then
      echo "ERROR: an independent Pi shell did not load $proxy_variable from the runtime environment." >&2
      exit 1
    fi
  done
  no_proxy_value=localhost,127.0.0.1,::1,10.200.0.1
  for no_proxy_variable in NO_PROXY no_proxy; do
    if [ "${!no_proxy_variable}" != "$no_proxy_value" ]; then
      echo "ERROR: an independent Pi shell did not load $no_proxy_variable from the runtime environment." >&2
      exit 1
    fi
  done
  merged_ca=/tmp/nemoclaw-ca-bundle.pem
  for ca_variable in \
    SSL_CERT_FILE \
    CURL_CA_BUNDLE \
    REQUESTS_CA_BUNDLE \
    GIT_SSL_CAINFO \
    NODE_EXTRA_CA_CERTS
  do
    if [ "${!ca_variable}" != "$merged_ca" ]; then
      echo "ERROR: an independent Pi shell did not load $ca_variable from the runtime environment." >&2
      exit 1
    fi
  done
'
printf 'Pi runtime and declared entrypoint passed for %s on %s.\n' "$reference" "$platform"
