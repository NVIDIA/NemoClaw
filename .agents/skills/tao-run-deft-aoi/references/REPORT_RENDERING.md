# DEFT Loop Report Rendering Protocol

Template: `references/DEFT_Loop_Report.html`. Output: `results/DEFT_Loop_Report.html`.
Re-render after every stage and at loop end. Embed all images as base64 data URIs so
the file opens offline.

## When to update which data

| Stage trigger | New data available |
|---|---|
| Baseline evaluate done | baseline FAR, threshold, recall |
| Baseline RCA done | RCA insight, score dist, recall-FAR table, defect type rows |
| Iter N evaluate done | iter N FAR, threshold, recall, checkpoint |
| Iter N RCA done | updated RCA insight and tables |
| Iter N AnomalyGen done | sample images (base64 thumbnails) for iter N |
| Iter N k-NN filtering done | knn_summary (`candidate_count`, `kept_count`, `rejected_count`), training row counts |
| Loop stop (KPI met or max_iterations) | final status, `best_iter`, recommendations |

Stub values for data not yet available:
- future iter FAR/rows → render `—`
- missing image columns → `.sample-img-placeholder`

## In-progress rendering rules

While the loop has not stopped:

- `{{ FINAL_KPI_STATUS }}` → `"IN PROGRESS"`, class → `""` (no green).
- `{{ ITERATIONS_RUN }}` → count of iterations with `status == "complete"` at render time.
- Iteration table rows → only completed iterations; omit rows for unstarted iterations.
- `{{ ITER_CARDS_HTML }}` → only emit cards for completed iterations.
- KPI banner → empty string while running; inject it only on loop stop.
- `{{ FAR_DATA_JSON }}` → include only data points from completed iterations.

## KPI status phrasing — be neutral, never say "NOT MET"

We are the product team. When the target is not yet reached, describe the **gap**
instead of stamping a failure label. Phrasing rules for `{{ FINAL_KPI_STATUS }}`
and any KPI banner copy:

| Condition | `FINAL_KPI_STATUS` | `FINAL_KPI_STATUS_CLASS` |
|---|---|---|
| `best_far <= kpi_target` | `"MET"` | `"green"` |
| `best_far > kpi_target` | `"{gap:.1f}pp from target"` (e.g. `"2.3pp from target"`) | `""` |
| Loop still running | `"IN PROGRESS"` | `""` |

Where `gap = best_far - kpi_target` (always positive in the not-met case).

Do **not** emit `"NOT MET"`, `"FAILED"`, the `red` CSS class, or red banner styling
even when the target is missed. The KPI banner in this case should use the neutral
yellow "Best result so far" treatment shown in the template doc-comment, not the
red "KPI NOT MET" treatment. Reporting the gap factually is the entire ask.

## Minimal render pattern

```python
import datetime, pathlib

template = pathlib.Path("references/DEFT_Loop_Report.html").read_text()
html = (
    template
    .replace("{{ GENERATED_DATE }}", datetime.datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC"))
    # ... fill remaining placeholders from deft_state.json + latest stage outputs ...
)
pathlib.Path(f"{RESULTS_DIR}/DEFT_Loop_Report.html").write_text(html)
```

Never defer to a single end-of-loop render — write after every stage so the user can refresh and see live progress.

### CRITICAL: Always render in a single pass from the source template

**Never read the output file and apply a second round of `.replace()` calls on it.**
Each render must start fresh from `references/DEFT_Loop_Report.html`, apply all
substitutions in one chained block, then write the output. Reading the output file
for a second pass causes two silent bugs:

1. **Section duplication.** If any placeholder was not filled in pass 1 (e.g.
   `{{ ITERATION_TABLE_ROWS_HTML }}`), pass 2 may split the partially-rendered HTML
   on that token and inject the second half of the file as the replacement value,
   duplicating every subsequent section and producing two `<script>` blocks.
2. **Stale data.** A second pass may overwrite already-correct values with stale data
   from a different state snapshot.

Pattern to follow — collect all values before writing:

```python
html = (
    template                                              # from source, not output
    .replace('{{ GENERATED_DATE }}',           generated_date)
    .replace('{{ KPI_TARGET }}',               kpi_target)
    .replace('{{ FAR_DATA_JSON }}',            far_data_json)
    # ... ALL remaining tokens in one chain ...
    .replace('{{ RECOMMENDATIONS_HTML }}',     recommendations_html)
)
out_path.write_text(html)
assert html.count('{{ ') == 0, "Unfilled placeholders remain"
```

## Template prep gotchas

### Strip the doc-comment header before any placeholder replacement

The template starts with a `<!-- ... -->` author-documentation block that must be
removed before substitution. **Do not** use a greedy or non-greedy `<!--.*?-->`
regex — it will stop at the first `-->` inside the block and leave the remainder
as raw visible text. Use exact boundary detection:

```python
outer_close = template.index('-->\n<html')
doc_start   = template.index('<!--\n====')
template    = template[:doc_start] + template[outer_close + 3:]
```

### Image embedding

Embed sample images as base64 JPEG data URIs (`data:image/jpeg;base64,...`)
resized to **256×256** with `PIL.Image.thumbnail` (each image now occupies twice
the screen area as before, so the previous 128px thumbnails look soft). The
sample strip is **2 columns only** — Input and Output — matching
`.sample-strip { grid-template-columns: repeat(2, 1fr); max-width: 640px }`
in the template:

| Strip | Source path |
|---|---|
| AnomalyGen OK (golden) | `${RESULTS_DIR}/iter${N}/dataset/images/synthetic_iter${N}_ok/` |
| AnomalyGen NG (input)  | `${RESULTS_DIR}/iter${N}/dataset/images/synthetic_iter${N}_ng/` |

EA variant: these dirs are populated by the pre-gen ingest stage
(`scripts/changenet_data_pair_prepare.py` staging output), not by an SDG
container. Sample selection still works on the same iter-scoped staging tree.

Emit **exactly one** `.sample-iter-block` containing **one** pair — not one per
iteration. Selection rule: pick the first existing pair (sorted by filename)
from the best iteration. If the best iteration has no staged synthetic pair,
fall back to the most recent iteration that does; if none, emit two
`<div class="sample-img-placeholder">No image</div>` cells. The earlier `Normal`,
`OV SDG Defect`, and `Mask` columns were removed and the per-iteration loop was
collapsed — do not emit any of them. Rationale: every extra sample is one more
crop the reader can complain about; one clean pair is the deliverable.

### Chart data field names (must match the template's JavaScript)

The template's JavaScript accesses specific field names. Using wrong names renders
blank charts with no error. Confirmed correct schemas from the template source:

| Placeholder | Required JSON schema | JS field accessed |
|---|---|---|
| `{{ FAR_DATA_JSON }}` | `[{"label": "Baseline", "value": 48.16, "color": "#c2262d"}, ...]` | `d.value`, `d.color`, `d.label` |

Common mistake: using `far` instead of `value`.

The training-data stacked bar chart (`DATA_DATA_JSON`, `DATA_Y_MAX`,
`DATA_Y_STEPS_JSON`) was removed from the Progress Overview. The Augmentation
Pool table below the FAR chart now carries that information instead — do not
attempt to render the old chart.

### Table row schemas (must match template `<thead>` column counts)

Each `*_ROWS_HTML` placeholder is injected inside a `<tbody>` whose `<thead>` is
fixed in the template. Column counts must match exactly or cells overflow/underflow
silently. Confirmed column counts from the template:

| Placeholder | Columns (count) | Column names |
|---|---|---|
| `{{ ITERATION_TABLE_ROWS_HTML }}` | 8 | Phase, FAR @ 100% Recall, Δ vs Baseline, Threshold, Training Rows, Synthetic, Syn Ratio, Note |
| `{{ SCORE_DIST_ROWS_HTML }}` | 4 | Metric (Score Range), PASS, NO_PASS, Notes |
| `{{ RECALL_FAR_ROWS_HTML }}` | 4 | Min Recall, FAR, Threshold, KPI |
| `{{ DEFECT_TYPE_ROWS_HTML }}` | 4 | Defect Type, Count, Score Range, Detectable at KPI threshold? |

### Verifying placeholder count

When counting rendered placeholder divs for verification, search for
`<div class="sample-img-placeholder">` — not the bare class string, which also
appears in CSS and comment text.
