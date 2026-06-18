# Benchmark runs, outputs, and error signals

Load this for full command examples, artifact descriptions, quality interpretation, retrieval/generation flags, and the error-signal table.

For **latency, throughput, and load testing**, use the **rag-perf** skill — not this document.

## Credential hygiene (`NVIDIA_API_KEY`)

- Prefer a secrets manager or a **sourced env file** that is **not committed**; ensure `.env` and key files are in `.gitignore`.
- **Shell history** may record `export ...` lines — avoid pasting real keys on the command line; rotate the key if it was exposed.
- Do **not** hardcode API keys in scripts or commit them to version control.

After the key is available in the environment, run commands from the repo root.

## Output artifacts

Under `--output_dir` (default `results`), each dataset gets a subdirectory named after the dataset directory basename. Files share the same `<label>` (the dataset folder name):

| File | Purpose |
|------|---------|
| `rag_<label>_evaluation_data.json` | **Per query:** `question`, `answer`, `generated_answer`, `generated_contexts`, `retrieved_docs`. Written before RAGAS. Use for forensics and failure patterns. |
| `rag_<label>_evaluation_summary.json` | **Headline means:** `nv_accuracy_mean`, `nv_context_relevance_mean`, `nv_response_groundedness_mean`. Fast pass/fail. |
| `rag_<label>_evaluation_results.json` | **RAGAS vectors:** per-sample score lists under `nv_accuracy`, `nv_context_relevance`, `nv_response_groundedness`. |
| `rag_<label>_evaluation_metrics.json` | **Structured roll-up:** `ingestion_metrics_list`, `evaluation_metrics` (model dump of `RagEvaluationMetrics`). |

**Analysis tips:** If `evaluation_data` has fewer rows than `train.json`, some queries failed (exceptions print during the run). After drops, use `id` / `query_id` to align rows rather than positional index. For "worst questions," pair index `i` in `evaluation_results` score lists with the `i`th object in `evaluation_data`.

## Interpreting RAGAS quality metrics

- **`nv_accuracy`** — answer accuracy (LLM judge vs ground-truth `answer`).
- **`nv_context_relevance`** and **`nv_response_groundedness`** — scored when retrieved contexts exist.
- If no non-empty `generated_contexts` are present across the run, the code scores **answer accuracy only**—do not treat empty context metrics as a silent success.

## Running the benchmark

Set `NVIDIA_API_KEY` (see credential hygiene above). Optionally set `RAG_EVAL_JUDGE_MODEL` for the RAGAS judge LLM id. Then from repo root:

### Minimal full-run example

```bash
uv run --project scripts/eval python scripts/eval/evaluate_rag.py \
  --dataset-paths /path/to/my_dataset \
  --host localhost \
  --port 8081 \
  --ingestor_server_url http://localhost:8082 \
  --output_dir results
```

(`NVIDIA_API_KEY` must already be exported or injected by your environment.)

### Skip ingestion (collection already populated)

```bash
uv run --project scripts/eval python scripts/eval/evaluate_rag.py \
  --dataset-paths /path/to/my_dataset \
  --host localhost \
  --port 8081 \
  --ingestor_server_url http://localhost:8082 \
  --skip_ingestion
```

### Ingestion only (no RAGAS scoring)

```bash
uv run --project scripts/eval python scripts/eval/evaluate_rag.py \
  --dataset-paths /path/to/my_dataset \
  --host localhost \
  --port 8081 \
  --ingestor_server_url http://localhost:8082 \
  --skip_evaluation
```

### Force re-ingest (delete existing collection first)

```bash
uv run --project scripts/eval python scripts/eval/evaluate_rag.py \
  --dataset-paths /path/to/my_dataset \
  --host localhost --port 8081 \
  --ingestor_server_url http://localhost:8082 \
  --force_ingestion
```

## Retrieval and generation options (quality comparisons)

Use these flags when comparing pipeline configs for RAGAS scores. Omit any flag to leave the RAG server default.

### Retrieval depth

```bash
--top_k 5          # sent as reranker_top_k to the generate endpoint
--vdb_top_k 20     # vector DB candidate pool size
```

### Toggle pipeline stages

```bash
--enable-reranker          # send enable_reranker=true on /v1/generate
--disable-reranker         # send enable_reranker=false
--enable-query-rewriting   # send enable_query_rewriting=true
--disable-query-rewriting  # send enable_query_rewriting=false
```

Omitting these flags does not send the field—the RAG server uses its own configured default. `--enable-reranker` and `--disable-reranker` are mutually exclusive; same for the query-rewriting pair.

### Generation parameters

```bash
--temperature 0.0    # deterministic output for repeatable benchmarks
--top-p 0.95
--max-tokens 512     # cap answer length
```

These are forwarded verbatim to `/v1/generate`; omit to use the server default.

### Example: quality comparison across configs

```bash
uv run --project scripts/eval python scripts/eval/evaluate_rag.py \
  --dataset-paths /path/to/my_dataset \
  --host localhost --port 8081 \
  --ingestor_server_url http://localhost:8082 \
  --skip_ingestion \
  --disable-reranker \
  --disable-query-rewriting \
  --temperature 0.0 \
  --max-tokens 512 \
  --output_dir results/baseline_no_rerank
```

Use a distinct `--collection` or `--force_ingestion` when you need an isolated corpus for each config.

## Result analysis

For ready-to-run Python scripts, read [`result-analysis.md`](result-analysis.md). It contains: per-query worst-accuracy table, CSV export, and markdown report table.

Quick headline scan:

```bash
python3 -m json.tool results/my_dataset/rag_my_dataset_evaluation_summary.json
```

Rows with `has_context=N` and low `nv_accuracy` signal retrieval problems (ingestion gap or collection mismatch), not generation problems.

## Common error cases and signals

| Signal | What it usually means | What to check |
|--------|------------------------|---------------|
| Script exits immediately on `NVIDIA_API_KEY` | Judge cannot run | Export a valid key; optional `RAG_EVAL_JUDGE_MODEL` for an available catalog model. |
| `train.json must be a JSON array` / validation errors | Bad JSON shape | Top-level **array** of objects, not a single object or multiline records without array wrapper. |
| Fewer rows in `evaluation_data.json` than in `train.json` | Per-query exception | Stderr during run: network or JSON decode on stream. |
| Row has `generated_answer: ""` and `generated_contexts: []` | RAG returned no content | Retrieval returned nothing: collection exists and is populated? `top_k`/`vdb_top_k` too low? |
| `Response contained error message` / answers matching the server's error sentinel | RAG returned an error string | RAG server logs, collection existence, `collection_names` vs ingested data. |
| `Failed to get response from rag-server` | HTTP or network | `--host`/`--port`, firewall, RAG server health and logs. |
| Ingestor or collection errors | 4xx/5xx on ingestor | `ingestor_server_url` base without `/v1`, credentials, disk, ingestor logs. |
| `nv_context_relevance` / `nv_response_groundedness` empty with empty `generated_contexts` | No usable retrieved text for context metrics | Ingestion, `collection_name` alignment, `top_k` / retrieval config. |
| >50% failures warning in stdout | `error_count` high | Systematic config issue (wrong collection, RAG down, or streaming parse errors). |
| Citation / filename mismatch in metrics | Names do not line up | `corpus/` file basenames vs citation `document_name` patterns. |
| Stale collection from a previous run tainting results | Unexpectedly high or low accuracy | Use `--force_ingestion` to delete and re-ingest, or `--collection` to isolate. |

## Pre-flight checklist

1. Each dataset root: `corpus/` + `train.json` (`corpus/` preferably PDF, including sources where the upstream link does not name a file explicitly).
2. `train.json`: top-level array of objects (dict-shaped root is rejected). Run the quick validation in [`dataset-and-conversion.md`](dataset-and-conversion.md) after any conversion.
3. Rows include `question` and `answer` for meaningful RAGAS scores.
4. `NVIDIA_API_KEY` available before invoking the script (optional `RAG_EVAL_JUDGE_MODEL` if not using the default judge).
5. For config comparisons: use a distinct `--collection` or `--force_ingestion` / `--skip_ingestion` so each run sees the intended corpus state.
