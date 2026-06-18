---
name: nemo-mbridge-perf-sequence-packing
description: Validate and use packed sequences and long-context training in Megatron-Bridge, distinguishing offline packed SFT for LLMs from in-batch packing for VLMs, and applying the right CP constraints.
license: Apache-2.0
when_to_use: Enabling sequence packing or long-context SFT, or investigating a commit that broke sequence packing or changed packing behavior; 'packed sequences', 'sequence packing', 'PackedSequenceSpecs', 'pack_sequences_in_batch', 'CP with packing'.
---

# Sequence Packing Skill

For stable background and recommendation level, see:

- @docs/training/packed-sequences.md
- @skills/nemo-mbridge-perf-sequence-packing/card.yaml

## Enablement

Offline packed SFT for LLM finetuning:

```python
from megatron.bridge.data.datasets.packed_sequence import PackedSequenceSpecs

cfg.train.micro_batch_size = 1
cfg.dataset.seq_length = 4096
cfg.model.seq_length = 4096
cfg.dataset.dataset_kwargs = {"pad_to_max_length": True}
cfg.dataset.packed_sequence_specs = PackedSequenceSpecs(
    packed_sequence_size=4096,
    pad_seq_to_mult=1,
)
```

If CP is enabled:

```python
cfg.model.context_parallel_size = 2
cfg.model.calculate_per_token_loss = True
cfg.ddp.average_in_collective = False
cfg.dataset.packed_sequence_specs.pad_seq_to_mult = cfg.model.context_parallel_size * 2

# If sequence_parallel is also enabled, use lcm(2*CP, CP*TP):
# import math
# cfg.dataset.packed_sequence_specs.pad_seq_to_mult = math.lcm(2 * CP, CP * TP)
# See src/megatron/bridge/training/vlm_step.py for reference logic.
```

If CUDA graphs are enabled for this packed path:

```python
cfg.dataset.packed_sequence_specs.pad_cu_seqlens = True
cfg.dataset.dataset_kwargs["pad_to_max_length"] = True
```

**Note:** `pad_cu_seqlens = True` also requires a metadata JSON file alongside
the packed dataset (asserted in `src/megatron/bridge/data/datasets/sft.py`).
Custom packed datasets that omit the metadata file will hit an assertion at
dataset initialization.

In-batch packing for VLM finetuning:

```python
cfg.dataset.pack_sequences_in_batch = True
cfg.train.micro_batch_size = 2
```

Long-context baseline:

```python
cfg.model.seq_length = 16384
cfg.dataset.seq_length = 16384
cfg.model.context_parallel_size = 2
```

## Code Anchors

LLM packed SFT config surface:

```72:97:src/megatron/bridge/recipes/utils/finetune_utils.py
if packed_sequence:
    dataset_kwargs = {"pad_to_max_length": True}
    packed_sequence_specs = PackedSequenceSpecs(packed_sequence_size=seq_length, pad_seq_to_mult=pad_seq_to_mult)
else:
    dataset_kwargs = {}
    packed_sequence_specs = None
```

Bridge validation:

```1617:1657:src/megatron/bridge/training/config.py
if self.model.context_parallel_size > 1:
    assert self.model.seq_length % (self.model.context_parallel_size * 2) == 0, ...
    if isinstance(self.dataset, FinetuningDatasetConfig):
        assert self.model.calculate_per_token_loss, ...
        assert not self.ddp.average_in_collective, ...
...
if ... packed_sequence_size > 0 and self.train.micro_batch_size > 1:
    raise ValueError(...)
...
if getattr(self.dataset, "pack_sequences_in_batch", False) and self.train.micro_batch_size == 1:
    raise ValueError(...)
```

VLM in-batch runtime:

```308:327:src/megatron/bridge/training/vlm_step.py
if enable_packing:
    ...
    ) = pack_batch_sequences(
        ...
        pad_token_id=0,
        pad_to_multiple_of=cp_size * 2 if cp_size > 1 else 1,
    )
```

Packed THD runtime constraint:

```61:64:src/megatron/bridge/training/gpt_step.py
if cu_seqlens.dim() > 1 and cu_seqlens.size(0) != 1:
    raise ValueError("Packed THD batches expect micro-batch size 1 for context-parallel slicing (THD layout)")
```

## Pitfalls

1. Offline packed SFT and VLM in-batch packing are different features with opposite micro-batch rules.
2. When CP is enabled, packed sequence lengths must respect `2 * context_parallel_size` divisibility.
3. For finetuning with CP, `calculate_per_token_loss=True` and `ddp.average_in_collective=False` are required.
4. `pad_cu_seqlens=True` also requires `pad_to_max_length=True`.
5. Packing support is model-family-specific. `Qwen3-Next`, `GLM-4.5`, and `Qwen3.5-VL` contain explicit opt-outs in different paths.
6. MTP finetuning is documented as incompatible with packed sequences.

## Verification

Use the checked-in unit coverage:

```bash
uv run python -m pytest tests/unit_tests/training/utils/test_packed_seq_utils.py -v && \
uv run python -m pytest tests/unit_tests/training/test_config.py -k "packed_sequence or pack_sequences_in_batch or context_parallel_seq_length_divisibility or context_parallel_finetuning_validations" -v && \
uv run python -m pytest tests/unit_tests/training/test_vlm_step.py -k "enable_packing" -v
```

Success criteria:

- first command reports `8 passed`
- second command reports `14 passed`
- third command reports `2 passed`
