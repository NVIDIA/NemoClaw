---
name: nemoclaw-k8s-hpa
description: >-
  Deploy and validate NemoClaw CPU agent tier on Kubernetes with Helm, CPU-based
  HPA, metrics-server, and load tests (Inference Hub / Nemotron). Use when the user
  asks about nemoclaw-cpu Helm chart, Kubernetes autoscaling, HPA scale-up/down,
  agent pods, load testing for HPA, or K8s packaging separate from VM NemoClaw/Telegram.
---

# NemoClaw Kubernetes HPA (nemoclaw-cpu)

## Architecture (read first)

```text
Telegram / OpenShell sandbox (VM)     ≠     K8s agent pods (nemoclaw-cpu chart)
         │                                              │
         └─ Inference Hub (Nemotron Ultra) ◄────────────┘ (optional same API)
```

| Layer | Location | Scales with HPA? |
|-------|----------|------------------|
| Full NemoClaw (Telegram, OpenShell) | VM `nemoclaw onboard` | **No** |
| CPU agent pods | `deploy/helm/nemoclaw-cpu/` | **Yes** |

HPA watches **CPU % of pod CPU requests** on agent pods, not VM processes.

**Load balancing:** `ClusterIP` Service `nemoclaw-nemoclaw-cpu-agent` is the in-cluster LB. No cloud ALB required. Traffic only reaches **Ready** pods (`kubectl get endpoints`).

---

## Repo map

| Path | Purpose |
|------|---------|
| `deploy/helm/nemoclaw-cpu/` | Helm chart (agent Deployment, Service, HPA, ConfigMap) |
| `deploy/helm/nemoclaw-cpu/scripts/install-hpa.sh` | **One-command** CPU HPA (metrics-server) |
| `deploy/helm/nemoclaw-cpu/scripts/install-performance-hpa.sh` | Optional Prometheus + performance HPA |
| `deploy/helm/nemoclaw-cpu/scripts/hpa-load-test.sh` | End-to-end HPA load test |
| `deploy/helm/nemoclaw-cpu/files/load-generator.mjs` | In-cluster load Job |
| `deploy/helm/nemoclaw-cpu/files/agent-server.mjs` | `/healthz`, `/readyz`, `/bench`, `/v1/chat/completions` |
| `deploy/helm/nemoclaw-cpu/values-step2-hpa.yaml` | Enable CPU HPA |
| `deploy/helm/nemoclaw-cpu/values-step2-hpa-saturate.yaml` | HPA + **400m CPU request/pod** (fit 7 on 8 vCPU node) |
| `deploy/helm/nemoclaw-cpu/scripts/hpa-reset.sh` | Clean Jobs/HPA/pods before a new test |

---

## Prerequisites

- Kubernetes (MicroK8s OK), `helm` 3, `kubectl`
- `NVIDIA_INFERENCE_HUB_API_KEY` in `~/.nemoclaw/secrets.env` (`sk-*`)
- **metrics-server** for CPU HPA: `microk8s enable metrics-server`
- Verify: `kubectl get apiservice v1beta1.metrics.k8s.io` → `AVAILABLE True`

---

## One-command install (recommended)

CPU HPA + metrics-server (no Prometheus):

```bash
cd deploy/helm/nemoclaw-cpu
source ~/.nemoclaw/secrets.env
./scripts/install-hpa.sh
kubectl get hpa,pods -n nemoclaw -w
```

Optional Prometheus path: `./scripts/install-performance-hpa.sh`

**Do not** use placeholder `sk-YOUR-INFERENCE-HUB-KEY` — `/readyz` stays 503 and pods never become Ready.

---

## Alternate — CPU HPA only (no Prometheus)

```bash
helm upgrade --install nemoclaw . -n nemoclaw --create-namespace \
  --set namespace.create=false \
  --set inference.apiKey="${NVIDIA_INFERENCE_HUB_API_KEY}"

helm upgrade nemoclaw . -n nemoclaw --reuse-values \
  -f values-step2-hpa-saturate.yaml \
  --set inference.apiKey="${NVIDIA_INFERENCE_HUB_API_KEY}"
```

| Value | Typical |
|-------|---------|
| `autoscaling.minReplicas` | 1 |
| `autoscaling.maxReplicas` | 7 (8 vCPU node) |
| `autoscaling.targetCPUUtilizationPercentage` | 50–65 (saturate); 65 (1 CPU/pod) |
| `autoscaling.behavior.scaleDown.stabilizationWindowSeconds` | 90–120 (not 300) |
| `cpuScaling.perPodRequest` | **400m** (fit 7 pods); **1** only fits ~4–6 |

When `autoscaling.enabled=true`, Helm sets `spec.replicas` to `minReplicas` (≥1); HPA scales between min and max.

---

## Step 3 — Run HPA load test

```bash
./scripts/hpa-reset.sh      # optional: clean Jobs/HPA/pods first
./scripts/hpa-load-test.sh
```

Defaults: `TARGET_PODS=7`, `CONCURRENCY_PER_POD=40`, `/bench` with worker-thread CPU spin, **one** load Job pod (`JOB_PARALLELISM=1`).

**Watch (two terminals — `kubectl get -w` accepts only one resource type):**

```bash
watch -n 5 'kubectl get hpa,pods -n nemoclaw; kubectl top pods -n nemoclaw 2>/dev/null | grep agent'
kubectl get endpoints nemoclaw-nemoclaw-cpu-agent -n nemoclaw
```

**Success:** `REPLICAS` climbs toward 7; multiple endpoint IPs; agent pods `1/1 Ready`; `kubectl top` shows **300m+** CPU per pod under load.

**After test:**

```bash
helm upgrade nemoclaw . -n nemoclaw --reuse-values --set loadTest.cpuSpinMs=0
```

---

## Manual scale (no HPA)

```bash
helm upgrade nemoclaw . -n nemoclaw --reuse-values --set autoscaling.enabled=false --set cpuScaling.count=4
```

`cpuScaling.count=N` → N pods, each `perPodRequest` CPU (default 1).

---

## Troubleshooting (symptom → cause)

| Symptom | Likely cause |
|---------|----------------|
| Helm `namespace already exists` | Chart + `--create-namespace` both create NS → `namespace.create=false` |
| Pod `0/1`, readiness 503 | Bad Inference Hub key |
| HPA `cpu: <unknown>` | metrics-server missing or pod unready |
| Stuck at 3–4 replicas, `cpu: 99%` | **Node CPU requests full** (1 CPU/pod); use `values-step2-hpa-saturate.yaml` (400m) |
| One endpoint IP only | Only one pod Ready — fix probes / worker-thread `/bench` |
| Load Job `fetch failed` | Pods unready or overloaded; check endpoints |
| `7/8` manual scale, pod Pending | Insufficient allocatable CPU |
| HPA scale-down slow | 5 min stabilization window (by design) |

**Not caused by missing external load balancer** — Service + Endpoints handle distribution.

---

## Agent HTTP API (for load & health)

| Path | Role |
|------|------|
| `GET /healthz` | Liveness |
| `GET /readyz` | Readiness (cached Inference Hub check) |
| `POST /bench?ms=450&threads=2` | CPU load for HPA tests (worker threads) |
| `POST /v1/chat/completions` | Proxy to Inference Hub (same model as NemoClaw) |
| `GET /metrics` | Prometheus metrics |

---

## Agent building checklist

When implementing or extending a **Kubernetes HPA agent** for NemoClaw:

- [ ] Distinguish VM NemoClaw vs K8s agent tier in docs and tests
- [ ] Confirm metrics-server before HPA
- [ ] Use saturate values on single-node 8 vCPU clusters
- [ ] Keep `/healthz` responsive under load (CPU spin off main thread)
- [ ] Verify `endpoints` has multiple IPs during load test
- [ ] Size `maxReplicas` to allocatable CPU on node
- [ ] Store secrets in `~/.nemoclaw/secrets.env`, never commit keys

---

## Additional resources

- Deep dive and env vars: [reference.md](reference.md)
