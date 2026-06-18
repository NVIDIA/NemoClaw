# Kubernetes OSMO

## Prerequisites

* MicroK8s v1.31+ with configured kubectl
* helm 3.x
* git (for shallow clone of https://github.com/nvidia/osmo)

## Supporting files

| Path | Use | When |
|------|-----|------|
| `scripts/preflight.sh` | Run first | Checks local MicroK8s/Kubernetes tools, Helm, Git, and repo `.env`; cluster state is verified during deploy. |

# Deployment

1. Run preflight

```bash
REPO="$(git rev-parse --show-toplevel)"
"$REPO/skills/physical-ai-infrastructure-setup-and-resilient-scaling/components/osmo-k8s/scripts/preflight.sh"
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

3. Load environment secrets

```bash
REPO="$(git rev-parse --show-toplevel)"
[ -f "$REPO/.env" ] && { set -a; . "$REPO/.env"; set +a; }
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

5. Deploy OSMO in "minimal" configuration in MicroK8s mode with in-cluster PostgreSQL, Redis, MicroK8s MinIO add-on, ClusterIP gateway with port-forward watchdog

```bash
"$OSMO_DIR/deployments/scripts/deploy-osmo-minimal.sh" \
  --provider microk8s \
  --storage-backend minio \
  --non-interactive
```

For CPU-only instances, add `--no-gpu`.

# Verify

Verification is done as part of `deploy-osmo-minimal.sh`. If the script exits with exit code 0, the OSMO deployment is considered verified.

# Re-run

Do not re-run deployment scripts during demos without explicit user approval.
Use the existing-install checks above first.

# Cleanup

This intentionally only cleans up the OSMO install - the MicroK8s cluster
remains up.

```bash
pkill -f 'osmo-pf-watchdog:' || true
$OSMO_DIR/deployments/scripts/deploy-osmo-minimal.sh \
  --provider microk8s \
  --destroy --non-interactive
```
