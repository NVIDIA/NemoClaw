# Riva ASR Pipeline Configuration

> **Note:** All `riva-build` commands run **inside the NIM container** — enter with `--entrypoint /bin/bash` (see [`asr-custom.md`](asr-custom.md)).
>
> **Source of truth.** This skill describes the `riva-build` command shape and pipeline component concepts, which are stable. For per-release detail — full parameter list, current NGC artifact paths, default values, decoder support per model family — **fetch or open the canonical doc page and answer from that, not from this skill's text.** See [Looking up current information](#looking-up-current-information) below.

## Purpose

Configure advanced ASR pipeline options when building a custom Riva NIM with `riva-build`. Covers streaming vs offline configuration, decoder selection, language models (ARPA / KenLM / NeMo), voice activity detection, endpointing, and speaker diarization. Choose streaming vs offline mode first, then apply the relevant components.

## Looking up current information

| Question type | Fetch this page |
|---|---|
| **Full `riva-build` parameter list, defaults, decoder/VAD/diarizer options per model family** | https://docs.nvidia.com/nim/speech/latest/asr/customization/pipeline-configuration.html |
| **Runtime customizations** that don't require a rebuild (`--custom-configuration` keys, runtime VAD / endpointing tuning) | https://docs.nvidia.com/nim/speech/latest/asr/customization/customization.html |
| **gRPC proto contract** (RecognitionConfig, custom_configuration map, runtime_config map) | https://docs.nvidia.com/nim/speech/latest/reference/api-references/asr/protos.html |
| **Current NGC artifacts** — `.riva` checkpoints, Silero VAD, Sortformer diarizer, P&C models, exact versions | https://catalog.ngc.nvidia.com/orgs/nim/teams/nvidia/models |
| **Get all parameters from inside the container** | `riva-build --config-path=pkg://servicemaker.configs.asr --config-name=streaming -h` (or `=offline`) |
| Which model families support which decoders / VAD / diarization | https://docs.nvidia.com/nim/speech/latest/asr/customization/customization.html |

**Do not infer from this skill's text:** which decoder a specific model family uses today, which VAD / diarizer artifacts exist on NGC, what the current default values are, or whether a feature is supported by a specific model. The doc and `riva-build -h` are the contract.

## Prerequisites

- Complete [`asr-custom.md`](asr-custom.md) first: NIM container available and `NGC_API_KEY` exported
- A deployable `.riva` artifact from NGC. If the user has their own fine-tuned `.nemo` checkpoint, pass it inline to `riva-build` via the `nemo2riva` `source_path` config; copy the exact config from the Notes section for that model in the pipeline configuration page.
- All `riva-build` commands in this skill run **inside the NIM container** (enter with `--entrypoint /bin/bash`)

## Instructions

All `riva-build` commands run **inside the NIM container** (see [`asr-custom.md`](asr-custom.md) Phase 2). Choose `--config-name=streaming` or `--config-name=offline` first, then apply the pipeline components (decoder, language model, VAD, diarization) relevant to your use case. **Run `riva-build -h` inside the container for the canonical parameter list** — defaults and supported values are version-specific.

For runtime tuning that doesn't require a rebuild (VAD thresholds, endpointing parameters, custom_configuration keys), fetch the customization page cited in the routing table — many parameters can be changed per request.

## Streaming vs Offline Configuration

Choose `--config-name=streaming` or `--config-name=offline` depending on your inference mode.

For full `riva-build` syntax and all parameters, fetch the pipeline configuration page cited in the routing table.

## Decoder Choice (general guidance — verify per model)

| Family | Typical decoder | Notes |
|---|---|---|
| CTC (Parakeet CTC, Conformer) | `greedy` or `flashlight` | `flashlight` for language-model support |
| RNNT / TDT (Parakeet RNNT, Parakeet TDT, Nemotron) | `nemo` | Add `nemo_decoder.use_stateful_decoding=true` for streaming |

**Verify the decoder for a specific model on the customization page** — newer model families may add or change supported decoders. Run `riva-build --config-name=<streaming|offline> -h` to see currently accepted decoder values.

## Chunk Size Reference

`chunk_size` is a server-side pipeline/deployment setting for Riva ASR streaming models.
It is not the same thing as client send chunking (`--chunk_duration_ms`,
`--file-streaming-chunk`, or application gRPC message size). Changing server-side
`chunk_size` requires changing the deployment/profile/pipeline config and redeploying the
NIM; the server may accumulate or split incoming client audio to match its own chunk size.

| Parameter | Description | Low-Latency starting point | High-Throughput starting point |
|-----------|-------------|---------------------------|-------------------------------|
| `chunk_size` | Audio chunk sent to acoustic model (seconds) | 0.16 | 0.8 |
| `decoder_chunk_size` | Decoder window size (CTC) | 0.96 | — |
| `left_padding_size` | Left audio context (seconds) | 1.92 | 1.6 |
| `right_padding_size` | Right audio context (seconds) | 1.92 | 1.6 |

These are **starting points** for tuning, not authoritative defaults. Run `riva-build -h` for the current model defaults; benchmark for your hardware.

## Chunk Size Rationale

- **Throughput vs latency trade-off.** Increasing server-side `chunk_size` usually increases throughput by reducing iterations per second of audio, but it also increases processing latency slightly.
- **Partial transcript periodicity.** Perceived latency increases because partial transcripts are generated once per server chunk. With `chunk_size=160ms`, partials can be emitted every 160ms; with larger chunks, users wait longer between partials.
- **Final transcripts.** Final transcripts are not directly chunk-driven; they are triggered by EOU detection (endpointing parameters), or by client-driven `force_eou` (cache-aware RNNT only — see customization page). However, if `chunk_size` is high, the server may accumulate more audio until the chunk is filled, which can delay final transcripts too.
- **Tuning rule.** `chunk_size`, `left_padding_size`, and `right_padding_size` must all be multiples of `ms_per_timestep` for the model. Per-model values: see customization or pipeline-configuration page (typically 80 ms for Parakeet, 40 ms for Conformer; verify per release). Invalid values silently degrade accuracy.

---

## Language Models

Language model integration is per-decoder; not all decoders support every LM format. Verify on the pipeline configuration page.

**ARPA Format (CTC + Flashlight)**

```bash
decoder=flashlight \
decoding_language_model_arpa=/riva_build_deploy/lm.arpa \
decoding_vocab=/riva_build_deploy/vocab.txt
```

**KenLM Binary Format (CTC + Flashlight)**

```bash
decoder=flashlight \
decoding_language_model_binary=/riva_build_deploy/lm.binary \
decoding_vocab=/riva_build_deploy/vocab.txt
```

**Flashlight Decoder Hyperparameters**

```bash
decoder=flashlight \
decoding_language_model_binary=/riva_build_deploy/lm.binary \
decoding_vocab=/riva_build_deploy/vocab.txt \
flashlight_decoder.beam_size=128 \
flashlight_decoder.beam_size_token=64 \
flashlight_decoder.beam_threshold=25 \
flashlight_decoder.lm_weight=0.8 \
flashlight_decoder.word_insertion_score=0.0
```

| Parameter | Description |
|-----------|-------------|
| `beam_size` | Max hypotheses held at each step |
| `beam_size_token` | Max tokens considered at each step |
| `beam_threshold` | Prune threshold for hypotheses |
| `lm_weight` | Language model scoring weight |
| `word_insertion_score` | Penalty/bonus per inserted word |

**NeMo LM (RNNT / TDT)**

```bash
nemo_decoder.language_model_alpha=0.5 \
nemo_decoder.language_model_file=/riva_build_deploy/lm.nemo
```

**Lexicon-Free Decoding (CTC + Flashlight)**

```bash
decoder=flashlight \
flashlight_decoder.use_lexicon_free_decoding=True \
decoding_language_model_binary=/riva_build_deploy/charlm.binary
```

---

## Voice Activity Detection (VAD)

VAD detects speech start/end. Using VAD impacts latency and throughput. Silero VAD is the supported neural-VAD option as of writing — verify the current set of supported VAD types on the customization page.

### Deploy-Time Config (riva-build)

```bash
riva-build --config-path=pkg://servicemaker.configs.asr --config-name=<streaming|offline> \
  output_path=/riva_build_deploy/model.rmir \
  'source_path=[/riva_build_deploy/model.riva]' \
  vad_model=<path-to-vad-riva-from-NGC> \
  vad_type=silero \
  neural_vad.onset=0.85 \
  neural_vad.offset=0.3 \
  neural_vad.min_duration_on=0.2 \
  neural_vad.min_duration_off=0.5 \
  neural_vad.pad_onset=0.3 \
  neural_vad.pad_offset=0.08
```

The exact NGC path for the Silero VAD `.riva` artifact rotates between releases — fetch the current path from the NGC catalog (https://catalog.ngc.nvidia.com/orgs/nim/teams/nvidia/models).

### Silero VAD Parameters (runtime-tunable via `--custom-configuration`)

| Parameter | Default (verify per release) | Description |
|-----------|---------|-------------|
| `neural_vad.onset` | 0.85 | Speech start probability threshold. Increase (→0.9+) for noisy environments; decrease if soft speech is missed. |
| `neural_vad.offset` | 0.3 | Speech end probability threshold. Increase (→0.4+) to prevent premature cutoff. |
| `neural_vad.min_duration_on` | 0.2s | Minimum duration to count as valid speech. Increase (→0.3s) to filter coughs/short noises. |
| `neural_vad.min_duration_off` | 0.5s | Minimum silence to count as end of speech. Increase (→0.8s+) to avoid splitting on brief pauses. |
| `neural_vad.pad_onset` | 0.3s | Audio padding added before detected speech start. |
| `neural_vad.pad_offset` | 0.08s | Audio padding added after detected speech end. |

For the authoritative current set of runtime-tunable VAD keys and their defaults, **fetch the customization page**.

**Runtime tuning example:**

```bash
python scripts/asr/transcribe_file.py \
  --server 0.0.0.0:50051 \
  --input-file audio.wav \
  --custom-configuration "neural_vad.onset:0.9,neural_vad.min_duration_off:0.8"
```

**Scenario tuning starting points:**

- Noisy environment: raise `onset` (0.9+), raise `min_duration_on` (0.3 s)
- Soft / quiet speech: lower `onset` (0.7), increase `pad_onset` (0.4 s)
- Long pauses mid-sentence: increase `min_duration_off` (1.0 s+)
- Speech beginning clipped: increase `pad_onset` (0.4–0.5 s)
- Speech ending clipped: increase `pad_offset` (0.2–0.3 s)

**Tip:** Add `get_vad_probabilities:true` to `--custom-configuration` to receive per-window VAD probabilities in the response — useful for debugging.

### Endpointing Parameters (CTC blank-token-based)

Control utterance start/end detection. Most are runtime-tunable via client flags.

| Parameter | Default (verify per release) | Description |
|-----------|---------|-------------|
| `start_history` | 300 ms | Window to detect utterance start. |
| `start_threshold` | 0.2 | Fraction of non-blank frames in window to trigger start. |
| `stop_history` | 800 ms | Window to detect utterance end. Must be a multiple of 80 ms; minimum 560 ms recommended. |
| `stop_threshold` | 0.98 | Fraction of blank frames in window to trigger end and reset decoder. |
| `stop_history_eou` | — | Window for 1st-pass end-of-utterance (2-pass EOU). Must be < `stop_history`. |
| `stop_threshold_eou` | — | Threshold for 1st-pass EOU — emits partial transcript with stability=1. |

```bash
python scripts/asr/transcribe_file.py \
  --server 0.0.0.0:50051 \
  --input-file audio.wav \
  --start-history 300 \
  --start-threshold 0.2 \
  --stop-history 800 \
  --stop-threshold 0.98
```

For client-driven EOU (cache-aware RNNT models, e.g., Nemotron ASR Streaming): see `runtime_config["force_eou"]` documented on the customization page.

---

## Speaker Diarization

Add speaker diarization to identify who spoke when. Sortformer is the supported diarizer as of writing — verify on the customization page.

```bash
riva-build --config-path=pkg://servicemaker.configs.asr --config-name=offline \
  output_path=/riva_build_deploy/model.rmir \
  'source_path=[/riva_build_deploy/model.riva]' \
  diarization_model=<path-to-sortformer-riva-from-NGC> \
  diarization_type=sortformer \
  sortformer_diarizer.min_speakers=1 \
  sortformer_diarizer.max_speakers=8 \
  sortformer_diarizer.speaker_label_coverage=0.8
```

| Parameter | Description | Default (verify per release) |
|-----------|-------------|---------|
| `min_speakers` | Minimum number of speakers | 1 |
| `max_speakers` | Maximum number of speakers | 8 |
| `speaker_label_coverage` | Minimum coverage of speaker labels | 0.8 |

The exact NGC path for the Sortformer diarizer artifact rotates between releases — fetch from the NGC catalog. Diarization is currently offline-only — verify support for streaming diarization on the customization page.

---

## Get All Available Parameters

To see all configurable parameters for the version you're running, run inside the NIM container:

```bash
riva-build --config-path=pkg://servicemaker.configs.asr --config-name=streaming -h
riva-build --config-path=pkg://servicemaker.configs.asr --config-name=offline -h
```

This output is authoritative — defaults shown here are starting points and may differ per release.

---

## NGC Model Artifacts

All deployable `.riva` artifacts live under `nim/nvidia` on NGC. Names of model artifacts, their versions, and which artifacts exist (LMs, VAD, diarizers, P&C models) **change per release** — always browse the catalog for the current set:

https://catalog.ngc.nvidia.com/orgs/nim/teams/nvidia/models

Use `deployable_vX.Y` versions; `trainable_vX.Y` versions are for NeMo fine-tuning, not deployment.

Download with NGC CLI (run on host):

```bash
ngc registry model download-version \
  nim/nvidia/<model-name>:<version> \
  --dest /path/to/artifacts/
```

---

## Examples

**Build a CTC streaming pipeline with Silero VAD (inside container):**

```bash
riva-build --config-path=pkg://servicemaker.configs.asr --config-name=streaming \
  output_path=/riva_build_deploy/model.rmir \
  'source_path=[/riva_build_deploy/model.riva]' \
  decoder=greedy \
  vad_model=<path-from-NGC>/silero_vad.riva \
  vad_type=silero
```

**Runtime VAD tuning without rebuilding:**

```bash
python scripts/asr/transcribe_file.py \
  --server 0.0.0.0:50051 \
  --input-file audio.wav \
  --custom-configuration "neural_vad.onset:0.9,neural_vad.min_duration_off:0.8"
```

**Lookup flow — agent question "what decoders does Parakeet RNNT support?":**

1. Fetch or open the pipeline configuration page (or run `riva-build -h` against the live container)
2. Read the per-family decoder support
3. Answer with the current information

Do not answer decoder / VAD / diarizer support questions from this skill's text alone — the table here is a starting orientation only.

## Troubleshooting

- **All paths inside the container** — `riva-build` runs inside the NIM container; paths like `/riva_build_deploy/` refer to the mounted directory inside the container, not the host.
- **Decoder choice matters** — use `decoder=flashlight` for CTC with a language model; `decoder=greedy` for CTC without LM; `decoder=nemo` for RNNT / TDT models. Verify supported values for your version with `riva-build -h`.
- **Lexicon-based Flashlight** — the default Flashlight decoder is lexicon-based and only emits words in the vocabulary file. Words not in the vocab will not appear in transcripts.
- **Streaming TensorRT warnings on offline deploy** — format conversion warnings during `riva-deploy` for offline models are typically benign.
- **Chunk size must be a multiple of `ms_per_timestep`** — value is per-model (typically 80 ms for Parakeet, 40 ms for Conformer; verify on the customization page). Same applies to `left_padding_size` and `right_padding_size`. Invalid values cause silent accuracy degradation.
- **NGC artifact path 404** — artifact paths and versions rotate between releases; refresh the path from the NGC catalog.

## Limitations

- All `riva-build` commands must run inside the NIM container — the tool is not available on the host.
- Lexicon-free decoding only works with CTC models.
- Streaming `riva-build` config cannot be changed at inference time — most decoder / VAD / diarizer choices require a full rebuild. Many runtime parameters (VAD thresholds, endpointing, custom_configuration keys) can be tuned without rebuilding — verify on the customization page.
- KenLM binary format requires pre-compilation; ARPA format can be used directly.
