#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

: "${NEMOCLAW_BREV_ROOT:?set NEMOCLAW_BREV_ROOT}"
root="${NEMOCLAW_BREV_ROOT}"
repo="${root}/source"
evidence="${root}/evidence"
mkdir -p "${evidence}"

diagnose_failure() {
  status=$?
  trap - ERR
  set +e
  echo "::group::Sanitized Brev guest diagnostics"
  docker ps --all --format 'container={{.Names}} status={{.Status}} image={{.Image}}'
  redactor='import re,sys
import pathlib
secret=pathlib.Path(sys.argv[1]).read_text() if pathlib.Path(sys.argv[1]).exists() else ""
text=sys.stdin.read().replace(secret,"[REDACTED]") if secret else sys.stdin.read()
text=re.sub(r"(?i)(authorization[=: ]+bearer[ ]+)[^ ]+",r"\1[REDACTED]",text)
text=re.sub(r"nvapi-[A-Za-z0-9_-]+","[REDACTED]",text)
text=re.sub(r"(?i)(api[_-]?key[=:\" ]+)[^, \"}]+",r"\1[REDACTED]",text)
sys.stdout.write(text)'
  while IFS= read -r container; do
    test -n "${container}" || continue
    echo "--- ${container} state ---"
    docker inspect --format 'status={{.State.Status}} exit={{.State.ExitCode}} error={{.State.Error}} health={{if .State.Health}}{{.State.Health.Status}}{{end}}' "${container}"
    docker inspect --format 'network_mode={{.HostConfig.NetworkMode}} ports={{json .HostConfig.PortBindings}} networks={{json .NetworkSettings.Networks}}' "${container}"
    echo "--- ${container} logs (last 200 lines, redacted) ---"
    docker logs --tail 200 "${container}" 2>&1 \
      | python3 -c "${redactor}" "${root}/nvidia-api-key"
  done < <(docker ps --all --format '{{.Names}}')
  gateway_container="$(docker ps --filter 'name=-gateway$' --format '{{.Names}}' | head -1)"
  if test -n "${gateway_container}"; then
    gateway_network="$(docker inspect "${gateway_container}" \
      | jq -r '.[0].NetworkSettings.Networks | keys[] | select(. != "bridge" and . != "none")' \
      | head -1)"
    gateway_port="$(docker inspect --format '{{range $port, $bindings := .HostConfig.PortBindings}}{{println $port}}{{end}}' "${gateway_container}" | sed -n 's#/tcp$##p' | head -1)"
    gateway_address="$(docker inspect "${gateway_container}" \
      | jq -r --arg network "${gateway_network}" '.[0].NetworkSettings.Networks[$network].IPAddress')"
    echo "gateway_probe network=${gateway_network} address=${gateway_address} port=${gateway_port}"
    curl --silent --show-error --max-time 3 "http://127.0.0.1:${gateway_port}" >/dev/null \
      && echo "gateway_loopback_probe=ok" || echo "gateway_loopback_probe=failed"
    curl --silent --show-error --max-time 3 "http://${gateway_address}:${gateway_port}" >/dev/null \
      && echo "gateway_managed_probe=ok" || echo "gateway_managed_probe=failed"
    docker run --rm --network "${gateway_network}" \
      --entrypoint node nc-fabric:openclaw \
      -e "fetch('http://${gateway_address}:${gateway_port}').then(() => console.log('gateway_container_probe=ok')).catch(error => { console.error('gateway_container_probe=failed', error.cause?.code || error.message); process.exit(1) })" \
      || true
  fi
  echo "::endgroup::"
  return "${status}"
}
trap diagnose_failure ERR

phase="${1:-all}"
case "${phase}" in prepare|qualify|all) ;; *) exit 2 ;; esac
if test "${phase}" != qualify; then
  test "$(uname -m)" = x86_64
  command -v docker >/dev/null
  docker info >/dev/null
  python3 - <<'PY'
import ctypes
import errno

libc = ctypes.CDLL(None, use_errno=True)
# landlock_create_ruleset(2) with VERSION asks the kernel for its ABI.
abi = libc.syscall(444, 0, 0, 1)
if abi < 1:
    raise SystemExit(f"Landlock unavailable: result={abi} errno={ctypes.get_errno()}")
PY
  available_kib="$(df --output=avail -k "${root}" | tail -1 | tr -d ' ')"
  test "${available_kib}" -ge $((80 * 1024 * 1024))
  test -z "$(docker ps -aq --filter 'name=nemoclaw' --filter 'name=openshell')"
  for inventory in container network volume; do
    case "${inventory}" in
      container) owned="$(docker ps -aq --filter 'label=nemoclaw.nvidia.com/uid')" ;;
      network) owned="$(docker network ls -q --filter 'label=nemoclaw.nvidia.com/uid')" ;;
      volume) owned="$(docker volume ls -q --filter 'label=nemoclaw.nvidia.com/uid')" ;;
    esac
    if test -n "${owned}"; then
      echo "fresh host contains NemoClaw-owned ${inventory} resources: ${owned//$'\n'/,}" >&2
      exit 1
    fi
  done
  test ! -e "${HOME}/.nemoclaw"
  test ! -e "${HOME}/.config/openshell"

  cd "${repo}"
  mkdir -p .build
  AGENT_PLATFORM=linux/amd64 docker buildx bake openclaw --load \
    --metadata-file .build/brev-agent-image.json
  image_ref="$(docker image inspect nc-fabric:openclaw --format '{{index .RepoDigests 0}}')"
  case "${image_ref}" in
    nc-fabric@sha256:*) ;;
    *) echo "local image store did not retain an immutable repository digest" >&2; exit 1 ;;
  esac

  printf '%s\n' "${image_ref}" > "${root}/image-ref"
  printf '%s\n' "${available_kib}" > "${root}/available-kib"
fi
if test "${phase}" = prepare; then exit 0; fi
image_ref="$(cat "${root}/image-ref")"
available_kib="$(cat "${root}/available-kib")"

config="${root}/brev.yaml"
python3 - "${repo}/crates/nemoclaw-e2e/fixtures/openclaw-nvidia-hosted/v1.yaml" \
  "${config}" "${image_ref}" <<'PY'
import pathlib
import sys
import uuid

source = pathlib.Path(sys.argv[1])
destination = pathlib.Path(sys.argv[2])
image = sys.argv[3]
text = source.read_text()
text = text.replace("b8f25ac9-8e58-4c0b-98c3-17648f9a5575", str(uuid.uuid4()))
text = text.replace(
    "nc-multi-models@sha256:3ab70ded67440e838a37d6c9f0e3b08b95e2acf416c6076f8817bac190525cf0",
    image,
)
destination.write_text(text)
PY

state="${root}/state"
NVIDIA_INFERENCE_API_KEY="$(cat "${root}/nvidia-api-key")" \
NEMOCLAW_LIVE_BREV_CONFIG="${config}" \
NEMOCLAW_LIVE_BREV_STATE="${state}" \
NEMOCLAW_TEST_BUNDLE="${root}/bundle" \
  "${root}/brev-test" --ignored --exact bare_brev_hosted_openclaw_lifecycle --nocapture

python3 - "${state}/brev-proof.json" "${evidence}/brev-proof.json" \
  "${available_kib}" <<'PY'
import json
import pathlib
import sys

source, destination = map(pathlib.Path, sys.argv[1:3])
proof = json.loads(source.read_text())
proof["freshHostChecks"] = {
    "architecture": "x86_64",
    "dockerReady": True,
    "landlockAvailable": True,
    "minimumAvailableDiskGiB": 80,
    "noPreinstalledDeployment": True,
}
destination.write_text(json.dumps(proof, indent=2, sort_keys=True) + "\n")
PY
