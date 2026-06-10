# Observability (performance HPA)

CPU-based HPA only needs **metrics-server**. For **performance HPA** (inflight requests, latency), use **Prometheus** + **prometheus-adapter**.

| Component | CPU HPA | Performance HPA |
|-----------|---------|-----------------|
| metrics-server | Yes | Optional |
| Prometheus | No | Yes |
| prometheus-adapter | No | Yes |
| Grafana | Optional | Recommended for tuning |

## Agent metrics (`GET /metrics`)

| Metric | Use |
|--------|-----|
| `nemoclaw_http_inflight_requests` | Backpressure / queue proxy |
| `nemoclaw_http_requests_total` | Throughput |
| `nemoclaw_llm_request_duration_seconds` | LLM chat/completions latency histogram |
| `nemoclaw_llm_latency_p95_milliseconds` | Rolling p95 LLM latency (ms); use with `autoscaling.mode=latency` |
| `nemoclaw_llm_latency_p50_milliseconds` | Rolling median LLM latency (ms) |
| `nemoclaw_llm_latency_avg_milliseconds` | Rolling average LLM latency (ms) |
| `nemoclaw_llm_requests_total` | LLM proxy success/error counts |
| `nemoclaw_inference_hub_reachable` | Hub health |

Enable scraping: set `metrics.serviceMonitor.enabled: true` in Helm values (requires Prometheus Operator in cluster).

## kube-prometheus-stack (example)

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update
kubectl create namespace monitoring
helm install kube-prometheus prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  --set prometheus.prometheusSpec.serviceMonitorSelectorNilUsesHelmValues=false
```

Then upgrade the chart with `metrics.serviceMonitor.enabled: true` and install [prometheus-adapter](https://github.com/kubernetes-sigs/prometheus-adapter) with a rule for `nemoclaw_http_inflight_requests` (see `values-step2-hpa-performance.yaml` and chart README).

## Further reading

- [Kubernetes HPA walkthrough](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale-walkthrough/)
- [NVIDIA Riva autoscaling with HPA + Grafana](https://developer.nvidia.com/blog/autoscaling-nvidia-riva-deployment-with-kubernetes-for-speech-ai-in-production/) (same metrics → HPA pattern)
