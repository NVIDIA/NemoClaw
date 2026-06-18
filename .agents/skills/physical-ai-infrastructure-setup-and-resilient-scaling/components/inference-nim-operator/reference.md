# NIM Operator Inference

## Prerequisites

* Kubernetes with RWX StorageClass and configured kubectl
* helm 3.x
* If pulling from private nvcr.io registry, NGC_API_KEY
* If pulling from HuggingFace where token is required, HF_TOKEN

# Supporting files

| Path | Use | When |
|------|-----|------|
| `scripts/preflight.sh` | Run first | Checks local tools, secrets, and selected NIM directories; cluster state is verified during deploy. |
| `scripts/install.sh` | Run | Installs NIM Operator, namespace objects, secrets, PVCs, download jobs, and selected NIMServices. |
| `nims/<name>/nimservice.yaml` | Runtime config | NIMService manifest for one model; directory name must match service name and DNS prefix. |
| `nims/<name>/pvc.yaml` | Runtime config | Model-cache PVC for HF-backed services. |
| `nims/<name>/hf-download-job.yaml` | Runtime config | HF model download job used before model-free NIM startup. |

# Deployment

Provide space-separated NIM names in `NIM_SERVICES` environment variable when invoking install script.

For example:

```bash
NIM_SERVICES="qwen25-14b cosmos-predict" skills/physical-ai-infrastructure-setup-and-resilient-scaling/components/inference-nim-operator/scripts/install.sh
```

If `NIM_SERVICES` is not provided it will install all known NIMs in this skill - very likely this is wrong.

Each NIMService pins the GPUs requested by its manifest for the cluster's lifetime — set `NIM_SERVICES` to only what the pipeline calls.

Derive the set by grepping the pipeline spec for `<name>.osmo-nims.svc.cluster.local`; `<name>` matches a directory under `nims/`. `install.sh` is idempotent (spec-hash); HF-backed NIMs skip automatically when `HF_TOKEN` is absent.

During a demo, do not patch GPU Operator, device-plugin, NIMService objects,
time-slicing, or force-delete pods unless the user explicitly approves that
mutation. If GPUs are not schedulable, stop with the blocker and options.

## Capability catalog

| NIMService | Image | GPU VRAM | PVC | Capabilities | Notes |
|------------|-------|----------|-----|--------------|-------|
| qwen25-14b | model-free-nim + HF Qwen2.5-14B | ~28GB | 50Gi | `text-llm`, `chat` (OpenAI-compat `/v1/chat/completions`) | Text LLM |
| qwen3-235b | model-free-nim + HF Qwen3-235B-A22B | 8x H100 80GB | 600Gi | `text-llm`, `chat` (OpenAI-compat `/v1/chat/completions`) | Large MoE LLM, 8-way tensor parallel, fixed 32K context |
| qwen3-vl | model-free-nim + HF Qwen3-VL-30B-A3B | ~58GB | 100Gi | `vlm`, `video-qa`, `chat` | MoE VLM, CUDA graphs disabled, 128K context |
| qwen-image-edit | qwen-image-edit Visual GenAI NIM | 80GB | 120Gi | `image-edit` (OpenAI-compat `/v1/images/edits`) | Official NGC NIM, `NIM_MODEL_VERSION=qwen-image-edit-2511` |
| qwen-image-edit-nvpcb-ovsl2sl | `vllm/vllm-omni:v0.20.0` + HF `nvidia/Qwen-Image-Edit-NVPCB-OVSL2SL` | 1 GPU / 128Gi mem | 150Gi | `image-edit` (`vllm serve --omni`) | Not an official NGC NIM; uses operator `spec.command`/`spec.args` to run `vllm serve`, `HF_TOKEN` grants model access |
| cosmos-transfer | cosmos-transfer2.5-2b NIM | ~56GB | 150Gi | `video-style-transfer` | Long warmup (~20 min) |
| cosmos-reason | cosmos-reason2-8b NIM | ~16GB | 50Gi | `vlm`, `spatial-reasoning`, `video-qa` | Reasoning VLM |
| cosmos-predict | cosmos-predict1-7b NIM | ~48GB | 100Gi | `video-world-model`, `video-generation` | Requires `NIM_CACHE_PATH=/model-store/cache` override — see inline comment in `nims/cosmos-predict/nimservice.yaml`. |

PVC sizes come from `nims/<name>/{pvc,nimservice}.yaml`. Sum of selected rows is the disk footprint.

`qwen25-14b` is the directory name for the Qwen2.5-14B service. Use
`qwen25-14b.osmo-nims.svc.cluster.local`, not `qwen2.5-14b`, in pipeline specs.

Qwen Image Edit references:

- Official Visual GenAI NIM docs: https://docs.nvidia.com/nim/visual-genai/latest/getting-started.html
- Support matrix: https://docs.nvidia.com/nim/visual-genai/latest/support-matrix.html
- Hosted API model card: https://build.nvidia.com/qwen/qwen-image-edit

# Verify

```bash
kubectl get pods -n nim-operator      # controller should be Running
kubectl get crd | grep -E "nim|nemo"  # CRDs should be present
kubectl get nimservice -A             # deployed models
kubectl get pvc -n osmo-nims          # model storage PVCs
kubectl get job -n osmo-nims          # HF download jobs (should be Complete)
```

# How to add new models

- **HuggingFace model-free NIM** (`model-free-nim` image): `nims/<name>/{pvc,hf-download-job,nimservice}.yaml`. Job name must be `<name>-hf-download`. Mirror `nims/qwen25-14b/`.
- **NGC NIM** (cosmos-*): `nims/<name>/nimservice.yaml` only, `storage.pvc.create: true`.

Directory name must equal NIMService `metadata.name` — install.sh and URL→name mapping rely on it.

# Troubleshooting

| Symptom | Fix |
|---------|-----|
| `CrashLoopBackOff` | Missing secrets, re-run install.sh with NGC_API_KEY + HF_TOKEN in .env |
| NIMService Pending | GPU not schedulable; verify GPU Operator health, pick a pool with capacity, or ask before changing existing workloads |
| Image pull 403 | NGC key lacks access to this model, check key permissions |
| Profile not found | Delete stale `nim_runtime_manifest.yaml` from PVC and restart pod |
| CUDA graph OOM | Add `NIM_DISABLE_CUDA_GRAPH: "true"` to env (needed for large MoE models) |
| KV cache too small | Add `NIM_MAX_MODEL_LEN` to reduce context length, or increase PVC-backed memory |
| HF 429 rate limit | Verify HF_TOKEN is set in .env and hf-token-secret exists in namespace |
| HTTP 413 | Set `NIM_PROXY_CLIENT_MAX_BODY_SIZE=500M` on model-free-nim VLM/LLM services |
