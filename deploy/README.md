# NemoClaw Kubernetes deployment

**How to run the GPU deployment:** **[README-gpu.md](README-gpu.md)** — install, port-forward, HPA, load test, architecture, metrics, ports, and troubleshooting.

**Model comparison (CPU vs GPU):** table below and [helm/README.md](helm/README.md).

---

## Quick links

| | GPU (primary) | CPU (optional) |
|--|---------------|----------------|
| **How to run** | **[README-gpu.md](README-gpu.md)** | **[README-cpu.md](README-cpu.md)** |
| **Chart** | [helm/nemoclaw-gpu/](helm/nemoclaw-gpu/) | [helm/nemoclaw-cpu/](helm/nemoclaw-cpu/) |
| **Namespace** | `nemoclaw-gpu` | `nemoclaw` |
| **Port** | 8081 | 8080 | 9000
| **Default model** | **Llama 3.2 3B** — `llama3.2:3b` | **Nemotron Ultra 253B** — `nvidia/nvidia/llama-3.1-nemotron-ultra-253b-v1` |
| **Inference backend** | Local **Ollama** on pod GPU (`127.0.0.1:11434`) | Remote **NVIDIA Inference Hub** (`inference-api.nvidia.com`) |
| **Where weights run** | In cluster (1× GPU per pod) | In NVIDIA cloud (no cluster GPU) |
| **HPA signal** | GPU util % (DCGM) | CPU % |

Full model comparison (sizes, auth, overrides): [helm/README.md](helm/README.md).

Charts are fully independent (separate install scripts, Services, HPAs). Do **not** use deprecated `deploy/scripts/*-both.sh` helpers.

---

## Layout

```text
deploy/
├── README.md           ← this index
├── README-gpu.md       ← GPU install & ops (main guide)
├── README-cpu.md       ← optional pre-GPU testing
└── helm/
    ├── README.md       ← model comparison (CPU vs GPU)
    ├── nemoclaw-gpu/   ← primary chart
    └── nemoclaw-cpu/   ← optional chart
```
