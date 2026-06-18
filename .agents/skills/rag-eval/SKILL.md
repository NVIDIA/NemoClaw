---
name: rag-eval
version: "2.6.0"
description: >-
  Filesystem RAG benchmarks: corpus/, train.json, evaluate_rag.py (RAGAS quality). Not for prod
  monitoring, latency/throughput benchmarking (use rag-perf), or evals outside this repo layout.
license: Apache-2.0
compatibility: Repository checkout with uv; Python 3.11+; run from repo root; uv sync --project scripts/eval (eval deps live in scripts/eval/pyproject.toml); network to RAG, ingestor, and vdb endpoints; NVIDIA_API_KEY for RAGAS; optional RAG_EVAL_JUDGE_MODEL (default mistralai/mixtral-8x22b-instruct-v0.1).
metadata:
  author: NVIDIA RAG <foundational-rag-dev@exchange.nvidia.com>
  github-url: "https://github.com/NVIDIA-AI-Blueprints/rag"
  endpoint-openapi-schemas:
    - docs/api_reference/openapi_schema_rag_server.json
    - docs/api_reference/openapi_schema_ingestor_server.json
  argument-hint: RAGAS eval | evaluate_rag | train.json | corpus | results json | error triage | uv run --project scripts/eval | enable_reranker | query_rewriting | temperature | skip_ingestion
  tags:
    - nvidia
    - blueprint
    - rag
    - evaluation
    - ragas
    - benchmarking
    - nvidia-rag-blueprint
  languages:
    - python
    - shell
  frameworks:
    - ragas
    - fastapi
  domain: ai-ml
allowed-tools: Read Grep Glob Bash(ls *) Bash(python3 *) Bash(uv *) Write Edit
---

# On-disk RAG evaluation (`corpus/` + `train.json`)

## Purpose

Guide agents through NVIDIA RAG Blueprint **filesystem** benchmarks: preparing `corpus/` and `train.json`, running `scripts/eval/evaluate_rag.py`, tuning retrieval and generation flags for **quality** comparisons, interpreting RAGAS JSON outputs, and triaging failures (HTTP/stream errors, empty contexts, collection mismatch, judge API).

For **latency, throughput, and load testing**, use the **rag-perf** skill (`scripts/rag-perf`, `docs/performance-benchmarking.md`) — not this skill.

## When not to use

Do **not** use this skill for: deploying or repairing services (use rag-blueprint); evaluating APIs without the `corpus/` + `train.json` layout; general ML experimentation unrelated to this evaluator; production monitoring/alerting; or latency/throughput benchmarking (use **rag-perf**).

## Prerequisites

- Repo cloned; **run commands from repo root** (imports and paths assume this).
- Python **3.11+** and **uv**; eval deps: `uv sync --project scripts/eval`.
- Reachable **RAG server** and **ingestor** (defaults often `localhost:8081` / `8082`).
- **`NVIDIA_API_KEY`** for RAGAS (see [credential hygiene](references/benchmark-execution.md#credential-hygiene-nvidia_api_key)); optional **`RAG_EVAL_JUDGE_MODEL`**.
- Dataset roots passed to `--dataset-paths` each contain **`corpus/`** and **`train.json`**.

## Instructions

1. **Prepare data** — Ensure each dataset directory matches the layout and `train.json` rules in [`references/dataset-and-conversion.md`](references/dataset-and-conversion.md). When sources arrive as public links (sites or dataset pages), materialize documents under `corpus/`—prefer **PDF** for multimodal content so **images stay embedded**; convert CSV/JSONL/etc. using the patterns there.
2. **Run eval** — `uv run --project scripts/eval python scripts/eval/evaluate_rag.py` with `--dataset-paths`, `--host`, and `--port`. See [`references/benchmark-execution.md`](references/benchmark-execution.md) for command examples, outputs, and errors. Use [`references/evaluate-rag-cli.md`](references/evaluate-rag-cli.md) for flag-level detail.
3. **Tune quality** — Adjust `--top_k` / `--vdb_top_k`, reranker and query-rewriting toggles, and generation overrides (`--temperature`, `--top-p`, `--max-tokens`) as documented in [`references/benchmark-execution.md`](references/benchmark-execution.md) when comparing retrieval/generation configs for RAGAS scores.
4. **Analyze results** — Use [`references/result-analysis.md`](references/result-analysis.md) for scripts; scan `rag_*_evaluation_summary.json` for headline RAGAS metrics.
5. **Triage errors** — Use the [error signal table](references/benchmark-execution.md#common-error-cases-and-signals) and the **Troubleshooting** section below.

## Examples

**Set API key without putting secrets in shell history (preferred patterns):** load from a gitignored env file or secrets manager; avoid committing `.env`; rotate keys if exposed. Details: [`references/benchmark-execution.md#credential-hygiene-nvidia_api_key`](references/benchmark-execution.md#credential-hygiene-nvidia_api_key).

**Minimal eval (key already in environment):**

```bash
uv sync --project scripts/eval
uv run --project scripts/eval python scripts/eval/evaluate_rag.py \
  --dataset-paths /path/to/my_dataset \
  --host localhost \
  --port 8081
```

**Pretty-print summary JSON:**

```bash
python3 -m json.tool results/my_dataset/rag_my_dataset_evaluation_summary.json
```

More examples (skip ingestion, quality sweeps): [`references/benchmark-execution.md`](references/benchmark-execution.md).

## Limitations

- Evaluator behavior is fixed to the **filesystem contract** and `evaluate_rag.py`; it does not substitute for custom offline judges or non-RAG benchmarks.
- **Vector DB / embedding** choices follow deployed ingestor and RAG env — not overridden by this CLI alone.
- **Scores depend on** retrieval quality, judge model availability, and `NVIDIA_API_KEY`; empty contexts yield partial RAGAS metrics (see references).
- Large procedural detail lives under **`references/`** to keep routing concise; read those files when the user needs step-by-step conversion, full flags, or error tables.

## Troubleshooting

| Error / signal | Likely cause | What to do |
|----------------|--------------|------------|
| Immediate exit mentioning `NVIDIA_API_KEY` | Missing or invalid key | Set key via secure channel; see credential hygiene in [`references/benchmark-execution.md`](references/benchmark-execution.md). |
| `train.json must be a JSON array` | Wrong JSON shape | Top-level array of objects; validate per [`references/dataset-and-conversion.md`](references/dataset-and-conversion.md). |
| Fewer rows in `evaluation_data.json` than `train.json` | Per-query failures | Check stderr: network or stream JSON errors; see error table in benchmark-execution. |
| Empty `generated_contexts` everywhere | Retrieval gap | Verify collection, ingestion, `top_k` / `vdb_top_k`, and `ingestor_server_url` **without** `/v1` suffix. |
| Ingestor 404 on upload | Bad ingestor base URL | Pass `http://host:port` only — code appends `/v1/`. |

Full signal table: [`references/benchmark-execution.md#common-error-cases-and-signals`](references/benchmark-execution.md#common-error-cases-and-signals).

## Gotchas

- **Run from repo root**: paths and imports in `scripts/eval/evaluate_rag.py` assume this; a wrong directory silently breaks imports.
- **`--ingestor_server_url`**: pass `http://host:port` without `/v1`—the code appends `/v1/` automatically. Including `/v1` causes 404s on ingestor calls.
- **Vector DB / embedding settings**: not set by this CLI; configure via the deployed ingestor and RAG server env vars (e.g. `APP_VECTORSTORE_URL`, embedding model).
- **`--model` / `--llm_endpoint`**: forwarded verbatim only when explicitly set; omit to keep the server's configured LLM.
- **Stale collections**: a previous run's ingested data persists unless you use `--force_ingestion`. Use `--collection` with a unique name when comparing quality across isolated runs.
- **Empty context metrics**: if all `generated_contexts` are empty, RAGAS scores only `nv_accuracy` and leaves the other two metrics blank—this is not a silent success.

## Source of truth

| Piece | Location |
|-------|----------|
| Driver | `scripts/eval/evaluate_rag.py` (`CORPUS_DIRECTORY` = `corpus`, `EVAL_DATA` = `train.json`) |
| Human README (always in-repo) | `scripts/eval/README.md` |
| Full CLI (flags, defaults) | `scripts/eval/evaluate_rag.py --help`; [`references/evaluate-rag-cli.md`](references/evaluate-rag-cli.md) |
| Dataset / conversion | [`references/dataset-and-conversion.md`](references/dataset-and-conversion.md) |
| Runs, outputs, errors | [`references/benchmark-execution.md`](references/benchmark-execution.md) |
| Result analysis scripts | [`references/result-analysis.md`](references/result-analysis.md) |
| Latency / throughput | **rag-perf** skill, `docs/performance-benchmarking.md` |

## Agent playbook

1. **Run eval** — `uv sync --project scripts/eval` then `uv run --project scripts/eval python scripts/eval/evaluate_rag.py` with required `--dataset-paths`, `--host`, and `--port` (and env `NVIDIA_API_KEY`). Argument `--ingestor_server_url` is optional (defaults to `http://localhost:8082`); pass it only when overriding the ingestor endpoint.
2. **Quality tuning** — See [`references/benchmark-execution.md`](references/benchmark-execution.md): `--top_k`/`--vdb_top_k`, reranker and query-rewriting toggles, `--temperature`, `--top-p`, `--max-tokens`.
3. **Data conversion** — Follow [`references/dataset-and-conversion.md`](references/dataset-and-conversion.md).
4. **Analyze results** — [`references/result-analysis.md`](references/result-analysis.md); quick scan: `python3 -m json.tool results/<dataset>/rag_<dataset>_evaluation_summary.json`.
5. **Error triage** — [`references/benchmark-execution.md#common-error-cases-and-signals`](references/benchmark-execution.md#common-error-cases-and-signals).
