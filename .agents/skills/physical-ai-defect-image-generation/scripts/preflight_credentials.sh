#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Preflight check for the credential every flow needs.
#
# The only credential the workflows require is the OSMO credential hf-token
# (GENERIC) — that is what gates the Hugging Face downloads every flow performs:
#   - hf-token is used by every group that hits Hugging Face — i.e. all model
#     downloads, all dataset downloads except UC2 (metal, public GitHub), the
#     PCBA USD asset bundle, and the pretrained bundle.
#
# There is NO registry credential requirement: the paidf-* workflow images are
# public on nvcr.io/nvidia/ and pull anonymously, so no NGC key / nvcr_io
# REGISTRY credential is needed. If image pulls fail (auth error or nvcr.io
# rate-limiting), see references/troubleshooting.md -> "nvcr.io image pull
# failures" for how to add an NGC pull credential.
#
# Env var HF_TOKEN is only needed when:
#   (a) the OSMO credential hf-token is missing and we want to auto-set it, OR
#   (b) you want the outbound HF probes to run (verify the token still has
#       read scope on the gated nvidia/Cosmos-AnomalyGen-* and
#       nvidia/Cosmos-Predict2-* repos before submitting a long workflow).
#
# Flow:
#   1. List OSMO credentials → determine whether hf-token is present.
#   2. Require hf-token (auto-set from HF_TOKEN if missing).
#   3. If HF_TOKEN is exported, probe two gated HF repos to verify scope
#      (unless --no-probe). If hf-token is already set and HF_TOKEN is not
#      exported, that's a clean exit 0.
#
# Usage:
#   preflight_credentials.sh [--no-probe]
#
# --no-probe skips outbound HTTPS probes (offline / restricted egress).
#
# Exit 0 when hf-token is present (whether already set or auto-set in step 2)
# and any probes that ran returned 200. Exit 1 with a specific remediation on
# stderr otherwise.

set -euo pipefail

probe=true
case "${1:-}" in
  --no-probe) probe=false ;;
  "") ;;
  *) echo "usage: $0 [--no-probe]" >&2; exit 2 ;;
esac

# Gated HF repos used by the setup + flow workflows. Probed when HF_TOKEN is
# exported to catch license-acceptance / scope drift before a workflow submit.
hf_anomalygen_probe_url="https://huggingface.co/api/models/nvidia/Cosmos-AnomalyGen-PCB-2B"
hf_predict2_probe_url="https://huggingface.co/api/models/nvidia/Cosmos-Predict2-2B-Text2Image"

have_hf_env=false
[[ -n "${HF_TOKEN:-}" ]] && have_hf_env=true

# 1. Is hf-token already provisioned in the cluster?
present=$(osmo credential list | awk 'NR>1 {print $1}' | sort -u)
has_hf_token=false
grep -qx 'hf-token' <<<"$present" && has_hf_token=true

# 2. hf-token is the only requirement. Missing-AND-no-env-var is the only
#    hard failure here.
if ! $has_hf_token && ! $have_hf_env; then
  echo "OSMO credential 'hf-token' is missing and HF_TOKEN is not exported to set it." >&2
  echo "" >&2
  echo "Two options:" >&2
  echo "  (a) Export the token and re-run:  export HF_TOKEN=<your-hf-token>" >&2
  echo "  (b) Provision it directly (see references/setup.md §Credential check)." >&2
  exit 1
fi

if ! $has_hf_token; then
  echo ">>> setting OSMO credential hf-token from HF_TOKEN" >&2
  osmo credential set hf-token --type GENERIC \
    --payload token="$HF_TOKEN"
fi

# Confirm hf-token is present (covers the case where `set` succeeded but with
# the wrong type or payload — re-listing is the only signal we have).
present_after=$(osmo credential list | awk 'NR>1 {print $1}' | sort -u)
if ! grep -qx 'hf-token' <<<"$present_after"; then
  echo "OSMO credential still missing after auto-set:" >&2
  echo "  - hf-token" >&2
  echo "Inspect with: osmo credential list" >&2
  exit 1
fi

# 3. Outbound probes — only when HF_TOKEN is exported. If the OSMO credential is
#    provisioned but no env var is available locally, we have no key to probe
#    with; that's not a failure.
if $probe; then
  if $have_hf_env; then
    for url in "$hf_anomalygen_probe_url" "$hf_predict2_probe_url"; do
      hf_status=$(curl -sS -o /dev/null -w '%{http_code}' \
        -H "Authorization: Bearer $HF_TOKEN" \
        "$url")
      if [[ "$hf_status" != "200" ]]; then
        echo "HF gated-repo probe failed (HTTP $hf_status) at $url" >&2
        if [[ "$hf_status" == "401" || "$hf_status" == "403" ]]; then
          echo "  HF_TOKEN cannot read this gated repo. Accept the license once for each repo the setup workflow touches:" >&2
          echo "    https://huggingface.co/nvidia/Cosmos-AnomalyGen-PCB-2B" >&2
          echo "    https://huggingface.co/nvidia/Cosmos-AnomalyGen-Metal-2B" >&2
          echo "    https://huggingface.co/nvidia/Cosmos-AnomalyGen-Glass-2B" >&2
          echo "    https://huggingface.co/nvidia/Cosmos-Predict2-2B-Text2Image" >&2
          echo "    https://huggingface.co/nvidia/Cosmos-Predict2-14B-Text2Image" >&2
          echo "  After accepting, regenerate the token at https://huggingface.co/settings/tokens if it predates the license acceptance." >&2
        elif [[ "$hf_status" == "000" ]]; then
          echo "  Network error reaching huggingface.co. If egress is restricted, re-run with --no-probe." >&2
        fi
        exit 1
      fi
    done
  else
    echo "note: skipping HF probe — HF_TOKEN not exported (OSMO credential 'hf-token' is already provisioned)." >&2
  fi
fi

echo "OK: OSMO credential hf-token present (paidf-* images are public on nvcr.io/nvidia/ — no registry credential needed)."
