#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail
: "${INSTANCE_NAME:?set INSTANCE_NAME}"
# Reject a broader target before any remote operation.
[[ "${INSTANCE_NAME}" =~ ^nclaw-v1-[0-9]+-[0-9]+$ ]] || exit 1

prepare() {
  revision="$(git rev-parse HEAD)"
  [[ "${revision}" =~ ^[0-9a-f]{40}$ ]] || exit 1
  echo "::group::Provision Brev workspace ${INSTANCE_NAME}"
  brev search cpu --arch x86_64 --min-vcpu 8 --min-ram 32 --min-disk 100 --sort price \
    | brev create "${INSTANCE_NAME}" \
        --startup-script @tools/e2e/brev-v1-startup.sh --detached
  brev refresh || true
  echo "::endgroup::"
  echo "Waiting for Brev SSH"
  for attempt in $(seq 1 90); do
    if ssh -T -o BatchMode=yes -o ConnectTimeout=10 "${INSTANCE_NAME}" true 2>/dev/null; then break; fi
    if test "${attempt}" -eq 90; then echo "Brev SSH did not become ready" >&2; exit 1; fi
    if test $((attempt % 5)) -eq 0; then brev refresh || true; fi
    sleep 10
  done
  echo "Brev SSH is ready; waiting for host prerequisites"
  for attempt in $(seq 1 120); do
    if ssh -T "${INSTANCE_NAME}" 'test -f /var/run/nemoclaw-brev-v1-ready'; then break; fi
    if test $((attempt % 10)) -eq 0; then
      ssh -T "${INSTANCE_NAME}" 'tail -20 /tmp/nemoclaw-brev-v1-startup.log 2>/dev/null || true' || true
    fi
    if test "${attempt}" -eq 120; then echo "Brev startup did not become ready" >&2; exit 1; fi
    sleep 10
  done
  echo "Host prerequisites are ready"
  # The startup script can run as root without knowing which account Brev
  # will use for SSH. Brev may also multiplex SSH connections, so explicitly
  # enter the docker group instead of relying on a later login to refresh it.
  ssh -T "${INSTANCE_NAME}" 'sudo usermod -aG docker "$(id -un)"'
  ssh -T "${INSTANCE_NAME}" 'sg docker -c "docker info >/dev/null"'
  # shellcheck disable=SC2029
  remote_home="$(ssh -T "${INSTANCE_NAME}" 'printf %s "$HOME"')"
  remote_root="${remote_home}/${INSTANCE_NAME}"
  # shellcheck disable=SC2029
  ssh -T "${INSTANCE_NAME}" "install -d -m 700 '${remote_root}/source' '${remote_root}/bundle'"
  git archive --format=tar HEAD | gzip -1 > "${RUNNER_TEMP}/candidate-source.tar.gz"
  rsync -a "${RUNNER_TEMP}/candidate-source.tar.gz" "${INSTANCE_NAME}:${remote_root}/"
  ssh -T "${INSTANCE_NAME}" "printf '%s\n' '${revision}' > '${remote_root}/source-revision' && tar -xzf '${remote_root}/candidate-source.tar.gz' -C '${remote_root}/source' && sg docker -c \"NEMOCLAW_BREV_ROOT='${remote_root}' bash '${remote_root}/source/tools/e2e/brev-v1-guest.sh' prepare\""
}

qualify() {
  test -n "${NVIDIA_INFERENCE_API_KEY:?set NVIDIA_INFERENCE_API_KEY}"
  brev refresh
  remote_home="$(ssh -T "${INSTANCE_NAME}" 'printf %s "$HOME"')"
  remote_root="${remote_home}/${INSTANCE_NAME}"
  rsync -a candidate/bundle/ "${INSTANCE_NAME}:${remote_root}/bundle/"
  rsync -a candidate-image/ "${INSTANCE_NAME}:${remote_root}/image-candidate/"
  rsync -a candidate/brev-test "${INSTANCE_NAME}:${remote_root}/brev-test"
  key="${RUNNER_TEMP}/nvidia-api-key"
  trap 'rm -f "${key}"' EXIT
  (umask 077; printf '%s' "${NVIDIA_INFERENCE_API_KEY}" > "${key}")
  rsync -a "${key}" "${INSTANCE_NAME}:${remote_root}/nvidia-api-key"
  rm -f "${key}"
  ssh -T "${INSTANCE_NAME}" "chmod 700 '${remote_root}/brev-test' && sg docker -c \"NEMOCLAW_BREV_ROOT='${remote_root}' bash '${remote_root}/source/tools/e2e/brev-v1-guest.sh' qualify\""
  mkdir -p "${RUNNER_TEMP}/brev-evidence"
  rsync -a "${INSTANCE_NAME}:${remote_root}/evidence/brev-proof.json" "${RUNNER_TEMP}/brev-evidence/"
}

cleanup() {
  echo "::group::Delete Brev workspace ${INSTANCE_NAME}"
  brev delete "${INSTANCE_NAME}" || true
  absent=0
  for attempt in $(seq 1 60); do
    rows="$(brev ls --json 2>/dev/null | jq -c 'if type == "array" then . elif type == "object" and (.workspaces | type) == "array" then .workspaces elif type == "object" and has("workspaces") and .workspaces == null then [] else error("unexpected Brev inventory") end | if all(.[]; type == "object" and ((.name // .workspaceName // .instanceName) | type == "string" and length > 0)) then . else error("incomplete Brev inventory row") end' 2>/dev/null || true)"
    if test -n "${rows}" && ! jq -e --arg name "${INSTANCE_NAME}" 'any(.[]; ((.name // .workspaceName // .instanceName // "") | tostring) == $name)' <<<"${rows}" >/dev/null; then
      absent=$((absent + 1))
      if test "${absent}" -ge 2; then
        echo "Verified Brev workspace deletion"
        break
      fi
    else
      absent=0
      # Brev can acknowledge a deletion and later surface the
      # workspace as unhealthy instead of removing it. Reissue the
      # idempotent delete while the owned workspace is still
      # present so cleanup can recover from that transition.
      brev delete "${INSTANCE_NAME}" >/dev/null 2>&1 || true
    fi
    # Inventory reads query the API directly; refreshing SSH adds unrelated work.
    echo "Deletion check ${attempt}/60: ${absent}/2 confirmed absences"
    sleep 15
  done
  if test "${absent}" -lt 2; then
    echo "Brev workspace deletion was not verified" >&2
    return 1
  fi
  echo "::endgroup::"
}

case "${1:-}" in
  prepare) prepare ;;
  qualify) qualify ;;
  cleanup) cleanup ;;
  *) echo "usage: $0 prepare|qualify|cleanup" >&2; exit 2 ;;
esac
