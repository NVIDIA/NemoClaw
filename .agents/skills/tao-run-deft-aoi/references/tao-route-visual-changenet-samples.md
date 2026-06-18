# DEFT AOI Routing (VCN) — DEFT Loop Reference

Read this when the parent runs the `routing` stage to split RCA gaps into
per-augmentation-module subsets. The underlying skill
`tao-skill-bank:tao-route-visual-changenet-samples` (`skills/data/tao-route-visual-changenet-samples/SKILL.md`)
owns the full routing contract: label eligibility for each module, the Python
recipe (two `.isin(...)` masks), per-label routing breakdown, and report format.
This file only covers the DEFT-loop-specific overlay: required inputs, output
layout, and `deft_state.json` / `loop_log.jsonl` updates.

## DEFT-Loop Inputs

- `gaps_parquet` — absolute path from `deft_state.json` (`rca_gaps_parquet` field set by the RCA stage); required columns: `filepath`, `label`
- `source_pool_csv` — VCN-format source pool CSV with a `label` column; pass empty string if unavailable (mining subset will be empty and routing summary will flag it)
- `anomalygen_supported_labels` — default `{"PASS", "EXCESS_SOLDER", "MISSING", "BRIDGE"}`; override only if AnomalyGen generator coverage has changed

If `rca_gaps_parquet` is absent from `deft_state.json` or the file does not exist on disk, stop and return failure — do not invent a path.

## Output Directory

`results/<baseline|iter${N}>/routing_results/<timestamp>/`

Required files:
- `mining_gaps.parquet` — subset routed to k-NN Mining (same schema as input `gaps.parquet`; may be empty)
- `anomalygen_gaps.parquet` — subset routed to AnomalyGen/Cosmos SDG (same schema; may be empty)
- `routing_summary.txt` — per-label routing decisions and dropped-label warnings

## Output to deft_state.json

```python
state["baseline" | f"iter{N}"]["routing_mining_parquet"]     = "<abs_path>/mining_gaps.parquet"
state["baseline" | f"iter{N}"]["routing_anomalygen_parquet"] = "<abs_path>/anomalygen_gaps.parquet"
```

Always write both paths, even when a subset is empty — downstream stages read these fields unconditionally. If both subsets are empty (all labels dropped), stop after writing the report and state, log `status=error`, and surface the dropped-label list.

## Log Stage

```bash
python3 <skill_root>/scripts/log_stage.py \
    --log-path results/loop_log.jsonl \
    --iter-label <baseline|iter${N}> \
    --stage routing --status ok \
    --summary "Routing: mining=N_mn rows, anomalygen=N_ag rows; N_drop labels dropped"
```
