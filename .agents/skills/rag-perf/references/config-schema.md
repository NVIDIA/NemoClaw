# Config schema reference

Load this when the user is authoring a new YAML, debugging a `Configuration errors` message, or asking which knob controls a behaviour. Schema is defined in [`scripts/rag-perf/rag_perf/config.py`](../../../scripts/rag-perf/rag_perf/config.py) (`RunConfig` + sub-models, Pydantic v2). User-facing prose is in [`docs/performance-benchmarking.md`](../../../docs/performance-benchmarking.md).

## Top-level shape

```yaml
target:    {...}
aiperf:    {...}
load:      {...}
rag:       {...}
generation: {...}
input:     {...}
output:    {...}
model_name: "nvidia/nemotron-3-super-120b-a12b"   # passed to aiperf via -m
tokenizer:  ""                                     # optional HF tokenizer for token counting
```

There is **no** `sweep:` block any more — sweep axes live where they belong (`load.concurrency`, `rag.vdb_top_k`, `rag.reranker_top_k`) and run-orchestration moved under `load` (`iterations`, `sleep_between_points_s`).

## `target`

| Field | Default | Purpose |
|---|---|---|
| `url` | `http://localhost:8081` | Base URL of the RAG server. No trailing slash. |
| `timeout_s` | `300` | Per-request wall-clock timeout. Raise on slow / overloaded backends. |

## `aiperf`

| Field | Default | Purpose |
|---|---|---|
| `enabled` | `true` | When `false`, skip the load-test phase. Output filenames become `profile_*` and load-test rows are suppressed in tables. |

## `load`

Drives the aiperf load-test phase **and** the orchestration of the grid.

| Field | Default | Purpose |
|---|---|---|
| `mode` | `concurrency` | `concurrency` (N workers always active) or `request_rate` (Poisson arrivals). |
| `concurrency` | `8` (`int \| list[int]`) | Scalar = single value, list = sweep axis. **No duplicates allowed.** |
| `request_rate` | `null` | Required when `mode: request_rate`. |
| `warmup_requests` | `10` (`>= 1`) | aiperf rejects warmup=0 — validator enforces minimum 1. |
| `total_requests` | `200` | Measured requests per point (excluding warmup). |
| `duration_s` | `null` | Alternative to `total_requests` (wall-clock based). |
| `profile_requests` | `20` | Number of requests in the server-side profiling pass. Independent of `total_requests`. |
| `iterations` | `1` (`>= 1`) | Repeat the full grid this many times (variance estimation). |
| `sleep_between_points_s` | `0` | Seconds between grid points. `60` matches the blueprint pipeline's default drain time. |

**Helper:** `LoadConfig.concurrency_list` returns `[scalar]` or the list — use this when iterating.

## `rag`

Forwarded verbatim into the `/v1/generate` request body. **Per-query overrides** in JSONL/CSV win over these defaults.

| Field | Default | Purpose |
|---|---|---|
| `collection_names` | `["default"]` | **Must be edited before running.** Presets ship with `["<collection_name>"]` placeholder. |
| `vdb_top_k` | `100` (`int \| list[int]`, each 1–400) | Chunks retrieved before reranking. List = sweep axis. No duplicates. |
| `reranker_top_k` | `10` (`int \| list[int]`, each 1–25) | Chunks passed to LLM after rerank. List = sweep axis. No duplicates. |
| `enable_reranker` | `true` | Toggle reranker stage. |
| `enable_citations` | `true` | Whether server returns citation chunks. |
| `use_knowledge_base` | `true` | False = bypass retrieval entirely. |
| `confidence_threshold` | `0.0` (`0–1`) | Minimum relevance score for retained chunks. |

**Helpers:** `RagParams.vdb_top_k_list`, `RagParams.reranker_top_k_list` mirror the `concurrency_list` pattern.

## `generation`

| Field | Default | Purpose |
|---|---|---|
| `max_tokens` | `512` | Max output tokens. |
| `min_tokens` | `null` | Set equal to `max_tokens` to pin output length exactly. |
| `ignore_eos` | `false` | Set `true` alongside `min_tokens` to suppress early EOS — pins fixed output length irrespective of content. |
| `temperature` | `0.0` | Sampling temperature passed to the RAG server's LLM. |

> **`min_tokens: null` handling.** rag-perf strips None-valued generation fields before merging into the request body — the server's `Prompt.min_tokens: int` rejects an explicit null (would be a 422). This is in [`QueryLoader._build_request`](../../../scripts/rag-perf/rag_perf/query.py).

## `input`

**Set exactly one** of `file` or `synthetic`. They are mutually exclusive — both → validation error. Neither → `synthetic` auto-fills with defaults.

| Field | Default | Purpose |
|---|---|---|
| `file` | `null` | Path to `.jsonl` or `.csv` (extension determines format). |
| `synthetic` | `null` (auto-filled) | LLM-generated queries — see [`synthetic-generation.md`](synthetic-generation.md). |
| `sampling` | `random` | `random` / `sequential` / `shuffle-once` when `total_requests` exceeds the query count. |
| `seed` | `42` | RNG seed for reproducible sampling. |

### File-based input details

- **`.jsonl`**: one JSON object per line, `{"query": "...", ...}`. Any field also defined under `rag.*` or `generation.*` is treated as a per-query override.
- **`.csv`**: must have a `query` column. Other columns matching `rag.*` / `generation.*` field names become per-query overrides; CSV cell values are JSON-parsed when possible (so `["finance"]` is a list, not a string).

## `output`

| Field | Default | Purpose |
|---|---|---|
| `dir` | `./rag-perf-results` | Root output dir. A timestamped `run_<ts>/` subdir is created per invocation. |
| `formats` | `[json, csv]` | Subset of `json`, `csv`, `jsonl_raw`. |
| `markdown_report` | `true` | Write `report.md`. |
| `save_responses` | `false` | Persist full generated text per request (large). |
| `cluster`, `gpu`, `experiment_name` | `""` | Stamped into per-point dir names for cross-machine diffs. |

## Polymorphic axes & the grid

Three fields are scalar-or-list:

- `load.concurrency`
- `rag.vdb_top_k`
- `rag.reranker_top_k`

The full grid is the Cartesian product across whichever are lists. Each point yields a fresh `RunConfig` with all three resolved to scalars (see `BenchmarkRunner._iter_grid_points` in [`runner.py`](../../../scripts/rag-perf/rag_perf/runner.py)). Run shape:

| Resolved grid | `iterations` | Output layout |
|---|---|---|
| 1 point | 1 | **Flat**: `run_<ts>/{report.md, results.json, results.csv, profiling/, aiperf_rag_on/}` |
| 1 point | >1 | Nested: `run_<ts>/iter_<i>/<single point>/...` |
| >1 points | any | Nested: `run_<ts>/iter_<i>/<CR:..._VDB-K:..._RERANKER-K:..._Model:...>/{profiling,aiperf_rag_on}/` |

When `aiperf.enabled: false`, top-level files become `profile_report.md` / `profile_results.json` / `profile_results.csv`.

## Validation invariants (worth remembering)

- `load.concurrency` rejects `[]`, scalar `<1`, list with `<1` entries, and **duplicates**.
- `rag.vdb_top_k` / `reranker_top_k` enforce range (`1–400` / `1–25`), reject duplicates in lists, reject empty lists.
- `load.warmup_requests >= 1` (aiperf rejects 0).
- `input` XOR rule: both `file` and `synthetic` set → fail; neither set → auto-fill `synthetic` with defaults.
- `input.file` extension must be `.jsonl` or `.csv`; anything else → fail.
- For `synthetic.mode: dataset_based`, either `dataset_file` or `dataset_name` must be set.

These all run at YAML load time in `_load_config` (cli.py). Errors print a per-field bullet list and exit 1 — no benchmark code runs, no output dir is created.

## Programmatic overrides

For tests / scripted invocations:

```python
from rag_perf.config import RunConfig
cfg = RunConfig.from_yaml("scripts/rag-perf/configs/single_run.yaml")
cfg = cfg.with_overrides(load__concurrency=[1, 4, 8], rag__vdb_top_k=50)
```

Double-underscore = nested key. `with_overrides` re-runs Pydantic validation on the merged config. There is **no** equivalent on the CLI — see [SKILL.md](../SKILL.md) "CLI is config-only" gotcha.
