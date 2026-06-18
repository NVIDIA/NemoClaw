# Azure OSMO

## Prerequisites

* Complete `components/azure-access/reference.md` first: login, PIM/roles, subscription, region
* Azure CLI, Terraform, kubectl, helm, and git available before deployment
* Azure cluster Terraform outputs available only when the deploy step consumes them
* helm 3.x
* git (for shallow clone of https://github.com/nvidia/osmo)

## Supporting files

| Path | Use | When |
|------|-----|------|
| `scripts/preflight.sh` | Run first | Checks Azure subscription/provider read access, local tools, and repo `.env`; Terraform state and cluster state are deploy-time inputs. |

# Deployment

1. Run preflight

```bash
REPO="$(git rev-parse --show-toplevel)"
"$REPO/skills/physical-ai-infrastructure-setup-and-resilient-scaling/components/osmo-azure/scripts/preflight.sh"
```

2. Clone https://github.com/nvidia/osmo - use `main` unless otherwise specified

```bash
OSMO_REF="${OSMO_REF:-main}"
OSMO_DIR="$HOME/.cache/physical-ai/osmo"
if [ -d "$OSMO_DIR/.git" ]; then
  git -C "$OSMO_DIR" fetch --depth 1 origin "$OSMO_REF"
  git -C "$OSMO_DIR" reset --hard FETCH_HEAD
else
  mkdir -p "$(dirname "$OSMO_DIR")"
  git clone --depth 1 --branch "$OSMO_REF" \
    https://github.com/NVIDIA/OSMO.git "$OSMO_DIR"
fi
```

3. Prepare OSMO deploy script inputs from Azure cluster Terraform state

```bash
REPO="$(git rev-parse --show-toplevel)"
TF_DIR="$REPO/skills/physical-ai-infrastructure-setup-and-resilient-scaling/components/cluster-azure/scripts"
export POSTGRES_HOST=$(terraform -chdir="$TF_DIR" output -raw pg_fqdn)
export POSTGRES_USERNAME=$(terraform -chdir="$TF_DIR" output -raw pg_admin_user)
export POSTGRES_PASSWORD=$(terraform -chdir="$TF_DIR" output -raw pg_admin_password)
export POSTGRES_DB_NAME=$(terraform -chdir="$TF_DIR" output -raw pg_database)
export POSTGRES_PORT=5432
export REDIS_HOST=$(terraform -chdir="$TF_DIR" output -raw redis_hostname)
export REDIS_PORT=$(terraform -chdir="$TF_DIR" output -raw redis_port)
export REDIS_PASSWORD=$(terraform -chdir="$TF_DIR" output -raw redis_primary_key)
export STORAGE_ACCOUNT=$(terraform -chdir="$TF_DIR" output -raw storage_account)
export STORAGE_KEY=$(terraform -chdir="$TF_DIR" output -raw storage_account_key)
az aks get-credentials \
  --resource-group "$(terraform -chdir="$TF_DIR" output -raw resource_group)" \
  --name "$(terraform -chdir="$TF_DIR" output -raw aks_name)" \
  --overwrite-existing
set -a; . "$REPO/.env"; set +a   # NGC_API_KEY
```

4. Check for an existing OSMO install before deploying. Do not redeploy or
   upgrade a working install just because namespace `osmo` is empty; Physical AI
   infra uses the `osmo-minimal` namespace.

```bash
helm status -n osmo-minimal osmo-minimal
kubectl get pods -n osmo-minimal
osmo workflow list --count 5
```

If Helm status succeeds and the pods are healthy, reuse the existing install.
Only continue to deploy when OSMO is absent or the user explicitly approves a
repair/redeploy.

5. Deploy OSMO.

```bash
"$OSMO_DIR/deployments/scripts/deploy-osmo-minimal.sh" \
  --provider byo \
  --storage-backend azure-blob \
  --non-interactive
```

# Verify

Verification is done as part of `deploy-osmo-minimal.sh`. If the script exits with exit code 0, the OSMO deployment is considered verified.

# Recovery

| Symptom | Check | Fix |
|---------|-------|-----|
| `.env` is missing or `NGC_API_KEY` is unset | `test -f "$REPO/.env"` then source it and run `test -n "${NGC_API_KEY:-}"` without printing the value | Create the repo-local `.env` with the approved NGC key source, then rerun step 3 from `set -a; . "$REPO/.env"; set +a`. |
| Terraform outputs fail or state is missing | `terraform -chdir="$TF_DIR" state list` | Run the Azure cluster component first, or point `TF_DIR` at the existing cluster state's active `scripts` Terraform root. Do not invent PostgreSQL, Redis, or storage values by hand. |
| `az aks get-credentials` fails | `az account show`, `az aks show -g <resource-group> -n <aks-name>` | Switch to the subscription that owns the cluster, refresh `allowed_cidr` through the Azure cluster component if caller IP changed, then rerun `az aks get-credentials --overwrite-existing`. |

# Re-run

Do not re-run deployment scripts during demos without explicit user approval.
Use the existing-install checks above first.

# Cleanup

This cleanup currently destroys the entire Azure resource group.

```bash
pkill -f 'osmo-pf-watchdog:' || true
"$OSMO_DIR/deployments/scripts/deploy-osmo-minimal.sh" \
  --provider byo \
  --destroy --non-interactive
```
