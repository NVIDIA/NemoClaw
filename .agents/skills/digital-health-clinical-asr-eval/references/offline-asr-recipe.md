# Offline NVCF gRPC ASR — full recipe + catalog

Companion to `SKILL.md` Step 3b. The compact pointer in SKILL.md is enough to run the happy path against the default Parakeet TDT 0.6B v2 function; this file carries the full Python recipe, the env-var resolution helper, the alternate-NIM catalog, and the Whisper / self-hosted-Riva fallbacks.

## Function-ID catalog (swap via `ASR_NVCF_FUNCTION_ID`)

Function IDs sourced from `/riva-asr`'s catalog. All four below are offline-capable except where noted; only the **offline** ones drop straight into the recipe in this file. Streaming-shaped NIMs need `/riva-asr`'s streaming call shape instead.

| Function ID | Model | Shape | Notes |
|---|---|---|---|
| `d3fe9151-442b-4204-a70d-5fcc597fd610` | `nvidia/parakeet-tdt-0.6b-v2` | **offline** | **Default.** Fastest/cheapest in the catalog; supported in NeMo's stock SFT recipe so Stage 3 baseline and a Stage 4 fine-tune ride the same model family. |
| `b702f636-f60c-4a3d-a6f4-f3568c13bd7d` | `openai/whisper-large-v3` | **offline** | Cross-vendor baseline. Drop-in for the Parakeet recipe; pass `language_code="en"` (not `"en-US"`). The pragmatic fallback while Parakeet's NVCF backend is faulting. |
| `71203149-d3b7-4460-8231-1be2543a1fca` | `nvidia/parakeet-tdt-1.1b-rnnt-multilingual` | streaming-shaped | Higher accuracy, larger model; pass `language_code="multi"`. Needs `/riva-asr`'s streaming recipe. |
| `1598d209-5e27-4d3c-8079-4751568b1081` | `nvidia/parakeet-ctc-1.1b-asr` | streaming-shaped | CTC decoder, English; simpler Riva export path. Needs `/riva-asr`'s streaming recipe. |
| `bb0837de-8c7b-481f-9ec8-ef5663e9c1fa` | `nvidia/nemotron-asr-streaming` | streaming-only | **Eval-only**; do not pair with `/digital-health-clinical-asr-finetune` (SFT path is unreliable — UNK collapse on validation after step 1). Use `/riva-asr` Option A's `transcribe_file.py` for the streaming call shape. |

## Full recipe

Same `auth_for` shape as the Stage 1 setup smoke test. The agent harness passes `api_key` as an explicit argument; the recipe itself reads the three optional env-var overrides (`ASR_NVCF_FUNCTION_ID`, `ASR_MODEL_NAME`, `ASR_ENDPOINT`) at the top so auditors can see the knobs from one place.

```python
import json, os, wave
from pathlib import Path
import riva.client

NVCF_HOST = "grpc.nvcf.nvidia.com:443"

DEFAULT_FUNCTION_ID = "d3fe9151-442b-4204-a70d-5fcc597fd610"  # Parakeet TDT 0.6B v2 (offline)
DEFAULT_MODEL_NAME  = "parakeet-tdt-0.6b-v2"

def resolve_asr_config():
    """Read env-var overrides once; returns (model_name, function_id, endpoint).
    endpoint=None means use hosted NVCF; otherwise use self-hosted gRPC."""
    return (
        os.environ.get("ASR_MODEL_NAME", DEFAULT_MODEL_NAME),
        os.environ.get("ASR_NVCF_FUNCTION_ID", DEFAULT_FUNCTION_ID),
        os.environ.get("ASR_ENDPOINT"),  # e.g. "localhost:50051"
    )

def build_asr_auth(api_key: str, function_id: str, endpoint: str | None):
    """Build a riva.client.Auth pointed at either NVCF (hosted) or a self-hosted gRPC URI."""
    if endpoint:
        # Self-hosted Riva NIM: no NVCF function-id, no NVCF bearer.
        return riva.client.Auth(use_ssl=False, uri=endpoint)
    return riva.client.Auth(
        use_ssl=True, uri=NVCF_HOST,
        metadata_args=[
            ["function-id", function_id],
            ["authorization", f"Bearer {api_key}"],
        ],
    )

def transcribe_row(asr_service, wav_path: str, language_code: str = "en-US") -> str:
    """One-shot offline transcription. Sentences in a clinical manifest are ≤ 30 s,
    so we treat the whole file as one chunk — no streaming or batching needed."""
    with wave.open(wav_path, "rb") as w:
        sr = w.getframerate()
        if w.getnchannels() != 1 or w.getsampwidth() != 2:
            raise ValueError(f"{wav_path}: expected 16-bit mono PCM (got {w.getnchannels()}ch / {w.getsampwidth()*8}-bit)")
        audio_bytes = w.readframes(w.getnframes())
    cfg = riva.client.RecognitionConfig(
        encoding=riva.client.AudioEncoding.LINEAR_PCM,
        sample_rate_hertz=sr, language_code=language_code,
        max_alternatives=1, enable_automatic_punctuation=True,
    )
    resp = asr_service.offline_recognize(audio_bytes, cfg)
    return resp.results[0].alternatives[0].transcript if resp.results else ""

def transcribe_manifest(api_key: str, manifest_path: str, out_path: str,
                        language_code: str = "en-US") -> str:
    """Iterate manifest.jsonl, write per_sample.json. Returns the resolved model name
    for downstream leaderboard labelling."""
    model_name, function_id, endpoint = resolve_asr_config()
    target = endpoint if endpoint else f"NVCF function-id {function_id}"
    print(f"ASR target: {model_name} -> {target}")  # pre-flight echo

    auth = build_asr_auth(api_key, function_id, endpoint)
    asr = riva.client.ASRService(auth)

    n_done = 0
    with open(manifest_path) as f_in, open(out_path, "w") as f_out:
        for line in f_in:
            row = json.loads(line)
            wav = row["audio_filepath"]
            hyp = transcribe_row(asr, wav, language_code=language_code)
            f_out.write(json.dumps({
                "audio_filepath":  wav,
                "ref":             row["text"],
                "hyp":             hyp,
                "term":            row.get("term"),
                "entity_category": row.get("entity_category"),
                "ipa_source":      row.get("ipa_source"),
                "voice_id":        row.get("voice_id"),
                "noise_level":     row.get("noise_level"),
                "context_type":    row.get("context_type"),
            }) + "\n")
            n_done += 1
    print(f"Wrote {n_done} rows -> {out_path}")
    return model_name

# Invoke from the agent (api_key sourced by the harness, not by this code):
# transcribe_manifest(api_key=<NVIDIA_API_KEY>, manifest_path="cycle1/manifest.jsonl",
#                     out_path="cycle1/per_sample.json")
```

## Whisper fallback (when Parakeet NVCF is faulting)

Whisper Large v3 is also offline; the recipe runs unchanged with two env-var nudges:

```bash
export ASR_NVCF_FUNCTION_ID=b702f636-f60c-4a3d-a6f4-f3568c13bd7d
export ASR_MODEL_NAME=whisper-large-v3
# Then call transcribe_manifest(..., language_code="en") instead of "en-US".
```

Symptom that warrants the fallback: `StatusCode.INVALID_ARGUMENT` with `CUDA illegal memory access` from Triton on Parakeet's NVCF function — that's a backend fault, not your environment. Switch to Whisper, complete the cycle, switch back later. The leaderboard `ASR_MODEL_NAME` label keeps cycles auditable.

## Self-hosted Riva NIM

Set `ASR_ENDPOINT=<host:port>` (e.g. `localhost:50051`); the recipe builds a non-SSL `Auth` and skips NVCF entirely.

```bash
export ASR_ENDPOINT=localhost:50051
# transcribe_manifest(...) now hits the local NIM instead of NVCF.
```

See `/riva-asr` Option B for deploying a self-hosted NIM.

## Resilience knobs

If NVCF returns `RESOURCE_EXHAUSTED` mid-batch, the loop raises on that row; re-run from the failing row or slice the manifest. Streaming/batching/retry-with-backoff are out of scope for this skill — see `/riva-asr` if you need them.
