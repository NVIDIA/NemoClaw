# Evaluation Practices

Use Stage 3 metrics as the source of truth for recipe quality. Training loss is useful for diagnosing learning dynamics, but it is not retrieval accuracy.

## Minimum Practice

- Compare base vs fine-tuned on the same held-out eval set.
- Keep the Stage 1 `eval_beir/` split fixed across hyperparameter, SDG, and data-volume comparisons.
- Inspect `output/embed/stage3_eval/eval_results.json` or `output/rerank/stage3_eval/eval_results.json`.
- Prioritize nDCG@10 for top-rank quality, then check the rest of the k values for consistency. For embed-vs-rerank routing, inspect first-stage candidate recall at the rerank candidate depth, usually `Recall@100` or the configured `top_k`, instead of treating `Recall@10` alone as candidate coverage.
- Use at least 100 eval queries when possible; 200-500 is better for detecting small changes.
- Treat less than roughly 5 absolute points of nDCG@10 improvement as a reason to inspect data quality, SDG coverage, hard negatives, and hyperparameters before deployment.
- For rerank, treat high candidate-depth Recall, for example `Recall@100`, with low nDCG@10 as a ranking problem; treat low candidate-depth Recall as a first-stage retrieval or embedding problem.
- Public benchmarks can be useful for broad sanity checks, but recipe personalization should be judged on the recipe's domain-specific held-out eval split.

## Experiment Hygiene

- Save the exact command, dotlist overrides, git commit, config files, and output directory for each run.
- Change one major variable at a time.
- Start embedding LR sweeps near `5e-6`, `1e-5`, and `2e-5`.
- Start rerank LR sweeps near `1e-6`, `3e-6`, and `1e-5`.
- Start real datasets at 1-2 epochs unless validation and Stage 3 metrics continue improving.
- Evaluate data saturation by running 25%, 50%, and 100% corpus sizes with the same held-out eval set.

## Interpretation Patterns

| Signal | Likely Meaning | Next Check |
| --- | --- | --- |
| Recall@100 is low before rerank | First-stage retrieval is missing relevant documents | Tune embedding, chunking, query/passage prefixes, or index settings before reranking. |
| Recall@100 is acceptable but nDCG@10 is low | Candidates exist but ordering is poor | Tune rerank, keep `top_k` fixed, and inspect top-ranked false positives. |
| Fine-tuned is worse than base | Data, prefixes, sequence lengths, or checkpoint path may not match | Compare Stage 1 eval split, Stage 2 training config, and Stage 3 `finetuned_model_path`. |
| Checkpoint eval is good but ONNX or TensorRT drops | Export parity or precision issue | Compare checkpoint vs ONNX first, then TensorRT; check `attn_implementation`, quantization, profiles, and layernorm settings. |
| NIM eval is worse than exported model | Deploy config points at stale or wrong artifact | Check `model_dir`, `use_onnx`, mounted paths, port, served model name, and `eval_nim=true eval_base=false`. |
| Small nDCG gain on tiny eval set | Possible noise | Increase eval query count or repeat with a fixed larger held-out split before deployment. |

## Deployment Checks

- Evaluate the exported or served model against the same eval set.
- For embedding NIM, use `uv run nemotron embed eval -c default eval_nim=true eval_base=false`.
- For rerank NIM, use `uv run nemotron rerank eval -c default eval_nim=true eval_base=false`.
- If metrics drift after export or deploy, check ONNX vs TensorRT, quantization, pooling, normalization, prefixes, prompt templates, and sequence length.
