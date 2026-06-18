---
name: tao-route-visual-changenet-samples
description: Routes the weakest VCN samples (output of `tao-analyze-gaps-visual-changenet`) into per-augmentation-module
  subsets — one parquet for k-NN mining, one for AnomalyGen (Cosmos SDG) — based on each module's label eligibility. Use as the
  immediate next step after DEFT gap analysis in a VCN AOI SDA iteration.
license: Apache-2.0
compatibility: Standalone — no external runtime requirements.
metadata:
  author: NVIDIA Corporation
  version: "0.1.0"
allowed-tools: Read Bash
tags:
- data
- routing
- vcn
- aoi
- sda
---

# TAO VCN Sample Routing Skill

You are the dispatcher between gap analysis and the augmentation modules in a VCN AOI SDA pipeline. Each augmentation module can only act on labels it knows how to handle:

- **k-NN Mining** can only mine real-image neighbors for labels that already exist in the **source pool CSV**. There is no point looking for `SHIFT` neighbors if the pool has no `SHIFT` rows.
- **AnomalyGen** (Cosmos SDG) can only generate synthetic anomalies for the classes its inference pipeline supports: `PASS`, `EXCESS_SOLDER`, `MISSING`, `BRIDGE`. A weak sample with a label outside this set is unroutable to AnomalyGen.

This skill runs **once per SDA iteration immediately after gap analysis**. It splits the gap-analysis parquet into one filtered parquet per module so each module operates on its own eligible subset, and it writes a human-readable summary of the per-label routing decisions.

The work is intentionally trivial: read a parquet, do two `.isin(...)` filters, write two parquets, write one summary. The skill exists to make those decisions auditable — every label must show up in the summary with a yes/no verdict for each module so a downstream reviewer can spot when a label is silently dropped because no module accepted it.

---

## Inputs

1. **`gaps_parquet`** — the gap-analysis output (typically `<exp_dir>/rca_results/<timestamp>/gaps.parquet` from `tao-analyze-gaps-visual-changenet`). Required columns: `filepath`, `label`. Other columns (`siamese_score`, `weakness`) are preserved verbatim.
2. **`source_pool_csv`** — VCN-format mining source pool CSV with a `label` column. Empty string or non-existent path is allowed; the mining subset will simply be empty in that case.
3. **Output directory** — where the two routed parquets, the summary, and the report are written. Default: a timestamped folder under the gap-analysis result directory: `<rca_result_dir>/routing_results/<timestamp>/`.
4. **`anomalygen_supported_labels`** *(optional)* — override the default AnomalyGen-eligible label set. Default: `{"PASS", "EXCESS_SOLDER", "MISSING", "BRIDGE"}`. **Warning:** This must stay in sync with `ANOMALYGEN_SUPPORTED_LABELS` in `mdo-kratos-workflows/pipelines/sda/routing.py` and the AnomalyGen integration's actual generator coverage. Adding a new defect class to AnomalyGen means adding it here too.

---

## Method

The whole skill is two `.isin(...)` masks against the uppercased label column.

### Step 1 — Load and uppercase

```python
df = pd.read_parquet(gaps_parquet)
labels_upper = df["label"].astype(str).str.upper()
```

The match is **case-insensitive** for both module checks. The original `label` column is preserved unchanged in the output parquets — only the comparison key is uppercased.

### Step 2 — Mining subset

```python
if source_pool_csv and os.path.isfile(source_pool_csv):
    pool_df = pd.read_csv(source_pool_csv)
    pool_labels = {str(l).upper() for l in pool_df["label"].unique()}
    mn_mask = labels_upper.isin(pool_labels)
    mn_df = df[mn_mask]
else:
    pool_missing = True
    pool_labels = set()
    mn_df = df.iloc[0:0]   # empty, but with the same schema
mn_df.to_parquet(mining_gaps_parquet, index=False)
```

If the pool CSV is missing or empty, the mining subset is an empty DataFrame **with the same columns as the input** so downstream readers don't crash on schema mismatch. Flag this case in the summary.

### Step 3 — AnomalyGen subset

```python
ANOMALYGEN_SUPPORTED = {"PASS", "EXCESS_SOLDER", "MISSING", "BRIDGE"}
ag_mask = labels_upper.isin(ANOMALYGEN_SUPPORTED)
ag_df = df[ag_mask]
ag_df.to_parquet(anomalygen_gaps_parquet, index=False)
```

Rows whose label is in the AnomalyGen-supported set are written verbatim to `anomalygen_gaps.parquet`. The schema matches the input parquet exactly — downstream AnomalyGen (Cosmos SDG) needs no other changes.

### Step 4 — Per-label routing breakdown

For every distinct label in the input gaps parquet (uppercased), record:
- `count` — how many rows have this label
- `mining` — yes if the label is in `pool_labels`, otherwise no
- `anomalygen` — yes if the label is in `ANOMALYGEN_SUPPORTED`, otherwise no

A label can route to **both** modules (e.g. PASS rows route to AnomalyGen, and if the source pool also contains PASS rows they route to Mining too). A label can also route to **none** — flag those, since they are silently dropped and may signal a configuration mismatch.

Write the breakdown to `routing_summary.txt`. The format mirrors the reference component exactly:

```
Weak-sample routing summary
Total weak samples: <N>
Mining subset:      <N_mn> -> <mining_gaps_parquet>
AnomalyGen subset:  <N_ag> -> <anomalygen_gaps_parquet>

[If pool missing:]
No source pool CSV at '<path>'; mining subset is empty.

Per-label breakdown (count, mining, anomalygen):
  PASS: 50 (mining=yes, anomalygen=yes)
  MISSING: 32 (mining=no, anomalygen=yes)
  SHIFT: 14 (mining=yes, anomalygen=no)
  EXCESS_SOLDER: 9 (mining=yes, anomalygen=yes)
  ...
```

### Step 5 — Sanity checks

After both subsets are written, verify:
- The sum of subset sizes is *not* required to equal `len(df)` — overlap is allowed (a label can route to both modules). What matters is that **every input row appears in at least one subset, OR appears in the "none" list with an explicit reason**.
- If `len(mn_df) == 0` and `len(ag_df) == 0`, something is wrong — flag prominently in the report.
- If an entire label group routes to no module, the `Recommended Actions` section must call this out so the user can either seed the source pool with that label or extend AnomalyGen's supported set.

---

## Reference Python Recipe

This is the exact computation, lifted from `mdo-kratos-workflows/pipelines/sda/routing.py`. Run as a single Python script via Bash; it produces every artifact except the report.

```python
import os
import pandas as pd

ANOMALYGEN_SUPPORTED = {"PASS", "EXCESS_SOLDER", "MISSING", "BRIDGE"}

df = pd.read_parquet(gaps_parquet)
labels_upper = df["label"].astype(str).str.upper()

# Mining subset
pool_missing = False
if source_pool_csv and os.path.isfile(source_pool_csv):
    pool_df = pd.read_csv(source_pool_csv)
    pool_labels = {str(l).upper() for l in pool_df["label"].unique()}
    mn_mask = labels_upper.isin(pool_labels)
    mn_df = df[mn_mask]
else:
    pool_missing = True
    pool_labels = set()
    mn_df = df.iloc[0:0]
os.makedirs(os.path.dirname(mining_gaps_parquet) or ".", exist_ok=True)
mn_df.to_parquet(mining_gaps_parquet, index=False)

# AnomalyGen subset
ag_mask = labels_upper.isin(ANOMALYGEN_SUPPORTED)
ag_df = df[ag_mask]
os.makedirs(os.path.dirname(anomalygen_gaps_parquet) or ".", exist_ok=True)
ag_df.to_parquet(anomalygen_gaps_parquet, index=False)

# Per-label breakdown
summary_lines = [
    "Weak-sample routing summary",
    f"Total weak samples: {len(df)}",
    f"Mining subset:      {len(mn_df)} -> {mining_gaps_parquet}",
    f"AnomalyGen subset:  {len(ag_df)} -> {anomalygen_gaps_parquet}",
    "",
]
if pool_missing:
    summary_lines.append(f"No source pool CSV at {source_pool_csv!r}; mining subset is empty.")
    summary_lines.append("")
summary_lines.append("Per-label breakdown (count, mining, anomalygen):")
label_counts = labels_upper.value_counts()
for label, count in label_counts.items():
    in_mn = (not pool_missing) and label in pool_labels
    in_ag = label in ANOMALYGEN_SUPPORTED
    summary_lines.append(
        f"  {label}: {count} "
        f"(mining={'yes' if in_mn else 'no'}, "
        f"anomalygen={'yes' if in_ag else 'no'})"
    )
summary_text = "\n".join(summary_lines) + "\n"

os.makedirs(logs_dir, exist_ok=True)
with open(os.path.join(logs_dir, "routing_summary.txt"), "w", encoding="utf-8") as f:
    f.write(summary_text)
print(summary_text.strip())
```

---

## Outputs

Write everything into a timestamped folder. The packaging hook will copy `routing_config/` and `claude_session.jsonl` automatically when `Routing_Report.md` is written.

```
<output_dir>/routing_results/YYYY-MM-DD_HHMMSS/
├── Routing_Report.md           # Full routing report
├── mining_gaps.parquet         # Subset routed to k-NN Mining
├── anomalygen_gaps.parquet     # Subset routed to AnomalyGen (Cosmos SDG)
├── routing_summary.txt         # Plain-text per-label breakdown
├── routing_config/             # Auto-copied by hook
└── claude_session.jsonl        # Auto-copied by hook
```

At the start of the run, get the real timestamp by running `date +%Y-%m-%d_%H%M%S` in Bash. If the user specifies a custom output path, use it directly but maintain the internal layout.

---

## Report Structure

Keep the report short (400–800 words). Routing is a deterministic decision; the value is making the decisions auditable, not narrative.

```
# VCN Routing Report: <Iteration / Experiment Name>

## 1. Verdict
- Total weak samples in: <N>
- Mining subset:     <N_mn> rows  →  `mining_gaps.parquet`
- AnomalyGen subset: <N_ag> rows  →  `anomalygen_gaps.parquet`
- Source pool present? <yes/no — and the path>
- One-line headline: "<X> labels routed, <Y> labels dropped (no module accepted)"

## 2. Inputs
| Input | Path | Notes |
|-------|------|-------|
| gaps_parquet     | … | rows=<N>, columns=<col list> |
| source_pool_csv  | … | rows=<M> or "not provided" / "missing" |

## 3. Per-Label Routing Decisions
| Label | Count in gaps | In source pool? | Mining? | AnomalyGen? | Routed To |
|-------|----------------|------------------|----------|--------------|-----------|

(One row per distinct label in `gaps_parquet`, uppercased. `Routed To` is one of:
`mining only`, `anomalygen only`, `mining+anomalygen`, `neither (DROPPED)`.
Use `neither (DROPPED)` whenever no module accepted the label. Sort by count descending.)

## 4. Module-Level Summaries
### 4.1 k-NN Mining
- Pool labels (from source_pool_csv): <list, or "pool missing">
- Labels accepted from input: <list>
- Total rows routed: <N_mn>
- Per-label row counts: <breakdown>

### 4.2 AnomalyGen (Cosmos SDG)
- Eligible labels (configured): PASS, EXCESS_SOLDER, MISSING, BRIDGE
- Labels accepted from input: <list>
- Total rows routed: <N_ag>
- Per-label row counts: <breakdown>

## 5. Dropped Labels (routed to NEITHER module)
| Label | Count | Why dropped | Suggested fix |
|-------|-------|-------------|----------------|

(Empty table is OK and means no labels were dropped. If non-empty, every row needs a
"why" — typically one of: "not in source pool AND not in AnomalyGen supported set",
"source pool missing entirely AND label not in AnomalyGen set", "label name doesn't
match any module's expected canonicalization".)

## 6. Recommended Actions
1. **If any labels are dropped**: seed the source pool with that label, OR extend
   `ANOMALYGEN_SUPPORTED_LABELS` (and the AnomalyGen generator coverage).
2. **If source pool is missing**: provide `source_pool_csv` to enable the Mining branch.
   Without it, half of the augmentation pipeline is dark.
3. **If AnomalyGen subset is empty**: gap analysis only surfaced labels AnomalyGen cannot
   generate; rely on Mining for this iteration, or extend the AnomalyGen integration.
4. **If both subsets are empty**: stop the SDA iteration. Nothing downstream can run.
```

---

## Execution Order

1. Run `date +%Y-%m-%d_%H%M%S` to get the timestamp; create `<output_dir>/routing_results/<timestamp>/`.
2. Run the Python recipe (Steps 1–4) to produce `mining_gaps.parquet`, `anomalygen_gaps.parquet`, and `routing_summary.txt`. Print summary stats to stdout so the script-check hook can verify it ran.
3. Build the per-label decision table by reading both parquets and computing the routed-to verdict per label.
4. Write `Routing_Report.md` last — writing it triggers the packaging hook, which copies session logs and skill config alongside.
