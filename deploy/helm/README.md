# Models — CPU vs GPU charts

How the two NemoClaw Kubernetes charts differ in **which model** they use and **where inference runs**.

| | **GPU chart** ([nemoclaw-gpu](nemoclaw-gpu/)) | **CPU chart** ([nemoclaw-cpu](nemoclaw-cpu/)) |
|--|-----------------------------------------------|-----------------------------------------------|
| **Role** | **Primary** — local inference on cluster GPU | **Optional** — pre-GPU testing, no cluster GPU |
| **Default model** | `llama3.2:3b` | `nvidia/nvidia/llama-3.1-nemotron-ultra-253b-v1` |
| **Display name** | Llama 3.2 **3B** (Ollama) | **Nemotron Ultra 253B** (NVIDIA Inference Hub) |
| **Approx. size** | ~3B parameters | ~253B parameters |
| **Where weights run** | On **your pod GPU** (pulled into cluster) | In **NVIDIA cloud** (not in your cluster) |
| **Backend** | [Ollama](https://ollama.com) sidecar in pod | [NVIDIA Inference Hub](https://inference-api.nvidia.com) HTTPS API |
| **API endpoint** | `http://127.0.0.1:11434/v1` (in-pod) | `https://inference-api.nvidia.com/v1` |
| **Model ID format** | Ollama **tag** (e.g. `llama3.2:3b`, `qwen2.5:7b`) | Hub **model path** (e.g. `nvidia/nvidia/llama-3.1-nemotron-ultra-253b-v1`) |
| **Auth** | None (default) | `NVIDIA_INFERENCE_HUB_API_KEY` (`sk-*`) |
| **First-start delay** | **5–15 min** — `ollama pull` on each new pod/node | Seconds — no local pull |
| **GPU memory** | Uses **1× `nvidia.com/gpu` / pod** | None |
| **Quality / use case** | Fast, small local model; good for HPA/load demos on L40S | Large Nemotron; matches VM NemoClaw + Inference Hub setup |
| **Set in** | `nemoclaw-gpu/values.yaml` → `inference.model` | `nemoclaw-cpu/values.yaml` → `inference.model` |

Defaults are defined in each chart’s `values.yaml`:

```yaml
# nemoclaw-gpu/values.yaml
inference:
  baseUrl: "http://127.0.0.1:11434/v1"
  model: "llama3.2:3b"

# nemoclaw-cpu/values.yaml
inference:
  baseUrl: "https://inference-api.nvidia.com/v1"
  model: "nvidia/nvidia/llama-3.1-nemotron-ultra-253b-v1"
```

---

## Request path

**GPU (local Ollama)**

```text
Client → agent :8081 → Ollama :11434 → GPU
```

**CPU (remote Hub)**

```text
Client → agent :8080 → HTTPS Inference Hub → Nemotron Ultra (cloud)
```

Same agent container pattern (health, metrics, OpenAI-compatible `/v1/chat/completions`); only the **inference backend and model** change.

---

## Changing the model

Model overrides are done at install/upgrade time in each chart’s ops guide — not in this file.

| Chart | How to run & change model |
|-------|---------------------------|
| **GPU** | [../README-gpu.md](../README-gpu.md) — `INFERENCE_MODEL=… ./scripts/install-hpa.sh` or `helm upgrade … --set inference.model=…` |
| **CPU** | [../README-cpu.md](../README-cpu.md) — install, port-forward, load test, and Hub model overrides |

Hub model ids and Ollama tags are **not interchangeable** — use the chart that matches your backend.

## Why the defaults differ

| Chart | Default model choice |
|-------|----------------------|
| **GPU** | Small Ollama model (`llama3.2:3b`) so pods start quickly on a single GPU, HPA load tests stay predictable, and VRAM use is modest on demo hardware. |
| **CPU** | Nemotron Ultra via Hub so pre-GPU testing matches **NemoClaw on a VM** when configured for Inference Hub — no local weights, no GPU. |

---

## Related docs

| Doc | Content |
|-----|---------|
| [../README-gpu.md](../README-gpu.md) | **How to run GPU** — install, HPA, load test, model override |
| [../README-cpu.md](../README-cpu.md) | **How to run CPU** — install, port-forward, load test, Hub model override |
| [../README.md](../README.md) | Deploy index (GPU-first) |
| [nemoclaw-gpu/](nemoclaw-gpu/) | GPU Helm chart |
| [nemoclaw-cpu/](nemoclaw-cpu/) | CPU Helm chart |
