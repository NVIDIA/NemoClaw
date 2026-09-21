#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

: "${NEMOCLAW_BREV_ROOT:?set NEMOCLAW_BREV_ROOT}"
root="${NEMOCLAW_BREV_ROOT}"
repo="${root}/source"
evidence="${root}/evidence"
mkdir -p "${evidence}"

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
