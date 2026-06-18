# Embedding Recipe Reference

Load this reference for `nemotron embed ...` work or for questions about first-stage retrieval, bi-encoder training, low Recall@k, missing relevant documents, embedding NIMs, or re-indexing after model changes.

## Contents

- Grounding Paths
- When To Use Embed
- Commands
- Data And Credential Safety
- Stage Map
- Stage Contracts
- Important Defaults
- Operating Patterns
- NIM Smoke Test
- Tests And Checks

## Grounding Paths

- Recipe README: `src/nemotron/recipes/embed/README.md`
- CLI group: `src/nemotron/cli/commands/embed/_typer_group.py`
- Pipeline command: `src/nemotron/cli/commands/embed/run.py`
- Stage configs: `src/nemotron/recipes/embed/stage*/config/default.yaml`
- Main outputs: `output/embed/`

## When To Use Embed

Use embedding fine-tuning when relevant documents are not retrieved into the candidate set, Recall@k is low, domain terms are poorly matched, or the user needs a better first-stage retrieval model. Embedding changes usually require re-embedding and re-indexing the deployment corpus.

## Commands

Use `uv run` when `nemotron` is not already available.

```bash
uv run nemotron embed info
uv run nemotron embed --help
uv run nemotron embed run -c default -d --from prep --to eval
```

For raw domain documents, preview only data generation and prep before any training plan:

```bash
uv run nemotron embed run -c default -d --from sdg --to prep
```

If training/eval pairs already exist, skip SDG and preview prep through eval:

```bash
uv run nemotron embed run -c default -d --from prep --to eval
```

Stage commands:

```bash
uv run nemotron embed sdg -c default corpus_dir=/path/to/docs
uv run nemotron embed prep -c default
uv run nemotron embed finetune -c default
uv run nemotron embed eval -c default
uv run nemotron embed export -c default
uv run nemotron embed deploy -c default
```

Remote execution uses root `env.toml` profiles:

```bash
uv run nemotron embed finetune -c default --run my-cluster
uv run nemotron embed finetune -c default --batch my-cluster
```

## Data And Credential Safety

Stage 0 SDG can transmit the user's text corpus or fetched HF corpus content to NVIDIA-hosted API endpoints for synthetic data generation. Before running SDG on proprietary, confidential, regulated, or customer data, confirm the user's data-governance policy permits that transfer; otherwise use an approved private or air-gapped path.

Protect `NVIDIA_API_KEY` and `NGC_API_KEY` as secrets. Keep them in environment variables, local `.env` files excluded from version control, or an approved secrets manager; never hardcode them in commands, scripts, configs, or committed logs. Rotate any key that may have been exposed.

## Stage Map

| Stage | Command | Input | Output | Notes |
| --- | --- | --- | --- | --- |
| 0 SDG | `embed sdg` | Text corpus or HF URI | `output/embed/stage0_sdg` | Requires `NVIDIA_API_KEY`; generates synthetic retrieval QA data. |
| 1 prep | `embed prep` | Stage 0 output or existing QA data | `output/embed/stage1_data_prep` | Converts to train/eval data, mines hard negatives, creates BEIR eval data. |
| 2 finetune | `embed finetune` | `train_mined.automodel_unrolled.json` | `output/embed/stage2_finetune/checkpoints` | AutoModel contrastive training. |
| 3 eval | `embed eval` | BEIR eval data and checkpoint | `output/embed/stage3_eval/eval_results.json` | Compare base vs fine-tuned on nDCG, Recall, Precision, and MAP. |
| 4 export | `embed export` | Fine-tuned HF checkpoint | `output/embed/stage4_export` | Default config exports ONNX only; set `export_to_trt=true` for TensorRT. |
| 5 deploy | `embed deploy` | ONNX/TensorRT model dir | NIM on `host_port` | Requires Docker/NGC setup and `NGC_API_KEY`. |

The pipeline order is `sdg`, `prep`, `finetune`, `eval`, `export`, `deploy`; `embed run` defaults to `--to eval`.


## Stage Contracts

| Stage | Required Inputs | Creates | Cheapest Check | Expensive Resource | Common Overrides |
| --- | --- | --- | --- | --- | --- |
| 0 SDG | Text corpus or HF URI, `NVIDIA_API_KEY` | `output/embed/stage0_sdg` | `uv run nemotron embed run -c default -d --from sdg --to prep` | Provider API calls | `corpus_dir`, `num_pairs`, `sentences_per_chunk`, `file_extensions`, `preview=true` |
| 1 prep | Stage 0 output or `sdg_input_path` | `output/embed/stage1_data_prep`, `eval_beir/` | `uv run nemotron embed prep -c default -d` | Hard-negative mining on larger sets | `sdg_input_path`, `quality_threshold`, `hard_negatives_to_mine`, `mining_batch_size` |
| 2 finetune | `train_mined.automodel_unrolled.json` | `output/embed/stage2_finetune/checkpoints` | `uv run nemotron embed finetune -c default -d` | GPU training | `num_epochs`, `learning_rate`, `global_batch_size`, `local_batch_size`, `train_n_passages` |
| 3 eval | Fixed `eval_beir/` split and checkpoint | `output/embed/stage3_eval/eval_results.json` | `uv run nemotron embed eval -c default -d` | Embedding inference over eval corpus | `finetuned_model_path`, `eval_data_path`, `k_values`, `eval_base`, `eval_finetuned`, `eval_nim` |
| 4 export | Fine-tuned checkpoint | `output/embed/stage4_export/onnx` or `tensorrt` | `uv run nemotron embed export -c default -d` | Export container/GPU for TensorRT | `model_path`, `export_to_trt`, `attn_implementation`, sequence profile settings |
| 5 deploy | ONNX/TensorRT model dir, Docker, NGC access | Embedding NIM on `host_port` | `uv run nemotron embed deploy -c default -d` | Docker, GPU, NGC image pull | `model_dir`, `use_onnx`, `host_port`, container/image fields |

## Important Defaults

Stage 0:

- Sample corpus: `hf://nvidia/Retrieval-Synthetic-NVDocs-v1@1c0d1856f3fb595b2dda98d4b61061fa6d782d51/sample_corpus/nv_pp_random`; confirm access and license before recommending it, or use the user's `corpus_dir`.
- Output: `./output/embed/stage0_sdg`
- Generation model: `nvidia/nemotron-3-nano-30b-a3b`
- SDG embedding model: `nvidia/llama-3.2-nv-embedqa-1b-v2`
- Useful overrides: `corpus_dir`, `num_pairs`, `sentences_per_chunk`, `file_extensions`, `max_parallel_requests_for_gen`, `preview=true`

Stage 1:

- Input: `./output/embed/stage0_sdg`
- Output: `./output/embed/stage1_data_prep`
- Base model for mining: `nvidia/llama-nemotron-embed-1b-v2`
- Quality threshold: `7.0`
- Split: `train_ratio=0.8`, `val_ratio=0`, `test_ratio=0.2`
- Hard negatives: `hard_negatives_to_mine=5`, `hard_neg_margin=0.95`, `mining_batch_size=128`

Stage 2:

- Base model: `nvidia/llama-nemotron-embed-1b-v2`
- Train data: `./output/embed/stage1_data_prep/train_mined.automodel_unrolled.json`
- Checkpoints: `./output/embed/stage2_finetune/checkpoints`
- Defaults: `num_epochs=3`, `global_batch_size=128`, `local_batch_size=4`, `learning_rate=1.0e-5`, `temperature=0.02`, `train_n_passages=5`
- Prefixes: `query_prefix="query:"`, `passage_prefix="passage:"`
- For real corpora, start with 1-2 epochs unless Stage 3 metrics still improve; the 3 epoch default is for small examples.

Stage 3:

- Eval data: `./output/embed/stage1_data_prep/eval_beir`
- Fine-tuned model: `./output/embed/stage2_finetune/checkpoints/LATEST/model/consolidated`
- Metrics: `k_values=[1,5,10,100]`
- Modes: `eval_base=true`, `eval_finetuned=true`, `eval_nim=false`
- NIM verification: `uv run nemotron embed eval -c default eval_nim=true eval_base=false`

Stage 4:

- Model path: `./output/embed/stage2_finetune/checkpoints/LATEST/model/consolidated`
- ONNX output: `./output/embed/stage4_export/onnx`
- TensorRT output: `./output/embed/stage4_export/tensorrt`
- `attn_implementation=eager` is the export-safe default.

Stage 5:

- NIM image: `nvcr.io/nim/nvidia/llama-3.2-nv-embedqa-1b-v2:1.10.1`
- Container: `nemotron-embed-nim`
- Default API: `http://localhost:8000/v1/embeddings`
- Default deploy runs in the foreground; for service handoff, add `detach=true` plus explicit container name and port overrides when needed.

## Operating Patterns

- Skip SDG when the user already has generated QA pairs or wants NVIDIA's pre-generated dataset; start Stage 1 with `sdg_input_path`.
- For production-like chunks, align `sentences_per_chunk`, `passage_max_length`, and eval `max_length` with expected retrieval chunks.
- If increasing sequence length, reduce batch sizes before attempting to recover from OOM.
- Mine at least as many hard negatives as Stage 2 will consume: `hard_negatives_to_mine >= train_n_passages - 1`.
- Preserve `output/embed/stage1_data_prep/eval_beir/` across comparisons so metrics are not shifted by new splits.
- Use `val_ratio=0` only for small datasets where preserving test size matters; use a validation split for larger datasets.
- Inspect existing `output/embed/` artifacts before rerunning a stage. Ask before deleting checkpoints, cached embeddings, or generated data.
- For deploy handoff, include the exact deploy command, `detach=true` when background service ownership is expected, container name, host port, smoke test, and stop/replace instructions.

## NIM Smoke Test

```bash
curl -X POST http://localhost:8000/v1/embeddings \
  -H 'Content-Type: application/json' \
  -d '{"input": ["hello"], "model": "nvidia/llama-3.2-nv-embedqa-1b-v2", "input_type": "query"}'
```

## Tests And Checks

```bash
uv run nemotron embed --help
uv run nemotron embed finetune -c default -d
uv run pytest tests/recipes/embed tests/nemo_runspec/test_execution_uv_spec.py -q
```
