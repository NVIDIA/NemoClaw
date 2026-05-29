# NemoClaw K8s HPA — Reference

## HPA math (CPU resource metric)

- Target: `averageUtilization` = % of **CPU request** (not limit).
- Example: request `1` CPU, target `35%` → HPA wants ~350m average per pod.
- With `perPodRequest: 400m` and target `30%` → ~120m average triggers scale-up.

Desired replicas (simplified):

```text
desired = ceil(currentReplicas × (currentCPU% / targetCPU%))
```

Scale-up stabilization: **0s**. Scale-down: **120s** (chart default).

## 8 vCPU node capacity (example)

| Config | 7 pods schedulable? |
|--------|---------------------|
| `perPodRequest: 1` | Usually **no** (~7 + system > 8) |
| `perPodRequest: 400m` | **Often yes** (~2.8 + ~1.5 system) |

Check: `kubectl describe node | grep -A6 "Allocated resources"`

## Load generator env vars

Used by `scripts/hpa-load-test.sh` → Job `nemoclaw-hpa-load-test`:

| Variable | Default | Meaning |
|----------|---------|---------|
| `TARGET_PODS` | 7 | HPA max / load target |
| `CONCURRENCY_PER_POD` | 40 | In-flight requests per pod (via Service) |
| `BENCH_MS` | 450 | CPU spin per `/bench` |
| `BENCH_THREADS` | 2 | Worker threads per bench (agent) |
| `JOB_PARALLELISM` | 1 | Load Job pods (default: one generator) |
| `DURATION_SEC` | 720 | Test duration |
| `RAMP_SEC` | 90 | Ramp to full concurrency |
| `HPA_TARGET_CPU` | 30 | Helm HPA target % |
| `SCALE_UP_TARGET` | 7 | Script success threshold |

Heavier run:

```bash
CONCURRENCY_PER_POD=55 BENCH_MS=500 JOB_PARALLELISM=3 HPA_TARGET_CPU=25 \
  ./scripts/hpa-load-test.sh
```

## Helm values quick reference

```yaml
# Manual scale
cpuScaling:
  oneReplicaPerCpu: true
  count: 4
  perPodRequest: "1"

# HPA
autoscaling:
  enabled: true
  minReplicas: 1
  maxReplicas: 7
  targetCPUUtilizationPercentage: 30

# Load test CPU on agent
loadTest:
  cpuSpinMs: 450
```

## Inference: VM vs K8s

| | VM NemoClaw | K8s agent pod |
|--|-------------|---------------|
| Telegram | Yes | No |
| Config | `~/.nemoclaw/`, openclaw.json | Helm values + Secret |
| Model | Nemotron Ultra via Inference Hub | Same via proxy |
| Scales with HPA | No | Yes |

## Performance HPA (Step 2b, optional)

Requires Prometheus + prometheus-adapter. Custom metric: `nemoclaw_http_inflight_requests` from `/metrics`. See `values-step2-hpa-performance.yaml` and `deploy/helm/nemoclaw-cpu/observability.md`.

## Reset + load test scripts

| Script | Purpose |
|--------|---------|
| `scripts/hpa-reset.sh` | Delete Jobs/HPA/stuck pods; reinstall baseline (min 1 replica) |
| `scripts/hpa-load-test.sh` | Run load Job; wait for scale-up/down |
| `scripts/hpa-common.sh` | Shared helpers (never scale to 0) |

## Git / fork notes

- Fork branch work: Inference Hub, Tavily, Telegram fixes live on VM sandbox path.
- `deploy/helm/nemoclaw-cpu/` may be uncommitted — commit when stabilizing HPA agent.

## Riva HPA pattern (prior art)

NVIDIA blog: autoscaling Riva with K8s HPA + Grafana — same pattern (metrics → HPA → dashboards). CPU HPA is Step 2a; queue/latency metrics are Step 2b.
