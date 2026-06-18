# `evaluate_rag.py` CLI flag reference

Complete argument tables for `scripts/eval/evaluate_rag.py`. Load this when the user asks about a specific flag, its default value, or fixed evaluator behavior not covered in the main skill.

For **latency, throughput, and load testing**, use the **rag-perf** skill — not the `--thread` / `--timeout` knobs here (they exist on the CLI for operational reliability only).

## Arguments

### Required

| Argument | Notes |
|----------|-------|
| `--dataset-paths` | One or more dataset root directories, each containing `corpus/` and `train.json`. |
| `--host` | RAG server host. |
| `--port` | RAG server port (integer). |

### Dataset and ingestion

| Argument | Default | Notes |
|----------|---------|-------|
| `--file-type` | `pdf` | Ingestion file type (e.g. `pdf`, `txt`, `txt,html`, `mp3` for audio). Substring `pdf` enables PDF page counts in ingestion metadata. |
| `--ingestor_server_url` | `http://localhost:8082` | Base URL — code appends `/v1/` automatically; do not include `/v1` here. |
| `--collection` | dataset folder basename | Override collection name for ingest and query. |
| `--batch_size` | `1000` | Ingestion batch size (server max is 10000). |
| `--skip_ingestion` | flag | Skip ingestion; query and RAGAS scoring only (collection must already exist). |
| `--skip_evaluation` | flag | Skip RAGAS scoring; perform ingestion only. |
| `--force_ingestion` | flag | Delete the collection first, then re-ingest from scratch. |
| `--delete_collection` | flag | Delete the collection after the run completes. |

### Retrieval

| Argument | Default | Notes |
|----------|---------|-------|
| `--top_k` | (omitted) | If set, sent as `reranker_top_k` on `/v1/generate`; if omitted, not sent. |
| `--vdb_top_k` | (omitted) | If set, sent as `vdb_top_k`; if omitted, not sent. |

### Pipeline stage toggles

| Argument | Notes |
|----------|-------|
| `--enable-reranker` | Send `enable_reranker=true` on `/v1/generate`. Mutually exclusive with `--disable-reranker`. |
| `--disable-reranker` | Send `enable_reranker=false` on `/v1/generate`. |
| `--enable-query-rewriting` | Send `enable_query_rewriting=true` on `/v1/generate`. Mutually exclusive with `--disable-query-rewriting`. |
| `--disable-query-rewriting` | Send `enable_query_rewriting=false` on `/v1/generate`. |

Omitting either pair entirely does not send the field — the RAG server uses its own configured default.

### Generation overrides

| Argument | Default | Notes |
|----------|---------|-------|
| `--model` | (omitted) | LLM model id forwarded to `/v1/generate` as `model`; omit to use the server default. |
| `--llm_endpoint` | (omitted) | LLM API endpoint URL forwarded as `llm_endpoint`; omit to use the server default. |
| `--temperature` | (omitted) | Sampling temperature forwarded to `/v1/generate`; omit to use the server default. |
| `--top-p` | (omitted) | Top-p forwarded to `/v1/generate`; omit to use the server default. |
| `--max-tokens` | (omitted) | Max tokens forwarded to `/v1/generate`; omit to use the server default. |

### Output and run control

| Argument | Default | Notes |
|----------|---------|-------|
| `--output_dir` | `results` | Root output directory; each dataset gets a subdirectory named after the dataset basename. |
| `--verbose` | flag | Enable verbose output. |
| `--thread` | `4` | Parallel workers for query generation (operational; not for latency benchmarking). |
| `--timeout` | `180` | Per-request HTTP timeout in seconds when queries fail to complete. |

## Fixed behavior (not CLI flags)

- The evaluator does not send `vdb_endpoint`, embedding dimension, or related overrides to the ingestor or `/v1/generate`; services use their configured defaults (environment / server config).
- Ingestion uploads always use `blocking: true` for a synchronous ingestor response.
- The client does not send `split_options` on document upload; chunk size and overlap are controlled by the ingestor server configuration.
- RAG queries use `POST /v1/generate` with a single user turn per benchmark row; `enable_filter_generator` is not sent (server default applies).
- `RAG_EVAL_JUDGE_MODEL` env var sets the RAGAS judge model id (`ChatNVIDIA`); defaults to `mistralai/mixtral-8x22b-instruct-v0.1` when unset or empty.
