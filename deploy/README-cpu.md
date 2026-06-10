# NemoClaw Kubernetes deployment — CPU (HPA, optional)

**Optional pre-GPU chart** — use only if you do not have cluster GPUs yet and want to test agents/HPA against **NVIDIA Inference Hub** (Nemotron Ultra). For the real deployment, use the **[GPU chart](README-gpu.md)**.

Helm chart and scripts for **CPU agent pods** with **HPA**. Each pod uses **1 CPU** and proxies remote inference (no `nvidia.com/gpu`).

**Index:** [deploy/README.md](README.md) · **Models (CPU vs GPU):** [helm/README.md](helm/README.md)

This document is the **CPU deployment guide** — install, operate, and load-test the optional CPU chart. GPU deployment: [README-gpu.md](README-gpu.md).

---

## Install (CPU only)

You do **not** install the chart, then HPA, then load test as three separate steps. One script installs **metrics-server + Helm chart + CPU HPA** together.

```bash
cd ~/NemoClaw/deploy/helm/nemoclaw-cpu
source ~/.nemoclaw/secrets.env   # NVIDIA_INFERENCE_HUB_API_KEY=sk-...

./scripts/install-hpa.sh
```

Confirm idle state (no workload required):

```bash
kubectl get hpa -n nemoclaw
kubectl get pods -n nemoclaw
```

Expect **1 Running pod** and HPA **REPLICAS 1** (CPU well below the ~65% target). **Autoscaling only happens under load** — see [Idle vs load test](#idle-vs-load-test).

---

## Port-forward

CPU agent listens on **8080** (Service, pod, and local port-forward):

```bash
kubectl port-forward -n nemoclaw svc/nemoclaw-nemoclaw-cpu-agent 8080:8080
```

**Verify** Inference Hub (needed for chat, not for rollout):

```bash
curl -s http://127.0.0.1:8080/healthz   # always ok if pod is up
curl -s http://127.0.0.1:8080/readyz    # 200 = Hub key OK; 503 = fix secrets
```

Override host port: `LOCAL_PORT=8080 ./scripts/install-hpa.sh` (default is 8080).

Optional demo of scale up/down:

```bash
./scripts/hpa-load-test.sh
./scripts/hpa-reset.sh    # return to idle baseline after the test
```


<img width="1832" height="1302" alt="Screenshot 2026-05-28 at 12 49 11 PM" src="https://github.com/user-attachments/assets/a91dd398-059a-4e3f-afec-07b2b66b12b0" />




<img width="1926" height="550" alt="Screenshot 2026-05-28 at 12 42 34 PM" src="https://github.com/user-attachments/assets/25b876d5-19a8-4758-8880-5702b38d5f51" />




If install keeps failing with **rollout failed** or Deployment **`0 up-to-date`**:

```bash
./scripts/cluster-recover.sh
```

Chart details: [helm/nemoclaw-cpu/README.md](helm/nemoclaw-cpu/README.md) · [CPU vs GPU comparison](helm/README.md)

---

## Scripts

All scripts live under `deploy/helm/nemoclaw-cpu/scripts/`. Run from the chart directory after sourcing `~/.nemoclaw/secrets.env`.

| Script | What it does | When to use |
|--------|----------------|-------------|
| **`install-hpa.sh`** | Enables **metrics-server**; `helm upgrade --install` with **CPU HPA** (`values-step2-hpa.yaml`, min **1** / max **7**); readiness on **`/healthz`** so rollout succeeds without Hub traffic. | **First install** or healthy cluster refresh. |
| **`hpa-reset.sh`** | Deletes load-test Jobs; force-deletes **pods** and stale ReplicaSets; **keeps HPA + Deployment** by default; `helm upgrade` to idle baseline. | After load test, stuck load-test pods, return to idle. |
| **`cluster-recover.sh`** | Removes stray resources, **`helm uninstall`**, wipes namespace leftovers, **restarts MicroK8s**, runs **`install-hpa.sh`**. | Repeated **rollout failed**, Deployment **`0 updated \| 0 total`**, ghost HPA. |
| **`hpa-load-test.sh`** | Switches to **saturate** values (400m CPU/pod); runs in-cluster load Job (~12 min); watches scale up then down. | Prove HPA only — not required for setup. |
| **`install-performance-hpa.sh`** | Optional Prometheus + adapter + inflight-metric HPA. Heavy; may timeout on small VMs. | Advanced only. |
| **`hpa-common.sh`** | Shared helpers (not run directly). | — |

### Workflow

```text
First time:              install-hpa.sh
After load test / tidy:  hpa-reset.sh
Rollout keeps failing:   cluster-recover.sh
Prove autoscaling:       hpa-load-test.sh  →  watch  →  hpa-reset.sh
```

Do **not** run `hpa-reset.sh && install-hpa.sh` unless you used `SKIP_HELM=1` on reset. Reset already runs `helm upgrade`.

### Environment variables

| Variable | Scripts | Effect |
|----------|---------|--------|
| `DELETE_DEPLOYMENT=1` | `hpa-reset.sh` | Delete Deployment before reinstall (stuck rollout) |
| `DELETE_HPA=1` | `hpa-reset.sh` | Delete HPA; two-phase reinstall (`desiredReplicas=0`) |
| `SKIP_HELM=1` | `hpa-reset.sh` | kubectl cleanup only; then run `install-hpa.sh` |
| `RUN_LOAD_TEST=1` | `hpa-reset.sh` | Run `hpa-load-test.sh` after reset |
| `RESTART_MICROK8S=0` | `cluster-recover.sh` | Skip MicroK8s restart (cleanup only) |
| `RUN_INSTALL=0` | `cluster-recover.sh` | Cleanup without reinstall |
| `MIN_REPLICAS` / `MAX_REPLICAS` | install, reset | Override HPA bounds (default 1 / 7) |
| `ROLLOUT_TIMEOUT` | install, reset | Seconds to wait for rollout (default 300) |
| `LOCAL_PORT` | install | Host port for port-forward hints (default **8080**) |

---

## Architecture

```text
┌─────────────────────────────────────────────────────────────────────────┐
│  Your VM (Brev)                                                          │
│  ┌──────────────────────┐         ┌──────────────────────────────────┐  │
│  │ NemoClaw (fork)       │         │ MicroK8s — namespace: nemoclaw    │  │
│  │ Telegram / OpenShell  │         │  agent pods: 1 CPU each (idle)    │  │
│  │ (not in this chart)   │         │  HPA min 1 … max 7 (CPU metrics)  │  │
│  └──────────┬───────────┘         └──────────────┬───────────────────┘  │
│             │ same API key                      │ metrics-server       │
└─────────────┼───────────────────────────────────┼────────────────────────┘
              │ HTTPS                               │
              ▼                                     ▼
         ┌────────────────────────────────────────────────┐
         │ NVIDIA Inference Hub (Nemotron Ultra)          │
         └────────────────────────────────────────────────┘
```

HPA scales on **CPU of agent pods** in `nemoclaw`, not on VM Telegram/OpenShell traffic.

---

## Load balancer

This chart uses a **ClusterIP** Service (`nemoclaw-nemoclaw-cpu-agent`) — **no AWS ALB/NLB** and no Ingress by default.

| Resource | Type | Role |
|----------|------|------|
| Agent Service | **ClusterIP** | In-cluster VIP; kube-proxy balances **new connections** across Ready CPU agent pods |
| `kubectl port-forward` | Local tunnel | Debug on **8080**; not production routing |
| Load-test Job | In-cluster client | Hits Service DNS → all replicas as HPA scales |

HPA changes replica count; the Service picks up new pods automatically. That is **not** the same as an external load balancer or GPU-aware routing.

**Next step (not implemented):** add **NGINX Ingress** (or AWS Load Balancer Controller on EKS) for external clients and smarter HTTP routing (least-connections, timeouts, rate limits). See [README-gpu.md — Load balancer](README-gpu.md#load-balancer) for the same pattern on GPU (including example **`g6e.12xlarge`** / 4× L40S reference node).

---

## Prerequisites

| Item | Notes |
|------|--------|
| MicroK8s or K8s 1.25+ | `microk8s status --wait-ready` |
| `helm` 3, `kubectl` | |
| Inference Hub key | `~/.nemoclaw/secrets.env` |

```bash
# ~/.nemoclaw/secrets.env
export NVIDIA_INFERENCE_HUB_API_KEY='sk-...'
```

`install-hpa.sh` enables metrics-server on MicroK8s when present. Confirm:

```bash
kubectl get apiservice v1beta1.metrics.k8s.io
# AVAILABLE should be True
```

---

## Readiness and Inference Hub

| Probe | Path | Used for |
|-------|------|----------|
| Liveness | `/healthz` | Pod restart if process dead |
| Readiness (default) | `/healthz` | Rollout success (`probes.readinessChecksInferenceHub: false`) |
| Manual check | `/readyz` | Inference Hub reachable (chat / load test) |

Install succeeds when the agent process is up. **`/readyz` can still return 503** if the API key is wrong — fix secrets and `helm upgrade`, or use:

```bash
helm upgrade nemoclaw . -n nemoclaw -f values-step2-hpa.yaml \
  --reuse-values --set inference.apiKey="${NVIDIA_INFERENCE_HUB_API_KEY}"
```

To require Hub for readiness (stricter, install may fail without valid key):

```bash
helm upgrade nemoclaw . -n nemoclaw --reuse-values \
  --set probes.readinessChecksInferenceHub=true
```

---

## Values overlays

| File | Used by | Purpose |
|------|---------|---------|
| `values-step2-hpa.yaml` | `install-hpa.sh`, `hpa-reset.sh` | Idle baseline: 1 CPU/pod, CPU % HPA, `/healthz` readiness |
| `values-step2-hpa-saturate.yaml` | `hpa-load-test.sh` | 400m CPU request/pod so up to 7 replicas fit on 8 vCPU |
| `values-step2-hpa-performance.yaml` | `install-performance-hpa.sh` | Scale on `nemoclaw_http_inflight_requests` (Prometheus) |

---

## Idle vs load test

### Idle (no traffic)

| Resource | Expected |
|----------|----------|
| Pods | **1** agent, `Running`, `READY 1/1` |
| HPA | `MINPODS 1`, `MAXPODS 7`, **`REPLICAS 1`** |
| TARGETS | `cpu: <low>%/65%` (may show `<unknown>` briefly after install) |

**No scale-up or scale-down** without workload — HPA stays at min replicas.

### Under load (`hpa-load-test.sh`)

Replicas rise toward **7** while CPU is high; after the Job ends, count drifts back to **1** over ~2–8 minutes (scale-down stabilization ~120s).

Watch (use separate commands — some kubectl versions reject `hpa,pods` together):

```bash
kubectl get hpa -n nemoclaw -w
kubectl get pods -n nemoclaw -w
kubectl top pods -n nemoclaw
less /tmp/nemoclaw-hpa-watch.log
```

---

## Troubleshooting

| Symptom | What to try |
|---------|-------------|
| `install-hpa.sh` → **rollout failed** | `./scripts/cluster-recover.sh` |
| Deployment **`0 up-to-date`**, no ReplicaSet | `./scripts/cluster-recover.sh` (restarts MicroK8s) |
| HPA **`REPLICAS 0`** / `desiredReplicas=0` | `DELETE_HPA=1 ./scripts/hpa-reset.sh` — never `kubectl scale … --replicas=0` |
| `/readyz` **503** after install | Fix `NVIDIA_INFERENCE_HUB_API_KEY`; pod can still be Running |
| Port-forward fails | Check nothing else is bound to local port **8080** |
| Load-test pods stuck `Terminating` | `./scripts/hpa-reset.sh` |
| HPA slow to scale down | Normal after load stops |
| Prometheus install timeout | Use CPU path only (`install-hpa.sh`) |

---

## Optional: Prometheus performance HPA

Scales on `nemoclaw_http_inflight_requests` instead of CPU. Requires kube-prometheus-stack + prometheus-adapter; **heavy** on small VMs.

```bash
PROM_HELM_TIMEOUT=35m ./scripts/install-performance-hpa.sh
```

See [helm/nemoclaw-cpu/observability.md](helm/nemoclaw-cpu/observability.md).

---

## Directory layout

```text
deploy/
├── README-cpu.md             ← this file
├── README-gpu.md             ← GPU deployment
└── helm/
    ├── README.md             ← CPU vs GPU comparison (models, endpoints)
    ├── nemoclaw-cpu/
    │   ├── README.md
    │   ├── values.yaml
    │   ├── values-step2-hpa.yaml
    │   ├── values-step2-hpa-saturate.yaml
    │   ├── values-step2-hpa-performance.yaml
    │   ├── scripts/
    │   │   ├── install-hpa.sh           ← start here
    │   │   ├── cluster-recover.sh       ← rollout / controller stuck
    │   │   ├── hpa-reset.sh
    │   │   ├── hpa-load-test.sh
    │   │   ├── install-performance-hpa.sh
    │   │   └── hpa-common.sh
    │   └── files/
    └── nemoclaw-gpu/
```

Cursor skill: `.cursor/skills/nemoclaw-k8s-hpa/`

---

## Uninstall

```bash
helm uninstall nemoclaw -n nemoclaw
helm uninstall prometheus-adapter kube-prometheus -n monitoring 2>/dev/null || true
kubectl delete namespace nemoclaw monitoring --ignore-not-found
```

---

## Further reading

- [README-gpu.md](README-gpu.md) — GPU + Ollama deployment
- [helm/nemoclaw-cpu/README.md](helm/nemoclaw-cpu/README.md) — chart values, manual helm, load-test tuning
- [NVIDIA Inference Hub](https://inference-api.nvidia.com)
- [Kubernetes HPA](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale-walkthrough/)
