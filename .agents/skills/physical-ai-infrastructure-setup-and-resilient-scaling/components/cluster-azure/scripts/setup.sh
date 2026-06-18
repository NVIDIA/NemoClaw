#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Post-deploy AKS setup: GPU Operator + RWX default StorageClass via helmfile.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TF_DIR="$SCRIPT_DIR"

"${SCRIPT_DIR}/preflight.sh"

# Always fetch credentials from TF to ensure correct cluster
RG=$(terraform -chdir="$TF_DIR" output -raw resource_group 2>/dev/null)
CLUSTER=$(terraform -chdir="$TF_DIR" output -raw aks_name 2>/dev/null)
[[ -n "$RG" && -n "$CLUSTER" ]] || { echo "ERROR: terraform outputs not available"; exit 1; }
az aks get-credentials -g "$RG" -n "$CLUSTER" --overwrite-existing

# Drift guard: if caller IP moved since last apply, AKS API allowlist and the
# storage account firewall (both driven by allowed_cidr) lock us out. Rewrite
# deploy.tfvars + do a full `terraform apply` — targeting only AKS would leave
# Blob / Key Vault / any other allowed_cidr consumer stale.
CURRENT_IP=$(curl -fsS --max-time 10 ifconfig.me)
AUTHORIZED=$(az aks show -g "$RG" -n "$CLUSTER" \
  --query "apiServerAccessProfile.authorizedIpRanges" -o tsv)
if [[ -n "$CURRENT_IP" ]] && ! grep -q "$CURRENT_IP" <<<"$AUTHORIZED"; then
  echo "==> allowed_cidr drift ($AUTHORIZED does not include $CURRENT_IP); syncing tfvars + full terraform apply"
  tmp=$(mktemp)
  awk -v new="${CURRENT_IP}/32" '
    /^[[:space:]]*allowed_cidr[[:space:]]*=/ {
      print "allowed_cidr = [\"" new "\"]";
      if ($0 ~ /\[/ && $0 !~ /\]/) in_allowed_cidr = 1;
      next;
    }
    in_allowed_cidr {
      if ($0 ~ /\]/) in_allowed_cidr = 0;
      next;
    }
    { print }
  ' "$TF_DIR/deploy.tfvars" > "$tmp"
  mv "$tmp" "$TF_DIR/deploy.tfvars"
  terraform -chdir="$TF_DIR" apply -input=false -auto-approve \
    -var-file=deploy.tfvars
fi

# Sanity: API reachable before running helmfile (fail fast, not 10-min hang)
kubectl cluster-info --request-timeout=15s >/dev/null || {
  echo "ERROR: cannot reach AKS API after CIDR sync. Check network / authorizedIpRanges."
  exit 1
}

echo "==> Ensure default StorageClass is RWX-capable (NFS + nconnect=4)"
# NIM multi-node needs RWX:
#   https://docs.nvidia.com/nim-operator/latest/multi-node.html
# NFS over Azure Files Premium with nconnect=4 is the fastest RWX option on
# this cluster's kernel (5.15 — too old for SMB Multichannel, which needs
# Ubuntu 22.04 kernel 6.8.0-1044+ per
#   https://learn.microsoft.com/en-us/azure/storage/files/smb-performance
# ). Shares are dynamically provisioned INSIDE the TF-managed Premium
# FileStorage SA (main.tf → azurerm_storage_account.nfs); no SA auto-
# creation, so `terraform destroy` cleans up end-to-end. See
# storage-class-nfs.yaml for driver parameter reference.
export NFS_RESOURCE_GROUP="$RG"
NFS_STORAGE_ACCOUNT=$(terraform -chdir="$TF_DIR" output -raw nfs_storage_account 2>/dev/null)
[[ -n "$NFS_STORAGE_ACCOUNT" ]] || { echo "ERROR: nfs_storage_account TF output missing — run terraform apply"; exit 1; }
export NFS_STORAGE_ACCOUNT
envsubst < "$SCRIPT_DIR/storage-class-nfs.yaml" | kubectl apply -f -

DESIRED_DEFAULT_SC="azurefile-nfs-premium"
CURRENT_DEFAULT_SC=$(kubectl get sc -o jsonpath='{.items[?(@.metadata.annotations.storageclass\.kubernetes\.io/is-default-class=="true")].metadata.name}')
if [[ "$CURRENT_DEFAULT_SC" != "$DESIRED_DEFAULT_SC" ]]; then
  echo "    current default: ${CURRENT_DEFAULT_SC:-<none>} -> ${DESIRED_DEFAULT_SC}"
  # Demote every currently-defaulted SC (there can only be one by convention,
  # but be defensive).
  for sc in $(kubectl get sc -o jsonpath='{.items[?(@.metadata.annotations.storageclass\.kubernetes\.io/is-default-class=="true")].metadata.name}'); do
    [[ "$sc" == "$DESIRED_DEFAULT_SC" ]] && continue
    kubectl annotate sc "$sc" storageclass.kubernetes.io/is-default-class- --overwrite
  done
  kubectl annotate sc "$DESIRED_DEFAULT_SC" storageclass.kubernetes.io/is-default-class=true --overwrite
else
  echo "    default already $DESIRED_DEFAULT_SC"
fi

echo "==> helmfile sync"
helmfile -f "$SCRIPT_DIR/helmfile.yaml" sync

echo "==> Verify"
kubectl get pods -n gpu-operator --no-headers
echo "---"
kubectl get nodes -o wide
