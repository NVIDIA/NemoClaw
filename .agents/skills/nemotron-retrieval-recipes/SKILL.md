---
name: nemotron-retrieval-recipes
version: "0.1.0"
author: "NVIDIA Nemotron Team <noreply@nvidia.com>"
license: Apache-2.0
tags:
  - nemotron
  - retrieval
  - fine-tuning
  - embeddings
  - reranking
metadata:
  author: "NVIDIA Nemotron Team <noreply@nvidia.com>"
  tags:
    - nemotron
    - retrieval
    - fine-tuning
    - embeddings
    - reranking
tools:
  - Read
  - Bash
  - Search
description: Use when planning, debugging, tuning, evaluating, exporting, or deploying public Nemotron `embed`/`rerank` retrieval recipes.
---

# Nemotron Retrieval Recipes

Invocation: `$nemotron-retrieval-recipes`.

## Purpose

Use this skill to work with public Nemotron embedding and reranking retrieval recipes in a source checkout or installed package. Prefer the current checkout over memory, because the recipe CLI, configs, containers, and output paths are actively changing. Treat each recipe family as available only after its recipe directory and matching CLI files are present.

This is a public product skill, not contributor-only guidance. Its value over static docs is to make an agent route the user's retrieval failure to the right recipe family, reconcile docs with the current checkout, avoid accidental long-running launches, preserve secrets, and return concrete preview/execution/run-report commands.

Use it only for tasks tied to the public Nemotron `embed` or `rerank` recipe flow. If the request is unrelated retrieval theory, generic vector database selection, generic benchmark advice, or non-recipe Docker/Slurm/NIM troubleshooting, stop with a short scope note and do not inspect recipe files in that turn.

## Security Notes

Use `Bash` for repo-scoped inspection, help, dry-run, and user-approved execution commands. Do not run API, GPU, Docker, Slurm, NIM, or other long-running work unless the user explicitly asks for it. Never run broad environment dumps or commands that expose secret values. Prefer dotlist overrides and config review over editing recipe defaults.

## Source Priority

Resolve conflicts in this order:

1. Current checkout recipe, CLI, config, and source files.
2. Bundled references in this skill.
3. User-provided docs or saved snippets.
4. Memory.

For runnable commands, treat the current checkout as authoritative. If a required recipe directory, CLI command, config, or env profile is missing, report the blocker instead of guessing.

## Prerequisites

- Repo environment: `uv sync --all-extras` or the smallest relevant extra documented by the checkout.
- Stage 0 SDG: `NVIDIA_API_KEY`; never ask users to paste secret values.
- Stage 1-4 GPU work: CUDA/NVIDIA driver availability and enough VRAM.
- Stage 4 export: NeMo Export-Deploy container when using TensorRT.
- Stage 5 deploy: Docker, NGC access, and `NGC_API_KEY`.
- Remote execution: root `env.toml` profile for `--run` or `--batch`; load `references/remote.md` when remote scheduling, logs, or GPU placement matter.

## Instructions

1. Identify the recipe family.
   - Use `references/embed.md` for embedding, embed, bi-encoder, vector search, first-stage retrieval, low Recall@k, missing relevant documents, NIM embeddings, or `nemotron embed`.
   - Use `references/rerank.md` for rerank, reranker, cross-encoder, second-stage retrieval, acceptable recall but poor top-rank ordering, low nDCG with good Recall, or `nemotron rerank`.
   - Use both references only when the user asks about both families or asks which family to choose.
2. Choose the model to tune from the retrieval failure mode.
   - Prefer embedding fine-tuning when relevant documents are absent from the candidate set.
   - Prefer reranker fine-tuning when relevant documents are retrieved but ordered poorly near the top.
   - For production retrieval stacks, remember that these are complementary: embed first, rerank candidates second.
3. Identify the intent: plan a run, execute a stage, debug a failure, tune hyperparameters, interpret metrics, export/deploy a model, inspect configs, or propose dotlist overrides.
4. Inspect the current public surface before acting:
   - Recipe files: `src/nemotron/recipes/<embed|rerank>/`
   - CLI files: `src/nemotron/cli/commands/<embed|rerank>/`
   - Default configs: `src/nemotron/recipes/<family>/stage*/config/default.yaml`
   - Help and dry runs: `uv run nemotron <family> --help`, `uv run nemotron <family> <stage> -c default -d`

## Safe Workflow

1. Gather only context relevant to the task: corpus path, existing SDG/training/eval data, target stage range, output directory, checkpoint path, execution mode, GPU IDs, and whether required secrets are configured. Never ask users to paste secret values.
2. Start with cheap checks before expensive work:
   - `uv run nemotron <family> --help`
   - `uv run nemotron <family> <stage> --help`
   - `uv run nemotron <family> <stage> -c default -d`
   - `uv run nemotron <family> run -c default -d --from <stage> --to <stage>`
   - `run --help` may omit inherited `-c` and `-d` options even though `run -c default -d ...` works; validate by running the dry-run when unsure.
   - In an already prepared checkout, `uv run --no-sync ... --help` or `uv run --no-sync ... -d` can avoid unexpected dependency sync during read-only checks.
3. Check prerequisites for the requested stage:
   - Repo environment: `uv sync --all-extras` or the smallest relevant extra if documented by the repo.
   - Stage 0 SDG: `NVIDIA_API_KEY`.
   - Stage 1-4 GPU work: CUDA/NVIDIA driver availability and enough VRAM.
   - Stage 4 export: the NeMo Export-Deploy container when using TensorRT.
   - Stage 5 deploy: Docker, NGC access, and `NGC_API_KEY`.
   - Remote execution: root `env.toml` profile for `--run` or `--batch`; load `references/remote.md` when remote scheduling, logs, or GPU placement matter.
4. Use dotlist overrides instead of editing defaults unless the user asks for reusable config changes. Keep sequence length, prefixes, pooling/normalization, prompt templates, and hard-negative counts consistent across stages.
5. Avoid launching API, GPU, Docker, Slurm, NIM, or long-running jobs unless the user explicitly asked to run them. Offer or run dry-runs, config review, and small pilots first.
6. If the user specifies GPU IDs, scope every stage command with `CUDA_VISIBLE_DEVICES=<ids>`.
7. For multi-stage local runs, prefer `uv run nemotron <family> run -c default --from <stage> --to <stage>`. The default `run` target stops at `eval`; `export` and `deploy` are opt-in.
8. When evaluating quality, compare against the base model on a fixed held-out evaluation set before recommending deployment. Do not substitute a standalone public-benchmark eval for the recipe's own Stage 3 evaluation.
9. For long-running SDG, prep, finetune, or eval work, start the process in a session-safe way and poll at human-scale intervals: roughly 60 seconds for small pilots and 120-300 seconds for larger runs.
10. For failures, load `PITFALLS.md`, localize the failing stage, then inspect the stage config, expected inputs, output directory, and corresponding CLI wrapper or `run_uv.py`.

## References

- `references/embed.md`: embedding recipe stages, commands, defaults, output paths, and operating patterns.
- `references/rerank.md`: rerank recipe stages, commands, defaults, output paths, and operating patterns.
- `references/evaluation.md`: metric interpretation, comparison hygiene, and deployment readiness checks.
- `references/remote.md`: remote execution profiles, batch/run mode, GPU scoping, logs, and polling.
- `PITFALLS.md`: common failures and recovery moves for SDG, prep, training, eval, export, deploy, and CLI setup.

## Examples

User asks: "Recall is decent, but nDCG is poor and the right passage is around rank 40. Should I tune embed or rerank?"

Load `references/rerank.md` and `references/evaluation.md`, explain that acceptable recall with poor top-rank ordering points to reranker tuning, then offer a cheap preview before training.

```bash
uv run nemotron rerank run -c default -d --from prep --to eval
```

## Troubleshooting

For failures, load `PITFALLS.md` first. Localize the failing stage, then inspect the stage config, expected inputs, output directory, and corresponding CLI wrapper or `run_uv.py`.

## Limitations

- Bundled references are condensed snapshots; verify commands, flags, defaults, and output paths against the active checkout before execution.
- This skill does not provide datasets, checkpoints, credentials, GPU capacity, Docker images, or NIM services.

## Output Style

For planning or debugging recommendations, use this shape when it helps: `Decision`, `Why`, `Required inputs`, `Preview command`, `Execution command`, `Avoid`, and `Next step`. Omit fields that are irrelevant to a short answer.

Give concrete commands and file paths. State assumptions, expected inputs, expected outputs, and the cheapest validation step that proves the next action is ready. For long-running stages, separate preview commands from execution commands so the user can choose deliberately.

When reporting a dry-run or real run, include a compact run report: command, mode, config, dotlist overrides, input paths, output paths, validation signal or metric file, and next cheapest check. Include the checkout commit when it is available.
