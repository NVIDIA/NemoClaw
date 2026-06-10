# nemoclaw-cpu Helm chart

**How to run the CPU deployment:** **[../../README-cpu.md](../../README-cpu.md)** — install, port-forward, HPA, load test, and troubleshooting.

Optional pre-GPU chart: CPU agent pods proxy **[NVIDIA Inference Hub](https://inference-api.nvidia.com)** (Nemotron Ultra by default). No cluster GPU required.

| | |
|--|--|
| **Ops guide** | [../../README-cpu.md](../../README-cpu.md) |
| **Models (vs GPU)** | [../README.md](../README.md) |
| **Primary deployment** | [nemoclaw-gpu](../nemoclaw-gpu/) · [../../README-gpu.md](../../README-gpu.md) |
| **Chart path** | `deploy/helm/nemoclaw-cpu/` |
| **Install script** | `./scripts/install-hpa.sh` |
| **Default model** | `inference.model` in `values.yaml` → Nemotron Ultra 253B on Inference Hub |

For Helm values, templates, and advanced overlays, see sections in [README-cpu.md](../../README-cpu.md) and files under this directory (`values.yaml`, `values-step2-hpa.yaml`, `templates/`).
