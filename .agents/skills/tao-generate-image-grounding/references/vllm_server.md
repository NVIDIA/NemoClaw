# vLLM Server Setup for Vision-Language Models

This guide walks the user through standing up a self-hosted [vLLM](https://github.com/vllm-project/vllm) server that exposes an OpenAI-compatible `/v1/chat/completions` endpoint for vision-language models (VLMs). Once the server is running, point the pipeline at it with `vlm.backend: "openai"` and the matching `base_url` / `model_name` / `api_key` values.

## 1. Prerequisites

- NVIDIA GPU(s) with enough VRAM for the chosen VLM (≥24 GB for 7-8B-class models, ≥80 GB for 32B+ models; tensor-parallel across multiple GPUs is supported via `--tensor-parallel-size`).
- A recent NVIDIA driver and `nvidia-container-toolkit` (for the recommended Docker path).
- Docker (recommended). Python ≥ 3.10 is only needed for the optional host install path.
- For gated HuggingFace repos: a `HF_TOKEN` with access to the model.

## 2. Install vLLM

**Default: Docker (Option A).** Use it unless you have a specific reason to install on the host — Docker pins a known-good CUDA/PyTorch/vLLM combination and avoids local environment drift. The `pip` path (Option B) is provided for advanced users who need to patch vLLM, debug locally, or run on a system where Docker is not available.

### Option A — Docker (default, recommended)

```bash
docker pull vllm/vllm-openai:latest
```

### Option B — `pip` (host install, advanced)

```bash
pip install --upgrade "vllm>=0.7.0"
```

## 3. Pick a VLM checkpoint

vLLM supports many vision models; the pipelines just need an OpenAI-compatible chat-completions endpoint that accepts image inputs. Common picks:

| Model | HuggingFace repo | Notes |
|-------|------------------|-------|
| Qwen3-VL-8B-Instruct | `Qwen/Qwen3-VL-8B-Instruct` | Newer Qwen3 family |
| Qwen3-VL-235B-A22B-Instruct | `Qwen/Qwen3-VL-235B-A22B-Instruct` | MoE; requires serious hardware |

If the chosen repo is gated, accept its license on the HuggingFace web UI first, then `export HF_TOKEN=<your_token>` before launching.

## 4. Launch the server

Use the launcher that matches the install path. Both commands listen on `0.0.0.0:8000` and serve an OpenAI-compatible API at `/v1`. **Prefer Option A (Docker)** unless you installed via `pip` in Section 2.

### Option A — Docker (default, recommended)

```bash
docker run --runtime nvidia --gpus all \
    -p 8000:8000 \
    -e HF_TOKEN=<your_hf_token> \
    -v ~/.cache/huggingface:/root/.cache/huggingface \
    vllm/vllm-openai:latest \
    --model Qwen/Qwen3-VL-8B-Instruct \
    --served-model-name Qwen/Qwen3-VL-8B-Instruct \
    --tensor-parallel-size 1 \
    --gpu-memory-utilization 0.9 \
    --media-io-kwargs '{"video": {"num_frames": -1, "fps": -1}}'
```

### Option B — `pip` install (host launch, advanced)

```bash
export HF_TOKEN=<your_hf_token>          # only required for gated models

vllm serve Qwen/Qwen3-VL-8B-Instruct \
    --host 0.0.0.0 \
    --port 8000 \
    --dtype bfloat16 \
    --served-model-name Qwen/Qwen3-VL-8B-Instruct \
    --tensor-parallel-size 1 \
    --max-model-len 32768 \
    --gpu-memory-utilization 0.9 \
    --media-io-kwargs '{"video": {"num_frames": -1, "fps": -1}}'
```

Key flags:

- `--served-model-name <NAME>` — value to use later for `vlm.openai.model_name`. Defaults to the full HF repo path if omitted.
- `--tensor-parallel-size <N>` — number of GPUs to shard the model across.
- `--max-model-len <N>` — context window; image tokens count against this, so leave headroom for multi-image prompts.
- `--limit-mm-per-prompt image=<N>` — max images per request. Bump it if a prompt sends multiple images.
- `--gpu-memory-utilization <0..1>` — lower (e.g. `0.85`) if you hit OOM at load time.

The first launch downloads weights to `~/.cache/huggingface`; expect several minutes for 7B+ models.

## 5. Verify the endpoint

Wait for the log line `Uvicorn running on http://0.0.0.0:8000`, then sanity-check the server.

List served models:

```bash
curl http://localhost:8000/v1/models
```

Send a minimal vision request:

```bash
curl http://localhost:8000/v1/chat/completions \
    -H "Content-Type: application/json" \
    -d '{
        "model": "Qwen3-VL-8B-Instruct",
        "messages": [{
            "role": "user",
            "content": [
                {"type": "image_url", "image_url": {"url": "https://upload.wikimedia.org/wikipedia/commons/thumb/3/3a/Cat03.jpg/640px-Cat03.jpg"}},
                {"type": "text", "text": "Describe this image in one sentence."}
            ]
        }],
        "max_tokens": 128
    }'
```

A non-empty `choices[0].message.content` in the response confirms the server is ready.

## 6. Wire the server into the pipeline

Once verified, collect these three values from the running server and pass them to the pipeline spec:

- `base_url` — e.g. `http://localhost:8000/v1` (no `/chat/completions` suffix). If vLLM runs on another host, use `http://<host_or_ip>:8000/v1` and make sure the port is reachable.
- `model_name` — must match `--served-model-name` exactly.
- `api_key` — vLLM ignores it but the OpenAI SDK requires a non-null string; use `"EMPTY"` if no auth is configured.

YAML snippet:

```yaml
vlm:
  backend: "openai"
  openai:
    base_url: "http://localhost:8000/v1"
    model_name: "Qwen3-VL-8B-Instruct"
    api_key: "EMPTY"
    temperature: 0.3
    max_tokens: 4096
    timeout: 300
```

## Common issues

| Symptom | Fix |
|---------|-----|
| `CUDA out of memory` on startup | Lower `--max-model-len`, drop `--gpu-memory-utilization` (e.g. `0.85`), pick a smaller model, or raise `--tensor-parallel-size` to spread across more GPUs |
| `Model architectures ['…'] are not supported` | Upgrade vLLM (`pip install -U vllm`) or use a newer Docker tag — VLM support changes per release |
| 401 / 403 during HuggingFace download | Set `HF_TOKEN` in the launch env and accept the model's license on the HuggingFace web UI |
| First request hangs for minutes | The model is still warming up — wait for the `Uvicorn running` log line and a successful `GET /v1/models` |
| `image is too large` / token overflow | Pre-resize images before sending, or raise `--max-model-len` |
| Empty / truncated responses | Raise `vlm.openai.max_tokens` in the pipeline spec; lower `temperature` for more deterministic output |
