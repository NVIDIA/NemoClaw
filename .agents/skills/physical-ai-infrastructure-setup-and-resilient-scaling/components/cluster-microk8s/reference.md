# MicroK8s Cluster

## Prerequisites

* Running on machine with GPU available and NVIDIA driver >= 525 installed
* snapd >= 2.45.0
* Ports 16443, 10250, 10255 available
* 20 GB disk space
* git >= 2.25.0 (for shallow clone of https://github.com/nvidia/osmo)

# Deployment

Run as root (sudo) from repo root.

1. Run preflight

```bash
REPO=$(git rev-parse --show-toplevel)
"$REPO/skills/physical-ai-infrastructure-setup-and-resilient-scaling/components/cluster-microk8s/scripts/preflight.sh"
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

3. Run Microk8s bootstrap

```bash
sudo "$OSMO_DIR/deployments/scripts/microk8s/install.sh" --gpu
```

# Verify

Check general Kubernetes state. Pods should be healthy and running.

```bash
kubectl get pods -A
```

Check GPUs are available and allocatable under `nvidia.com/gpu`.

```bash
kubectl describe node <node-name>
```

Ensure runtime class is marked as `nvidia`.

```bash
kubectl get runtimeclass nvidia -o jsonpath='{.handler}'
```

# Troubleshooting

| Symptom | Fix |
| ------- | --- |
| `snap: command not found` | `sudo apt-get install snapd` |
| Node NotReady after install | `sudo microk8s status --wait-ready` |
| GPU not visible | `nvidia-smi`; verify driver ≥ 525 |
| kubeconfig permission denied | `sudo chown $USER:$USER ~/.kube/config` |
| Existing microk8s install in degraded state | `sudo snap remove microk8s --purge` then re-run from step 2 |
