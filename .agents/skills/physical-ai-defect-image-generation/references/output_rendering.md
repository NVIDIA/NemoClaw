# Output rendering and download

Two operations the agent runs after a DIG workflow completes, depending on
what the user asks for:

- **Download** — package all stages + per-task logs as a single zip the
  user can pull from the agent host.
- **Preview** — render a small grid of representative samples across
  pipeline stages, emit a self-contained HTML page the rendering UI can
  display.

The underlying `osmo data download` / `mc cp` commands live in
`references/output_retrieval.md`; this file is about **how the agent
presents** those outputs after fetching them.

## Table of Contents

- [Pick the path (download vs preview)](#pick-the-path-download-vs-preview)
- [The agent's canvas directory](#the-agents-canvas-directory)
- [Path A — Download all stages and logs](#path-a--download-all-stages-and-logs)
- [Path B — Preview grid](#path-b--preview-grid)
  - [Stages and per-stage source](#stages-and-per-stage-source)
  - [Sample selection](#sample-selection)
  - [HTML layout](#html-layout)
  - [Procedure](#procedure)
- [Pitfalls](#pitfalls)

## Pick the path (download vs preview)

| User asks | Path | Returns |
|---|---|---|
| "download the results", "give me the files", "I want everything" | Download | absolute path to `<run_name>.zip` |
| "show me the results", "preview", "summarize", "what does it look like" | Preview | absolute path to `index.html` |
| Both ("show me and download") | Run both | both paths |

If the request is ambiguous, use `AskUserQuestion` with two options
("download archive" / "preview grid") before doing either.

## The agent's canvas directory

The rendering UI (Claude Code, Codex, web client) serves files from a
workspace-rooted directory. Writing to `/tmp/` or another path outside
that root means the UI cannot resolve `<img src="…">` references in the
generated HTML. Rules:

1. **Default to the current working directory.** Use
   `./outputs/<run_name>/{preview,download}/`. The cwd is always
   addressable by the rendering UI.
2. **Honor any explicit user override.** If the user asked for a
   specific path ("put it under `~/dig-results`"), use that — but
   confirm it's writable and inside the workspace before writing.
3. **All `src=` in the generated HTML must be relative.** Reference
   images as `./col1/sample_001.png`, not absolute paths and not
   S3 / MinIO URLs. The UI will not fetch external URLs.
4. **Echo the absolute path back to the user.** After writing, print
   the absolute path on its own line so the UI / user can open it.
5. **Don't overwrite without echoing first.** If the target directory
   exists, surface that to the user before clobbering.

## Path A — Download all stages and logs

Trigger: user wants a downloadable archive of everything.

### Stages to include (per flow)

Source root is `<dig_url_root>/runs/<name>/`.

| Flow | Stages |
|---|---|
| Day 0 — Texture Defects | `usd2roi-components/`, `augment/`, `finetune/` (if scheduled), `anomaly/` |
| Day 0 — Good Image | `usd2roi-components/`, `augment/` |
| Day 0 — Structural Defects | `structural_defect/`, `structural_defect_edited/` |
| Day 1 — Real-photo Alignment | `usd2roi-day1/`, `finetune/` (if scheduled), `anomaly/` |
| Day 1 — Manual ROI | `finetune/` (if scheduled), `anomaly/` |
| Finetune Only | `finetune/` |

Plus per-task logs for every group in the workflow.

### Procedure

1. Resolve `<dig_url_root>`, `<name>`, `<workflow_id>`, and the flow type
   (cookbook + Step 0 §1).
2. Stage outputs locally:
   ```bash
   mkdir -p ./outputs/<name>/download/runs
   osmo data download <dig_url_root>/runs/<name>/ ./outputs/<name>/download/runs/
   # or, if MinIO-backed (see references/troubleshooting.md §"Output Retrieval"):
   mc cp --recursive osmo/<bucket>/dig/runs/<name>/ ./outputs/<name>/download/runs/
   ```
3. Dump logs per task — iterate over the flow's group structure (see the
   diagram in each `references/flows/<flow>.md`):
   ```bash
   mkdir -p ./outputs/<name>/download/logs
   for task in <task_names>; do
     osmo workflow logs <workflow_id> -t "$task" -n 5000 \
       > "./outputs/<name>/download/logs/${task}.log"
   done
   ```
4. Zip:
   ```bash
   ( cd ./outputs/<name> && zip -r "<name>.zip" download/ )
   ```
5. Echo `realpath ./outputs/<name>/<name>.zip` back to the user.

Tip: if the run is large (> ~2 GB) and the user only needs the final
labeled output, ask whether they want the full archive or just `anomaly/`
+ logs.

## Path B — Preview grid

Trigger: user wants a visual summary.

### Stages and per-stage source

Columns are built left → right in pipeline order, including only stages
that exist for the flow. The same sample ID is used across columns so
each row reads as one frame moving through the pipeline.

Columns map a frame through the pipeline: **input → constraint/mask →
transformation → final**. For OV-driven flows, that's OV render → cad
mask → augmentation → AnomalyGen reconstructed. For Manual ROI (no OV
upstream), the input + mask come from AnomalyGen's own per-sample
`original_image/` and `original_mask/` outputs, which are co-emitted
alongside `reconstructed_image/` and align 1:1 by filename.

| Column | Day 0 Texture / Good | Structural | Day 1 Real-Photo Alignment | Day 1 Manual ROI |
|---|---|---|---|---|
| 1. Input | `usd2roi-components/crop/<MAT>/<cell>/normal_img/<NNNN>.png` (OV render) | `structural_defect/cropped/rgb/<NNNN>.png` | `usd2roi-day1/crop/<MAT>/normal_img/<NNNN>.png` | `anomaly/inference/original_image/<file>.png` |
| 2. Mask | `usd2roi-components/crop/<MAT>/<cell>/cad_mask/<NNNN>_cad_mask.png` | `structural_defect/cropped/semantic_segmentation/<NNNN>.png` | `usd2roi-day1/crop/<MAT>/cad_mask/<NNNN>.png` | `anomaly/inference/original_mask/<file>.png` |
| 3. Augmentation | `augment/crop/<MAT>/<cell>/<NNNN>.png` | `structural_defect_edited/rgb/<NNNN>.png` | n/a | n/a |
| 4. AnomalyGen reconstructed | `anomaly/inference/reconstructed_image/<file>.png` | n/a (no anomaly stage) | `anomaly/inference/reconstructed_image/<file>.png` | `anomaly/inference/reconstructed_image/<file>.png` |

Skip a column entirely if its source path is missing for the flow.
**Good Image** has columns 1–3 (no anomaly stage). **Structural** has
columns 1–3 (no anomaly stage). **Manual ROI** has columns 1, 2, 4 (no
augmentation stage — input + mask come from the anomaly stage's own
per-sample originals).

Header labels in the rendered HTML should match the flow: use
"OV render" / "OV cad mask" for OV-driven flows and
"Original image" / "Original mask" for Manual ROI, so the user reading
the grid sees what each column actually is.

### Sample selection

- 5–10 samples total. Fewer than 5 looks anemic; more than 10 slows the
  rendering UI.
- **Deterministic**: sort filenames lexicographically and pick every
  `k`-th so the picks span the dataset (e.g., 7 samples → `k = ceil(N / 7)`).
- **Aligned across columns**: pick sample IDs that exist in *every*
  available column for that flow, so each row tells one story. If
  alignment is impossible (e.g., per-component crops in structural don't
  map 1:1 to anomaly), drop the unalignable column rather than mixing
  unrelated frames.
- **For Day 0 PCBA**: prefer one sample per (material × cell) that exists
  in all columns. For structural: one per defect mode
  (shift / tombstone / sideflip).

### Filename patterns (matters for row alignment)

Sample IDs are not literally the same string across all columns — each
stage names files differently. To align a row across columns:

- **Day 0 Texture / Good** — upstream OV stages share the `<NNNN>` stem:
  - col 1 (normal_img): `<NNNN>.png`
  - col 2 (cad_mask): `<NNNN>_cad_mask.png` ← `_cad_mask` suffix
  - col 3 (augment): `<NNNN>.png` (same stem as normal_img)
  - col 4 (anomaly): **composite** `<cell>__<stem>.png` (the per-cell
    tree is flattened into one directory at the anomaly stage). Pick a
    Day-0 row by first picking `<NNNN>` from `normal_img/`, then
    locating `<cell>__<NNNN>.png` under `anomaly/inference/` — `<cell>`
    is the directory name two levels up from `normal_img/<NNNN>.png`.
- **Structural** — `cropped/{rgb,semantic_segmentation,component_instance}/<NNNN>.png`
  share the `<NNNN>` stem 1:1; `structural_defect_edited/rgb/<NNNN>.png`
  preserves it. Skip the `component_instance/` subdir — it's a per-
  component index, not a viewable image.
- **Day 1 Real-Photo Alignment** — `usd2roi-day1/crop/<MAT>/{normal_img,cad_mask}/<NNNN>.png`
  share the stem 1:1 (no `_cad_mask` suffix at this stage). Anomaly
  stage flattens to `anomaly/inference/` with paired filenames across
  subdirs.
- **Manual ROI** — all three columns come from `anomaly/inference/{original_image,original_mask,reconstructed_image}/`
  with **identical filenames** in each subdir. Pick one filename from
  `reconstructed_image/` and the same filename exists in the other two.

### HTML layout

Self-contained `index.html` at `./outputs/<name>/preview/index.html`.
No external CSS or JS — the rendering UI usually handles only images and
inline HTML. Skeleton:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>DIG preview: <run-name></title>
  <style>
    body { font-family: system-ui, sans-serif; padding: 1rem; }
    h1 { margin: 0 0 1rem; font-size: 1.1rem; }
    .grid { display: grid; grid-template-columns: repeat(<N_COLS>, 1fr); gap: .5rem; }
    .hdr { font-weight: 600; padding: .25rem 0; border-bottom: 1px solid #ddd; }
    .cell { display: flex; flex-direction: column; align-items: center; }
    .cell img { width: 100%; height: auto; display: block; }
    .cap { font-size: .75rem; color: #666; margin-top: .15rem; }
  </style>
</head>
<body>
  <h1>DIG preview — <run-name> (<flow-type>)</h1>
  <div class="grid">
    <div class="hdr">OV render</div>
    <div class="hdr">OV cad mask</div>
    <div class="hdr">Augmentation</div>
    <div class="hdr">AnomalyGen</div>
    <!-- one row per sample -->
    <div class="cell"><img src="./col1/0001.png"><div class="cap">sample 0001</div></div>
    <div class="cell"><img src="./col2/0001.png"><div class="cap">sample 0001</div></div>
    <div class="cell"><img src="./col3/0001.png"><div class="cap">sample 0001</div></div>
    <div class="cell"><img src="./col4/0001.png"><div class="cap">sample 0001</div></div>
    <!-- … -->
  </div>
</body>
</html>
```

`<N_COLS>` = number of columns actually populated for the flow.

### Procedure

1. Resolve `<dig_url_root>`, `<name>`, `<workflow_id>`, flow type.
2. Decide which columns apply for the flow (see the table above).
3. Pick sample IDs (5–10, deterministic, aligned across columns where
   possible).
4. For each picked sample × each applicable column, download just that
   one image into `./outputs/<name>/preview/col<K>/<sample_id>.png`.
   Skip a sample if any *required* column is missing — don't render
   partial rows.
5. Generate `index.html` referencing the staged images by relative path.
   Number of columns matches what was actually staged.
6. Echo `realpath ./outputs/<name>/preview/index.html` back to the user.

If Path A has already run, prefer to read from the local
`./outputs/<name>/download/runs/` copy rather than re-downloading.

## Pitfalls

- **Absolute paths in HTML `src=`** — the UI cannot resolve them. Use
  relative paths only.
- **Writing outside the cwd-rooted output tree** — the UI sandbox
  typically refuses to read those files. Stay under `./outputs/<name>/`.
- **Picking samples per-stage independently** — rows will mix unrelated
  frames. Pick once, reuse the IDs across columns.
- **Forgetting to localize images** — `src=` pointing at S3 / MinIO URLs
  will not fetch in the UI sandbox. Download to the preview dir.
- **Mis-ordered columns** — keep OV render → cad mask → augmentation →
  AnomalyGen. That's pipeline order, left to right; flipping it makes
  the grid unreadable.
- **Including the structural flow's `cropped/component_instance/`** in
  the preview — it's a per-component index, not a viewable image; skip
  it.
- **Over-large images** — the per-cell crops are usually small (~512 px
  per side); no need to resize. If a stage emits very large frames
  (Day 1 real-alignment can produce 4k+ usd2roi-day1 renders), generate
  thumbnails first (`mogrify -resize 640x` or similar) and reference
  the thumbnails in the HTML, not the originals.
