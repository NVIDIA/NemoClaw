# Output layout and result analysis

Load this when the user asks where artifacts went, how to interpret a metric, or what a column in `results.csv` means. Driver code: [`scripts/rag-perf/rag_perf/runner.py`](../../../scripts/rag-perf/rag_perf/runner.py) (`BenchmarkRunner.run`, `_write_aggregate_outputs`) and [`scripts/rag-perf/rag_perf/reporting.py`](../../../scripts/rag-perf/rag_perf/reporting.py) (`MetricsAggregator`, `Reporter`, `RagMetricsSummary`).

## Stdout sequence (in order)

1. **Banner:** ASCII "RAG PERF" logo + version.
2. **Run-info summary:** target URL, collection, vdb_top_k / reranker_top_k, input source, concurrency, total_requests, aiperf on/off. One-line per field, ~7 lines.
3. **Resolved configuration:** the full `RunConfig` dumped as YAML via `RunConfig.to_yaml_str()`. Verbose (~50 lines) by design — makes terminal output a self-contained reproducer. Don't strip in scripts.
4. **Per grid point:**
   - Section rule: `─── Point N/M: conc=...  vdb_top_k=...  rr_top_k=... ───`
   - `→ Running profiling pass (collecting server-side metrics)...`
   - `→ Running aiperf load test (concurrency=..., requests=...)...` (only when `aiperf.enabled: true`)
   - aiperf's own per-iteration log lines (logger.INFO output from the subprocess)
   - **Copy-pastable shell command:** `\n  $ python -m aiperf profile -m ... --endpoint-type nvidia_rag ...\n` — useful for reproducing a single point outside rag-perf
   - aiperf summary (its own table)
5. **Per-point summary table** (rich format, after each point completes in multi-point mode): "RAG-Perf Results — conc=N  vdb_top_k=N  rr_top_k=N" with stage breakdown bars, citation quality, bottleneck, load-test block.
6. **Aggregate sweep table** (multi-point only): "RAG-Perf Sweep — \<varying axis\>" side-by-side comparison. Auto-detects which axes vary; column header reflects the varying axis (concurrency / vdb_top_k / reranker_top_k / iter#). Footer: `Optimal throughput: <axis>=<value>  (X req/s)` and `Best p99 TTFT < 30s: <axis>=<value>`.

If `aiperf.enabled: false`, the load-test rows in step 5/6 are suppressed and the optimal-throughput footer is hidden.

## On-disk layout

Top level always: `output.dir/run_<ts>/` (UTC timestamp `YYYYMMDDTHHMMSS`).

### Single point + `iterations=1` + `aiperf.enabled=true`

```
run_<ts>/
├── report.md            # markdown summary of this point
├── results.csv          # one-row CSV
├── results.json         # single RagMetricsSummary dict
├── profiling/
│   └── profiler_records.jsonl
└── aiperf_rag_on/
    ├── inputs.json
    ├── profile_export_aiperf.csv
    ├── profile_export_aiperf.json
    ├── profile_export.jsonl
    └── logs/aiperf.log
```

### Single point + `iterations=1` + `aiperf.enabled=false`

```
run_<ts>/
├── profile_report.md
├── profile_results.json
├── (no profile_results.csv if "csv" not in output.formats)
└── profiling/
    └── profiler_records.jsonl
```

No `aiperf_rag_on/`. `profile_*` filename prefix is the visual indicator.

### Multi-point or `iterations > 1`

```
run_<ts>/
├── report.md            # aggregate, summarises all points
├── results.csv          # one row per (point × iteration)
├── results.json         # list of RagMetricsSummary dicts (or single dict if N=1)
└── iter_<i>/
    └── CR:<conc>_ISL:<isl>_OSL:<osl>_VDB-K:<vdb>_RERANKER-K:<rr>_Model:<model_clean>[_Cluster:<x>][_GPU:<y>][_Experiment:<z>]/
        ├── profiling/
        │   └── profiler_records.jsonl
        └── aiperf_rag_on/
            └── ... (same files as above)
```

`<isl>` is `synthetic.min_query_tokens` for synthetic mode, literal `var` for file-based mode (where ISL varies per query). `<osl>` is `generation.max_tokens`. `<model_clean>` is `model_name` with `/` replaced by `-`.

## `RagMetricsSummary` fields (results.json / results.csv)

Defined in [`scripts/rag-perf/rag_perf/reporting.py`](../../../scripts/rag-perf/rag_perf/reporting.py).

### Stage breakdown (profiling pass)

| Field | Source | Notes |
|---|---|---|
| `stage_breakdown.rag_ttft_ms` | `metrics.rag_ttft_ms` from final SSE chunk | Total server-side TTFT |
| `stage_breakdown.retrieval_ms` | `metrics.retrieval_time_ms` | Vector DB retrieval |
| `stage_breakdown.reranking_ms` | `metrics.context_reranker_time_ms` | Reranker stage |
| `stage_breakdown.llm_ttft_ms` | `metrics.llm_ttft_ms` | LLM time-to-first-token |
| `stage_breakdown.llm_generation_ms` | `metrics.llm_generation_time_ms` | LLM full generation |
| `stage_breakdown.{retrieval,reranking,llm}_frac` | derived | Each stage as fraction of `rag_ttft_ms` |
| `stage_breakdown.bottleneck` | `argmax(retrieval_ms, reranking_ms, llm_ttft_ms)` | Stage name string |

### Citation quality

| Field | Source |
|---|---|
| `citation_quality.mean_count` | Mean number of citations across requests |
| `citation_quality.{mean,p50,p90}_score` | Aggregations of per-citation `score` field |

> **Citations land on the first SSE chunk.** The profiler latches them on the first non-empty `citations.results` payload (server attaches them alongside the initial empty content delta, **not** the final chunk). Don't change this.

### Client-side timing (profiling pass)

| Field | Notes |
|---|---|
| `profile_client_ttft_p50_ms`, `_p90_ms` | Client-observed TTFT — includes network round-trip |
| `profile_client_e2e_p50_ms` | End-to-end latency for the profiling-pass requests |

### aiperf load-test fields

| Field | Notes |
|---|---|
| `load_ttft_{mean,p50,p90,p99}_ms` | TTFT distribution under load |
| `load_e2e_{mean,p90,p99}_ms` | End-to-end latency under load |
| `load_throughput_tok_s` | Output-token throughput |
| `load_request_throughput` | Requests per second |
| `load_error_rate` | Failed / total |

All `None` when `aiperf.enabled: false` (suppressed in tables).

### Run metadata

| Field | Notes |
|---|---|
| `concurrency`, `vdb_top_k`, `reranker_top_k` | Identifying axes — populated up-front in `_run_point`, before aiperf branches |
| `collection_names`, `total_requests` | Echoed from config |
| `profile_requests_failed`, `profile_requests_total` | If equal across all points → cli exits 1 (CI safety) |

## Quick analysis recipes

**Pretty-print a single-point summary:**
```bash
python3 -m json.tool rag-perf-results/<dir>/run_<ts>/results.json
```

**One-row-per-point view of a sweep:**
```bash
column -ts',' rag-perf-results/<dir>/run_<ts>/results.csv | less -S
```

**Compare two sweep runs:**
```bash
diff <(cat rag-perf-results/before/run_*/results.csv) \
     <(cat rag-perf-results/after/run_*/results.csv)
```

**Replay a single aiperf invocation outside rag-perf:** copy the `\n  $ python -m aiperf profile ...` line from rag-perf's stdout — it's a self-contained shlex-joined shell command using the same temp queries JSONL.

## Summarising results to the user

After a run finishes, follow this playbook to produce a tight report instead of dumping raw JSON.

### 1. Locate the canonical result file

Depends on run shape:

| Shape | Read first | Then |
|---|---|---|
| Single point + aiperf | `run_<ts>/results.json` (single dict) | `run_<ts>/report.md` for the rendered tables |
| Single point + profile-only | `run_<ts>/profile_results.json` | `run_<ts>/profile_report.md` |
| Multi-point or `iterations>1` | `run_<ts>/results.csv` (one row per point × iter) | `run_<ts>/results.json` (list of dicts) for nested fields the CSV flattens away |

Discover the latest run dir with:
```bash
ls -td rag-perf-results/<preset>/run_* | head -1
```

### 2. Extract the headline numbers

For each point pull these into a table:

| Column | Path in `RagMetricsSummary` |
|---|---|
| Concurrency | `concurrency` |
| `vdb_top_k`, `reranker_top_k` | (same names, top-level) |
| Server RAG TTFT (mean) | `stage_breakdown.rag_ttft_ms` |
| Retrieval / Reranking / LLM TTFT | `stage_breakdown.{retrieval_ms, reranking_ms, llm_ttft_ms}` |
| Bottleneck | `stage_breakdown.bottleneck` |
| TTFT p50 / p99 | `load_ttft_p50_ms`, `load_ttft_p99_ms` |
| E2E p99 | `load_e2e_p99_ms` |
| Throughput (req/s, tok/s) | `load_request_throughput`, `load_throughput_tok_s` |
| Error rate | `load_error_rate` |
| Citation count / score (mean) | `citation_quality.mean_count`, `citation_quality.mean_score` |
| Profile-pass success ratio | `1 - profile_requests_failed / profile_requests_total` |

If `aiperf.enabled: false`, `load_*` are all `None` — note "profile-only run" and skip the load-test column group.

### 3. Compute the unaccounted-time gap

```text
unaccounted = rag_ttft_ms − (retrieval_ms + reranking_ms + llm_ttft_ms)
```

If unaccounted > a stage's reported time, the breakdown isn't telling the whole story (most often: `llm_ttft_ms` is mismeasured server-side and reads near zero, leaving most of the TTFT unattributed). Mention this in the summary as a caveat — don't let the user infer "the LLM is free."

### 4. Compute scaling efficiency (sweeps only)

For a concurrency sweep, compute throughput ratio vs concurrency ratio between the lowest and highest points:

```text
scaling_efficiency = (req/s_max / req/s_min) / (concurrency_max / concurrency_min)
```

Linear scaling = 1.0; sub-linear < 1.0 indicates saturation. Pair with TTFT p99 ratio — `>2× p99 worsening for <1.5× throughput gain` is the canonical congestion signature; flag the knee location.

### 5. Signals worth calling out

Always flag in the summary, not just in passing:

- **`Citation count (mean): 0` everywhere** — collection mismatch. Suggest verifying with `curl http://<ingestor>:8082/v1/collections`.
- **`load_error_rate > 0`** — non-zero error rate in a benchmark is a finding, not a footnote. State the absolute count and the likely cause (saturation? timeouts?).
- **`stage_breakdown.llm_ttft_ms < 1 ms`** — almost certainly a measurement bug, not a real number. Caveat any LLM-stage conclusions.
- **`profile_requests_failed > 0`** — partial profiling pass; the per-stage means may be skewed if the failures clustered.
- **Bottleneck stays constant across the sweep** — informative: tells the user that scaling that axis doesn't shift the bottleneck (e.g. reranker stays dominant whether `vdb_top_k=20` or `100` → reranker model is the real cost, not the chunk-count).
- **Tail-latency p99 from very low `total_requests`** (`< 50`) — explicitly note that the tail is not statistically robust at that sample size; recommend bumping `total_requests` for follow-up.

### 6. Suggest concrete next experiments

Tie suggestions to the data, not generic advice. Examples:

- "Reranker is the bottleneck at 23% of TTFT — try `enable_reranker: false` as a baseline to see how much accuracy you'd give up to drop that 164 ms."
- "Throughput plateau between conc=4 and conc=8 — add `concurrency: [1, 2, 4, 6, 8]` to find the knee precisely."
- "TTFT p99 jumps 3× for 1.7× throughput gain at conc=4 — the system is saturating; back off to conc=2 for SLA-bound traffic and use conc≥4 only when batched throughput matters more than tail latency."
- "Citation score mean 0.58 with p90 0.80 is fine; if you want higher precision try `reranker_top_k=2` and watch the per-citation score change."

### 7. Format the summary

Use a small fixed structure:

1. **Run shape** — preset, point count, iterations, profile-only or full.
2. **Headline table** — one row per point, columns from §2.
3. **Findings** — 3–5 bullets pointing at numbers in the table (cite the column).
4. **Caveats** — sample size, suspect metrics, anything in §5.
5. **Recommended next config** — concrete YAML diff or a "try this preset" line.

Aim for ~30 lines total. Long-form interpretation belongs in a follow-up if the user asks; the first response should be scannable.


## Common patterns in results

| Pattern | Likely cause |
|---|---|
| `Citation count (mean): 0` everywhere | Collection mismatch (placeholder `<collection_name>` left in config, or wrong collection name); verify with `curl http://<ingestor>:8082/v1/collections`. |
| `Citation relevance score: N/A` while count > 0 | Citations returned without `score` field — server-side issue; check rag-server build. |
| `LLM TTFT: 0.4 ms` | Suspiciously low — likely a server-side metric measurement bug, not a real number. Don't infer optimisation conclusions from this stage alone. |
| Bottleneck stays at "RERANKING" across vdb_top_k sweep | Reranker is the dominant cost regardless of input fan-out at this scale. Try `enable_reranker: false` as a baseline. |
| TTFT p99 grows >2× while throughput grows <1.5× across concurrency | System saturation between those two concurrency levels. Add intermediate values to find the knee. |
| Sub-linear throughput scaling with high error rate | Server overloaded; lower concurrency or raise `total_requests` to get past warmup-noise. |
| `WARNING: usage was empty` (only in older outputs) | Pre-fix behaviour. Current build always populates usage from aiperf. If you see this on a current run, file a bug. |
