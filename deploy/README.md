# NemoClaw Kubernetes deployment (GPU)

**How to run the GPU deployment:** **[README-gpu.md](README-gpu.md)** — install, port-forward, HPA, load test, architecture, metrics, ports, and troubleshooting.

**Model comparison (CPU vs GPU):** [helm/README.md](helm/README.md)

---

## Quick links

| | GPU (primary) | CPU (optional) |
|--|---------------|----------------|
| **How to run** | **[README-gpu.md](README-gpu.md)** | **[README-cpu.md](README-cpu.md)** |
| **Chart** | [helm/nemoclaw-gpu/](helm/nemoclaw-gpu/) | [helm/nemoclaw-cpu/](helm/nemoclaw-cpu/) |
| **Namespace** | `nemoclaw-gpu` | `nemoclaw` |
| **Port** | 8081 | 8080 |
| **HPA signal** | GPU util % (DCGM) | CPU % |

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
