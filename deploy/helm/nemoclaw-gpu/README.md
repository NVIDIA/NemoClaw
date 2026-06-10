# nemoclaw-gpu Helm chart

**How to run the GPU deployment:** **[../../README-gpu.md](../../README-gpu.md)** — install, port-forward, HPA, load test, architecture, metrics, and troubleshooting.

Primary NemoClaw Kubernetes chart: **Ollama on one GPU per pod** + Node.js agent (health, metrics, OpenAI-compatible API). Namespace `nemoclaw-gpu`, agent port **8081**.

| | |
|--|--|
| **Ops guide** | [../../README-gpu.md](../../README-gpu.md) |
| **Models (vs CPU)** | [../README.md](../README.md) |
| **Deploy index** | [../../README.md](../../README.md) |
| **Optional CPU chart** | [nemoclaw-cpu](../nemoclaw-cpu/) · [../../README-cpu.md](../../README-cpu.md) |
| **Chart path** | `deploy/helm/nemoclaw-gpu/` |
| **Install script** | `./scripts/install-hpa.sh` |
| **Watch HPA** | `kubectl get hpa -n nemoclaw-gpu -w` |
| **Per-pod GPU %** | `./scripts/get-agent-pods.sh -n nemoclaw-gpu -w` |
| **Default model** | `inference.model` in `values.yaml` → `llama3.2:3b` (Ollama) |

For Helm values, overlays (`values-step2-hpa.yaml`, latency/performance variants), and templates, see [README-gpu.md](../../README-gpu.md) and files under this directory.
