---
name: "digital-health-clinical-asr-setup"
description: "Stage 1 of Clinical ASR Flywheel. Use when bootstrapping a cycle: NVCF+MW disclosure, NVIDIA_API_KEY check, deps install, TTS+ASR smoke test."
version: "1.1.0"
author: "Ben Randoing <brandoing@nvidia.com>"
tags:
  - clinical-asr
  - setup
  - flywheel
  - bootstrap
tools:
  - Read
  - Write
  - Bash
  - Skill
license: Apache-2.0
compatibility: "NVIDIA_API_KEY (required) for hosted Magpie TTS + Parakeet/Nemotron ASR via NVCF. DICTIONARY_API_KEY (optional) for Merriam-Webster pronunciation lookup. NGC_API_KEY (optional) for Stage 4 fine-tune. Python 3.10+."
metadata:
  author: "Ben Randoing <brandoing@nvidia.com>"
  tags:
    - clinical-asr
    - flywheel
    - setup
    - bootstrap
  team: healthcare-tme
  domain: ai-ml
  stage: 1
  next_skill: digital-health-clinical-asr-build
---

<!--
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# Clinical ASR Flywheel — Stage 1 (Setup)

> **Agent: this file is the complete Stage 1 procedure.** Do not invoke `find`, `ls`, `rg`, or `grep` looking for an installer or hidden config — there isn't one. The four sections below (outbound-data disclosure, three numbered checks, sibling hand-off) are all required reading; don't skip any. Function IDs, env-var conventions, and the smoke-test gate are inlined further down — answer from what's actually written here rather than from prior Riva/NVCF familiarity.

Stage 1 has one job: prove the user can reach NVIDIA's hosted speech stack with the `NVIDIA_API_KEY` they currently hold. Once a single clinical sentence round-trips through Magpie TTS → Parakeet/Nemotron ASR successfully, the user is cleared to advance to `/digital-health-clinical-asr-build`.

The four-stage flywheel exists to drive down **KER (keyword error rate)** on clinical entities — drugs, procedures, anatomy, conditions, labs, roles. WER averages obscure the failures that hurt clinically; KER is what Stage 3 will measure you against.

There is **no installer script** anywhere in this skill — not `install.sh`, not `setup.py`, nothing hidden. Stage 1 *is* the three steps below: verify the key, install Python deps, run the smoke test. Anything past Stage 1 is composed from sibling skills (`/data-designer`, `/riva-tts`, the inlined Stage 3 ASR recipe, `/riva-asr-custom`). If a user asks "what script installs everything?", answer from this paragraph; don't go searching.

## Outbound data flows — surface before any text or audio is sent

Two external endpoints receive data during this flywheel. The user has to acknowledge both before Stage 2 begins, against whatever data-governance policy their organization enforces. **Render the table below word-for-word in your response — a paraphrase doesn't satisfy the disclosure; the literal phrasing is what counts.**

| Service | What gets sent | When | Hosted by |
|---|---|---|---|
| **NVIDIA NVCF** (`grpc.nvcf.nvidia.com`) | The clinical sentences you synthesize (text), and the WAV files you transcribe (audio) | Every Stage 2 TTS call and every Stage 3 ASR call | NVIDIA, governed by build.nvidia.com terms |
| **Merriam-Webster** (`dictionaryapi.com` JSON API **or** the public `merriam-webster.com` HTML site) | Individual clinical terms (drug names, anatomy, procedures), one HTTP request per term | Stage 2 IPA tagging — see "Two MW paths" below for which endpoint applies | Merriam-Webster, governed by their API or site terms |

The data is **synthetic by construction** — the flywheel manufactures sentences and audio from a user-curated term list, never from real patient encounters. That said: **do not feed real patient transcripts, recorded clinical audio, or any PHI through any stage.** If the term list itself contains sensitive material (codename drugs, unreleased product names), the user should consult their organization's external-API policy before proceeding. Either endpoint can be turned off:

- **Skip Merriam-Webster entirely:** leave `DICTIONARY_API_KEY` unset and don't run a scraper. Stage 2 falls back to Magpie G2P, which still works but with weaker coverage on long-tail clinical terms.
- **Skip NVCF:** this is a hard stop. Magpie TTS + Parakeet/Nemotron ASR *are* the workload; without them this skill family is the wrong tool — a self-hosted ASR/TTS pipeline is what you want instead.

Recommend a copy of this notice lands in the user's workspace `README.md`; bring it forward on first invocation if it isn't already there.

## Purpose

Get a fresh environment ready for Stage 2. Three things to confirm: key is present, deps import cleanly, hosted stack actually answers. Close by naming which skill to run next.

The four `digital-health-clinical-asr-*` skills are **self-contained** — every TTS, ASR, IPA-tagging, and scoring recipe lives inside them; no other agent skill needs installing to run the flywheel end-to-end.

This skill takes no opinion on workspace layout. The user decides where their cycle artifacts live; `data/eval_sets/cycle<N>/` is not imposed.

## When to use this skill

Activate on user phrases like:

- "Set up the Clinical ASR Flywheel"
- "Initialize the clinical-asr eval"
- "I want to evaluate ASR on clinical terminology — where do I start?"
- "Bootstrap my environment for the flywheel"
- "What do I need installed before I run the flywheel?"

Do **not** activate when:

- The user already has a manifest and wants to score it → `/digital-health-clinical-asr-eval`
- The user already has the env set up and wants to curate terms → `/digital-health-clinical-asr-build`
- The user is asking about Stage 4 fine-tune NGC/Docker setup specifically → that's covered inside `/digital-health-clinical-asr-finetune`

## Prerequisites

| Requirement | Required? | Why | How |
|---|---|---|---|
| `NVIDIA_API_KEY` (`nvapi-…`) | **Required** | Hosted Magpie TTS + Parakeet/Nemotron ASR via NVCF | Issue at <https://build.nvidia.com>; `export NVIDIA_API_KEY=...` in shell |
| Python ≥ 3.10 | **Required** | NeMo client, scoring, manifest tools | `python3 --version` |
| `nvidia-riva-client`, `pandas`, `soundfile`, `requests` | **Required** | TTS + ASR clients, manifest I/O, MW lookup | `pip install nvidia-riva-client pandas soundfile requests` |
| `DICTIONARY_API_KEY` | Optional | Merriam-Webster Medical Dictionary lookup via the JSON API (Path A in the build skill — recommended) | Free key at <https://dictionaryapi.com>. Path B (HTML scrape of `merriam-webster.com`, no key, brittle) is also documented in the build skill if you can't get a key. Without either path, Stage 2 falls through to Magpie G2P with weaker long-tail coverage. |
| `jiwer` | Optional | Reference WER/CER against the inlined Levenshtein implementation | `pip install jiwer` — the eval skill includes a pure-Python fallback |
| (Stage 4 only) `NGC_API_KEY` + CUDA host + NeMo container | Optional, deferred | Fine-tune workload | Set up inside `/digital-health-clinical-asr-finetune`; defer until the eval shows KER > 0.3 |

## Instructions

**Scope.** This skill performs **read-only environment checks**: confirming a key is exported (length-only), the Python version, that libraries import, and that the hosted NVCF stack responds to a single smoke-test round-trip. It does **not** install system packages, modify shell rc files, write to disk outside an explicit `.venv/`, or attempt to authenticate with the real key value. Validate; never mutate without explicit user direction.

### 1a. Verify `NVIDIA_API_KEY` (length-only — never echo the value)

```bash
# Export NVIDIA_API_KEY in your shell — never echo or commit the value
export NVIDIA_API_KEY=nvapi-...     # from https://build.nvidia.com

# Length-only check; the key value never appears in any log
test -n "$NVIDIA_API_KEY" && echo "NVIDIA_API_KEY len=${#NVIDIA_API_KEY}"
```

A length of 70+ is normal. If the output is empty or shows `len=0`, the user must paste a key from <https://build.nvidia.com>. Do **not** print the key, even truncated. To persist across shell sessions, add the `export` line to your shell rc (`~/.bashrc`, `~/.zshrc`) — or use a per-directory tool like `direnv`.

### 1b. Install Python dependencies

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install nvidia-riva-client pandas soundfile requests
# optional
pip install jiwer
```

For Stage 4 (fine-tune) only: `nemo-toolkit` and Docker + NVIDIA Container Toolkit are also required. Defer those to `/digital-health-clinical-asr-finetune` — there is no point installing them up front if the user may never reach Stage 4.

### 1c. Smoke-test the hosted NVCF stack

**`NVIDIA_API_KEY` handling — load-bearing, do not deviate:**

- The agent harness reads `$NVIDIA_API_KEY` from the shell and passes it as an **explicit function argument** to `smoke_test(api_key=…)`.
- Auditors can grep the recipe for every wire crossing — every `api_key` use is visible in `auth_for(...)`.
- Do **not** `echo`, `print`, or log the key value (including truncated). Length-only checks are fine (see §1a).
- Do **not** let the recipe read `os.environ["NVIDIA_API_KEY"]` itself — the explicit-argument pattern is the auditability guarantee.
- Do **not** commit the key to any file, including `.env` examples or notebook outputs.

Verify the `NVIDIA_API_KEY` actually works against Magpie TTS and Parakeet/Nemotron ASR before advancing. The four skills inline every recipe needed; this round-trip just confirms the API key + network path are real.

The agent harness loads the `NVIDIA_API_KEY` shell variable and passes it as an explicit function argument to the helpers below. The recipe code itself does not read environment variables — auditors can see exactly which API keys cross the wire.

```python
import wave, tempfile
import riva.client

NVCF_HOST = "grpc.nvcf.nvidia.com:443"
MAGPIE_FUNCTION_ID    = "877104f7-e885-42b9-8de8-f6e4c6303969"   # Magpie TTS
PARAKEET_FUNCTION_ID  = "d3fe9151-442b-4204-a70d-5fcc597fd610"   # Parakeet TDT 0.6B v2 (offline ASR)

def auth_for(function_id: str, api_key: str) -> riva.client.Auth:
    return riva.client.Auth(
        use_ssl=True, uri=NVCF_HOST,
        metadata_args=[
            ["function-id", function_id],
            ["authorization", f"Bearer {api_key}"],
        ],
    )

def smoke_test(api_key: str) -> str:
    """Caller passes api_key (the harness reads $NVIDIA_API_KEY at the shell;
    this code never touches the environment). Returns the ASR transcript."""

    # 1. TTS: "The patient was prescribed cefazolin."
    tts = riva.client.SpeechSynthesisService(auth_for(MAGPIE_FUNCTION_ID, api_key))
    pcm = b"".join(c.audio for c in tts.synthesize_online(
        text="The patient was prescribed cefazolin.",
        voice_name="Magpie-Multilingual.EN-US.Mia",
        language_code="en-US", sample_rate_hz=16000,
    ))
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        with wave.open(f, "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(pcm)
        wav_path = f.name

    # 2. ASR: transcribe the WAV we just synthesized.
    asr = riva.client.ASRService(auth_for(PARAKEET_FUNCTION_ID, api_key))
    with open(wav_path, "rb") as f:
        audio_bytes = f.read()
    config = riva.client.RecognitionConfig(
        encoding=riva.client.AudioEncoding.LINEAR_PCM,
        sample_rate_hertz=16000, language_code="en-US",
        max_alternatives=1, enable_automatic_punctuation=True,
    )
    response = asr.offline_recognize(audio_bytes, config)
    transcript = response.results[0].alternatives[0].transcript if response.results else ""
    print(f"TTS:  The patient was prescribed cefazolin.")
    print(f"ASR:  {transcript}")
    return transcript

# Invoke from the agent (api_key sourced by the harness, not by this code):
# smoke_test(api_key="<NVIDIA_API_KEY value>")
```

**Run the smoke test — don't defer it.** This is the gate that proves Stages 2–4 can reach the hosted stack with the user's current key. "I can run it later" is not an acceptable completion of Stage 1; either invoke `smoke_test(api_key=…)` now or, if the user has explicitly opted out, log the deferral in your closing summary so they know what they're missing.

If the transcript matches the input within ~1 token, the hosted stack is reachable and the user can advance to Stage 2. If either call fails:

- `401 Unauthorized` / `PERMISSION_DENIED` → `NVIDIA_API_KEY` is wrong, expired, or not exported in this shell. Re-export and re-test.
- `404` / `INVALID_ARGUMENT: function not found` → the function ID is stale. Look up the current ID at <https://build.nvidia.com> and update the constant above.
- `RESOURCE_EXHAUSTED` → NVCF rate limit. Retry after 30 seconds; this is normal under load.
- Network/TLS errors → corporate proxy or DNS issue. Test `curl https://build.nvidia.com` first.

### 1d. (Optional) Verify Merriam-Webster lookup

Two paths produce a `merriam-webster`-tagged manifest row in Stage 2. Pick one (or neither — Magpie G2P fall-through is a valid posture):

- **Path A — JSON API + key.** Recommended for standalone use of this skill. Check the key is set:

  ```bash
  test -n "$DICTIONARY_API_KEY" && echo "DICTIONARY_API_KEY len=${#DICTIONARY_API_KEY}" \
    || echo "DICTIONARY_API_KEY not set — Path A is off"
  ```

  Free key issues instantly at <https://dictionaryapi.com>.

- **Path B — HTML scraping.** No API key needed; reachability is the only prerequisite. Brittle to MW site HTML changes; recipe inlined in the build skill's `references/pronunciation-pipeline.md`.

  ```bash
  curl -fsS -o /dev/null -w "merriam-webster.com reachable, HTTP %{http_code}\n" \
    https://www.merriam-webster.com/medical/cefazolin
  ```

  If you don't want to maintain a scraper, use Path A instead.

Remember the data-disclosure note at the top: under either path, each clinical term in your seed list goes out as an HTTP request to a Merriam-Webster endpoint.

## Examples

**Fresh shell, never run before.** User says something like *"I want to start the flywheel."* → Quote the disclosure table first, then walk through 1a → 1b → 1c in order. On a green smoke test, point them at `/digital-health-clinical-asr-build` and explicitly name KER as the metric Stage 3 will judge them by.

**Returning user, env already up.** User says *"I already have the env, just confirm I'm good to go."* → Skip the venv + `pip install` (1b). Run only the length check (1a) and the smoke test (1c). On green, advance.

## Artifacts produced

- `NVIDIA_API_KEY` exported in the user's shell
- An activated virtualenv with `nvidia-riva-client`, `pandas`, `soundfile`, `requests`
- A confirmed TTS→ASR round-trip on a clinical sentence (proof the hosted stack works)

No manifest, audio, or model artifact is produced at this stage — those come at Stages 2–4.

## Troubleshooting

- **Length check shows nothing or `len=0`** → `NVIDIA_API_KEY` isn't exported in this shell. Run `export NVIDIA_API_KEY=nvapi-...` and re-check.
- **Variable is set in one shell but not another** → exports don't persist across sessions. Add the `export` line to your shell rc (`~/.bashrc`, `~/.zshrc`), or use a per-directory loader like `direnv`.
- **`401 Unauthorized` on the smoke test** → key value is wrong or expired. Re-issue at <https://build.nvidia.com>.
- **`grpc.RpcError: function not found`** → the inlined function IDs need updating against the current NVCF catalog. Check <https://build.nvidia.com> and edit the constants in 1c. The eval skill (`/digital-health-clinical-asr-eval`) provides a catalog of current function IDs in its Step 3a "Other catalog options" list.
- **`StatusCode.INVALID_ARGUMENT` with `CUDA error: an illegal memory access was encountered`** → NVCF-side backend fault on this specific function ID (Triton/PyTorch on NVCF, not your env). Either retry later or temporarily point at a different offline ASR NIM — Whisper Large v3 function-id `b702f636-f60c-4a3d-a6f4-f3568c13bd7d` is the closest drop-in (also offline; pass `language_code="en"` instead of `"en-US"`). For routine eval cycles, prefer to wait for the Parakeet backend to recover so Stage 3 baseline and Stage 4 SFT base stay aligned.
- **`TypeError: Auth.__init__() got an unexpected keyword argument 'ssl_cert'`** → you're on `nvidia-riva-client >= 2.x` where the kwarg was renamed to `ssl_root_cert` (and is no longer needed for hosted NVCF). Drop the `ssl_cert=None,` line from your local copy of the recipe.
- **`ModuleNotFoundError: riva.client`** → step 1b was skipped or the venv isn't activated. `source .venv/bin/activate && pip install nvidia-riva-client`.

## Limitations

- **Scope is environment readiness only.** Whether the user's term list or pronunciation overrides make sense is decided in `/digital-health-clinical-asr-build`, not here.
- **Magpie en-US assumption.** Downstream IPA validation rides on Magpie's English phoneme inventory; other locales require a different phoneme set entirely.
- **Hosted NVCF is the assumed deployment.** Running self-hosted Riva NIMs is possible but the setup for that lives inside `/digital-health-clinical-asr-finetune` Stage 4d.
- **Synthetic data only.** This skill family is built for benchmarks generated from a curated term list. Real patient transcripts and recorded audio must not flow through any stage.

## Next steps

**Mandatory close on success:** finish the Stage 1 response by **pointing the user explicitly to `/digital-health-clinical-asr-build`** and **naming KER (keyword error rate) as the headline measure** they'll see at Stage 3. Both pointers are required, not optional — they place the user inside the four-stage flywheel.

- **Default forward route:** `/digital-health-clinical-asr-build` — specialty interview, term curation, IPA tagging, NeMo manifest synthesis.
- **Direct jump to Stage 3** (only when the user is bringing their own NeMo-format manifest with `term` / `entity_category` / `ipa_source` fields): `/digital-health-clinical-asr-eval`.

## References

- [`references/dependency-ownership.md`](references/dependency-ownership.md) — boundary between skill-owned and companion-owned responsibilities.

