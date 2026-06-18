---
name: nv-reason-cxr
description: Used for command-shape or live NV-Reason-CXR chest X-ray reasoning smoke tests. Not for diagnosis or clinical reporting.
license: Apache-2.0
allowed-tools: Bash
metadata:
  author: NVIDIA MedTech Team
  tags:
    - MedTech
    - CXR
    - reasoning
---

# NV-Reason-CXR

## Purpose
- Used for command-shape or live NV-Reason-CXR chest X-ray reasoning smoke tests. Not for diagnosis or clinical reporting.
- Use the wrapper exactly as documented; do not replace the upstream entrypoint with a handwritten implementation.
- Manifest I/O: inputs are `chest_xray_image_or_fixture`; outputs are `result_json`.

## Instructions
- Read `skill_manifest.yaml` before changing arguments, side effects, or validation gates.
- Run `scripts/run_nv_reason_cxr.py` through the documented command below; pass `--out-dir` only for generated fixtures or harness-managed artifact directories.
- If a host agent exposes `run_script`, use `run_script("scripts/run_nv_reason_cxr.py", args=[...])`; otherwise run the Bash/Python command shown below.
- Check the emitted JSON and paired verifier guidance before treating the run as evidence.
- When reporting a completed run, return the full wrapper JSON or at minimum
  the complete `output.response_text` exactly as emitted, including any
  model-generated `<think>...</think>` and `<answer>...</answer>` sections. Do
  not collapse the result to labels unless the user explicitly asks for a
  summary.

## Available Scripts
| Script | Purpose | Arguments |
|---|---|---|
| `scripts/run_nv_reason_cxr.py` | Primary entrypoint declared by skill_manifest.yaml. | `PATH_TO_CXR_OR_FIXTURE [--out-dir OUT_DIR] [--backend local\|hf-space-api] [--mock] [--check-setup]` |

## Prerequisites
- Local backend requirements: GPU/CUDA when declared by the manifest; Python packages listed in `runtime.side_effects.pip_packages`.
- API backend requirements: public network access to the [Hugging Face Space](https://huggingface.co/spaces/nvidia/nv-reason-cxr); no local PyTorch, Transformers, CUDA, model cache, or Hugging Face token.
- Side effects: emits result JSON on stdout; may write generated fixture artifacts under the caller's `--out-dir`; may cache model assets under `~/.cache/huggingface/` for local inference; and may contact `https://huggingface.co`, `https://github.com`, or `https://*.hf.space` outside `--mock` mode.
- Run commands from the repository root unless an existing section below says otherwise.

## Limitations
- This is a thin wrapper. Image preprocessing, model inference, and decoding are delegated to Hugging Face Transformers and the NV-Reason-CXR-3B model.
- Output is not a diagnosis, clinical report, treatment recommendation, or triage decision. It is engineering evidence and must be reviewed by a qualified professional before any medical use.
- The model may hallucinate findings, miss subtle abnormalities, misread support devices, or produce overconfident prose.
- The committed fixture uses a generated synthetic PNG and deterministic mock response so CI can verify wrapper behavior without downloading model weights. Mock mode is not a substitute for model inference.
- The `hf-space-api` backend depends on public Hugging Face Space availability and API compatibility.
- Not for clinical deployment, clinical interpretation, autonomous diagnosis, treatment decisions.

## Troubleshooting
| Error | Cause | Fix |
|---|---|---|
| Missing dependency or import error | Runtime package drift from `skill_manifest.yaml`. | Install the packages declared in the manifest or use the documented setup command. |
| CUDA unavailable from an agent but available in a user terminal | The agent sandbox, container, or job wrapper may not expose NVIDIA device nodes even when the same Python environment has CUDA-capable PyTorch installed. | Compare `python -c "import torch; print(torch.cuda.is_available())"` and `nvidia-smi` inside the agent context and in the user terminal. If only the agent context fails, rerun with GPU/device access, use the host terminal, or pass `--device cpu --allow-cpu` only for an explicit slow CPU test. |
| API backend HTTP or schema error | The public Hugging Face Space may be unavailable, rate limited, or changed. | Re-run later or use `--backend local` when local dependencies and CUDA are available. |
| Empty or schema-invalid output | Wrong input path, unsupported modality, or upstream failure. | Re-run with a known fixture and inspect the wrapper JSON plus stderr. |
| Validation gate failure | Output violated a declared engineering invariant. | Keep the failed evidence pack and use the gate message to repair inputs or wrapper code. |

Runs NVIDIA-Medtech [`NV-Reason-CXR-3B`](https://github.com/NVIDIA-Medtech/NV-Reason-CXR)
for chest X-ray image interpretation through either the documented local
Hugging Face Transformers inference path or the public Hugging Face Space API.
The wrapper does not reimplement the model, image preprocessing, or decoding.


## Exact Runnable Surface

For command-shape smoke tests and JSON fixtures, use this repo-root wrapper path exactly:

```bash
python skills/nv-reason-cxr/scripts/run_nv_reason_cxr.py PATH_TO_CXR_OR_FIXTURE --mock --out-dir OUT_DIR
```

For local live image inference, omit `--mock` only when the user asks for live
model inference. Local is the default backend:

```bash
python skills/nv-reason-cxr/scripts/run_nv_reason_cxr.py PATH_TO_CXR_OR_FIXTURE \
  --prompt "Find abnormalities and support devices." \
  --backend local
```

For public API inference without local model packages, use:

```bash
python skills/nv-reason-cxr/scripts/run_nv_reason_cxr.py PATH_TO_CXR_OR_FIXTURE \
  --prompt "Find abnormalities and support devices." \
  --backend hf-space-api
```

Do not invent `Medical AI Skills run`, `eval_engine/run.py`, `infer.py`, or
`python -m nv_reason_cxr` commands for ordinary user runs.

## Preconditions

For `--backend local`, install the inference dependencies in the environment
that will run the skill:

```bash
pip install torch==2.7.1 torchvision==0.22.1 transformers==4.56.1 Pillow
```

The model weights are loaded from `nvidia/NV-Reason-CXR-3B` through
Transformers. They may download to the Hugging Face cache on first use.
Set `TRANSFORMERS_OFFLINE=1` or pass `--local-files-only` only after the
weights are already cached.

CUDA is expected for practical inference. CPU execution may work for small
tests but is slow and must be requested explicitly.

For `--backend hf-space-api`, no local PyTorch, Transformers, CUDA, model
cache, or Hugging Face token is required. The backend sends the image and
prompt to the public `nvidia/nv-reason-cxr` Hugging Face Space.

Check the local environment before downloading weights or running inference:

```bash
python skills/nv-reason-cxr/scripts/run_nv_reason_cxr.py --check-setup
```

The setup report checks importable dependencies, CUDA visibility, Hugging Face
cache state, and the recommended next step.

Operational environment variables:

| Variable | When to use |
|---|---|
| `MOCK_NV_REASON_CXR` | Set to `1` for deterministic command-shape smoke tests without model inference. |
| `NV_REASON_CXR_MODEL` | Override the Hugging Face model id only for compatibility probes. |
| `HF_HOME` | Point at a pre-populated Hugging Face cache. |
| `HF_TOKEN` | Optional for local model downloads only when required by the local environment; not needed for the public API backend. |
| `TRANSFORMERS_OFFLINE` | Set to `1` only after weights are already cached. |
| `HF_HUB_OFFLINE` | Set to `1` only after Hugging Face assets are already cached. |

## Prompt Routing

Choose both the model prompt and the user-facing output mode before running
the wrapper. Routing order matters: exact model-prompt requests use
pass-through/raw-only mode first; otherwise report-generation requests take
precedence over general analysis and specific-question routing.

Use pass-through/raw-only mode only when the user explicitly asks to send an
exact prompt to the model, such as "call the model with this prompt exactly:
...". Pass only that exact model prompt as `--prompt`.

Use abnormality-analysis mode when the user asks to analyze, examine, or find
abnormalities in a chest X-ray. Treat local image paths, uploaded filenames,
backend choices such as "use API" or "use local", output delivery instructions,
and other agent orchestration text as wrapper instructions, not model prompt
content. Do not include local filesystem paths, backend names, or "use API" in
`--prompt` unless the user explicitly asks to send that exact text to the
model. For ordinary abnormality-finding requests, use the documented prompt,
usually `--prompt "Find abnormalities and support devices."`, with the
requested backend.

Use report-generation/two-call mode if the user asks to write, create, or
generate a structured report, chest X-ray report, radiology report, or report.
If sufficient raw model context for the same image is already available,
especially output from `Find abnormalities and support devices.`, skip the context-gathering
call. Otherwise first run the wrapper with `--prompt "Examine the chest
X-ray."` to gather context, but do not show that first call. Then run the
wrapper again with a multi-turn transcript prompt:

```text
User: Find abnormalities and support devices.

Assistant:
<raw model context>

User: Write a structured report.
```

Treat the second call as the completed run.

Use default-prompt/context-answer mode when the user asks a specific question
about a finding, such as presence, count, location, or characterization, or
mixes general analysis with specific questions. Run the wrapper with
`--prompt "Find abnormalities and support devices."` before answering the original question
in plain text prefixed exactly with `Answer:`. Base the answer only on the raw
model output context and the image.

## Follow-up Handling

For follow-up questions about an image already analyzed in the conversation,
reuse prior raw model context when it is sufficient. For report follow-ups, use
report-generation/two-call mode and skip directly to the second model call if
there is sufficient context. If prior context is insufficient and the same
image path or image bytes are available, call the wrapper again using the
prompt routing rules above. If the image is no longer available, ask the user
to reattach it.

For long multi-turn prompts that include prior raw model output, prefer a
quoted Bash here-doc variable so XML-like tags, apostrophes, quotes, and
newlines are preserved:

```bash
IFS= read -r -d '' prompt <<'PROMPT'
User: Examine the chest X-ray.

Assistant:
<raw model context>

User: Write a structured report.
PROMPT

python skills/nv-reason-cxr/scripts/run_nv_reason_cxr.py PATH_TO_CXR.png \
  --prompt "$prompt" \
  --backend hf-space-api
```

Use `IFS= read -r -d '' prompt <<'PROMPT'`, not command substitution, for long
pasted transcripts.

## License

The upstream repository code is Apache-2.0. The model weights are released
under the NVIDIA OneWay Noncommercial License Agreement. Users are responsible
for complying with the model-weight terms before live inference.

## Usage

From Medical AI Skills repo root:

```bash
python skills/nv-reason-cxr/scripts/run_nv_reason_cxr.py PATH_TO_CXR.png \
  --prompt "Find abnormalities and support devices." \
  --backend local
```

For public API inference without installing model packages locally:

```bash
python skills/nv-reason-cxr/scripts/run_nv_reason_cxr.py PATH_TO_CXR.png \
  --prompt "Find abnormalities and support devices." \
  --backend hf-space-api
```

For user requests that include local path or backend instructions, keep those
instructions out of the model prompt:

```text
User request: find abnormalities in ~/Desktop/363.jpg (use API)
```

```bash
python skills/nv-reason-cxr/scripts/run_nv_reason_cxr.py ~/Desktop/363.jpg \
  --prompt "Find abnormalities and support devices." \
  --backend hf-space-api
```

Use the wrapper script directly for agent-generated commands. Do not replace
it with `eval_engine/run.py` unless the user explicitly asks to run the eval
harness. Do not redirect stdout with `>` in generated commands: callers and
the eval harness read the wrapper's stdout JSON to verify the run. The direct
runnable surface is:

```bash
python skills/nv-reason-cxr/scripts/run_nv_reason_cxr.py PATH_TO_CXR_OR_FIXTURE \
  --mock \
  --out-dir runs/nv_reason_cxr_case
```

`PATH_TO_CXR_OR_FIXTURE` may be a PNG/JPEG image or a JSON fixture. If the
user provides a JSON request such as
`runs/.../synthetic_cxr_input.json`, pass that exact JSON path as the first
argument. The script will load `generated://synthetic_chest_xray` fixtures,
create the temporary PNG under the output directory, and emit JSON with the
model response. Use `--mock` only for command-shape smoke tests or fixtures
that request mock mode; omit `--mock` for live model inference.

For JPEG input:

```bash
python skills/nv-reason-cxr/scripts/run_nv_reason_cxr.py PATH_TO_CXR.jpg \
  --prompt "Describe the chest X-ray findings." \
  --backend local
```

Flags:

- `--backend local|hf-space-api` — inference backend, default `local`.
- `--model-id` — Hugging Face model id, default `nvidia/NV-Reason-CXR-3B`.
- `--device auto|cuda|cpu` — default `auto`, using CUDA when available.
- `--allow-cpu` — required for live CPU inference; CPU runs can be very slow.
- `--torch-dtype auto|float16|bfloat16|float32` — default `auto`, using
  bfloat16 on CUDA and float32 on CPU, matching the published BF16 model.
- `--max-new-tokens` — generation cap, default 2048.
- `--local-files-only` — use only locally cached Hugging Face assets.
- `--mock` — deterministic dry-run response for CI and wiring checks.
- `--prompt-preset findings|comprehensive|educational|structured` — optional
  known-good prompt presets from the model card/demo behavior.
- `--out-dir` — optional artifact directory. Required for generated JSON
  fixtures; the eval harness passes it explicitly.

The tested local live path uses:

- `AutoModelForImageTextToText.from_pretrained(..., dtype=torch.bfloat16).eval().to("cuda")`
- `AutoProcessor.from_pretrained(..., use_fast=True)`
- PNG/JPEG image input plus one text prompt
- `max_new_tokens=2048` by default

The script emits JSON on stdout and writes no clinical report files. Direct
PNG/JPEG runs do not create a default output directory. Generated JSON fixtures
require `--out-dir` for the temporary synthetic image. The result JSON records
input image metadata, prompt, model id, runtime mode, response text, and known
limitations. If `runtime.truncated_by_max_new_tokens` is `true`, rerun with a
higher `--max-new-tokens` value.

Reporting reminder: for both `local` and `hf-space-api` backends, follow the
completed-run rule in Instructions.

The `hf-space-api` backend calls the fixed public Hugging Face Space at
`https://nvidia-nv-reason-cxr.hf.space` with a 300 second HTTP timeout.

## Fixture Smoke Test

The committed fixture uses a generated synthetic PNG and mock mode so the
eval harness can verify the wrapper without downloading weights:

```bash
python eval_engine/run.py skills/nv-reason-cxr \
  --fixture skills/nv-reason-cxr/fixtures/synthetic_cxr_input.json \
  --out runs/nv_reason_cxr_smoke
```

## Limits

This is research and engineering tooling only. It is not validated for
clinical diagnosis, treatment decisions, triage, patient-facing reporting, or
regulatory use. Model outputs can hallucinate, miss subtle findings, or
overstate uncertainty. A qualified professional must review any use in a
medical workflow.
