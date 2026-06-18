# Riva TTS NIM

Two modes: **cloud-hosted** (no GPU, uses build.nvidia.com) or **self-hosted** (your own GPU + Docker).

> **Agent:** When walking the user through a multi-step workflow, announce each step before presenting it: **Step N/M — Step Title** (e.g., "**Step 1/4 — Deploy the Container**").
>
> **Source of truth.** This skill describes deployment mechanics, which are stable across releases. For anything that varies per release — model catalog, container IDs, function IDs, voice lists, supported languages, feature support per model, VRAM minimums — **fetch or open the canonical doc page and answer from that, not from this skill's text.** See [Looking up current information](#looking-up-current-information) below.

---

## Purpose

Deploy and run NVIDIA Riva TTS (text-to-speech) NIMs for speech synthesis. Supports cloud-hosted inference via build.nvidia.com (no GPU required) and self-hosted deployment. Covers offline synthesis, streaming, and Helm deployment.

## Looking up current information

This skill is **orientation, not catalog**. When a question depends on data that changes per release, fetch or open the relevant page and answer from that page:

| Question type | Fetch this page |
|---|---|
| Current models, container IDs, `NIM_TAGS_SELECTOR` profiles, available voices, supported languages, VRAM minimums | https://docs.nvidia.com/nim/speech/latest/reference/support-matrix/tts.html |
| Function IDs for cloud (build.nvidia.com) inference | `https://api.nvcf.nvidia.com/v2/nvcf/functions` (auth with `NVIDIA_API_KEY`; filter by `name` and `status=="ACTIVE"`). For human browsing only: `https://build.nvidia.com/<org>/<model>/api` (JS-rendered, not suitable for non-browser fetch tools). |
| **Runtime feature support per model** — streaming synthesis, SSML, custom dictionaries, sample-rate control, emotional styles | https://docs.nvidia.com/nim/speech/latest/tts/customization/customization.html |
| **gRPC proto contract** — `SynthesizeSpeechRequest`, `SynthesizeSpeechResponse`, voice metadata fields | https://docs.nvidia.com/nim/speech/latest/reference/api-references/tts/protos.html |
| **Realtime WebSocket API** — OpenAI-realtime-compatible TTS sessions | https://docs.nvidia.com/nim/speech/latest/reference/api-references/tts/realtime-tts.html |
| GPU / VRAM / driver minimums, OS prerequisites | https://docs.nvidia.com/nim/speech/latest/get-started/prerequisites.html |
| Latency / throughput benchmarks per model and GPU | https://docs.nvidia.com/nim/speech/latest/reference/performances/tts/performance.html |

**Do not infer from this skill's text:** which models exist, which voices they expose, which languages are supported, what `NIM_TAGS_SELECTOR` values are valid, or what VRAM is required. The docs are the contract.

> **Naming caveat.** The same model can appear under different slugs across NVIDIA's catalogs: support-matrix label (e.g., "Magpie TTS Multilingual"), `CONTAINER_ID`, NVCF function name (`ai-magpie-tts-multilingual`), and build.nvidia.com URL slug. Do not assume they match — cross-reference each from its own catalog. The NVCF Functions API is the only catalog you can hit programmatically; use it to resolve function-ids at runtime rather than hardcoding.

---

## Workflow

Choose **Option A** (cloud) for quick testing without a GPU, or **Option B** (self-hosted) for production. Self-hosted follows a 4-step process: deploy container → verify health → list voices → synthesize speech.

## Prerequisites

- Complete [`setup.md`](setup.md) before self-hosted deployment: NVIDIA Container Toolkit, `NGC_API_KEY` exported, Docker logged in to `nvcr.io`
- Cloud-hosted inference: `pip install -U nvidia-riva-client` and a valid `NVIDIA_API_KEY`
- Not sure which TTS model to use? Run [`model-selection.md`](model-selection.md) first

## Instructions

For **cloud synthesis**: install `nvidia-riva-client`, set `NVIDIA_API_KEY`, fetch the model's function-id from its build.nvidia.com API page, and run `talk.py` against `grpc.nvcf.nvidia.com:443` with `--use-ssl`.

For **self-hosted**: fetch the current `CONTAINER_ID` and `NIM_TAGS_SELECTOR` from the support matrix, then follow Steps 1–4 below.

For **runtime feature questions** (voice list, SSML, streaming format): fetch or open the customization page from the routing table above before answering — feature support is per-model and changes per release.

## Option A — Cloud-Hosted Inference (build.nvidia.com)

**Setup:** `pip install -U nvidia-riva-client`, then clone https://github.com/nvidia-riva/python-clients and `cd` into it.

**Auth:** Set `NVIDIA_API_KEY` — either a build.nvidia.com personal key, or an NGC personal key with the **Cloud Functions** scope enabled (the same NGC key you use for `docker login nvcr.io`). Most users export the same value to both `NVIDIA_API_KEY` and `NGC_API_KEY`.

**Server:** `grpc.nvcf.nvidia.com:443` — always pass `--use-ssl`.

**Function ID lookup (JSON, scriptable, no hardcoding):**

```bash
curl -fsS -H "Authorization: Bearer $NVIDIA_API_KEY" \
  "https://api.nvcf.nvidia.com/v2/nvcf/functions?visibility=public,authorized" \
  | python3 -c "
import sys, json, re
pat = re.compile(r'magpie|tts', re.I)
for f in json.load(sys.stdin).get('functions', []):
    if f.get('status') == 'ACTIVE' and pat.search(f.get('name','')):
        print(f['id'], f['name'])
"
```

Pick the `id` of the function whose `name` matches your model.

Function IDs and `versionId` rotate per release — never hardcode them; always resolve fresh via this API.

For interactive browsing only: `https://build.nvidia.com/<org>/<model>/api`. That page is JS-rendered and not suitable for non-browser fetch tools.

**Synthesize speech:**

```bash
python python-clients/scripts/tts/talk.py \
    --server grpc.nvcf.nvidia.com:443 --use-ssl \
    --metadata function-id "<FUNCTION_ID>" \
    --metadata authorization "Bearer $NVIDIA_API_KEY" \
    --language-code <LANG_CODE> \
    --text "Hello from NVIDIA TTS." \
    --voice "<VOICE_NAME>" \
    --output audio.wav
```

> **Security note:** `$NVIDIA_API_KEY` passed as a command-line argument is visible in process listings and shell history. Prefix the command with a space (`HISTCONTROL=ignorespace`) or store the key in a file with `chmod 600` and reference it at runtime.

**List available voices:** add `--list-voices` (drop `--text`, `--voice`, `--output`).

---

## Option B — Self-Hosted TTS NIM Deployment

For TTS self-hosting, use the TTS support matrix to confirm the voice-capable model, deployment profile, and current GPU requirement before Step 1.

## Step 1 — Deploy the Container

Fetch the current `CONTAINER_ID` and `NIM_TAGS_SELECTOR` for your chosen model from the support matrix.

```bash
export CONTAINER_ID=<container-id-from-support-matrix>
export NIM_TAGS_SELECTOR="<selector-from-support-matrix>"
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

For a specific batch size, append it to `NIM_TAGS_SELECTOR`: `name=<model>,batch_size=32`.

> **Security note:** `NGC_API_KEY` passed via `-e NGC_API_KEY` inherits from the shell environment. For production, use Docker secrets or a secrets manager.

## Step 2 — Verify Readiness

If you started the container yourself, the HTTP probe is enough:

```bash
curl -fsS http://localhost:9000/v1/health/ready    # expect {"status":"ready"}
```

If a container was already running when you arrived (shared dev box, mystery process), the HTTP check is not sufficient — a host-mapped gRPC port can route to a container with **nothing bound inside**, and connections silently drop mid-RPC. Confirm a TTS model is actually being served with this inline probe (needs only `pip install nvidia-riva-client`):

```bash
python3 - <<'PY'
import sys, riva.client
from riva.client.proto.riva_tts_pb2 import RivaSynthesisConfigRequest
auth = riva.client.Auth(uri="0.0.0.0:50051")
try:
    cfg = riva.client.SpeechSynthesisService(auth).stub.GetRivaSynthesisConfig(
        RivaSynthesisConfigRequest(), metadata=auth.get_auth_metadata())
except Exception as e:
    print(f"UNHEALTHY: {e}"); sys.exit(2)
if not cfg.model_config:
    print("UNHEALTHY: server responded but exposes no TTS models"); sys.exit(2)
print(f"OK: {len(cfg.model_config)} model(s)")
for m in cfg.model_config:
    voices = m.parameters.get("voice_name", "")
    langs  = m.parameters.get("language_code", "")
    print(f"  - {m.model_name}  [{langs}]  voices={voices}")
PY
```

An empty model list or `UNAVAILABLE: Socket closed` means the server is not actually running TTS — restart the NIM rather than continuing.

## Step 3 — List Available Voices

Voice names and pattern conventions vary per model — always discover at runtime:

**gRPC:**

```bash
python3 python-clients/scripts/tts/talk.py \
  --server 0.0.0.0:50051 \
  --list-voices
```

**HTTP:**

```bash
curl -sS http://localhost:9000/v1/audio/list_voices | python3 -m json.tool
```

Use the voice names returned by the running NIM rather than memorized strings — they may change between model versions.

## Step 4 — Run Speech Synthesis

### Quick path — inline (no separate scripts, no upstream coupling)

This recipe uses only the `nvidia-riva-client` pip package — no `python-clients` clone, no `docker exec`, no vendored scripts. It travels with this SKILL.md, so any update to the skill includes the latest recipe.

**Cloud — discover function-id, then synthesize:**

```bash
FID=$(curl -fsS -H "Authorization: Bearer $NVIDIA_API_KEY" \
  "https://api.nvcf.nvidia.com/v2/nvcf/functions?visibility=public,authorized" \
  | python3 -c "
import sys, json
for f in json.load(sys.stdin).get('functions', []):
    if f.get('status') == 'ACTIVE' and f.get('name','').removeprefix('ai-') == 'magpie-tts-multilingual':
        print(f['id']); break
")

# Replace VOICE with a value returned by --list-voices.
TEXT="Hello from NVIDIA TTS." OUT=out.wav SERVER=grpc.nvcf.nvidia.com:443 \
VOICE="<voice-name-from-list-voices>" FID=$FID python3 - <<'PY'
import os, wave, riva.client
server = os.environ["SERVER"]
is_cloud = "nvcf" in server
md = None
if is_cloud:
    md = [["function-id", os.environ["FID"]],
          ["authorization", f"Bearer {os.environ['NVIDIA_API_KEY']}"]]
auth = riva.client.Auth(uri=server, use_ssl=is_cloud, metadata_args=md)
tts = riva.client.SpeechSynthesisService(auth)
sr = 44100
resp = tts.synthesize(
    text=os.environ["TEXT"],
    voice_name=os.environ["VOICE"],
    language_code="en-US",
    encoding=riva.client.AudioEncoding.LINEAR_PCM,
    sample_rate_hz=sr,
)
with wave.open(os.environ["OUT"], "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
    w.writeframes(resp.audio)
print(f"wrote {os.environ['OUT']} ({len(resp.audio)} bytes @ {sr} Hz)")
PY
```

**Self-hosted:** drop `FID=...` and set `SERVER=0.0.0.0:50051` — the heredoc auto-skips the cloud metadata. To discover voices, see Step 3's probe output or use the `list_voices` HTTP endpoint.

### Alternative — upstream `python-clients` CLI

`https://github.com/nvidia-riva/python-clients` ships canonical `talk.py` and `realtime_tts_client.py`. Useful for richer CLI flags or interactive exploration:

```bash
PY_CLIENTS=~/.cache/riva-skills/python-clients
[ -d "$PY_CLIENTS" ] || git clone --depth 1 https://github.com/nvidia-riva/python-clients "$PY_CLIENTS"

python3 "$PY_CLIENTS/scripts/tts/talk.py" \
  --server grpc.nvcf.nvidia.com:443 --use-ssl \
  --metadata function-id "$FID" \
  --metadata authorization "Bearer $NVIDIA_API_KEY" \
  --text "Hello." --voice "<voice-name-from-list-voices>" \
  --output out.wav
```

> **Note.** `python-clients` tags are stale (last tag is `r2.19.0` while pip ships much newer) — always use `main`, which `git clone --depth 1` pulls by default. If `main` briefly outpaces your installed `nvidia-riva-client` and a script fails with `ImportError`, fall back to the inline Quick path above (it depends only on the pip package).

### Offline Synthesis (Full Audio in One Response)

**gRPC:**

```bash
python3 python-clients/scripts/tts/talk.py \
  --server 0.0.0.0:50051 \
  --language-code <LANG_CODE> \
  --text "Deploy and run speech synthesis with NVIDIA TTS NIM." \
  --voice <VOICE_NAME> \
  --output output.wav
```

**HTTP:**

```bash
curl -sS http://localhost:9000/v1/audio/synthesize --fail-with-body \
  -F language=<LANG_CODE> \
  -F text="Deploy and run speech synthesis with NVIDIA TTS NIM." \
  -F voice=<VOICE_NAME> \
  --output output.wav
```

### Streaming Synthesis (Lower Latency, Audio Chunks)

**gRPC:**

```bash
python3 python-clients/scripts/tts/talk.py \
  --server 0.0.0.0:50051 \
  --language-code <LANG_CODE> \
  --text "..." \
  --voice <VOICE_NAME> \
  --stream \
  --output output.wav
```

**HTTP (returns raw LPCM, not WAV — wrap with sox):**

```bash
curl -sS http://localhost:9000/v1/audio/synthesize_online --fail-with-body \
  -F language=<LANG_CODE> \
  -F text="..." \
  -F voice=<VOICE_NAME> \
  -F sample_rate_hz=22050 \
  --output output.raw

sox -b 16 -e signed -c 1 -r 22050 output.raw output.wav
```

### WebSocket / Realtime API

For OpenAI-realtime-compatible WebSocket TTS sessions, the realtime API has its own request / response shape and `custom_configuration` keys. Fetch the realtime API reference cited in the routing table for current event names, payload schemas, and supported keys.

```bash
python3 python-clients/scripts/tts/realtime_tts_client.py \
  --server localhost:9000 \
  --language-code <LANG_CODE> \
  --text "..." \
  --voice <VOICE_NAME> \
  --output output.wav
```

## Helm Deployment (Kubernetes)

```yaml
# custom-values.yaml
image:
  repository: nvcr.io/nim/nvidia/<container-id>
  pullPolicy: IfNotPresent
  tag: latest
nim:
  ngcAPISecret: ngc-api
imagePullSecrets:
  - name: ngc-secret
envVars:
  NIM_TAGS_SELECTOR: "<selector-from-support-matrix>"
```

```bash
helm install riva-tts <chart> -f custom-values.yaml
```

## Key Parameters for talk.py

| Parameter | Description | Default |
|-----------|-------------|---------|
| `--server` | gRPC endpoint | `0.0.0.0:50051` |
| `--text` | Text to synthesize | — |
| `--voice` | Voice name (discover via `--list-voices`) | First available |
| `--language-code` | Language code (e.g., `en-US`) | `en-US` |
| `--output` / `-o` | Output WAV file | `output.wav` |
| `--stream` | Enable streaming | `false` |
| `--sample-rate-hz` | Output sample rate | `44100` |
| `--list-voices` | List voices then exit | — |

For the full flag list (and any per-model behavior), see the customization page or run `talk.py --help`.

## Examples

**Cloud synthesis (replace `<FUNCTION_ID>` and `<VOICE_NAME>` with values fetched from the model's build.nvidia.com page and `--list-voices`):**

```bash
python python-clients/scripts/tts/talk.py \
    --server grpc.nvcf.nvidia.com:443 --use-ssl \
    --metadata function-id "<FUNCTION_ID>" \
    --metadata authorization "Bearer $NVIDIA_API_KEY" \
    --text "Hello from NVIDIA TTS." \
    --voice "<VOICE_NAME>" \
    --output audio.wav
```

**Self-hosted offline synthesis:**

```bash
python3 python-clients/scripts/tts/talk.py \
  --server 0.0.0.0:50051 \
  --text "Deploy speech synthesis with NVIDIA TTS NIM." \
  --voice <VOICE_NAME> \
  --output output.wav
```

**Runtime feature lookup — agent flow:** When a user asks "does Magpie support SSML?" or "what voices are available for English?", the agent should:
1. Fetch or open the customization page (or the support matrix for voice lists)
2. Answer based on the fetched content

Do not answer feature/voice questions from this skill's text alone.

## Troubleshooting

- **gRPC 4 MB limit** — if synthesized audio exceeds 4 MB, switch to `--stream` or use the WebSocket client.
- **HTTP streaming returns raw LPCM** — not a WAV file; use `sox` to convert.
- **Voice name not recognized** — voice strings are case-sensitive and per-model. Always run `--list-voices` against the running NIM rather than copying from documentation.
- **Function-id rejected by cloud** — fetch the model's current API page on build.nvidia.com; function IDs rotate.

## Limitations

- x86_64 architecture only — ARM is not supported
- Self-hosted deployment requires an NVIDIA AI Enterprise license
- Cloud-hosted inference requires an active `NVIDIA_API_KEY` and internet access
- gRPC responses are limited to 4 MB — long synthesis requests must use streaming or be chunked
- HTTP streaming returns raw LPCM (not WAV) — requires client-side wrapping
- Voice names are case-sensitive
