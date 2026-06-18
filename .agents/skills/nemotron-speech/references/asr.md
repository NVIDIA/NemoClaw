# Riva ASR NIM

> **Agent:** When walking the user through a multi-step workflow, announce each step before presenting it: **Step N/M — Step Title** (e.g., "**Step 1/4 — Set Model Variables**").
>
> **Source of truth.** This skill describes deployment mechanics, which are stable across releases. For anything that varies per release — model catalog, container IDs, function IDs, feature support per model, VRAM minimums, performance numbers — **fetch or open the canonical doc page and answer from that, not from this skill's text.** See [Looking up current information](#looking-up-current-information) below.

---

## Purpose

Deploy and run NVIDIA Riva ASR (speech-to-text) NIMs. Supports cloud-hosted inference via build.nvidia.com (no GPU required) and self-hosted deployment on your own GPU using Docker. Covers streaming and offline transcription.

## Looking up current information

This skill is **orientation, not catalog**. When a question depends on data that changes per release, fetch or open the relevant page and answer from that page:

| Question type | Fetch this page |
|---|---|
| Current models, container IDs, `NIM_TAGS_SELECTOR` profiles, VRAM minimums, supported GPUs | https://docs.nvidia.com/nim/speech/latest/reference/support-matrix/asr.html |
| Function IDs for cloud (build.nvidia.com) inference | `https://api.nvcf.nvidia.com/v2/nvcf/functions` (auth with `NVIDIA_API_KEY`; filter by `name` and `status=="ACTIVE"`). For human browsing only: `https://build.nvidia.com/<org>/<model>/api` (JS-rendered, not suitable for non-browser fetch tools). |
| **Runtime feature support per model** — word/token/phrase boosting, ITN / verbatim, profanity filter, force_eou, speaker diarization, word timestamps, `--show-intermediate`, `--stop_history`, `is_final`, `runtime_config` keys, `custom_configuration` keys | https://docs.nvidia.com/nim/speech/latest/asr/customization/customization.html |
| **gRPC proto contract** — `StreamingRecognizeRequest`, `runtime_config` map, `RecognitionConfig`, response shapes | https://docs.nvidia.com/nim/speech/latest/reference/api-references/asr/protos.html |
| **Realtime WebSocket API** — OpenAI-realtime-compatible sessions, AudioCodes telephony | https://docs.nvidia.com/nim/speech/latest/reference/api-references/asr/realtime-asr.html |
| Build-time pipeline configuration (`riva-build` flags, VAD, decoder, language model) | https://docs.nvidia.com/nim/speech/latest/asr/customization/pipeline-configuration.html |
| GPU / VRAM / driver minimums, OS prerequisites | https://docs.nvidia.com/nim/speech/latest/get-started/prerequisites.html |
| Latency / throughput benchmarks per model and GPU | https://docs.nvidia.com/nim/speech/latest/reference/performances/asr/performance.html |

**Do not infer from this skill's text:** which models exist, which features they support, what `NIM_TAGS_SELECTOR` values are valid, which gRPC fields the server honors, or what VRAM is required. The docs are the contract.

> **Naming caveat.** The same model can appear under different slugs across NVIDIA's catalogs: support-matrix label (e.g., "Parakeet 1.1b CTC English"), `CONTAINER_ID` (`parakeet-1-1b-ctc-en-us`), NVCF function name (`ai-parakeet-ctc-1_1b-asr`), and build.nvidia.com URL slug (`parakeet-ctc-1-1b-en-us`). Do not assume they match — cross-reference each from its own catalog. The NVCF Functions API is the only catalog you can hit programmatically; use it to resolve function-ids at runtime rather than hardcoding.

---

## Workflow

Choose **Option A** (cloud) for quick testing without a GPU, or **Option B** (self-hosted) for production. Self-hosted follows a 4-step process: set model variables → run container → verify health → run inference.

## Protocol Selection

| Deployment | How to choose the client protocol |
|---|---|
| Cloud-hosted NVCF / build.nvidia.com | Try gRPC first using the model's NVCF function ID. If gRPC is not exposed or fails for that cloud NIM, switch to the HTTP endpoint shown on the model's build.nvidia.com page. Do not assume every cloud NIM exposes every protocol. |
| Self-deployed / self-hosted NIM | Both gRPC and HTTP server surfaces are exposed by the deployed NIM. For streaming ASR, use gRPC or WebSocket. For offline / full-file ASR, use gRPC or HTTP. |

**Important:** The cloud fallback rule is only for cloud-hosted NVCF endpoints. For self-deployed NIMs, the expected port pattern is gRPC on `:50051` and HTTP/WebSocket on `:9000` unless the deployment explicitly remapped ports.

## Prerequisites

- Complete [`setup.md`](setup.md) before self-hosted deployment: NVIDIA Container Toolkit, `NGC_API_KEY` exported, Docker logged in to `nvcr.io`
- Cloud-hosted inference: `pip install -U nvidia-riva-client` and a valid `NVIDIA_API_KEY`
- Not sure which model to use? Run [`model-selection.md`](model-selection.md) first

## Instructions

For **cloud inference**: install `nvidia-riva-client`, set `NVIDIA_API_KEY`, and fetch the model's function ID from its build.nvidia.com API page. Try the gRPC recipe first against `grpc.nvcf.nvidia.com:443` with `--use-ssl`. If that cloud NIM does not expose gRPC or the gRPC call fails because the endpoint is unavailable, switch to the HTTP endpoint shown on the current build.nvidia.com page for that model.

For **self-hosted**: fetch the current `CONTAINER_ID` and `NIM_TAGS_SELECTOR` from the support matrix, mount a container-writable model cache directory, then follow Steps 1–4 in Option B below.

For **runtime feature questions** (word boosting, force_eou, ITN, diarization, etc.): fetch or open the customization page from the routing table above before answering — feature support is per-model and changes per release.

## Option A — Cloud-Hosted Inference (build.nvidia.com)

**Setup:** `pip install -U nvidia-riva-client`, then clone https://github.com/nvidia-riva/python-clients and `cd` into it.

**Auth:** Set `NVIDIA_API_KEY` — either a build.nvidia.com personal key, or an NGC personal key with the **Cloud Functions** scope enabled (the same NGC key you use for `docker login nvcr.io`). Most users export the same value to both `NVIDIA_API_KEY` and `NGC_API_KEY`.

**Server:** For cloud-hosted NVCF, start with `grpc.nvcf.nvidia.com:443` and always pass `--use-ssl`. If gRPC is not exposed for that cloud NIM, switch to the HTTP endpoint shown on the model's current build.nvidia.com page.

**Function ID lookup (JSON, scriptable, no hardcoding):**

```bash
curl -fsS -H "Authorization: Bearer $NVIDIA_API_KEY" \
  "https://api.nvcf.nvidia.com/v2/nvcf/functions?visibility=public,authorized" \
  | python3 -c "
import sys, json, re
pat = re.compile(r'parakeet|canary|whisper|nemotron-asr', re.I)
for f in json.load(sys.stdin).get('functions', []):
    if f.get('status') == 'ACTIVE' and pat.search(f.get('name','')):
        print(f['id'], f['name'])
"
```

Pick the `id` of the function whose `name` matches your model.

Function IDs and `versionId` rotate per release — never hardcode them; always resolve fresh via this API.

For interactive browsing only: `https://build.nvidia.com/<org>/<model>/api`. That page is JS-rendered and not suitable for non-browser fetch tools.

**Streaming-vs-offline classification per model is on the support matrix** (cited in the routing table above). Use `transcribe_file.py` for streaming, `transcribe_file_offline.py` for offline-only models.

**Canonical command (streaming model):**

```bash
python python-clients/scripts/asr/transcribe_file.py \
    --server grpc.nvcf.nvidia.com:443 --use-ssl \
    --metadata function-id "<FUNCTION_ID>" \
    --metadata "authorization" "Bearer $NVIDIA_API_KEY" \
    --language-code <LANG_CODE> \
    --input-file /path/to/audio.wav
```

**Note:** Both cloud and self-hosted scripts use `--input-file`, not `--audio-file`.

---

## Option B — Self-Hosted ASR NIM Deployment

For ASR self-hosting, use the ASR support matrix to choose the streaming/offline profile, model selector, and current VRAM target before Step 1.

## Step 1 — Set Model Variables

Get the current `CONTAINER_ID` and `NIM_TAGS_SELECTOR` values from the ASR support matrix. The matrix lists all models, modes (streaming / offline), VRAM, and deployment profiles in one place.

```bash
export CONTAINER_ID=<container-id-from-support-matrix>
export NIM_TAGS_SELECTOR="<selector-from-support-matrix>"
```

`NIM_TAGS_SELECTOR` pattern: `name=<model-name>,mode=<str|offline|all>[,model_type=<prebuilt|rmir>]`

**Prebuilt vs RMIR:** The NIM auto-detects your GPU on startup. For well-known GPUs the NIM pulls a prebuilt model repo (TensorRT engines pre-compiled for that GPU). For unsupported GPUs it falls back to RMIR (Riva Model Intermediate Representation), which is compiled into TensorRT engines on first run (slower startup, same runtime performance). You rarely need to set `model_type` explicitly — omit it and the NIM picks the right one. The set of "well-known GPUs" changes per release; check the support matrix.

## Step 2 — Run the Container

```bash
export LOCAL_NIM_CACHE=~/.cache/nim
mkdir -p $LOCAL_NIM_CACHE && sudo chown 1000:1000 $LOCAL_NIM_CACHE

docker run -it --rm --name=$CONTAINER_ID \
  --runtime=nvidia \
  --gpus '"device=0"' \
  --shm-size=8GB \
  -e NGC_API_KEY \
  -e NIM_TAGS_SELECTOR \
  -e NIM_HTTP_API_PORT=9000 \
  -e NIM_GRPC_API_PORT=50051 \
  -p 9000:9000 \
  -p 50051:50051 \
  -v $LOCAL_NIM_CACHE:/opt/nim/.cache \
  nvcr.io/nim/nvidia/$CONTAINER_ID:latest
```

Omit `-v $LOCAL_NIM_CACHE:/opt/nim/.cache` to skip caching (re-downloads model on every run).

> **Security note:** `NGC_API_KEY` passed via `-e NGC_API_KEY` inherits from the shell environment. For production, use Docker secrets or a secrets manager instead of env vars; avoid storing API keys in shell history or plaintext config files.

### RMIR Model (Export + Re-run Pattern)

```bash
export NIM_EXPORT_PATH=~/nim_export
mkdir -p $NIM_EXPORT_PATH && sudo chown 1000:1000 $NIM_EXPORT_PATH
export NIM_TAGS_SELECTOR="name=<model-name>,mode=<str|offline>,model_type=rmir"

```

See [setup.md → Cache directory ownership](setup.md#cache-directory-ownership) for the `chown 1000:1000` rationale.

```bash

# Step 1: Export
docker run -it --rm --name=$CONTAINER_ID \
  --runtime=nvidia --gpus '"device=0"' --shm-size=8GB \
  -e NGC_API_KEY -e NIM_TAGS_SELECTOR \
  -e NIM_HTTP_API_PORT=9000 -e NIM_GRPC_API_PORT=50051 \
  -p 9000:9000 -p 50051:50051 \
  -v $NIM_EXPORT_PATH:/opt/nim/export \
  -e NIM_EXPORT_PATH=/opt/nim/export \
  nvcr.io/nim/nvidia/$CONTAINER_ID:latest

# Step 2: Run from export
docker run -it --rm --name=$CONTAINER_ID \
  --runtime=nvidia --gpus '"device=0"' --shm-size=8GB \
  -e NGC_API_KEY -e NIM_TAGS_SELECTOR \
  -e NIM_DISABLE_MODEL_DOWNLOAD=true \
  -e NIM_HTTP_API_PORT=9000 -e NIM_GRPC_API_PORT=50051 \
  -p 9000:9000 -p 50051:50051 \
  -v $NIM_EXPORT_PATH:/opt/nim/export \
  -e NIM_EXPORT_PATH=/opt/nim/export \
  nvcr.io/nim/nvidia/$CONTAINER_ID:latest
```

## Step 3 — Verify Readiness

If you started the container yourself, the HTTP probe is enough:

```bash
curl -fsS http://localhost:9000/v1/health/ready    # expect {"status":"ready"}
```

If a container was already running when you arrived (shared dev box, mystery process), the HTTP check is not sufficient — a host-mapped gRPC port can route to a container with **nothing bound inside**, and connections silently drop mid-RPC. Confirm an ASR model is actually being served with this inline probe (needs only `pip install nvidia-riva-client`):

```bash
python3 - <<'PY'
import sys, riva.client
from riva.client.proto.riva_asr_pb2 import RivaSpeechRecognitionConfigRequest
auth = riva.client.Auth(uri="0.0.0.0:50051")
try:
    cfg = riva.client.ASRService(auth).stub.GetRivaSpeechRecognitionConfig(
        RivaSpeechRecognitionConfigRequest(), metadata=auth.get_auth_metadata())
except Exception as e:
    print(f"UNHEALTHY: {e}"); sys.exit(2)
models = [m.model_name for m in cfg.model_config]
if not models:
    print("UNHEALTHY: server responded but exposes no ASR models"); sys.exit(2)
print(f"OK: {len(models)} model(s)")
for m in models: print(" -", m)
PY
```

An empty model list or `UNAVAILABLE: Socket closed` means the server is not actually running ASR — restart the NIM rather than continuing.

## Step 4 — Run Inference

### Quick path — inline (no separate scripts, no upstream coupling)

This recipe uses only the `nvidia-riva-client` pip package — no `python-clients` clone, no `docker exec`, no vendored scripts. It travels with this SKILL.md, so any update to the skill includes the latest recipe.

**Cloud — discover function-id, then transcribe (streaming; works for Parakeet and most cloud ASR):**

```bash
FID=$(curl -fsS -H "Authorization: Bearer $NVIDIA_API_KEY" \
  "https://api.nvcf.nvidia.com/v2/nvcf/functions?visibility=public,authorized" \
  | python3 -c "
import sys, json
for f in json.load(sys.stdin).get('functions', []):
    if f.get('status') == 'ACTIVE' and f.get('name','').removeprefix('ai-') == 'parakeet-ctc-1_1b-asr':
        print(f['id']); break
")

AUDIO=audio.wav SERVER=grpc.nvcf.nvidia.com:443 FID=$FID python3 - <<'PY'
import os, sys, wave, riva.client
audio, server = os.environ["AUDIO"], os.environ["SERVER"]
is_cloud = "nvcf" in server
md = None
if is_cloud:
    md = [["function-id", os.environ["FID"]],
          ["authorization", f"Bearer {os.environ['NVIDIA_API_KEY']}"]]
auth = riva.client.Auth(uri=server, use_ssl=is_cloud, metadata_args=md)
asr = riva.client.ASRService(auth)

# Riva ASR accepts WAV (16-bit PCM, mono) and Opus (mono). Sample rate is flexible
# per model. Stereo is NOT supported — convert with `ffmpeg -i in.wav -ac 1 out.wav`.
ext = audio.lower().rsplit(".", 1)[-1]
if ext == "wav":
    with wave.open(audio, "rb") as w:
        sr, ch, sw = w.getframerate(), w.getnchannels(), w.getsampwidth()
        pcm = w.readframes(w.getnframes())
    if ch != 1: sys.exit("Riva ASR is mono-only; convert with `ffmpeg -i in.wav -ac 1 out.wav`")
    if sw != 2: sys.exit("WAV must be 16-bit PCM; `ffmpeg -i in.wav -acodec pcm_s16le out.wav`")
    encoding, payload, sample_rate = riva.client.AudioEncoding.LINEAR_PCM, pcm, sr
elif ext in ("opus", "ogg"):
    encoding, payload, sample_rate = riva.client.AudioEncoding.OGGOPUS, open(audio, "rb").read(), 0
else:
    sys.exit(f"Unsupported .{ext} — Riva ASR accepts WAV (mono, 16-bit PCM) or Opus")

cfg = riva.client.RecognitionConfig(
    language_code="en-US", sample_rate_hertz=sample_rate, audio_channel_count=1,
    encoding=encoding, enable_automatic_punctuation=True, max_alternatives=1)
scfg = riva.client.StreamingRecognitionConfig(config=cfg, interim_results=False)
chunk_size = sample_rate * 2 if encoding == riva.client.AudioEncoding.LINEAR_PCM else 8192
chunks = (payload[i:i+chunk_size] for i in range(0, len(payload), chunk_size))
for resp in asr.streaming_response_generator(audio_chunks=chunks, streaming_config=scfg):
    for r in resp.results:
        if r.is_final and r.alternatives:
            print(r.alternatives[0].transcript)
PY
```

**Self-hosted:** drop `FID=...` and set `SERVER=0.0.0.0:50051` — the heredoc auto-skips the cloud metadata.

**Offline-only models** (e.g. Canary): replace the streaming block with `print(asr.offline_recognize(payload, cfg).results[0].alternatives[0].transcript)`.

### Alternative — upstream `python-clients` CLI

`https://github.com/nvidia-riva/python-clients` ships canonical `transcribe_file.py`, `transcribe_file_offline.py`, `transcribe_mic.py`, etc. Useful for richer CLI flags or interactive exploration:

```bash
PY_CLIENTS=~/.cache/riva-skills/python-clients
[ -d "$PY_CLIENTS" ] || git clone --depth 1 https://github.com/nvidia-riva/python-clients "$PY_CLIENTS"

python3 "$PY_CLIENTS/scripts/asr/transcribe_file.py" \
  --server grpc.nvcf.nvidia.com:443 --use-ssl \
  --metadata function-id "$FID" \
  --metadata authorization "Bearer $NVIDIA_API_KEY" \
  --language-code en-US \
  --input-file audio.wav
```

> **Note.** `python-clients` tags are stale (last tag is `r2.19.0` while pip ships much newer) — always use `main`, which `git clone --depth 1` pulls by default. If `main` briefly outpaces your installed `nvidia-riva-client` and a script fails with `ImportError`, fall back to the inline Quick path above (it depends only on the pip package).

### Streaming ASR (Python — gRPC)

```bash
python3 python-clients/scripts/asr/transcribe_file.py \
  --server 0.0.0.0:50051 \
  --input-file /path/to/audio.wav \
  --language-code en-US
```

For real-time microphone streaming:

```bash
python3 python-clients/scripts/asr/transcribe_mic.py \
  --server 0.0.0.0:50051
```

### Streaming ASR (Python — WebSocket / Realtime)

Use this for self-deployed NIMs when the HTTP/WebSocket port is exposed. The client initializes a transcription session over HTTP, then streams audio over `ws://<server>:9000/v1/realtime?intent=transcription`.

```bash
python3 python-clients/scripts/asr/realtime_asr_client.py \
  --server 0.0.0.0:9000 \
  --input-file /path/to/audio.wav \
  --language-code en-US \
  --model-name <streaming-model-name> \
  --automatic-punctuation \
  --output-text transcript.txt
```

### Offline Transcription (Python — gRPC)

```bash
python3 python-clients/scripts/asr/transcribe_file_offline.py \
  --server 0.0.0.0:50051 \
  --input-file /path/to/audio.wav \
  --language-code en-US
```

### Offline Transcription (HTTP API)

Use the HTTP API for self-deployed NIM full-file transcription. Upload the whole audio file as multipart form data and receive the final text response.

```bash
curl -sS --fail-with-body http://localhost:9000/v1/audio/transcriptions \
  -F "file=@/path/to/audio.wav" \
  -F "language=en-US"
```

Some ASR NIMs infer the model from the deployed model repository. If passing `-F model=<model-name>` returns `400 bad model`, retry without the `model` field.

### C++ Client

```bash
cd cpp-clients
bazel build //riva/clients/asr:riva_asr_client
./bazel-bin/riva/clients/asr/riva_asr_client \
  --server=0.0.0.0:50051 \
  --audio-file=/path/to/audio.wav
```

### WebSocket / Realtime API

For OpenAI-realtime-compatible WebSocket sessions and AudioCodes telephony bridges, the Realtime WebSocket API has its own request / response shape and `custom_configuration` keys. Fetch the realtime API reference cited in the routing table above for current event names, payload schemas, and supported keys. For ordinary file-based smoke tests on self-deployed NIMs, prefer `python-clients/scripts/asr/realtime_asr_client.py` as shown above.

## Port Reference

| Port | Protocol | Use |
|------|----------|-----|
| 9000 | HTTP / WebSocket | REST API, WebSocket realtime API, health check |
| 50051 | gRPC | Python / C++ client inference |

---

## Customization (runtime features)

This skill **does not list** which features each model supports — that data goes stale within releases. **Always fetch or open https://docs.nvidia.com/nim/speech/latest/asr/customization/customization.html** for the current per-model support matrix and example flags before recommending a feature.

The customization page covers (non-exhaustive — verify on the page itself):

- Word / token / phrase boosting (per-decoder score ranges)
- Inverse text normalization (`--no-verbatim-transcripts`)
- Profanity filter (`--profanity-filter`)
- Speaker diarization (`--speaker-diarization`)
- Word timestamps (`--word-time-offsets`)
- End-of-utterance tuning (`--stop_history`) and client-driven force EOU (`runtime_config["force_eou"] = "true"`)
- Streaming response handling (`is_final`, partial vs final transcripts, `--show-intermediate`)
- `RecognitionConfig.custom_configuration` keys

For the proto-level contract (request fields, response fields, `runtime_config` map semantics), fetch the proto reference cited in the routing table.

**Common shape — runtime customization through `transcribe_file.py`:**

```bash
python3 python-clients/scripts/asr/transcribe_file.py \
  --server 0.0.0.0:50051 \
  --input-file audio.wav \
  --language-code en-US \
  <feature-flags>
```

Flag names and per-model compatibility live on the customization page — verify before recommending a flag for a specific model.

---

## Performance Benchmarking (Self-Hosted)

> **Scope.** `docker exec`-ing into a NIM container is an **appliance leak** and is not recommended for app-side inference — use the inline Quick path or the upstream `transcribe_file.py` in Step 4 instead. The exec pattern here is acceptable **only** for benchmarking, because the official benchmark client (`riva_streaming_asr_client`) is a C++ binary that ships in PATH inside the NIM and matches the deployment exactly.

Use `riva_streaming_asr_client` — a **pre-built binary available in PATH inside the NIM container**. Run it via `docker exec`. A sample LibriSpeech wav file is bundled at `/opt/riva/examples/asr_lib/1272-135031-0000.wav` inside the container.

For published latency / throughput targets per model and GPU, fetch the performance page cited in the routing table.

### Streaming Models

Run at increasing concurrency levels (1, 2, 4, 8, …). Set `num_iterations` to 3× `num_parallel_requests` for stable results.

**Chunk-size caveat:** Client chunk flags such as `--chunk_duration_ms` or Python-client
`--file-streaming-chunk` only control how the benchmark/client sends audio. They do
**not** change the deployed Riva ASR model/server chunk size. For any Riva ASR streaming
model, changing server-side `chunk_size` requires changing the deployment/profile/pipeline
configuration and redeploying the NIM. The server may accumulate or split incoming client
audio to match its own configured chunk size.

```bash
export N=4  # num parallel streams — sweep: 1, 2, 4, 8, ...

docker exec <container_name> riva_streaming_asr_client \
  --riva_uri=0.0.0.0:50051 \
  --language_code=en-US \
  --audio_file=/opt/riva/examples/asr_lib/1272-135031-0000.wav \
  --chunk_duration_ms=160 \
  --simulate_realtime=true \
  --automatic_punctuation=true \
  --num_parallel_requests=$N \
  --num_iterations=$((3 * N)) \
  --print_transcripts=false \
  --interim_results=false \
  --output_filename=/tmp/output.json
```

### Offline Models

Omit `--chunk_duration_ms` and `--simulate_realtime` (offline models process the full audio in one shot, not streaming chunks).

```bash
export N=4

docker exec <container_name> riva_streaming_asr_client \
  --riva_uri=0.0.0.0:50051 \
  --language_code=en-US \
  --audio_file=/opt/riva/examples/asr_lib/1272-135031-0000.wav \
  --automatic_punctuation=true \
  --num_parallel_requests=$N \
  --num_iterations=$((3 * N)) \
  --print_transcripts=false \
  --interim_results=false \
  --output_filename=/tmp/output.json
```

**Key flags:**

| Flag | Description |
|------|-------------|
| `--chunk_duration_ms` | Client send chunk duration for streaming benchmark traffic. For apples-to-apples benchmarking, usually match the deployed server `chunk_size`, but this flag does not change server `chunk_size`. |
| `--simulate_realtime` | Throttle audio to real-time speed — streaming models only |
| `--num_parallel_requests` | Concurrent streams; sweep 1→2→4→8→… to find throughput peak |
| `--num_iterations` | Total requests; use 3× `num_parallel_requests` for stable results |
| `--print_transcripts=false` | Suppress transcripts for clean benchmark output |

**Output metrics:**

| Metric | Description |
|--------|-------------|
| Median / 90th / 95th / 99th latency | Time from chunk sent to partial transcript received (ms) |
| Throughput (RTFX) | Audio processed per second of wall time; >1.0 = faster than real-time |

---

## Examples

**Cloud inference — transcribe a file (replace `<FUNCTION_ID>` with the value fetched from the model's build.nvidia.com API page):**

```bash
python python-clients/scripts/asr/transcribe_file.py \
    --server grpc.nvcf.nvidia.com:443 --use-ssl \
    --metadata function-id "<FUNCTION_ID>" \
    --metadata authorization "Bearer $NVIDIA_API_KEY" \
    --input-file audio.wav
```

**Self-hosted streaming transcription:**

```bash
python3 python-clients/scripts/asr/transcribe_file.py \
  --server 0.0.0.0:50051 --input-file audio.wav --language-code en-US
```

**Runtime feature lookup — agent flow:** When a user asks "does Riva ASR support force_eou?" or "can I word-boost on Whisper?", the agent should:
1. Fetch or open https://docs.nvidia.com/nim/speech/latest/asr/customization/customization.html
2. Locate the relevant feature section
3. Read the per-model support badges to answer with current information

Do not answer feature questions from this skill's text alone.

## Troubleshooting

- **Wrong `NIM_TAGS_SELECTOR`** — if the selector doesn't match any available profile, the container exits. Fetch the support matrix for exact tag values.
- **GPU device index** — `--gpus '"device=0"'` targets GPU 0. Adjust for multi-GPU hosts.
- **Port 8000 conflict** — avoid `NIM_HTTP_API_PORT=8000`; use 9000 (default).
- **Feature flag silently does nothing** — many runtime features are per-model. Fetch the customization page and verify the model has the feature badge before recommending the flag.
- **Function-id rejected by cloud** — fetch the model's current API page on build.nvidia.com; function IDs rotate.
- **Stereo audio rejected / hangs** — Riva ASR is mono-only. Convert with `ffmpeg -i in.wav -ac 1 out.wav` (or `-ac 1` when re-encoding to Opus). The Quick path heredoc detects this and fails fast.

## Audio format support

- **Container/encoding:** WAV (16-bit signed PCM, little-endian) and Opus (OGG container) are the supported on-the-wire formats. Other containers (FLAC, MP3, AAC) must be transcoded — typically with `ffmpeg -i input.xxx -ac 1 -ar 16000 out.wav` or `ffmpeg -i input.xxx -c:a libopus -ac 1 out.opus`.
- **Channels:** mono only. Stereo files must be downmixed (`ffmpeg -ac 1`).
- **Sample rate:** flexible *per model*. Fixed-rate models (e.g. some Parakeet variants serve only at 16 kHz; Magpie/Canary may accept wider ranges) — when in doubt, resample to 16 kHz (`ffmpeg -ar 16000`). The model rejects sample rates it doesn't serve.

## Limitations

- x86_64 architecture only — ARM is not supported
- Self-hosted deployment requires an NVIDIA AI Enterprise license
- Cloud-hosted inference requires an active `NVIDIA_API_KEY` and internet access
- Audio must be mono WAV (16-bit PCM) or Opus; stereo and other encodings are not accepted on the wire
