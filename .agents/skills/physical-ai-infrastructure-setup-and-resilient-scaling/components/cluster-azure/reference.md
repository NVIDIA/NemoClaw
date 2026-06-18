# Azure Cluster

## Prerequisites

* Azure CLI >= 2.60.0 with `components/azure-access/reference.md` completed
* PIM/RBAC active for the target subscription (`Owner`, or `Contributor` plus `User Access Administrator`)
* Terraform >= 1.9.8, < 2.0
* kubectl >= 1.31.0
* helmfile >= 0.165.0
* curl >= 7.68.0

## Security Model

AKS API server is **public** but restricted to `allowed_cidr` (your IP/32).
All deployment tools (kubectl, helm, osmo CLI) run from your local
machine. No jumpbox needed.

# Supporting files

| Path | Use | When |
|------|-----|------|
| `scripts/terraform.tfvars.example` | Read/copy | Template for local-only `deploy.tfvars`. |
| `scripts/{main,variables,outputs,versions}.tf` | Runtime config | Active Terraform root used by all `terraform -chdir=.../scripts` commands below. |
| `scripts/preflight.sh` | Run first | Checks `az` subscription/provider read access, CLI versions, binaries, the tfvars template, and completed local tfvars when present. |
| `scripts/setup.sh` | Run | Installs GPU Operator and swaps the default RWX StorageClass after AKS is reachable. |
| `scripts/helmfile.yaml` | Runtime config | Consumed by `scripts/setup.sh`; do not run directly unless debugging setup. |
| `scripts/storage-class-nfs.yaml` | Runtime config | Applied by `scripts/setup.sh` for the `azurefile-nfs` default StorageClass. |
| `scripts/system_node_capacity_test.sh` | Run | Optional post-deploy capacity check for system node sizing. |
| `terraform/` | Legacy/read-only | Older Terraform layout kept for compatibility notes and prerequisites. Do not use for new applies unless explicitly migrating an old state. |

# Deployment

1. Run preflight

```bash
REPO=$(git rev-parse --show-toplevel)
"$REPO/skills/physical-ai-infrastructure-setup-and-resilient-scaling/components/cluster-azure/scripts/preflight.sh"
```

2. Generate `deploy.tfvars`

`deploy.tfvars` is local-only (gitignored); `terraform.tfvars.example` is the tracked template. On a fresh clone, `cp terraform.tfvars.example deploy.tfvars` and fill in `subscription_id` (from `az account show --query id -o tsv`) and `allowed_cidr` (list containing your public IP `/32`). Other values (region, VM sizes, GPU min/max, priority, pg SKU, K8s version) are edited here when workload needs change — defaults live in `variables.tf`. Post-apply IP drift is handled by `setup.sh`, which re-applies TF against the live AKS resource.

User-overridable values (ask before assuming; defaults in `variables.tf`):

| Variable | Decide when |
|----------|-------------|
| `location` | Region pinned by quota/data residency |
| `system_vm_size` | Default D16; D8 is too small |
| `gpu_vm_size` | Pipeline's GPU model fit + quota (H100 for cosmos, T4/A10 for text) |
| `gpu_priority` | `Regular` vs `Spot` (dev can use Spot) |
| `gpu_min` / `gpu_max` | ≥ number of standing NIMServices; peak workload |
| `kubernetes_version` | AKS-supported; match helm chart requirements |
| `pg_sku` | OSMO load |

3. Check quotas

Check CPU + GPU quota for the chosen `location` + SKUs in `deploy.tfvars` before `terraform apply`. Skill matches `name.value` (Azure's SKU codename) against the localized usage list — `az vm list-usage` returns hundreds of rows, the filter must pick the family of `system_vm_size` / `gpu_vm_size`:

```bash
REPO=$(git rev-parse --show-toplevel)
LOCATION=$(awk -F'"' '/^location/{print $2}' "$REPO/skills/physical-ai-infrastructure-setup-and-resilient-scaling/components/cluster-azure/scripts/deploy.tfvars")
GPU_SKU=$(awk -F'"'  '/^gpu_vm_size/{print $2}' "$REPO/skills/physical-ai-infrastructure-setup-and-resilient-scaling/components/cluster-azure/scripts/deploy.tfvars")

az vm list-usage -l "$LOCATION" -o table \
  --query "[?contains(name.value, 'standardDDSv5')].{name:name.localizedValue, used:currentValue, limit:limit}"

az vm list-usage -l "$LOCATION" -o table \
  --query "[?contains(name.value, 'NCadsH100') || contains(name.value, 'NVADSA10') \
           || contains(name.value, 'NCASv3_T4') || contains(name.value, 'NCADSA100')] \
           .{name:name.localizedValue, used:currentValue, limit:limit}"
```

`name.value` filters above cover the SKU families in `variables.tf`; add the family for any new `gpu_vm_size` you introduce. Request increases via Azure Portal → Subscriptions → Usage + quotas. **STOP** before applying if the total `limit - used` is below what TF will request.

4. Apply the Terraform

Absolute paths only — no `cd`. `-chdir` makes Terraform cwd-agnostic.

```bash
REPO=$(git rev-parse --show-toplevel)
terraform -chdir="$REPO/skills/physical-ai-infrastructure-setup-and-resilient-scaling/components/cluster-azure/scripts" init
terraform -chdir="$REPO/skills/physical-ai-infrastructure-setup-and-resilient-scaling/components/cluster-azure/scripts" plan  -var-file=deploy.tfvars
terraform -chdir="$REPO/skills/physical-ai-infrastructure-setup-and-resilient-scaling/components/cluster-azure/scripts" apply -var-file=deploy.tfvars
```

5. Connect to AKS cluster

```bash
REPO=$(git rev-parse --show-toplevel)
RG=$(terraform -chdir="$REPO/skills/physical-ai-infrastructure-setup-and-resilient-scaling/components/cluster-azure/scripts" output -raw resource_group)
AKS=$(terraform -chdir="$REPO/skills/physical-ai-infrastructure-setup-and-resilient-scaling/components/cluster-azure/scripts" output -raw aks_name)
az aks get-credentials -g "$RG" -n "$AKS"
kubectl get nodes
```

6. Install GPU Operator + RWX default StorageClass on AKS cluster

```bash
"$(git rev-parse --show-toplevel)/skills/physical-ai-infrastructure-setup-and-resilient-scaling/components/cluster-azure/scripts/setup.sh"
```

RBAC propagation can take 1–2 minutes; a fresh cluster's first NFS PVC may retry once before binding.

# Verify

Check general Kubernetes state. Pods should be healthy and running.

```bash
kubectl get pods -A
```

Check GPUs are available and allocatable under `nvidia.com/gpu` for all nodes.

```bash
kubectl get nodes
kubectl describe node <node-name>
```
