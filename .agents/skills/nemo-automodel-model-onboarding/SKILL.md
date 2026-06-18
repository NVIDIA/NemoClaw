---
name: nemo-automodel-model-onboarding
description: Guide for onboarding new model architectures into NeMo AutoModel, including architecture discovery, implementation patterns, registration, and validation.
when_to_use: Adding or modifying model architecture support in NeMo AutoModel, such as LLM/VLM/MoE model files, custom layers, state-dict adapters, registry entries, Hugging Face config mapping, or capability flags.
license: Apache-2.0
metadata:
  author: NVIDIA
  tags:
    - nemo-automodel
    - model-onboarding
---

# Adding Model Support to NeMo AutoModel

## Purpose

This skill guides implementation of new model architectures in NeMo AutoModel. Follow the five phases in order.

## Instructions

When answering an onboarding question, keep the response in this order:

1. Classify the architecture from `config.json`.
2. Name the exact implementation files under `components/models/<name>/`.
3. Identify registry and optional custom-config updates.
4. State the validation tests that must be added before full checkpoint use.

For conceptual onboarding questions, answer from this skill without opening the
pattern files unless the user asks you to edit code. Mention pattern filenames
as references, then give the direct checklist.

Use direct action verbs: classify the model, name the files, map the weights,
register the class, and add tests. Do not discuss distributed strategy,
launcher configuration, or general recipe authoring unless the user explicitly
connects it to onboarding a new architecture.

## Examples

Use these compact answer patterns for common questions:

- Dense causal LM: classify as dense only when `architectures` contains a
  `ForCausalLM` class and expert fields such as `num_local_experts`,
  `n_routed_experts`, or `num_experts_per_tok` are absent. Create
  `components/models/<name>/model.py`, `state_dict_adapter.py`, `__init__.py`,
  and optional `config.py`, register `MODEL_ARCH_MAPPING` in
  `_transformers/registry.py`, add example YAML, and add tiny-config unit tests
  plus layer-equivalence tests for rewritten layers.
- MoE state dict: identify expert fields in `config.json`, reference
  `moe-patterns.md`, map router tensors separately, preserve routed-expert
  index order, map routed experts, shared experts, and gate/up/down projections,
  add adapter key-map tests and tiny-config numerical equivalence tests, and do
  not rely only on `from_pretrained()` or silent tensor reshapes.
- VLM onboarding: classify as VLM only when `vision_config`, `text_config`, and
  a `ForConditionalGeneration` architecture are present. Reference
  `vlm-patterns.md` and existing VLM implementations such as `mistral4`,
  `kimivl`, or `kimi_k25_vl`; check text backbone, vision tower, projector,
  processor assumptions, text and vision `state_dict_adapter.py` mappings,
  registry registration, and tiny image-text tests before full checkpoints.
  Do not treat VLM onboarding as a pure causal-LM path or skip processor/image
  tests.

For MoE state-dict questions, always include the safety checklist:

- Map router tensors separately from expert tensors.
- Preserve routed-expert index order; never sort, drop, merge, or silently
  reshape expert weights to make loading pass.
- Map gate, up, and down projections explicitly, including combined projection
  layouts and shared experts when present.
- Add adapter key-map tests and tiny-config numerical equivalence tests before
  relying on full checkpoint loading.

For VLM questions, explicitly check `vision_config`, `text_config`, the
conditional-generation architecture, text backbone, vision tower, projector,
processor assumptions, registry entry, and tiny image-text tests.

## Routing Boundary

Use this skill only when the user is adding or modifying model architecture support: model files, custom layers, state-dict adapters, Hugging Face config mapping, registry entries, or model capability flags.

Do not use this skill for standalone training recipe YAML questions about optimizers, datasets, schedulers, validation datasets, or trainer wiring unless they are explicitly part of onboarding a new model architecture. Those recipe questions belong to the nemo-automodel-recipe-development skill.

In-scope examples:

- "Add support for a new Hugging Face causal LM architecture."
- "Map MoE router and expert weights from a Hugging Face checkpoint."
- "Register a new model class in NeMo AutoModel."

Out-of-scope examples:

- "Write a finetuning recipe YAML with optimizer and dataset sections."
- "Choose FSDP2, DDP, tensor parallel, or context parallel settings."
- "Configure Slurm, SkyPilot, containers, mounts, or launch dispatch."

## Phase 1: Discovery

Before writing code, gather information about the target model.

### 1.1 Fetch HuggingFace config.json

Download the model's `config.json` from the HuggingFace Hub (or use `AutoConfig.from_pretrained`). Key fields to extract:

- `architectures` -- determines the class name and registration key (e.g., `"LlamaForCausalLM"`, `"Qwen3MoeForCausalLM"`, `"Mistral3ForConditionalGeneration"`)
- `model_type` -- used for custom config registration in `_CUSTOM_CONFIG_REGISTRATIONS` if HF does not have a built-in config class
- `hidden_size`, `intermediate_size`, `num_hidden_layers`, `num_attention_heads`, `num_key_value_heads` -- sizing
- `vocab_size` -- needed for tiny test configs
- `tie_word_embeddings` -- whether lm_head shares weights with embed_tokens
- `hidden_act` -- activation function (e.g., `"silu"` for SwiGLU)

### 1.2 Determine model type

| Type | Indicators | Pattern file |
|------|-----------|-------------|
| **Dense LLM** | `ForCausalLM` in architectures, no expert fields | [llm-patterns.md](./llm-patterns.md) |
| **MoE LLM** | `n_routed_experts`, `num_local_experts`, `num_experts_per_tok` in config | [moe-patterns.md](./moe-patterns.md) |
| **VLM** | `ForConditionalGeneration` in architectures, has `vision_config` + `text_config` | [vlm-patterns.md](./vlm-patterns.md) |

### 1.3 Check for existing similar architectures

Look in `components/models/` for architectures with similar attention or MLP patterns:

```
components/models/
  llama/           # Standard GQA + SwiGLU (CombinedQKV + CombinedGateUpMLP)
  qwen2/           # Same as Llama but with attention bias + QKV bias
  baichuan/        # ALiBi attention variant
  deepseek_v3/     # MLA attention + MoE (DeepSeek-style grouped experts)
  mistral4/        # MLA + MoE + VLM (Pixtral vision)
  kimivl/          # DeepSeek-V3 backbone + MoonVit vision
  kimi_k25_vl/     # Updated KimiVL with different projector
  qwen3_moe/       # Qwen3 with MoE layers
  nemotron_v3/     # Hybrid mamba-attention
```

### 1.4 Identify custom components

Check whether the model needs:

- **Custom attention**: GQA (standard), MLA (DeepSeek/Mistral4), sliding window, bidirectional
- **Custom RoPE**: Standard (Llama), YaRN scaling, NTK-aware, complex-number (DeepSeek)
- **Custom normalization**: RMSNorm (standard), LayerNorm, different eps values
- **Custom MLP**: SwiGLU (standard), GeGLU, ReLU-squared, MoE routing
- **Custom config class**: Needed only if HF `AutoConfig` cannot parse the model's `config.json` (check `auto_map` field)

### 1.5 Note dimensions for test config

For unit tests, create a tiny config. Target: ~1M parameters or less.

```python
# Example tiny config for a Llama-like model:
tiny_config = LlamaConfig(
    hidden_size=64,
    intermediate_size=128,
    num_hidden_layers=2,
    num_attention_heads=4,
    num_key_value_heads=2,
    vocab_size=256,
    max_position_embeddings=128,
)
```

---

## Phase 2: Implementation

### 2.1 Create directory structure

```
components/models/<name>/
  __init__.py
  model.py
  state_dict_adapter.py
  config.py            # Only if HF config is insufficient
  layers.py            # Only for MoE / MLA / other non-standard layers
  rope_utils.py        # Only for custom RoPE
```

### 2.2 Implementation order

Implement files in dependency order:

1. **config.py** (if needed) -- Custom `PretrainedConfig` subclass
2. **rope_utils.py** (if needed) -- RoPE implementation
3. **layers.py** (if needed) -- Attention, MLP, decoder block classes
4. **model.py** -- The main `ForCausalLM` (or `ForConditionalGeneration`) class
5. **state_dict_adapter.py** -- HF weight conversion
6. **__init__.py** -- Re-export the main model class

See the pattern files for detailed implementation guidance:

- Dense LLM: [llm-patterns.md](./llm-patterns.md)
- MoE: [moe-patterns.md](./moe-patterns.md)
- VLM: [vlm-patterns.md](./vlm-patterns.md)

### 2.3 MoE state-dict adapter checklist

For MoE models, do not stop at generic loading. The adapter must explicitly map:

- Router weights, including gate bias or correction-bias tensors when the Hugging Face model has them.
- Expert weights, preserving expert index order across local and routed experts.
- Gate/up/down projections, including combined or split projection layouts.
- Shared experts separately from routed experts when the architecture has both.

Add tests that assert expected key mappings and run numerical equivalence with tiny configs before trying full checkpoints.

Do not use these shortcuts:

- Do not validate the adapter only by calling `from_pretrained()`.
- Do not accept missing or extra expert keys without an explicit mapping reason.
- Do not change dtype, transpose dimensions, or reshape tensors unless the HF
  and NeMo layouts require it and a test proves the conversion is reversible.
- Do not skip router or shared-expert tests because dense-layer tests pass.

### 2.4 VLM onboarding checklist

For VLMs, confirm the Hugging Face config has `vision_config` and `text_config`
and that `architectures` points to a conditional-generation class. Start from
the closest VLM pattern file, usually [vlm-patterns.md](./vlm-patterns.md), and
compare existing implementations such as `mistral4`, `kimivl`, or
`kimi_k25_vl`.

The implementation should explicitly cover:

- Text backbone, vision tower, projector, and processor or image preprocessing assumptions.
- Weight mapping for both text and vision modules in `state_dict_adapter.py`.
- Registration of the `ForConditionalGeneration` class in `_transformers/registry.py`.
- Tiny tests that exercise image-text inputs and verify the adapter round-trip.

### 2.5 Register in registry

Add the model to `MODEL_ARCH_MAPPING` in `_transformers/registry.py`:

```python
# In _transformers/registry.py
MODEL_ARCH_MAPPING = OrderedDict([
    # ... existing entries ...
    (
        "NewModelForCausalLM",
        ("nemo_automodel.components.models.new_model.model", "NewModelForCausalLM"),
    ),
])
```

If the model has a custom config class with `auto_map` in its `config.json`, also register in `_CUSTOM_CONFIG_REGISTRATIONS`:

```python
_CUSTOM_CONFIG_REGISTRATIONS: Dict[str, Tuple[str, str]] = {
    # ... existing entries ...
    "new_model": ("nemo_automodel.components.models.new_model.configuration", "NewModelConfig"),
}
```

---

## Phase 3: Onboarding Example Config

This phase is only for adding a minimal example config that proves the newly
onboarded architecture can load and run. Use nemo-automodel-recipe-development for general
recipe authoring or existing recipe modifications.

### 3.1 Create example YAML config

Create an example config under `examples/llm_finetune/<name>/` (or `examples/vlm_finetune/<name>/`):

```yaml
model:
  _target_: nemo_automodel.NeMoAutoModelForCausalLM.from_pretrained
  pretrained_model_name_or_path: <org>/<model-name>

trainer:
  max_steps: 100
  gradient_clip_val: 1.0
  accumulate_grad_batches: 1

# ... data, optimizer config ...
```

### 3.2 Verify model loads

Test that the model loads from a HuggingFace checkpoint:

```python
from nemo_automodel import NeMoAutoModelForCausalLM

model = NeMoAutoModelForCausalLM.from_pretrained("<org>/<model-name>")
```

### 3.3 Test with tiny config first

Before using full-size models, verify with a tiny config (1-2 layers, small hidden dim) to catch shape mismatches early.

## Phase 4: Tests

Create `tests/unit_tests/models/<name>/` and cover the checks below before
loading full checkpoints:

- Forward-shape smoke test with a tiny config.
- State-dict adapter round-trip: `from_hf -> to_hf` preserves mapped names,
  shapes, dtypes, and values.
- Layer equivalence tests for every rewritten attention, MLP, normalization,
  RoPE, or MoE layer. Use the model dtype from config, identical seeded weights,
  identical inputs, and dtype-appropriate `torch.allclose` tolerances.
- Short functional test that verifies loss decreases over a few training steps.

---

## Phase 5: Documentation

### 5.1 Update model coverage page

Edit the appropriate file in `docs/model-coverage/`:
- LLM/MoE: `docs/model-coverage/llm/index.md`
- VLM: `docs/model-coverage/vlm/index.md`

Add a row with the model name, supported features (TP, PP, FSDP, LoRA, QLoRA), and any limitations.

---

## Phase 6: Parity Testing

After implementation and unit tests are complete, run the full parity-testing
workflow to verify that the new model produces numerically equivalent results to
the reference HuggingFace implementation.

Run three levels of comparison:

1. State-dict round-trip: load a reference HuggingFace checkpoint, convert it
   into the NeMo AutoModel layout, export it back, and verify that all mapped
   tensors match the reference names, shapes, dtypes, and values within the
   expected tolerance.
2. Component-level parity: compare rewritten attention, MLP, normalization,
   RoPE, and MoE components against the HuggingFace implementation with fixed
   seeds and identical dtype.
3. End-to-end forward pass: run the full NeMo AutoModel and HuggingFace model
   on the same tokenized input and compare logits, hidden states, and loss.

Do not skip this phase. A model that passes unit tests can still diverge from HF
due to subtle weight-conversion bugs, backend differences, or RoPE mismatches
that only surface in a full parity comparison.

---

## Key Files Reference

| File | Purpose |
|------|---------|
| `_transformers/registry.py` | `MODEL_ARCH_MAPPING` and `_CUSTOM_CONFIG_REGISTRATIONS` |
| `components/models/common/__init__.py` | Exports `CombinedQKVAttentionMixin`, `CombinedGateUpMLP`, `BackendConfig`, `HFCheckpointingMixin`, etc. |
| `components/models/common/combined_projection/combined_qkv.py` | `CombinedQKVAttentionMixin` with `setup_qkv_projection()` and `compute_qkv()` |
| `components/models/common/combined_projection/combined_mlp.py` | `CombinedGateUpMLP` with interleaved gate/up layout |
| `components/models/common/combined_projection/state_dict_adapter.py` | `CombinedProjectionStateDictAdapter` base class |
| `components/models/common/hf_checkpointing_mixin.py` | `HFCheckpointingMixin` for save/load |
| `components/models/common/utils.py` | `BackendConfig`, `initialize_rms_norm_module`, `initialize_linear_module`, `get_rope_config` |
| `components/moe/config.py` | `MoEConfig` dataclass |
| `components/moe/fsdp_mixin.py` | `MoEFSDPSyncMixin` for distributed expert handling |
| `components/moe/layers.py` | `MoE` layer, `MLP` (dense) for MoE blocks |
| `components/moe/experts.py` | `GroupedExperts`, `GroupedExpertsDeepEP`, `GroupedExpertsTE` |

---

## Checklist

- [ ] Fetched and analyzed `config.json` from HuggingFace
- [ ] Determined model type (dense LLM / MoE / VLM)
- [ ] Identified custom components (attention, RoPE, normalization, MLP)
- [ ] Created `components/models/<name>/` directory
- [ ] Implemented config.py (if custom config needed)
- [ ] Implemented layers.py (if custom layers needed)
- [ ] Implemented rope_utils.py (if custom RoPE needed)
- [ ] Implemented model.py with `HFCheckpointingMixin`
- [ ] Implemented state_dict_adapter.py
- [ ] Implemented __init__.py with re-export
- [ ] Registered in `MODEL_ARCH_MAPPING` in `_transformers/registry.py`
- [ ] Registered custom config in `_CUSTOM_CONFIG_REGISTRATIONS` (if applicable)
- [ ] Created example YAML config
- [ ] Verified model loads via `NeMoAutoModelForCausalLM.from_pretrained()`
- [ ] Created unit tests (forward shape, state_dict round-trip)
- [ ] Created layer equivalence tests for every rewritten layer (matching model dtype)
- [ ] Created functional tests (training loss decreases)
- [ ] Updated docs/model-coverage page
- [ ] Ran state-dict round-trip, component parity, and E2E forward-pass parity checks
- [ ] Set `ModelClass = <Name>ForCausalLM` at module bottom
