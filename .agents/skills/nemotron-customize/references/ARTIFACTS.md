# Artifact Compatibility

Use this reference before planning DAGs or inserting conversion stages. It is a
compact copy of the catalog artifact graph; verify with `src/nemotron/steps/types.toml`
only when exact live metadata is required.

## Table Of Contents

- [Type Graph](#type-graph)
- [Common Pipelines](#common-pipelines)
- [Compatibility Checks](#compatibility-checks)

## Type Graph

| Artifact | Meaning | Compatible As | Explicit Conversion |
|---|---|---|---|
| `raw_jsonl` | Raw downloaded/local JSONL records. | `training_jsonl` | - |
| `filtered_jsonl` | JSONL accepted for downstream data steps, often after curation/language/domain filters. Existing clean corpora may enter here without a new curation run. | `training_jsonl` | - |
| `translated_jsonl` | Translated JSONL plus optional quality metadata. | `training_jsonl` | - |
| `synthetic_jsonl` | Data Designer generated JSONL. | `training_jsonl` | - |
| `training_jsonl` | OpenAI-style chat JSONL or RL prompt/preference JSONL. | - | - |
| `packed_parquet` | Packed Megatron-Bridge SFT shards with `input_ids` and `loss_mask`. | - | Produced by `data_prep/sft_packing`. |
| `binidx` | Megatron pretraining bin/idx shards plus `blend.json`. | - | Produced by `data_prep/pretrain_prep`. |
| `checkpoint_megatron` | Megatron distributed checkpoint. | - | `convert/megatron_to_hf` -> `checkpoint_hf`. |
| `checkpoint_hf` | Hugging Face safetensors checkpoint. | - | `convert/hf_to_megatron` -> `checkpoint_megatron`. |
| `checkpoint_lora` | LoRA adapter weights. | - | `convert/merge_lora` -> `checkpoint_hf`; optional Megatron output. |
| `eval_results` | Evaluation metrics and output artifacts. | - | - |
| `env_toml` | Environment profile TOML for remote/local execution. | - | Produced by `env/env_toml`. |
| `benchmark_source_corpus` | Domain documents grouped by benchmark target subject. | - | - |
| `benchmark_parquet` | BYOB benchmark dataset. | - | - |
| `mcq_benchmark_parquet` | Multiple-choice BYOB benchmark parquet. | `benchmark_parquet` | - |
| `translated_mcq_benchmark_parquet` | Translated multiple-choice BYOB benchmark parquet. | `mcq_benchmark_parquet` | - |

## Common Pipelines

### Data-To-Training (compose by artifact type)

Each data step is independent. `raw_jsonl`, `filtered_jsonl`,
`translated_jsonl`, and `synthetic_jsonl` all satisfy `training_jsonl`, so the
agent inserts a data step only when the goal requires that transform (cleaning,
translation, generation). The chain below shows the maximal path; drop any hop
the request does not need.

```text
raw_jsonl
  -> [curate/nemo_curator]      # only if cleaning/filtering is requested
  -> [translate/nemo_curator]   # only if translation is requested
  -> training_jsonl
  -> sft/automodel              # JSONL-native AutoModel path
  -> checkpoint_hf
```

```text
training_jsonl
  -> data_prep/sft_packing      # required because Megatron-Bridge consumes packed_parquet
  -> packed_parquet
  -> sft/megatron_bridge
  -> checkpoint_megatron
```

### SFT / PEFT Backend Split

```text
training_jsonl -> sft/automodel -> checkpoint_hf
training_jsonl -> peft/automodel -> checkpoint_lora -> convert/merge_lora -> checkpoint_hf
```

```text
training_jsonl
  -> data_prep/sft_packing
  -> packed_parquet
  -> sft/megatron_bridge or peft/megatron_bridge
  -> checkpoint_megatron or checkpoint_lora
```

### Pretraining / CPT

```text
filtered_jsonl
  -> data_prep/pretrain_prep
  -> binidx + blend.json
  -> pretrain/automodel        -> checkpoint_hf
  -> pretrain/megatron_bridge  -> checkpoint_megatron
```

### RL Alignment

```text
sft/megatron_bridge -> checkpoint_megatron
training_jsonl or data_prep/rl_prep output
  -> rl/nemo_rl/dpo | rl/nemo_rl/rlvr | rl/nemo_rl/rlhf
  -> checkpoint_megatron
```

### Checkpoint Bridges

```text
checkpoint_hf       -> convert/hf_to_megatron -> checkpoint_megatron
checkpoint_megatron -> convert/megatron_to_hf -> checkpoint_hf
checkpoint_lora + exact base -> convert/merge_lora -> checkpoint_hf
```

### BYOB Benchmarks

```text
benchmark_source_corpus
  -> byob/mcq stage=prepare
  -> byob/mcq stage=generate
  -> mcq_benchmark_parquet
  -> byob/mcq stage=translate
  -> translated_mcq_benchmark_parquet
```

## Compatibility Checks

- `is_a` compatibility is implicit; conversion is not needed for those edges.
- `convert_to` edges require an explicit converter step; do not rely on downstream steps to read another checkpoint layout.
- Prepared data is tokenizer-locked. Rebuild `packed_parquet` or `binidx` after tokenizer, chat template, sequence length, split, or blend changes.
- `packed_parquet` is only for Megatron-Bridge SFT/PEFT paths.
- AutoModel SFT/PEFT reads `training_jsonl` directly.
- `checkpoint_lora` is not a deployable full model until merged with the exact base.
- For Megatron exports, point conversion/eval at a concrete `iter_*` checkpoint.
- Keep benchmark artifacts separate from training artifacts; BYOB output is held-out eval data.
