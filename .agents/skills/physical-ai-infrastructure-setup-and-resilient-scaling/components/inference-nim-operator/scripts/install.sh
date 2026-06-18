#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Install NVIDIA NIM Operator via Helm and deploy NIMService instances.
#
# Prerequisites: kubectl configured, helm installed, NGC_API_KEY set
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../../.." && pwd)"
# shellcheck disable=SC1091
[[ -f "${REPO_ROOT}/.env" ]] && set -a && source "${REPO_ROOT}/.env" && set +a

NIM_OPERATOR_VERSION="${NIM_OPERATOR_VERSION:-3.1.0}"
NAMESPACE="${NAMESPACE:-nim-operator}"

# ── Preflight ─────────────────────────────────────────────────────────────────
"${SCRIPT_DIR}/preflight.sh"

# ── 1. Verify GPUs ───────────────────────────────────────────────────────────
PHYSICAL_GPUS=$(kubectl get node -o jsonpath='{.items[0].status.capacity.nvidia\.com/gpu}' 2>/dev/null || echo "0")
echo "==> ${PHYSICAL_GPUS} GPU(s) available on node"

# ── 2. Add Helm repo ─────────────────────────────────────────────────────────
echo "==> Adding nvidia helm repo"
helm repo add nvidia https://helm.ngc.nvidia.com/nvidia --force-update
helm repo update nvidia

# ── 3. Create namespace ──────────────────────────────────────────────────────
echo "==> Creating namespace ${NAMESPACE}"
kubectl create namespace "${NAMESPACE}" --dry-run=client -o yaml | kubectl apply -f -

# ── 4. Create NGC pull secret (if NGC_API_KEY is set) ────────────────────────
if [[ -n "${NGC_API_KEY:-}" ]]; then
  echo "==> Creating nvcr-pull-secret in ${NAMESPACE}"
  kubectl create secret docker-registry nvcr-pull-secret \
    -n "${NAMESPACE}" \
    --docker-server=nvcr.io \
    --docker-username='$oauthtoken' \
    --docker-password="${NGC_API_KEY}" \
    --dry-run=client -o yaml | kubectl apply -f -
else
  echo "WARNING: NGC_API_KEY not set — NIM deployments will fail to pull images"
fi

# ── 5. Install NIM Operator ──────────────────────────────────────────────────
echo "==> Installing NIM Operator ${NIM_OPERATOR_VERSION}"
helm upgrade --install nim-operator nvidia/k8s-nim-operator \
  -n "${NAMESPACE}" \
  --version="${NIM_OPERATOR_VERSION}" \
  --wait --timeout=300s

# ── 6. Deploy NIMService instances ───────────────────────────────────────────
# Each NIM lives in its own directory under nims/<name>/ containing its
# nimservice.yaml and, when pre-staging is needed, pvc.yaml + hf-download-job.yaml.
# install.sh applies the files in a fixed per-NIM order: pvc → job (wait) →
# nimservice.
#
# NIM_SERVICES (optional): space-separated allow-list of NIM directory names
# under nims/. Root SKILL.md computes this from the pipeline spec's capability
# needs. Unset = deploy every nims/*/ directory.
NIMS_DIR="${SCRIPT_DIR}/../nims"

SELECTED_NIMS=()
if [[ -d "${NIMS_DIR}" ]]; then
  for d in "${NIMS_DIR}"/*/; do
    [[ -d "${d}" ]] || continue
    name=$(basename "${d}")
    if [[ -n "${NIM_SERVICES:-}" ]]; then
      for want in ${NIM_SERVICES}; do
        [[ "${want}" == "${name}" ]] && { SELECTED_NIMS+=("${name}"); break; }
      done
    else
      SELECTED_NIMS+=("${name}")
    fi
  done
fi

if [[ -n "${NIM_SERVICES:-}" ]] && [[ ${#SELECTED_NIMS[@]} -eq 0 ]]; then
  echo "ERROR: NIM_SERVICES='${NIM_SERVICES}' matched zero directories under ${NIMS_DIR}"
  exit 1
fi

if [[ ${#SELECTED_NIMS[@]} -gt 0 ]]; then
  echo "==> Deploying NIMs (${#SELECTED_NIMS[@]} selected): ${SELECTED_NIMS[*]}"

  # All NIMs live in the osmo namespace (matches the nimservice.yaml metadata).
  NIM_NS="osmo-nims"
  kubectl create namespace "${NIM_NS}" --dry-run=client -o yaml | kubectl apply -f -
  if [[ -n "${NGC_API_KEY:-}" ]]; then
    kubectl create secret docker-registry nvcr-pull-secret \
      -n "${NIM_NS}" \
      --docker-server=nvcr.io \
      --docker-username='$oauthtoken' \
      --docker-password="${NGC_API_KEY}" \
      --dry-run=client -o yaml | kubectl apply -f -
    kubectl create secret generic ngc-api-secret \
      -n "${NIM_NS}" \
      --from-literal=NGC_API_KEY="${NGC_API_KEY}" \
      --dry-run=client -o yaml | kubectl apply -f -
  fi
  if [[ -n "${HF_TOKEN:-}" ]]; then
    kubectl create secret generic hf-token-secret \
      -n "${NIM_NS}" \
      --from-literal=HF_TOKEN="${HF_TOKEN}" \
      --dry-run=client -o yaml | kubectl apply -f -
  fi

  # PVCs + NIMService storage omit storageClassName so Kubernetes uses the
  # cluster's default StorageClass (MicroK8s: microk8s-hostpath; AKS: default).

  deploy_one_nim() {
    local nim="$1"
    local nim_dir="${NIMS_DIR}/${nim}"
    local svc_yaml="${nim_dir}/nimservice.yaml"
    local job_yaml="${nim_dir}/hf-download-job.yaml"
    local prefix="[${nim}]"

    [[ -f "${svc_yaml}" ]] || { echo "${prefix} ERROR: ${svc_yaml} missing"; return 1; }

    # An hf-download-job.yaml is the authoritative marker for HF-backed NIMs —
    # that's the manifest that references hf-token-secret. Skip the whole NIM
    # when we have no HF_TOKEN to avoid applying a PVC + Job that will wait
    # the full 60m for a secret that does not exist.
    if [[ -f "${job_yaml}" ]] && [[ -z "${HF_TOKEN:-}" ]]; then
      echo "${prefix} Skipping — HF-backed NIM requires HF_TOKEN (not set)"
      return 0
    fi

    # Compute a short hash over every reconciled YAML for this NIM. The hash is
    # stamped on the NIMService after a successful apply; the fast path only
    # fires when the deployed hash equals the current hash, so changes to
    # pvc.yaml / hf-download-job.yaml (model revision, cache layout, PVC size)
    # force a full reconcile even when the service is already Ready.
    local spec_hash
    spec_hash=$( { if [[ -f "${nim_dir}/pvc.yaml" ]]; then cat "${nim_dir}/pvc.yaml"; fi; \
                   if [[ -f "${job_yaml}" ]];         then cat "${job_yaml}"; fi; \
                   cat "${svc_yaml}"; } | shasum -a 256 | cut -c1-16)

    local svc_state deployed_hash
    svc_state=$(kubectl get nimservice -n "${NIM_NS}" "${nim}" --ignore-not-found -o jsonpath='{.status.state}' 2>/dev/null)
    deployed_hash=$(kubectl get nimservice -n "${NIM_NS}" "${nim}" --ignore-not-found \
      -o jsonpath='{.metadata.annotations.orion\.nvidia\.com/spec-hash}' 2>/dev/null)

    if [[ "${svc_state}" == "Ready" && "${deployed_hash}" == "${spec_hash}" ]]; then
      echo "${prefix} NIMService Ready + spec-hash matches (${spec_hash}) — skipping reconcile"
      return 0
    fi
    if [[ "${svc_state}" == "Ready" ]]; then
      echo "${prefix} NIMService Ready but spec-hash drifted (deployed=${deployed_hash:-<none>} current=${spec_hash}) — full reconcile"
    fi

    # Route stderr through the same prefixer as stdout so kubectl errors
    # appear in-band alongside the NIM's tag (debugging the subshell failure
    # mode where kubectl wrote to stderr and output looked silently truncated).
    if [[ -f "${nim_dir}/pvc.yaml" ]]; then
      echo "${prefix} apply pvc.yaml"
      kubectl apply -f "${nim_dir}/pvc.yaml" 2>&1 | sed "s/^/${prefix} /"
    fi

    if [[ -f "${job_yaml}" ]]; then
      local job_name="${nim}-hf-download"
      local job_complete job_failed
      job_complete=$(kubectl get job -n "${NIM_NS}" "${job_name}" --ignore-not-found -o jsonpath='{.status.conditions[?(@.type=="Complete")].status}' 2>/dev/null)
      job_failed=$(kubectl get job -n "${NIM_NS}" "${job_name}" --ignore-not-found -o jsonpath='{.status.conditions[?(@.type=="Failed")].status}' 2>/dev/null)

      # Complete jobs are normally skipped — but a hash drift means the YAML
      # for the job or its PVC has changed, so a previously-Complete job is
      # stale. Tear it down (`jobs/spec` is immutable; apply wouldn't rerun
      # it) and rebuild from the new manifest. This closes the upgrade hole
      # where a model rev bump would annotate as reconciled while actually
      # serving the prior weights.
      if [[ "${job_complete}" == "True" && -n "${deployed_hash}" && "${deployed_hash}" != "${spec_hash}" ]]; then
        echo "${prefix} hf-download-job is Complete but spec-hash drifted — deleting so the new manifest runs"
        kubectl delete job -n "${NIM_NS}" "${job_name}" --ignore-not-found --wait 2>&1 | sed "s/^/${prefix} /"
        job_complete=""
      fi

      if [[ "${job_complete}" == "True" ]]; then
        echo "${prefix} hf-download-job already Complete — skipping Job"
      else
        # Kubernetes Jobs are immutable in spec; a Job that exhausted its
        # backoffLimit stays Failed forever. `kubectl apply` on the same
        # name won't reset it, so delete-then-recreate on Failed. RWX PVC
        # means the old pod releasing and new pod attaching can overlap
        # without Multi-Attach.
        if [[ "${job_failed}" == "True" ]]; then
          echo "${prefix} hf-download-job is Failed — deleting for fresh attempt"
          kubectl delete job -n "${NIM_NS}" "${job_name}" --ignore-not-found --wait 2>&1 | sed "s/^/${prefix} /"
        fi
        echo "${prefix} apply hf-download-job.yaml (weights download; up to 60m)"
        kubectl apply -f "${job_yaml}" 2>&1 | sed "s/^/${prefix} /"
        kubectl wait -n "${NIM_NS}" --for=condition=complete "job/${job_name}" --timeout=60m 2>&1 | sed "s/^/${prefix} /"
      fi
    fi

    echo "${prefix} apply nimservice.yaml"
    kubectl apply -f "${svc_yaml}" 2>&1 | sed "s/^/${prefix} /"
    # Stamp the hash we just reconciled, so the next run can fast-path only if
    # nothing has changed on disk since this deploy.
    kubectl annotate nimservice -n "${NIM_NS}" "${nim}" \
      "orion.nvidia.com/spec-hash=${spec_hash}" --overwrite 2>&1 | sed "s/^/${prefix} /"
  }

  # Deploy each NIM concurrently; one failure fails the whole step.
  # Trap ensures any background subshell (and its children — helm, kubectl,
  # kubectl wait) gets SIGTERM if install.sh exits before `wait` completes
  # (CTRL+C, set -e failure, kill). Guard kill with `kill -0` so the trap
  # doesn't fail on already-exited PIDs (no `|| true`).
  declare -a PIDS=()
  kill_bg() {
    for pid in "${PIDS[@]:-}"; do
      if kill -0 "${pid}" 2>/dev/null; then
        # Negative PID targets the whole process group rooted at the subshell,
        # so nested kubectl/helm children get the signal too.
        kill -TERM "-${pid}" 2>/dev/null
      fi
    done
  }
  trap kill_bg EXIT INT TERM

  set -m  # enable job control so each `&` launches its own process group
  for nim in "${SELECTED_NIMS[@]}"; do
    deploy_one_nim "${nim}" &
    PIDS+=($!)
  done
  set +m

  FAIL=0
  for pid in "${PIDS[@]}"; do
    wait "${pid}" || FAIL=1
  done
  trap - EXIT INT TERM
  [[ "${FAIL}" == "0" ]] || { echo "ERROR: one or more NIM deployments failed"; exit 1; }
fi

# ── 7. Verify ────────────────────────────────────────────────────────────────
echo ""
echo "==> NIM Operator pods:"
kubectl get pods -n "${NAMESPACE}"
echo ""
echo "==> NIM CRDs installed:"
if kubectl get crd | grep -E "nim|nemo"; then
  :
else
  echo "    (none)"
fi
echo ""
echo "==> NIMService instances:"
kubectl get nimservice -A 2>/dev/null || echo "    (none)"
echo ""
echo "==> GPU allocation:"
kubectl get node -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}gpu: {.status.allocatable.nvidia\.com/gpu}{"\n"}{end}'
