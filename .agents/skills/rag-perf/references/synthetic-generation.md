# Synthetic query generation

Load this when `input.synthetic` is in play, when reasoning-model query leakage is suspected, when generation fails midway, or when the user wants to reproduce a query set across runs.

Implementation lives in [`scripts/rag-perf/rag_perf/query.py`](../../../scripts/rag-perf/rag_perf/query.py) (`SyntheticQueryGenerator`). Default prompts are in [`scripts/rag-perf/prompts/default_prompts.yaml`](../../../scripts/rag-perf/prompts/default_prompts.yaml).

## Pipeline

When `input.synthetic` is set, rag-perf — *before the benchmark phase even starts* — does this:

1. Resolves the LLM model (`synthetic.llm_model`, or auto-discover via `GET /v1/models`).
2. Loads prompt templates (`synthetic.prompts_file`, or bundled defaults).
3. For `mode: dataset_based`, loads reference questions from `synthetic.dataset_file` or `synthetic.dataset_name` (auto-lookup under `./datasets/<name>/{train,data}.json`). For `mode: random`, no reference material.
4. Builds N per-query user messages.
5. Fans out concurrent LLM calls (bounded by `synthetic.generation_concurrency`, default 8) using `asyncio.gather` over `asyncio.to_thread` wrappers around the sync `httpx.post`.
6. **Streams each successful query to disk** as it completes — under an `asyncio.Lock`, with `flush()` after every line. The file at `synthetic.jsonl_output_path` is opened in `"w"` mode and written line-by-line.
7. Returns the in-memory list (also persisted on disk).
8. Hands off to `QueryLoader._load_jsonl` and the benchmark runs from the now-static file.

The key consequence: a mid-generation failure preserves all queries that completed before it. The exception still propagates (`asyncio.gather` cancels remaining tasks on first failure) and the run aborts — **no automatic retry**.

## All synthetic knobs

| Field | Default | Purpose |
|---|---|---|
| `mode` | `random` | `random` (no seed) or `dataset_based` (seeded by reference questions). |
| `num_queries` | `50` | Distinct queries to generate. The list is cycled if `total_requests` exceeds it. |
| `min_query_tokens` | `50` | Approximate minimum word count target (multiplied by 0.75 to derive `word_target` for the prompt). Combined with `generation.min_tokens == max_tokens` and `generation.ignore_eos: true`, pins exact ISL × OSL. |
| `generation_concurrency` | `8` (`>= 1`) | Bounded parallel LLM calls. Raise on fast endpoints, lower for rate-limited ones. |
| `temperature` | `0.9` | Sampling temperature for the generator LLM. |
| `disable_thinking` | `true` | Inject `chat_template_kwargs: {enable_thinking: false}` into the request body. **Critical for reasoning models.** |
| `extra_body` | `null` | Escape hatch — arbitrary keys merged into the LLM request body. Merged after `disable_thinking`, so explicit keys here win. |
| `llm_url` | `http://localhost:8999/v1/chat/completions` | OpenAI-compatible endpoint. Often the same NIM the RAG server proxies, but can be any. |
| `llm_model` | `""` | Empty string → auto-discover via `GET <llm_url base>/v1/models`. |
| `prompts_file` | `null` | Custom YAML; `null` → bundled defaults. |
| `jsonl_output_path` | `./rag-perf-synthetic-queries.jsonl` | Where streamed queries land. Re-running with the same path overwrites it. |
| `dataset_file` | `null` | Required for `dataset_based` (or use `dataset_name`). |
| `dataset_name` | `null` | Auto-lookup — searches `./datasets/<name>/train.json`, `./datasets/<name>.json`, `./datasets/<name>/data.json` in order. |

For `dataset_based`, validation requires either `dataset_file` or `dataset_name`. Both unset → `ValidationError`.

## Reasoning-model gotcha (read this if generation looks corrupted)

**Symptom:** the synthetic JSONL contains entries like:

```jsonl
{"query": "We need to output a single question, at least 384 words long. Must be specific and self-contained. Only the question, no extra text. So we need a long question (384+ words). Must be a question that could be answered..."}
```

The LLM's chain-of-thought is leaking into the query text.

**Cause:** Nemotron Omni / Qwen-Reasoning / similar models, in reasoning mode, put their final answer in `message.content` and the deliberation in `message.reasoning_content`. With `min_tokens` near the model's reasoning budget, `content` can come back **empty** — the model exhausted the budget on CoT.

**Why rag-perf used to leak this:** an old version of `_call_llm` fell back to `reasoning_content` when `content` was empty. We removed that fallback — `_call_llm` now reads only `message.content` and raises if empty, with a clear hint:

```
LLM returned empty content (reasoning_content was populated — model exhausted its
budget on chain-of-thought; raise min_query_tokens or set
synthetic.disable_thinking=true).
```

**Fix paths:**

1. **Default already correct:** `synthetic.disable_thinking: true` injects `chat_template_kwargs: {enable_thinking: false}`. The model skips reasoning and writes the answer directly to `content`.
2. **For non-reasoning endpoints:** set `disable_thinking: false` to avoid sending the unsupported kwarg.
3. **Last resort:** raise `min_query_tokens` substantially so the model has budget for both reasoning and answer.

## Failure recovery (partial JSONL)

If generation fails at query 47 of 100:

- Queries 1–46 (or however many had completed; *order is completion-order, not request-order, since calls are concurrent*) are on disk at `synthetic.jsonl_output_path`.
- The exception in stdout looks like: `RuntimeError: Random synthetic query generation failed at query N: <root cause>`.

Recovery options:

- **Fix the LLM endpoint and re-run:** the file is overwritten (`"w"` mode) — old partial is lost.
- **Use the partial directly:** swap `input.synthetic` for `input.file: <jsonl_output_path>` and the benchmark runs from whatever made it to disk.
- **Lower `num_queries`** so the new total stays under what you previously generated; combine with `input.file` pointing at the partial.

## Prompt templates

Default templates ([`prompts/default_prompts.yaml`](../../../scripts/rag-perf/prompts/default_prompts.yaml)) are deliberately strict to keep `content` clean: forbid markdown, numbering, "Question:" / "Here is" / "Sure," prefixes, planning/thinking text, restating instructions. They require exactly one `?` at the end.

If swapping in custom prompts via `synthetic.prompts_file`, **preserve the same output discipline** or expect leaked planning text in the JSONL — the rag-perf side does only minimal cleanup (`q.lstrip("0123456789.). ").strip()` to drop leading numbering).

Variables interpolated into the templates:

- `{word_target}` — `int(min_query_tokens * 0.75)`, lower-bound 10.
- `{index}` — 1-based query index (for "make this unique" hints).
- `{ref}` — reference question (`dataset_based` mode only).

## Reproducibility

- `synthetic.jsonl_output_path` is the canonical artefact. Commit it to a known location and switch to `input.file: <that path>` for subsequent runs to keep the load identical while iterating on retrieval / reranker config.
- Generation is concurrent → completion order is non-deterministic. The dataset is reproducible across runs only if you pin and reuse the JSONL — not by re-running generation with the same config. (Even with the same seed, async scheduling is non-deterministic.)
