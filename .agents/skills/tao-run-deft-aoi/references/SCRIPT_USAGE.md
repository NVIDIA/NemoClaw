# Bundled Script Usage

Detailed examples live here so `SKILL.md` stays focused on trigger behavior, workflow, and hard invariants.

## `run_script()` Invocation

`run_script()` is a Claude Code plugin runtime helper — it is **not defined in this repo**, and importing it from any of the bundled scripts will fail. Use it only when the harness exposes it in the current execution context (check `globals()` for the name, or feature-detect with a try/except `NameError` wrapper). When the harness does not provide it, fall back to **Direct Python Invocation** below; both reach the same scripts. Resolve every path argument to an absolute host path before calling.

```python
run_script(
    "scripts/log_stage.py",
    args=[
        "--log-path", f"{workspace_root}/results/loop_log.jsonl",
        "--iter-label", iter_label,
        "--stage", "anomalygen",
        "--status", "ok",
        "--summary", "generated 1024 triplets, 8 defect types",
        "--duration-sec", str(duration_sec),
    ],
)
```

`--context-tokens` is optional and defaults to `0`. Bash and `run_script()` callers cannot measure LLM context, so they should omit it; real per-stage usage is filled in by `align_token_usage.py` after the loop (see below).

## Direct Python Invocation

Use direct `python` invocation only when `run_script()` is unavailable.

```bash
python scripts/log_stage.py \
  --log-path /abs/path/results/loop_log.jsonl \
  --iter-label iter1 \
  --stage anomalygen \
  --status ok \
  --summary "generated 1024 triplets, 8 defect types" \
  --duration-sec 612
```

## In-Process Library Use

When the parent runs a stage in-process, prefer the library API. Pass `log_path` as `pathlib.Path`; `append_stage()` intentionally rejects plain strings.

```python
from log_stage import append_stage
import pathlib

append_stage(
    pathlib.Path(f"{workspace_root}/results/loop_log.jsonl"),
    iter_label="iter1",
    stage="train",
    status="ok",
    summary="best_ckpt=ep049 FAR=0.42% threshold=0.31",
    duration_sec=duration_sec,
)
```

Never write `loop_log.jsonl` with `echo`, heredocs, or inline `jq`. The writer must compute `seq` from the live tail through `next_seq()`.

## Aligning Per-Stage Token Usage (Post-Loop)

`log_stage.py` cannot measure LLM token usage at write time. Run `align_token_usage.py` after the loop (or on demand) to backfill real per-stage numbers from the Claude Code transcript JSONL:

```bash
python scripts/align_token_usage.py \
  --log-path /abs/path/results/loop_log.jsonl \
  --cwd /abs/path/to/project-root
```

The script reads `~/.claude/projects/<slug>/*.jsonl` (slug derived from `--cwd`), attributes each assistant message's `usage` to the stage whose `(prev.ts, this.ts]` window contains it, and rewrites `loop_log.jsonl` atomically with a per-entry `tokens` field plus a refreshed `context_tokens`. The `tokens` field exposes `input`, `output`, `cache_read`, `cache_create` (and its `5m`/`1h` breakdown), `context_size_end`, and the list of `models` seen.

Pass `--transcript PATH` (repeatable) or `--project-dir PATH` if you need to override the auto-discovered location. Use `--dry-run` to inspect output without rewriting the log.
