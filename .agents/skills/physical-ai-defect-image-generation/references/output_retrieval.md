# Output retrieval

How to pull DIG workflow outputs out of OSMO and onto the agent host. Shared
across all flows; per-flow walkthroughs in `references/flows/<flow>.md` point
here for the retrieval block.

For *presenting* outputs to the user once retrieved (download archive zip,
preview-grid HTML), see `references/output_rendering.md` — separate concern.

## Pull the anomaly tree

```bash
osmo data list --no-pager <dig_url_root>/runs/${NAME}/
osmo data download <dig_url_root>/runs/${NAME}/anomaly ./output/${NAME}/
```

`${NAME}` is the value the agent passed via `--set name=<flow>-$STAMP` at
submit (Common Preconditions §4). `<dig_url_root>` is the bucket prefix
established at first-time setup (Step 0 first-time gate).

## MinIO-backed OSMO alternative

If the OSMO instance is backed by MinIO, `mc cp` is an alternative to
`osmo data download`:

```bash
mc cp --recursive osmo/<bucket>/runs/${NAME}/anomaly ./output/${NAME}/
```

The `mc` alias `osmo` is configured at `~/.mc/config.json`
(key `osmo` → `http://localhost:30090`).

## Canonical `anomaly/` tree

Every Day 0 Texture and Day 1 (manual-ROI / real-alignment) flow emits this
flat layout under `runs/<name>/anomaly/`:

- `reconstructed_image/` — AnomalyGen reconstructions
- `annotated_image/` — annotated samples with defect overlays
- `cropped_image/` — per-ROI cropped inputs fed to AnomalyGen
- `cropped_mask/` — per-ROI submasks used during inference
- `original_image/` — pre-crop source
- `original_mask/` — pre-crop submask
- `SDG_result.csv` — per-sample labels + metadata

Day 0 Good Image and Day 0 Structural Defects emit different trees (no
`anomaly/` — they don't run AnomalyGen); see their flow refs for the
per-flow layout.
