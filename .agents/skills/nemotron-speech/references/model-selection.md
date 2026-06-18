# Riva Model Selection & Routing

> **Agent:** This is the entry point for any Riva task. Walk through the **Procedure** below before opening the relevant modality reference — environment context changes what's possible (some boxes have no GPU; some have a key for one path and not the other; some already have a NIM running). The modality references ([`asr.md`](asr.md) / [`tts.md`](tts.md) / [`nmt.md`](nmt.md)) expect you to arrive with `SERVER`, `FID` (if cloud), and the model name already resolved.
>
> **Source of truth.** Model catalog, container IDs, supported languages, voice lists, and VRAM requirements **change with every Riva release**. This skill provides routing logic and a stable family taxonomy — the docs are the contract for what exists *right now*. Always **fetch or open the support matrix** before recommending a specific model name.

## Looking up current information

| Question type | Fetch this page |
|---|---|
| **Current ASR models, container IDs, supported languages, VRAM** | https://docs.nvidia.com/nim/speech/latest/reference/support-matrix/asr.html |
| **Current TTS models, voice lists, supported languages, VRAM** | https://docs.nvidia.com/nim/speech/latest/reference/support-matrix/tts.html |
| **Current NMT models, language pairs, VRAM** | https://docs.nvidia.com/nim/speech/latest/reference/support-matrix/nmt.html |
| **ASR per-model feature support** (word boosting, ITN, force_eou, diarization, etc.) | https://docs.nvidia.com/nim/speech/latest/asr/customization/customization.html |
| **TTS per-model feature support** (SSML, voice list, sample-rate, emotional styles) | https://docs.nvidia.com/nim/speech/latest/tts/customization/customization.html |
| **NMT per-model feature support** (DNT tags, custom dictionaries, max-length variation, language pairs) | https://docs.nvidia.com/nim/speech/latest/nmt/customization/customization.html |
| **ASR performance benchmarks** (latency, throughput, RTFX per GPU) | https://docs.nvidia.com/nim/speech/latest/reference/performances/asr/performance.html |
| **TTS performance benchmarks** | https://docs.nvidia.com/nim/speech/latest/reference/performances/tts/performance.html |
| **NMT performance benchmarks** | https://docs.nvidia.com/nim/speech/latest/reference/performances/nmt/performance.html |
| **Active cloud functions** (function-ids for build.nvidia.com / NVCF inference) | `https://api.nvcf.nvidia.com/v2/nvcf/functions` (auth with `$NVIDIA_API_KEY`; filter by `name` and `status=="ACTIVE"`) |

**Do not infer model names, container IDs, or feature support from this skill's text.** Use the family taxonomy below as a starting point, then fetch the support matrix to find the specific model and its `CONTAINER_ID` / `NIM_TAGS_SELECTOR`.

## Purpose

Main entry point for any Riva Speech NIM task. Encodes four concerns in one skill:

1. **Pick a model family** for the user's goal (ASR / TTS / NMT, language, mode, special needs).
2. **Detect environment** — GPU + VRAM, API keys, network, NIMs already running on the host.
3. **Route** cloud (build.nvidia.com / NVCF) vs self-hosted, gated by capability and privacy.
4. **Open** the relevant modality reference ([`asr.md`](asr.md) / [`tts.md`](tts.md) / [`nmt.md`](nmt.md)) with routing values pre-resolved.

## Procedure

**Lead with the fast path. Escalate only when necessary, and narrate before probing.** When a routine signal already tells you which path to take, take it — don't run system inspections "just in case." When you do need to inspect the user's environment, **state what you're checking and why** before running the command, and **ask before probing** if the user didn't directly request the check.

### Default — `NVIDIA_API_KEY` is set → cloud, zero friction

If the user's environment has `NVIDIA_API_KEY` exported, the path is decided. Open the relevant modality reference ([`asr.md`](asr.md) / [`tts.md`](tts.md) / [`nmt.md`](nmt.md)) with `SERVER=grpc.nvcf.nvidia.com:443`; that file shows how to discover the function-id — then follow the Quick path heredoc there.

**No GPU detection, no `docker ps`, no privacy interrogation, no Docker checks** — these add friction without value when cloud is wired up. The user explicitly opted into cloud by setting the key.

Reasonable model defaults when the user hasn't named one:
- **ASR English** → Parakeet CTC 1.1b English (`ai-parakeet-ctc-1_1b-asr`) — best-accuracy English; streaming.
- **ASR multilingual** → Parakeet RNNT Multilingual.
- **ASR with diarization** → Nemotron ASR Streaming (`ai-nemotron-asr-streaming`) — includes Sortformer.
- **TTS** → Magpie TTS Multilingual (`ai-magpie-tts-multilingual`).
- **NMT** → Riva Translate 1.6b (`ai-riva-translate-1_6b`).

Confirm the model choice with the user only if you have a reason to (e.g. they said "diarization", which routes away from the default Parakeet).

### `NVIDIA_API_KEY` not set — surface the two options to the user

Don't probe the system. Ask:

> "I don't see `NVIDIA_API_KEY` in your environment. Two options for transcribing:
> 1. **Cloud** — set `NVIDIA_API_KEY` (free key at https://build.nvidia.com). Fastest path; runs on NVIDIA's GPUs.
> 2. **Local deploy** — pull a Riva NIM container and run it on this box. Needs an NVIDIA GPU and `NGC_API_KEY`; first-run model pull is 10–30 GB.
>
> Which do you prefer?"

Wait. **Do not pre-probe the GPU** in case they say local — that's invisible work the user didn't ask for.

### User picked cloud → tell them how to set the key

> "Get a key from https://build.nvidia.com (NGC personal keys with the Cloud Functions scope also work). Then `export NVIDIA_API_KEY=...` and re-ask."

### User picked local deploy → ask about existing NIMs first

Before reaching for `nvidia-smi`, surface the simpler question:

> "Before I check whether this system can run a NIM, **is there already a Riva NIM running on this box that you want me to reuse?** I can scan running containers with `docker ps` — want me to check?"

If yes:

> "Scanning for Riva/NIM containers… `docker ps | grep -iE 'riva|nim'`"

[run the scan, report what showed up inline]

> "Found `<container>` on port 50051. Probing its gRPC port to confirm it's actually serving ASR…"

[run the modality reference's inline probe]

If the probe returns models, open the relevant modality reference with `SERVER=0.0.0.0:50051`. Skip the rest of this section.

### No reusable NIM → check feasibility, narrate each step

State the plan **before** running anything:

> "OK, no existing NIM to reuse. Before I propose a fresh deploy, I'll verify this system can actually run a NIM. I need to check four things:
> 1. **GPU + VRAM** — Riva NIMs need an NVIDIA GPU. The specific VRAM minimum depends on the model you pick (usually ≥ 16 GB).
> 2. **`nvidia-container-toolkit`** — without it, Docker can't pass the GPU through to the container.
> 3. **Disk space** — first-time model pull is 10–30 GB.
> 4. **`NGC_API_KEY`** — needed to pull from `nvcr.io`.
>
> Running those now."

Then run them one at a time (see [Environment Detection Reference](#environment-detection-reference) for commands), **reporting each result inline**. Don't batch them into a single output dump.

If any check fails: tell the user *which* one and what would unblock it. Often the unblock is "set `NVIDIA_API_KEY` and use cloud instead" — surface that explicitly rather than letting the user assume local is their only option.

If all four pass: confirm the user still wants to proceed (the cloud path is faster on first run; only proceed with local if the user's reason for picking it still holds).

### Privacy gate — only when warranted

If the input *looks* sensitive (PII, health records, internal-confidential content, or the user mentioned it), ask before cloud. **Do not ask on every routine transcription** — that's friction the cloud-by-default users will resent. Default-yes on cloud unless there's a signal.

### Routing values handoff (any path)

Once a path is committed:
- **Cloud:** the modality reference shows how to discover the NVCF function-id via the curl one-liner in its Quick path; you don't need to pre-resolve it.
- **Local (running NIM):** pass `SERVER=0.0.0.0:50051` when opening the relevant modality reference.
- **Local (fresh deploy):** follow the modality reference's Step 1 deploy with `CONTAINER_ID` + `NIM_TAGS_SELECTOR` from the support matrix.

For ASR, also remind the user: audio must be **mono WAV (16-bit PCM) or Opus**; the heredoc fails fast on stereo with an `ffmpeg` conversion hint.

---

## Decision Framework

Use after Step 4 to narrow to a family:

1. **Task** — transcription (ASR), speech synthesis (TTS), or translation (NMT)?
2. **Language(s)** — English only, one specific non-English language, or multilingual?
3. **Mode** — real-time streaming (low-latency, partial transcripts) or offline batch (full audio in one shot, often higher accuracy)?
4. **Special needs** — speaker diarization, word timestamps, translation alongside transcription, custom-trained model?

---

## ASR Family Taxonomy

Riva ASR currently spans several model families. Family names are stable across releases; specific model sizes and language variants within a family rotate. Always fetch the support matrix for current model names and `CONTAINER_ID` values.

| Family | Architecture | Typical use cases | Notes |
|---|---|---|---|
| **Parakeet CTC** | CTC | Best-accuracy English / per-language production; works with word boosting; best word-timestamp accuracy | Streaming + offline; multiple model sizes and per-language variants |
| **Parakeet RNNT** | RNNT | Multilingual streaming with auto-detect | Streaming + offline |
| **Parakeet TDT** | TDT | Offline transcription with word timestamps | Often offline-only; check support matrix |
| **Canary** | Encoder-decoder | Multilingual transcription with bidirectional translation | Often offline-only |
| **Whisper** | OpenAI Whisper | Broadest language coverage; transcription + translate-to-English | Offline-only |
| **Nemotron ASR Streaming** | Cache-aware RNNT | Low-latency English streaming; supports client-driven `force_eou` | Streaming-only |
| **Conformer** | CTC | Legacy; for custom-trained model deployments via [`asr-custom.md`](asr-custom.md) | — |

### ASR Quick Picks (decision-only; fetch matrix for specific model)

| Use Case | Family to start from |
|---|---|
| English production (best accuracy) | Parakeet CTC English |
| English real-time streaming | Parakeet CTC English or Nemotron ASR Streaming |
| Need word timestamps (best accuracy) | Any Parakeet CTC family model |
| Need word timestamps (offline) | Parakeet TDT |
| Need word timestamps (multilingual streaming) | Parakeet RNNT Multilingual |
| Multilingual streaming | Parakeet RNNT Multilingual |
| Any-language auto-detect (offline) | Whisper |
| ASR + translate to English | Whisper |
| ASR + bidirectional translation | Canary |
| Per-language variant (e.g., Spanish, Mandarin, Vietnamese) | Per-language Parakeet CTC |
| Lowest-latency English streaming with client-driven EOU | Nemotron ASR Streaming |
| Custom-trained acoustic model | Conformer / CTC via [`asr-custom.md`](asr-custom.md) |

**Word timestamp accuracy ranking** (stable across releases): CTC > TDT > RNNT. Use `--word-time-offsets`. Whisper and Canary do not currently expose word timestamps — verify on the customization page.

---

## TTS Family Taxonomy

| Family | Typical use cases | Notes |
|---|---|---|
| **Magpie TTS Multilingual** | Production multilingual synthesis with named voices | Streaming + offline |

### TTS Quick Picks

| Use Case | Family to start from |
|---|---|
| Production multilingual TTS | Magpie TTS Multilingual |

For the current voice list, **discover at runtime** via `--list-voices` on the running NIM (or `GET /v1/audio/list_voices`). Voice strings are case-sensitive and per-model.

---

## NMT Family Taxonomy

A small number of bidirectional translation models cover all language pairs. Always run `--list-models` against a running NIM to see the current language pairs the server supports — language code conventions can drift between releases.

For the current `CONTAINER_ID` and supported languages, fetch the NMT support matrix.

---

## GPU and VRAM Requirements

GPU compatibility, VRAM, and driver minimums vary significantly by model and profile. Check the support matrix before deploying — these change per release. If you're uncertain whether your hardware can run a specific NIM, run [`deployment-readiness-checks.md`](deployment-readiness-checks.md) first.

---

## Environment Detection Reference

Concrete shell probes for the Procedure's local-deploy feasibility check. **Run only when escalated to** — never preemptively. Each probe should be preceded by a one-line statement of intent ("I need to check X because Y") so the user understands why their system is being inspected; see [[narrate-before-probing]] in agent memory.

**GPU + driver:**

```bash
command -v nvidia-smi >/dev/null && \
  nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader
# → "NVIDIA H100 80GB HBM3, 81559 MiB, 555.42.06"
```

**`nvidia-container-toolkit` wired up (Docker can pass GPU through):**

```bash
docker run --rm --runtime=nvidia --gpus all ubuntu nvidia-smi -L 2>/dev/null | head -1
# → "GPU 0: ..." if working; empty / error if toolkit not installed
```

**API keys present:**

```bash
[ -n "$NVIDIA_API_KEY" ] && echo "cloud OK" || echo "no NVIDIA_API_KEY (cloud unavailable)"
[ -n "$NGC_API_KEY" ]    && echo "ngc OK"   || echo "no NGC_API_KEY (self-hosted pulls unavailable)"
```

**NVCF reachable + key valid (one shot — fails fast on bad key or air-gapped box):**

```bash
curl --max-time 3 -fsS -H "Authorization: Bearer $NVIDIA_API_KEY" \
  "https://api.nvcf.nvidia.com/v2/nvcf/functions?visibility=public,authorized" \
  | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('functions',[])), 'functions visible')"
# → "N functions visible" on success; "401 Unauthorized" / curl exit non-zero otherwise
```

**Running NIM container scan:**

```bash
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}' | grep -iE 'riva|nim'
```

Then probe any candidate's gRPC port using the modality reference's `python3 - <<PY ... PY` readiness check (see [`asr.md`](asr.md) / [`tts.md`](tts.md) / [`nmt.md`](nmt.md) Step 2 / 3 "Verify Readiness"). A host-mapped port can still route to a container with **nothing bound inside**, so HTTP `/v1/health/ready` alone is not sufficient.

**Disk space (for fresh NIM pull — 10–30 GB typical):**

```bash
df -BG --output=avail "$HOME/.cache/nim" 2>/dev/null || df -BG --output=avail "$HOME"
```

---

## Examples

**Example 1 — "Transcribe this audio file" (the common case)**

`$NVIDIA_API_KEY` is set. **You're done with selection mechanics.** Hand off to [`asr.md`](asr.md) with `SERVER=grpc.nvcf.nvidia.com:443` and let it pick `ai-parakeet-ctc-1_1b-asr` (default English ASR) via the Quick path heredoc. No probes, no questions, no privacy interrogation — the user opted into cloud by setting the key.

If the user names a different need (e.g. "I need diarization"), swap the default model: `ai-nemotron-asr-streaming` for diarization, `ai-canary-1b-asr` for offline batch, etc.

**Example 2 — "Transcribe this audio file", `NVIDIA_API_KEY` not set**

Don't probe anything yet. Use the `NVIDIA_API_KEY` prompt template in the Procedure section above, then branch based on the user's answer. If cloud → tell them how to set the key. If local → next example.

**Example 3 — "Local deploy" branch with existing-NIM check first**

User asked for local. Follow the existing-NIM check in the Procedure section above before any hardware probing: ask whether to reuse a running NIM, scan only after the user agrees, then narrate the gRPC probe.

If the probe succeeds → hand off to [`asr.md`](asr.md) with `SERVER=0.0.0.0:50051`. Done.

If probe fails → tell the user: "the container is up but no ASR model is bound. I'd suggest restarting the NIM, or moving on to deploying a fresh one — want me to check this system's feasibility for a fresh deploy?"

**Example 4 — Fresh local deploy, feasibility check with narration**

No existing NIM and the user wants a fresh deploy. Narrate the plan before running anything:

> "OK, no NIM to reuse. Before proposing a deploy, I'll verify this system can run one. I need to check:
> 1. **GPU + VRAM** — Riva NIMs need an NVIDIA GPU; the specific VRAM minimum depends on the model.
> 2. **`nvidia-container-toolkit`** — without it, Docker can't pass the GPU through.
> 3. **Disk space** — first model pull is 10–30 GB.
> 4. **`NGC_API_KEY`** — needed to pull from `nvcr.io`.
>
> Running them now."

Then run each, reporting inline:

> "GPU check: `nvidia-smi --query-gpu=...` → RTX A5000, 24 GB. ✓"
> "Container toolkit: `docker run --rm --runtime=nvidia --gpus all ubuntu nvidia-smi -L` → GPU 0 visible. ✓"
> "Disk: 1.39 TB free. ✓"
> "`NGC_API_KEY` set. ✓"
> "All four pass. Proceed with deploying Parakeet CTC 1.1b English? It's a ~15 GB pull; takes about 5 minutes the first time."

**Narrow model-comparison example — "Which model has the best word timestamps?"**

Pure selection question, no orchestration: don't probe anything. Go straight to the ASR Family Taxonomy → CTC > TDT > RNNT ranking; fetch the customization page for current per-model badges; answer.

## Troubleshooting

- **"Which model should I use?"** — fetch the support matrix for the modality; this skill only narrows to a family.
- **Model not found in support matrix** — model catalog rotates per release. Family names are stable; specific names within a family may have moved.
- **Custom-trained acoustic model** — pre-built NIMs cover the families above; for your own `.riva` / `.nemo` checkpoints see [`asr-custom.md`](asr-custom.md).
- **GPU detected but Docker can't pass it through** — `nvidia-container-toolkit` missing or unconfigured; see [`setup.md`](setup.md) Step 3.
- **Key set but rejected (401)** — the env var is set but the key value isn't scoped for the plane being called. Most commonly: an NGC personal key without the **Cloud Functions** scope works for `docker login nvcr.io` but fails against `api.nvcf.nvidia.com`. Re-issue the key with the Cloud Functions scope ticked, or get a key from `build.nvidia.com` for the cloud path.
- **NIM running but gRPC drops mid-RPC** — container is alive but no model is bound. Probe via the modality reference's inline gRPC `Get*Config` check; if empty, restart the NIM.
- **`/v1/health/ready` says ready but gRPC fails** — HTTP probe is not sufficient on its own when the container was started by someone else. Always run the modality reference's gRPC probe before assuming the service is usable.

## Limitations

- This skill does **not** carry the live model catalog — it intentionally points to docs.
- Self-hosted models require an NVIDIA AI Enterprise license; WSL2 on Windows requires Podman instead of Docker.
- Family taxonomy is stable across releases; specific model names, sizes, language variants, voice names, and `CONTAINER_ID` values are not — always verify with the support matrix.
- Environment-detection probes assume a Linux host with `docker` and `curl` available; adapt for other shells / runtimes.
